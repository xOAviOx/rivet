import assert from "node:assert/strict";
import test from "node:test";
import { configSchema } from "../dist/config.js";
import { settingsReport, toolDetails, toolHistory } from "../dist/inspect.js";
import { hash } from "../dist/security.js";

const call = (id, name, args = {}) => ({ id, name, arguments: args });
const result = (callId, content, error = false) => ({
  role: "tool",
  callId,
  content: typeof content === "string" ? content : JSON.stringify(content),
  error,
});
const config = (overrides = {}) =>
  configSchema.parse({
    provider: "compatible",
    endpoint: "http://127.0.0.1:8080/v1",
    model: { id: "local-model", tools: true, context: 32768, maxOutput: 2048 },
    ...overrides,
  });
const info = {
  configFile: "/state/config.json",
  database: "/state/sessions.sqlite",
  session: "session-1",
  workspace: "/work",
  sessionKey: false,
};

test("toolHistory pairs results with their own batch even when call ids repeat", () => {
  const messages = [
    { role: "user", content: "one" },
    { role: "assistant", content: "", calls: [call("call_0", "file_read")] },
    result("call_0", { contents: "first" }),
    { role: "assistant", content: "done" },
    { role: "user", content: "two" },
    {
      role: "assistant",
      content: "",
      calls: [call("call_0", "git"), call("call_1", "command")],
    },
    result("call_0", { output: "second" }),
  ];
  const records = toolHistory(messages);
  assert.deepEqual(
    records.map((r) => [r.call.name, r.result?.content]),
    [
      ["file_read", '{"contents":"first"}'],
      ["git", '{"output":"second"}'],
      ["command", undefined],
    ],
  );
});

test("details show exact arguments and the complete result without truncation", () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join(
    "\r\n",
  );
  const messages = [
    { role: "user", content: "run it" },
    {
      role: "assistant",
      content: "",
      calls: [
        call("a", "file_list", { path: "." }),
        call("b", "command", {
          command: "node",
          args: ["-e", "print()"],
          cwd: "src",
        }),
      ],
    },
    result("a", { files: ["a.ts", "b.ts"], truncated: false }),
    result("b", { exitCode: 0, output: `${long}\r\n`, truncated: false }),
  ];
  const text = toolDetails(messages, 1);
  assert.match(text, /^tool call 2 of 2: command \(id b\) · completed$/m);
  assert.match(text, /^ {2}arguments:\n {4}command: "node"$/m);
  assert.match(text, /^ {4}args: 2 items\n {6}- "-e"\n {6}- "print\(\)"$/m);
  assert.match(
    text,
    /^ {4}output: 400 lines, ending with a newline, CRLF line endings$/m,
  );
  assert.match(text, /^ {6}\| line 1$/m);
  assert.match(text, /^ {6}\| line 400$/m);
  assert.ok(!text.includes("file_list"), "only the last call is shown");

  const both = toolDetails(messages, 5);
  assert.match(both, /^tool call 1 of 2: file_list/m);
  assert.match(both, /^ {4}files: 2 items\n {6}- "a\.ts"\n {6}- "b\.ts"$/m);
  assert.match(both, /\n\ntool call 2 of 2/);
});

test("details report failures, deferrals, plain-text results, and missing results", () => {
  const messages = [
    {
      role: "assistant",
      content: "",
      calls: [
        call("p", "file_patch", { path: "a.ts" }),
        call("d", "file_read", { path: "src/a.ts" }),
        call("m", "mcp_docs_lookup", {}),
        call("u", "command", { command: "slow" }),
      ],
    },
    result("p", { error: "Content hash does not match" }, true),
    result("d", { deferred: true, instructions: "Scope src:\nRule\n" }),
    result("m", "plain text\nfrom a server"),
  ];
  const text = toolDetails(messages, 4);
  assert.match(text, /file_patch \(id p\) · failed\n/);
  assert.match(text, /^ {4}error: "Content hash does not match"$/m);
  assert.match(
    text,
    /file_read \(id d\) · deferred: scoped instructions were returned and nothing ran/,
  );
  assert.match(text, /^ {4}instructions: 2 lines, ending with a newline$/m);
  assert.match(text, /^ {2}arguments: none$/m);
  assert.match(
    text,
    /^ {2}result: 2 lines\n {4}\| plain text\n {4}\| from a server$/m,
  );
  assert.match(
    text,
    /command \(id u\) · no result recorded \(interrupted; outcome unknown\)$/m,
  );
  assert.equal(
    toolDetails([{ role: "user", content: "hi" }], 1),
    "· no tool calls in this session",
  );
});

test("details make terminal controls visible and mask known secrets", (t) => {
  process.env.RIVET_INSPECT_TEST_TOKEN = "env-token-value-123";
  t.after(() => delete process.env.RIVET_INSPECT_TEST_TOKEN);
  const messages = [
    {
      role: "assistant",
      content: "",
      calls: [call("x", "command\u202e", { note: "session-key-abc \x1b[2J" })],
    },
    result("x", {
      output:
        "red \x1b[31mtext\x1b[0m\nkey env-token-value-123 sk-abcdefghijklmnop\n",
    }),
  ];
  const text = toolDetails(messages, 1, ["session-key-abc"]);
  assert.match(text, /command<U\+202E>/);
  assert.match(text, /note: "\[REDACTED\] \\u001b\[2J"/);
  assert.match(text, /\| red <U\+001B>\[31mtext<U\+001B>\[0m/);
  assert.match(text, /\| key \[REDACTED\] \[REDACTED\]/);
  assert.ok(
    !/session-key-abc|env-token-value|sk-abcdefghij|\x1b|\u202e/.test(text),
  );
});

test("settings describe the effective configuration without revealing keys", (t) => {
  const previous = process.env.RIVET_API_KEY;
  process.env.RIVET_API_KEY = "sk-settings-secret-value";
  t.after(() => {
    if (previous === undefined) delete process.env.RIVET_API_KEY;
    else process.env.RIVET_API_KEY = previous;
  });
  const text = settingsReport(
    config({
      mode: "custom",
      policy: { git: "ask", file_read: "allow" },
      limits: {
        steps: 12,
        tools: 40,
        tokens: 250000,
        timeoutMs: 60000,
        outputBytes: 65536,
      },
      mcp: [
        {
          name: "docs",
          transport: "http",
          url: "https://mcp.example/mcp",
          trusted: true,
          keyEnv: "DOCS_MCP_KEY",
        },
        {
          name: "local",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
      ],
    }),
    info,
  );
  for (const line of [
    "settings for this session (loaded from /state/config.json; /model and /key changes are not saved)",
    "  provider: compatible",
    "  destination: http://127.0.0.1:8080/v1/chat/completions",
    "  credential: environment variable RIVET_API_KEY (set)",
    "  model: local-model",
    "    context: 32,768 tokens",
    "    max output: 2,048 tokens per step",
    "    prices: not both set, so cost is not tracked",
    "  mode: custom (each tool follows its policy rule; tools without a rule, including reads, ask first)",
    "  policy:\n    file_read: allow\n    git: ask",
    "    steps: 12\n    tool calls: 40\n    tokens: 250,000\n    cost: none",
    "  request timeout: 60,000 ms (provider and MCP requests)",
    "  tool output: 65,536 bytes per result sent to the model",
    "    docs: http https://mcp.example/mcp · trusted · key DOCS_MCP_KEY (not set)",
    '    local: stdio ["node","server.js"] (host process, not sandboxed) · not trusted; turns stop until it is trusted or removed',
    "  workspace: /work\n  session: session-1\n  session store: /state/sessions.sqlite",
  ])
    assert.ok(
      text.includes(line),
      `missing ${JSON.stringify(line)} in\n${text}`,
    );
  assert.ok(!text.includes("sk-settings-secret-value"));
});

test("settings explain plan mode, OS credentials, session keys, and prices", () => {
  const os = config({
    credential: "os",
    policy: { command: "allow" },
    model: {
      id: "priced",
      tools: true,
      context: 8192,
      inputPrice: 2.5,
      outputPrice: 10,
    },
    limits: { cost: 0.5 },
  });
  const text = settingsReport(os, { ...info, sessionKey: true });
  assert.match(
    text,
    /credential: session key from \/key \(this process only, not saved\); configured source: OS credential store, service "rivet", account ([0-9a-f]{64})/,
  );
  assert.ok(text.includes(hash("http://127.0.0.1:8080/v1/chat/completions")));
  assert.match(text, /prices: \$2\.5 input, \$10 output per million tokens/);
  assert.match(text, /cost: \$0\.5/);
  assert.match(
    text,
    /mode: plan \(reads and read-only Git run without approval; edits, commands, other Git, and MCP tools are refused\)/,
  );
  assert.match(
    text,
    /policy \(used only in custom mode\):\n {4}command: allow/,
  );
  assert.match(text, /MCP servers: none/);
  const onePrice = settingsReport(
    config({ model: { id: "m", tools: true, context: 8192, inputPrice: 1 } }),
    info,
  );
  assert.match(
    onePrice,
    /prices: \$1 input per million tokens; not both set, so cost is not tracked/,
  );
});
