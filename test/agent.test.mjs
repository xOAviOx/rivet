import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { reconcileSession, runAgent } from "../dist/agent.js";
import { configSchema } from "../dist/config.js";
import { Policy, Workspace } from "../dist/security.js";
import { Store } from "../dist/store.js";

async function fixture(t, provider, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "rivet-agent-"));
  const database = join(root, "sessions.sqlite");
  const store = new Store(database);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = configSchema.parse({
    provider: "openai",
    model: { id: "test", tools: true, context: 16384, maxOutput: 1024 },
    mode: "edit",
  });
  const session = store.create(root, config.model.id);
  const events = [];
  const options = {
    config,
    provider,
    store,
    session,
    workspace: await Workspace.open(root),
    policy: new Policy(
      config,
      async () => "once",
      (e) => events.push(e),
    ),
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    ...extra,
  };
  return { options, store, session, events, database };
}

const step = (calls) => ({
  message: {
    role: "assistant",
    content: calls ? "" : "Done",
    ...(calls ? { calls } : {}),
  },
  usage: { input: 10, output: 5 },
});

/** Provider rule: every tool-call batch is directly followed by one result per call. */
function assertPaired(messages) {
  for (let i = 0; i < messages.length; i++) {
    const calls =
      messages[i].role === "assistant" ? (messages[i].calls ?? []) : [];
    if (!calls.length) continue;
    const results = [];
    while (messages[i + 1]?.role === "tool") results.push(messages[++i].callId);
    assert.deepEqual(results.sort(), calls.map((call) => call.id).sort());
  }
}

test("plain-text MCP results reach the next provider step intact", async (t) => {
  let requests = 0;
  const result = "MCP returned plain text, not JSON";
  const env = await fixture(
    t,
    {
      async step(_system, messages) {
        if (requests++ === 0)
          return step([{ id: "one", name: "mcp_test_read", arguments: {} }]);
        assert.deepEqual(messages.at(-1), {
          role: "tool",
          content: result,
          callId: "one",
          error: false,
        });
        return step();
      },
    },
    { mcp: { tools: [], call: async () => result } },
  );
  assert.equal((await runAgent(env.options, "Read MCP")).exitCode, 0);
  assert.equal(env.events.find((e) => e.type === "tool.end").error, false);
  assert.equal(env.store.messages(env.session.id)[2].content, result);
});

test("eight consecutive built-in errors stop the loop and mark tool events", async (t) => {
  let requests = 0;
  const env = await fixture(t, {
    async step() {
      requests++;
      return step([
        {
          id: String(requests),
          name: "file_read",
          arguments: { path: `missing-${requests}` },
        },
      ]);
    },
  });
  assert.equal((await runAgent(env.options, "Read missing files")).exitCode, 4);
  assert.equal(requests, 8);
  const ends = env.events.filter((e) => e.type === "tool.end");
  assert.equal(ends.length, 8);
  assert.ok(ends.every((e) => e.error));
  assert.match(
    env.events.find((e) => e.type === "error").message,
    /consecutive tool errors/,
  );
});

test("tool-result secrets are redacted before provider, events, messages, and action storage", async (t) => {
  const secret = "compatible-session-credential";
  const envSecret = "environment-secret-value";
  const variable = "RIVET_AGENT_TEST_SECRET";
  const previous = process.env[variable];
  process.env[variable] = envSecret;
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  let requests = 0;
  const env = await fixture(
    t,
    {
      async step(_system, messages) {
        if (requests++ === 0)
          return step([{ id: "one", name: "mcp_test_read", arguments: {} }]);
        assert.equal(messages.at(-1).content, "[REDACTED] [REDACTED]");
        return step();
      },
    },
    {
      secrets: [secret],
      mcp: { tools: [], call: async () => `${secret} ${envSecret}` },
    },
  );
  assert.equal((await runAgent(env.options, "Read MCP")).exitCode, 0);
  for (const records of [
    env.events,
    env.store.events(env.session.id),
    env.store.messages(env.session.id),
  ]) {
    assert.ok(!JSON.stringify(records).includes(secret));
    assert.ok(!JSON.stringify(records).includes(envSecret));
  }
  const db = new DatabaseSync(env.database, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT result FROM actions").get().result,
      "[REDACTED] [REDACTED]",
    );
  } finally {
    db.close();
  }
});

const createCall = (id, path, newText = "created") => ({
  id,
  name: "file_patch",
  arguments: { path, expectedHash: null, oldText: "", newText, create: true },
});

test("new scopes defer every call in a batch until the model receives their instructions", async (t) => {
  let requests = 0;
  let approvals = 0;
  const env = await fixture(t, {
    async step(system, messages) {
      assert.ok(
        !system.includes("Nested rules") && !system.includes("Sibling rules"),
      );
      if (requests++ === 0) {
        assert.match(system, /Root rules/);
        return step([
          createCall("one", "src/new.txt"),
          createCall("two", "src/new.txt"),
        ]);
      }
      if (requests === 2) {
        assert.equal(approvals, 0);
        assert.equal(
          existsSync(join(env.options.workspace.root, "src/new.txt")),
          false,
        );
        for (const message of messages.slice(-2)) {
          const result = JSON.parse(message.content);
          assert.equal(result.deferred, true);
          assert.match(result.instructions, /Scope src.*src\/AGENTS.md/s);
          assert.match(result.instructions, /Nested rules/);
          assert.ok(!result.instructions.includes("Sibling rules"));
        }
        return step([
          createCall("three", "src/new.txt", "conforms to nested rules"),
        ]);
      }
      return step();
    },
  });
  const root = env.options.workspace.root;
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "sibling"));
  writeFileSync(join(root, "AGENTS.md"), "Root rules");
  writeFileSync(join(root, "src/AGENTS.md"), "Nested rules");
  writeFileSync(join(root, "sibling/AGENTS.md"), "Sibling rules");
  env.options.policy = new Policy(
    env.options.config,
    async () => {
      approvals++;
      return "once";
    },
    () => {},
  );
  assert.equal(
    (await runAgent(env.options, "Create a nested file")).exitCode,
    0,
  );
  assert.equal(approvals, 1);
  assert.equal(
    readFileSync(join(root, "src/new.txt"), "utf8"),
    "conforms to nested rules",
  );
  assert.deepEqual(env.store.pending(env.session.id), []);
});

test("changed instructions are shown again before retrying a deferred operation", async (t) => {
  let requests = 0;
  const env = await fixture(t, {
    async step(_system, messages) {
      requests++;
      if (requests === 2) {
        assert.match(messages.at(-1).content, /Version one/);
        writeFileSync(
          join(env.options.workspace.root, "src/AGENTS.md"),
          "Version two",
        );
      }
      if (requests === 3) {
        assert.match(messages.at(-1).content, /Version two/);
        assert.equal(
          existsSync(join(env.options.workspace.root, "src/new.txt")),
          false,
        );
      }
      return requests <= 3
        ? step([createCall(String(requests), "src/new.txt")])
        : step();
    },
  });
  mkdirSync(join(env.options.workspace.root, "src"));
  writeFileSync(
    join(env.options.workspace.root, "src/AGENTS.md"),
    "Version one",
  );
  assert.equal(
    (await runAgent(env.options, "Create a nested file")).exitCode,
    0,
  );
  assert.equal(requests, 4);
});

test("deleted instruction files invalidate the previously presented scope", async (t) => {
  let requests = 0;
  const env = await fixture(t, {
    async step(_system, messages) {
      requests++;
      if (requests <= 2)
        return step([createCall(String(requests), "src/first.txt")]);
      if (requests === 3) {
        rmSync(join(env.options.workspace.root, "src/AGENTS.md"));
        return step([createCall("three", "src/second.txt")]);
      }
      if (requests === 4) {
        assert.deepEqual(JSON.parse(messages.at(-1).content).removed, [
          "src/AGENTS.md",
        ]);
        assert.equal(
          existsSync(join(env.options.workspace.root, "src/second.txt")),
          false,
        );
        return step([createCall("four", "src/second.txt")]);
      }
      return step();
    },
  });
  mkdirSync(join(env.options.workspace.root, "src"));
  writeFileSync(
    join(env.options.workspace.root, "src/AGENTS.md"),
    "Old scope rules",
  );
  assert.equal((await runAgent(env.options, "Create files")).exitCode, 0);
  assert.equal(requests, 5);
});

test("command cwd instructions are delivered before process execution", async (t) => {
  let requests = 0;
  const env = await fixture(t, {
    async step(_system, messages) {
      requests++;
      if (requests === 2) {
        assert.match(messages.at(-1).content, /Command scope rules/);
        assert.equal(
          existsSync(join(env.options.workspace.root, "src/marker")),
          false,
        );
      }
      return requests <= 2
        ? step([
            {
              id: String(requests),
              name: "command",
              arguments: {
                command: process.execPath,
                args: ["-e", "require('fs').writeFileSync('marker','done')"],
                cwd: "src",
              },
            },
          ])
        : step();
    },
  });
  mkdirSync(join(env.options.workspace.root, "src"));
  writeFileSync(
    join(env.options.workspace.root, "src/AGENTS.md"),
    "Command scope rules",
  );
  assert.equal((await runAgent(env.options, "Run a command")).exitCode, 0);
  assert.equal(
    readFileSync(join(env.options.workspace.root, "src/marker"), "utf8"),
    "done",
  );
});

test("instruction previews must fit the provider's tool-result output limit", async (t) => {
  let requests = 0;
  let approvals = 0;
  const env = await fixture(t, {
    async step() {
      requests++;
      return step([createCall("one", "src/new.txt")]);
    },
  });
  mkdirSync(join(env.options.workspace.root, "src"));
  writeFileSync(
    join(env.options.workspace.root, "src/AGENTS.md"),
    "Rules ".repeat(100),
  );
  env.options.config.limits.outputBytes = 100;
  env.options.policy = new Policy(
    env.options.config,
    async () => {
      approvals++;
      return "once";
    },
    () => {},
  );
  assert.equal((await runAgent(env.options, "Create a file")).exitCode, 4);
  assert.equal(requests, 1);
  assert.equal(approvals, 0);
  assert.equal(
    existsSync(join(env.options.workspace.root, "src/new.txt")),
    false,
  );
  assert.match(
    env.events.find((e) => e.type === "error").message,
    /tool output limit/,
  );
});

test("oversized root instructions fail the context budget before contacting the model", async (t) => {
  let requests = 0;
  const env = await fixture(t, {
    async step() {
      requests++;
      return step();
    },
  });
  env.options.config.model.context = 4096;
  writeFileSync(
    join(env.options.workspace.root, "AGENTS.md"),
    "r".repeat(3000),
  );
  assert.equal((await runAgent(env.options, "Work")).exitCode, 4);
  assert.equal(requests, 0);
});

for (const stop of ["tool limit", "cancellation"]) {
  test(`a turn stopped mid-batch by ${stop} records unstarted calls so the next turn stays paired`, async (t) => {
    const controller = new AbortController();
    const calls = [
      { id: "first", name: "mcp_test_read", arguments: {} },
      { id: "second", name: "file_list", arguments: {} },
      { id: "third", name: "file_list", arguments: { limit: 1 } },
    ];
    let requests = 0;
    const env = await fixture(
      t,
      {
        async step(_system, messages) {
          if (requests++ === 0) return step(calls);
          assertPaired(messages);
          return step();
        },
      },
      {
        signal: controller.signal,
        mcp: {
          tools: [],
          async call() {
            if (stop === "cancellation") controller.abort();
            return "first result";
          },
        },
      },
    );
    if (stop === "tool limit") env.options.config.limits.tools = 1;
    const first = await runAgent(env.options, "Work");
    assert.equal(first.exitCode, stop === "tool limit" ? 4 : 130);
    const stored = env.store.messages(env.session.id);
    assertPaired(stored);
    for (const id of ["second", "third"]) {
      const result = stored.find((m) => m.callId === id);
      assert.equal(result.error, true);
      assert.match(result.content, /Not executed/);
      assert.ok(
        !env.events.some((e) => e.type === "tool.start" && e.call.id === id),
      );
    }
    assert.deepEqual(env.store.pending(env.session.id), []);
    env.options.config.limits.tools = 64;
    env.options.signal = new AbortController().signal;
    const next = await runAgent(env.options, "Continue", stored);
    assert.equal(next.exitCode, 0);
    assert.equal(requests, 2);
  });
}

for (const [name, configure, sameCall, requestsMade, message] of [
  ["step", (c) => (c.limits.steps = 2), false, 2, /Step limit exceeded/],
  ["token", (c) => (c.limits.tokens = 20), false, 2, /Token limit exceeded/],
  [
    "cost",
    (c) => {
      c.model.inputPrice = 1000;
      c.model.outputPrice = 1000;
      c.limits.cost = 0.02;
    },
    false,
    2,
    /Cost limit exceeded/,
  ],
  ["loop", () => {}, true, 3, /Loop detected/],
]) {
  test(`${name} limit stops the turn with exit 4 and a paired transcript`, async (t) => {
    let requests = 0;
    const env = await fixture(t, {
      async step() {
        requests++;
        return step([
          {
            id: String(requests),
            name: "file_list",
            arguments: sameCall ? {} : { limit: requests },
          },
        ]);
      },
    });
    configure(env.options.config);
    assert.equal((await runAgent(env.options, "Keep listing")).exitCode, 4);
    assert.equal(requests, requestsMade);
    assert.match(env.events.find((e) => e.type === "error").message, message);
    assert.equal(env.events.at(-1).reason, "limit");
    assertPaired(env.store.messages(env.session.id));
    assert.deepEqual(env.store.pending(env.session.id), []);
  });
}

test("unfinished calls block new turns until reconciliation records them without replay", async (t) => {
  let requests = 0;
  const env = await fixture(t, {
    async step(_system, messages) {
      requests++;
      assertPaired(messages);
      return step();
    },
  });
  const { store, session } = env;
  const calls = [
    { id: "done", name: "file_list", arguments: {} },
    { id: "stored", name: "file_list", arguments: { path: "." } },
    {
      id: "uncertain",
      name: "command",
      arguments: {
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('marker','ran')"],
      },
    },
    { id: "unstarted", name: "file_list", arguments: { limit: 1 } },
  ];
  // A process killed during "uncertain": earlier calls resolved, later ones never began.
  store.append(session.id, { role: "user", content: "Earlier" });
  store.append(session.id, { role: "assistant", content: "", calls });
  store.complete(store.begin(session.id, calls[0]), session.id, {
    role: "tool",
    content: '{"files":[]}',
    callId: "done",
    error: false,
  });
  // Older stores wrote the action result and transcript message separately.
  store.finish(store.begin(session.id, calls[1]), '{"error":"stored failure"}');
  store.begin(session.id, calls[2]);
  const history = () => store.messages(session.id);

  const refused = await runAgent(env.options, "Continue", history());
  assert.equal(refused.exitCode, 2);
  assert.equal(requests, 0);
  assert.match(
    env.events.find((e) => e.type === "error").message,
    /3 unfinished tool call/,
  );
  assert.ok(!history().some((m) => m.content === "Continue"));

  assert.equal(await reconcileSession(store, session.id, async () => false), 1);
  const recorded = history();
  assert.deepEqual(
    recorded.find((m) => m.callId === "stored"),
    {
      role: "tool",
      content: '{"error":"stored failure"}',
      callId: "stored",
      error: true,
    },
  );
  assert.match(
    recorded.find((m) => m.callId === "unstarted").content,
    /Not executed/,
  );
  assert.deepEqual(
    store.pending(session.id).map((action) => action.call.id),
    ["uncertain"],
  );
  assert.equal(
    (await runAgent(env.options, "Continue", history())).exitCode,
    2,
  );

  const confirmed = [];
  assert.equal(
    await reconcileSession(store, session.id, async (call) => {
      confirmed.push(call.id);
      return true;
    }),
    0,
  );
  assert.deepEqual(confirmed, ["uncertain"]);
  assert.deepEqual(store.pending(session.id), []);
  assert.match(
    history().find((m) => m.callId === "uncertain").content,
    /outcome is unknown/,
  );
  assert.equal(
    (await runAgent(env.options, "Continue", history())).exitCode,
    0,
  );
  assert.equal(requests, 1);
  assertPaired(history());
  assert.equal(existsSync(join(env.options.workspace.root, "marker")), false);
});
