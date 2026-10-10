import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runAgent } from "../dist/agent.js";
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
