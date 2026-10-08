import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { reconcileSession } from "../dist/agent.js";
import { Store } from "../dist/store.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const signalCli = fileURLToPath(
  new URL("./fixtures/cli-signal.mjs", import.meta.url),
);
const key = "cli-fixture-provider-credential";
const reply = (res, delta, finish) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
  );
};
const calls = (res, ...list) =>
  reply(
    res,
    {
      tool_calls: list.map(([id, name, args], index) => ({
        index,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      })),
    },
    "tool_calls",
  );
/** Real providers reject a tool-call batch that is not directly followed by all its results. */
function unpaired(messages = []) {
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].tool_calls?.length) {
      if (messages[i].role === "tool")
        return `result ${messages[i].tool_call_id} has no preceding call`;
      continue;
    }
    const expected = messages[i].tool_calls.map((call) => call.id).sort();
    const results = [];
    while (messages[i + 1]?.role === "tool")
      results.push(messages[++i].tool_call_id);
    if (results.sort().join() !== expected.join())
      return `calls ${expected.join(", ")} lack matching results`;
  }
}
const rejectUnpaired = (res, problem) => {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: problem } }));
};
function launcher(workspace, state, children) {
  return (args, { input = "", interruptible = false } = {}) => {
    const child = spawn(
      process.execPath,
      [interruptible ? signalCli : cli, ...args],
      {
        cwd: workspace,
        windowsHide: true,
        env: { ...process.env, RIVET_HOME: state, RIVET_API_KEY: key },
        stdio: interruptible
          ? ["pipe", "pipe", "pipe", "ipc"]
          : ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    child.stdin.end(input);
    return { child, done };
  };
}
async function stopAll(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await closed;
    }
  }
}
async function fixture(t, { mode = "custom", trusted = true, hold } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rivet-cli-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  const requests = [];
  let ready;
  const held = new Promise((resolve) => {
    ready = resolve;
  });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const data of req) body += data;
    const message = body ? JSON.parse(body) : {};
    requests.push({ url: req.url, method: req.method, message });
    if (req.url === "/mcp") {
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result;
      if (message.method === "initialize") {
        res.setHeader("mcp-session-id", "cli-session");
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      } else if (message.method === "tools/list") {
        result = {
          tools: [
            {
              name: "echo",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          ],
        };
      } else if (hold === "mcp") {
        ready();
        return;
      } else
        result = {
          content: [
            { type: "text", text: `echo: ${message.params.arguments.value}` },
          ],
        };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      return;
    }
    const problem = unpaired(message.messages);
    if (problem) return rejectUnpaired(res, problem);
    if (hold === "provider") {
      ready();
      return;
    }
    const userCount = message.messages.filter((m) => m.role === "user").length;
    if (!message.messages.some((m) => m.role === "tool") && userCount === 1) {
      reply(
        res,
        {
          tool_calls: [
            {
              index: 0,
              id: "call-one",
              type: "function",
              function: {
                name: "mcp_remote_echo",
                arguments: '{"value":"hello"}',
              },
            },
          ],
        },
        "tool_calls",
      );
    } else reply(res, { content: "Workflow finished." }, "stop");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(state, "config.json"),
    JSON.stringify({
      provider: "compatible",
      endpoint: `${base}/v1`,
      model: { id: "fixture", tools: true, context: 16384, maxOutput: 1024 },
      mode,
      policy: { mcp_remote_echo: "allow" },
      limits: { timeoutMs: 5000 },
      mcp: [{ name: "remote", transport: "http", url: `${base}/mcp`, trusted }],
    }),
  );
  const children = [];
  t.after(async () => {
    await stopAll(children);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const start = launcher(workspace, state, children);
  return { root, workspace, state, requests, start, held };
}

/** A compatible endpoint driven by `handle`; non-chat paths reach it without a message. */
async function scripted(t, settings, handle) {
  const root = mkdtempSync(join(tmpdir(), "rivet-cli-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  const chats = [];
  const rejected = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const data of req) body += data;
    if (req.url !== "/v1/chat/completions") return handle(req, res);
    const message = JSON.parse(body);
    chats.push(message);
    const problem = unpaired(message.messages);
    if (problem) {
      rejected.push(problem);
      return rejectUnpaired(res, problem);
    }
    handle(req, res, message);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(state, "config.json"),
    JSON.stringify({
      provider: "compatible",
      endpoint: `${base}/v1`,
      model: { id: "fixture", tools: true, context: 16384, maxOutput: 1024 },
      mode: "custom",
      limits: { timeoutMs: 10000 },
      ...settings,
    }),
  );
  const children = [];
  t.after(async () => {
    await stopAll(children);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  });
  const start = launcher(workspace, state, children);
  return { root, workspace, state, base, chats, rejected, start };
}
/** The latest user prompt and the tool results the model has received since it. */
const turnOf = (message) => {
  const last = message.messages.findLastIndex((m) => m.role === "user");
  return {
    prompt: message.messages[last].content,
    results: message.messages.slice(last + 1).filter((m) => m.role === "tool"),
  };
};
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const events = (result) =>
  result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test(
  "CLI runs an MCP tool, persists results, resumes in a new process, and exports",
  { timeout: 15000 },
  async (t) => {
    const env = await fixture(t);
    const result = await env.start(["run", "--json", "Use the echo tool"]).done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      events(result).some(
        (event) =>
          event.type === "tool.end" &&
          event.result === "echo: hello" &&
          !event.error,
      ),
    );
    assert.equal(events(result).at(-1).type, "done");
    const provider = env.requests.filter(
      (request) => request.url === "/v1/chat/completions",
    );
    assert.ok(
      provider[0].message.tools.some(
        (tool) => tool.function.name === "mcp_remote_echo",
      ),
    );
    assert.equal(provider[1].message.messages.at(-1).content, "echo: hello");
    const store = new Store(join(env.state, "sessions.sqlite"));
    const session = store.list()[0];
    assert.equal(store.messages(session.id)[2].content, "echo: hello");
    assert.deepEqual(store.pending(session.id), []);
    store.close();
    const resumed = await env.start(["resume", session.id, "--json"], {
      input: "Follow up\n/exit\n",
    }).done;
    assert.equal(resumed.code, 0, resumed.stderr);
    const latest = env.requests
      .filter((request) => request.url === "/v1/chat/completions")
      .at(-1);
    assert.ok(
      latest.message.messages.some(
        (message) =>
          message.role === "tool" && message.content === "echo: hello",
      ),
    );
    const target = join(env.root, "export.json");
    const exported = await env.start(["export", session.id, target]).done;
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(readFileSync(target, "utf8"), /echo: hello/);
    assert.ok(!readFileSync(target, "utf8").includes(key));
    assert.equal(
      env.requests.filter((request) => request.method === "DELETE").length,
      2,
    );
  },
);

test(
  "CLI plan policy blocks MCP invocation even for trusted servers",
  { timeout: 10000 },
  async (t) => {
    const env = await fixture(t, { mode: "plan" });
    const result = await env.start(["run", "--json", "Use the echo tool"]).done;
    assert.equal(result.code, 0, result.stderr); // Model handles the denied call and finishes.
    assert.ok(
      events(result).some(
        (event) =>
          event.type === "tool.end" &&
          event.error &&
          event.result.includes("Policy denies"),
      ),
    );
    assert.equal(
      env.requests.filter((request) => request.message.method === "tools/call")
        .length,
      0,
    );
  },
);

test(
  "CLI refuses untrusted MCP before provider or server traffic",
  { timeout: 10000 },
  async (t) => {
    const env = await fixture(t, { trusted: false });
    const result = await env.start(["run", "--json", "Use the echo tool"]).done;
    assert.equal(result.code, 3);
    assert.match(result.stderr, /not trusted/);
    assert.equal(env.requests.length, 0);
  },
);

for (const hold of ["provider", "mcp"]) {
  test(
    `one-shot SIGINT cancels a pending ${hold} request, closes MCP, and exits 130`,
    { timeout: 10000 },
    async (t) => {
      const env = await fixture(t, { hold });
      const { child, done } = env.start(
        ["run", "--json", "Use the echo tool"],
        { interruptible: true },
      );
      await env.held;
      child.send("interrupt");
      const result = await done;
      assert.equal(result.code, 130, result.stderr);
      assert.ok(
        events(result).some(
          (event) => event.type === "done" && event.reason === "cancelled",
        ),
      );
      assert.equal(
        env.requests.filter((request) => request.method === "DELETE").length,
        1,
      );
    },
  );
}

test(
  "help, version, and unknown commands use defined output and exit codes",
  { timeout: 10000 },
  async (t) => {
    const env = await scripted(t, {}, (_req, res) => res.writeHead(500).end());
    const help = await env.start(["help"]).done;
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /rivet run --json "prompt"/);
    assert.match(help.stdout, /130 cancelled/);
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const shown = await env.start(["--version"]).done;
    assert.equal(shown.stdout, `rivet ${version}\n`);
    const unknown = await env.start(["bogus"]).done;
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown command bogus/);
    const empty = await env.start(["run"]).done;
    assert.equal(empty.code, 2);
    assert.deepEqual(env.chats, []);
  },
);

test(
  "sample Git workflow: search, scoped read, guarded patch, and commit survive restart and export",
  { timeout: 30000 },
  async (t) => {
    const env = await scripted(
      t,
      {
        policy: {
          file_search: "allow",
          file_read: "allow",
          file_patch: "allow",
          git: "allow",
        },
      },
      (_req, res, message) => {
        const { prompt, results } = turnOf(message);
        if (prompt === "Show the last commit")
          return results.length
            ? reply(res, { content: "Shown." }, "stop")
            : calls(res, [
                "log-2",
                "git",
                { args: ["log", "--oneline", "-1"] },
              ]);
        switch (results.length) {
          case 0:
            return calls(res, ["search", "file_search", { query: "Helo" }]);
          case 1:
            return calls(res, [
              "read-1",
              "file_read",
              { path: "src/greet.js" },
            ]);
          case 2:
            return calls(res, [
              "read-2",
              "file_read",
              { path: "src/greet.js" },
            ]);
          case 3:
            return calls(res, [
              "patch",
              "file_patch",
              {
                path: "src/greet.js",
                expectedHash: JSON.parse(results[2].content).sha256 ?? "",
                oldText: '"Helo"',
                newText: '"Hello"',
              },
            ]);
          case 4:
            return calls(
              res,
              ["diff", "git", { args: ["diff", "--stat"] }],
              [
                "commit",
                "git",
                { args: ["commit", "-qam", "Fix greeting typo"] },
              ],
            );
          case 6:
            return calls(res, [
              "log",
              "git",
              { args: ["log", "--oneline", "-1"] },
            ]);
          default:
            return reply(res, { content: "Committed the fix." }, "stop");
        }
      },
    );
    const { workspace } = env;
    mkdirSync(join(workspace, "src"));
    writeFileSync(
      join(workspace, "AGENTS.md"),
      "Root rule: keep commits small.\n",
    );
    writeFileSync(
      join(workspace, "src/AGENTS.md"),
      "Source rule: use double quotes.\n",
    );
    writeFileSync(
      join(workspace, "src/greet.js"),
      'export const greet = () => "Helo";\n',
    );
    git(workspace, "init", "-q");
    // A disposable repository gets a fixed identity and settings so commits are deterministic.
    git(workspace, "config", "user.email", "rivet@example.invalid");
    git(workspace, "config", "user.name", "Rivet Test");
    git(workspace, "config", "commit.gpgsign", "false");
    git(workspace, "config", "core.autocrlf", "false");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "initial");

    const result = await env.start([
      "run",
      "--json",
      "Fix the greeting typo and commit it",
    ]).done;
    assert.equal(result.code, 0, result.stderr);
    const ends = events(result).filter((event) => event.type === "tool.end");
    assert.deepEqual(
      ends.map((event) => event.id),
      ["search", "read-1", "read-2", "patch", "diff", "commit", "log"],
    );
    assert.ok(
      ends.every((event) => !event.error),
      JSON.stringify(ends),
    );
    const deferred = JSON.parse(ends[1].result);
    assert.equal(deferred.deferred, true);
    assert.match(deferred.instructions, /Source rule/);
    assert.match(JSON.parse(ends[2].result).contents, /"Helo"/);
    const system = env.chats[0].messages[0];
    assert.equal(system.role, "system");
    assert.match(system.content, /Root rule/);
    assert.ok(!system.content.includes("Source rule"));
    assert.match(JSON.parse(ends[4].result).output, /1 file changed/);
    assert.match(JSON.parse(ends[6].result).output, /Fix greeting typo/);
    assert.equal(
      readFileSync(join(workspace, "src/greet.js"), "utf8"),
      'export const greet = () => "Hello";\n',
    );
    assert.equal(
      git(workspace, "log", "-1", "--format=%s"),
      "Fix greeting typo",
    );
    assert.equal(git(workspace, "status", "--porcelain"), "");

    const store = new Store(join(env.state, "sessions.sqlite"));
    const session = store.list()[0];
    assert.deepEqual(store.pending(session.id), []);
    assert.equal(store.actions(session.id).length, 7);
    store.close();

    const resumed = await env.start(["resume", session.id, "--json"], {
      input: "Show the last commit\n/exit\n",
    }).done;
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(events(resumed).at(-1).type, "done");
    const history = env.chats.at(-1).messages;
    assert.ok(
      history.some((m) => m.role === "tool" && m.tool_call_id === "commit"),
    );
    assert.match(history.at(-1).content, /Fix greeting typo/);
    assert.equal(git(workspace, "rev-list", "--count", "HEAD"), "2");
    assert.deepEqual(env.rejected, []);

    const target = join(env.root, "workflow.md");
    const exported = await env.start([
      "export",
      session.id,
      target,
      "--markdown",
    ]).done;
    assert.equal(exported.code, 0, exported.stderr);
    const markdown = readFileSync(target, "utf8");
    assert.match(markdown, /Fix greeting typo/);
    assert.ok(!markdown.includes(key));
  },
);

test(
  "/details shows full tool results and /settings the effective configuration, never the key",
  { timeout: 20000 },
  async (t) => {
    const env = await scripted(
      t,
      { policy: { file_read: "allow", command: "allow" } },
      (_req, res, message) => {
        const { results } = turnOf(message);
        if (results.length)
          return reply(res, { content: "Read both." }, "stop");
        calls(
          res,
          ["read", "file_read", { path: "notes.txt" }],
          [
            "print",
            "command",
            {
              command: process.execPath,
              args: [
                "-e",
                "for (let i = 1; i <= 60; i++) console.log('row ' + i)",
              ],
            },
          ],
        );
      },
    );
    writeFileSync(
      join(env.workspace, "notes.txt"),
      "first line\nsecond \x1b[31mred\x1b[0m line\n",
    );
    const session = await env.start([], {
      input:
        "Read the notes and print rows\n/details 2\n/settings\n/details x\n/exit\n",
    }).done;
    assert.equal(session.code, 0, session.stderr);
    const out = session.stdout;
    assert.match(out, /^tool call 1 of 2: file_read \(id read\) · completed$/m);
    assert.match(out, /^ {4}contents: 2 lines, ending with a newline$/m);
    assert.match(out, /^ {6}\| second <U\+001B>\[31mred<U\+001B>\[0m line$/m);
    assert.match(out, /^tool call 2 of 2: command \(id print\) · completed$/m);
    assert.match(out, /^ {6}\| row 1$/m);
    assert.match(out, /^ {6}\| row 60$/m);
    assert.match(
      out,
      /^ {2}destination: http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/m,
    );
    assert.match(
      out,
      /^ {2}credential: environment variable RIVET_API_KEY \(set\)$/m,
    );
    assert.match(out, /^ {2}mode: custom /m);
    assert.match(out, /^ {4}command: allow\n {4}file_read: allow$/m);
    // The workspace is shown by real path, which may differ from tmpdir() in 8.3 aliases.
    assert.match(out, /^ {2}workspace: .*[\\/]workspace$/m);
    assert.match(out, /^ {2}session store: .*sessions\.sqlite$/m);
    assert.match(out, /error: Usage: \/details \[count\]/);
    assert.ok(!out.includes(key));
    assert.ok(!out.includes("\x1b[31m"));

    const store = new Store(join(env.state, "sessions.sqlite"));
    const id = store.list()[0].id;
    store.close();
    const json = await env.start(["resume", id, "--json"], {
      input: "/settings\n/details\n/exit\n",
    }).done;
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stdout, "");
    assert.match(json.stderr, /settings for this session/);
    assert.match(json.stderr, /tool call 2 of 2: command \(id print\)/);
    assert.ok(!json.stderr.includes(key));
  },
);

test(
  "a crash during a command leaves it pending; resume never replays it and refuses to continue until reconciled",
  { timeout: 30000 },
  async (t) => {
    let started = 0;
    let release;
    let markStarted;
    const commandStarted = new Promise((resolve) => {
      markStarted = resolve;
    });
    const env = await scripted(
      t,
      { policy: { command: "allow", git: "allow" } },
      (_req, res, message) => {
        if (!message) {
          started++;
          release = () => res.end("released");
          markStarted();
          return;
        }
        const { prompt, results } = turnOf(message);
        if (prompt === "Run the slow check" && !results.length)
          return calls(
            res,
            [
              "slow",
              "command",
              {
                command: process.execPath,
                args: [
                  "-e",
                  `fetch(${JSON.stringify(`${env.base}/started`)}).then((r) => r.text()).then(() => process.exit(0))`,
                ],
              },
            ],
            ["after", "git", { args: ["status", "--short"] }],
          );
        reply(
          res,
          { content: "Recovered without replaying the check." },
          "stop",
        );
      },
    );
    const run = env.start(["run", "--json", "Run the slow check"]);
    await commandStarted;
    const exited = once(run.child, "exit");
    run.child.kill("SIGKILL");
    await exited;
    // The orphaned command waits on this response; releasing it lets that process exit.
    release();
    await run.done;

    let store = new Store(join(env.state, "sessions.sqlite"));
    const session = store.list()[0];
    assert.deepEqual(
      store.pending(session.id).map((action) => action.call.id),
      ["slow"],
    );
    assert.ok(!store.messages(session.id).some((m) => m.role === "tool"));
    store.close();

    const blocked = await env.start(["resume", session.id, "--json"], {
      input: "Continue\n/exit\n",
    }).done;
    assert.equal(blocked.code, 2, blocked.stderr);
    assert.match(
      blocked.stderr,
      /pending action slow \(command\) requires reconciliation/,
    );
    assert.match(
      events(blocked).find((event) => event.type === "error").message,
      /1 unfinished tool call/,
    );
    assert.equal(env.chats.length, 1);
    assert.equal(started, 1);

    store = new Store(join(env.state, "sessions.sqlite"));
    assert.match(
      store.messages(session.id).find((m) => m.callId === "after").content,
      /Not executed/,
    );
    assert.deepEqual(
      store.pending(session.id).map((action) => action.call.id),
      ["slow"],
    );
    // Stands in for the user's answer at the interactive terminal prompt.
    assert.equal(
      await reconcileSession(store, session.id, async () => true),
      0,
    );
    store.close();

    const resumed = await env.start(["resume", session.id, "--json"], {
      input: "Continue\n/exit\n",
    }).done;
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(env.chats.length, 2);
    assert.deepEqual(env.rejected, []);
    assert.match(
      env.chats[1].messages.find((m) => m.tool_call_id === "slow").content,
      /outcome is unknown/,
    );
    assert.equal(started, 1);
  },
);
