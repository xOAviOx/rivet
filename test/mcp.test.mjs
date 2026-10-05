import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connectMcp, connectAll } from "../dist/mcp.js";

const signal = () => new AbortController().signal;
const fixture = fileURLToPath(
  new URL("./fixtures/mcp-server.mjs", import.meta.url),
);
const stdio = (mode = "normal") => ({
  name: "local",
  transport: "stdio",
  command: process.execPath,
  args: [fixture, mode],
  trusted: true,
});
const tool = (name = "echo") => ({
  name,
  inputSchema: { type: "object", properties: {} },
});
const init = {
  protocolVersion: "2025-06-18",
  serverInfo: { name: "fixture", version: "1" },
  capabilities: { tools: {} },
};
const json = (res, id, result) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
async function http(t, handler = () => false) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const data of req) body += data;
      const message = body ? JSON.parse(body) : {};
      requests.push({ method: req.method, headers: req.headers, message });
      if (await handler(req, res, message)) return;
      if (
        req.method === "DELETE" ||
        message.id === undefined ||
        !message.method
      ) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === "initialize") {
        res.setHeader("mcp-session-id", "fixture-session");
        return json(res, message.id, init);
      }
      if (message.method === "tools/list")
        return json(res, message.id, { tools: [tool()] });
      json(res, message.id, { content: [{ type: "text", text: "hello" }] });
    } catch (error) {
      res.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    requests,
    config: {
      name: "remote",
      transport: "http",
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      trusted: true,
    },
  };
}
async function connect(t, config, options = {}) {
  const events = [];
  const client = await connectMcp(config, signal(), (e) => events.push(e), {
    timeoutMs: 2000,
    ...options,
  });
  t.after(() => client.close());
  return { client, events };
}

test("untrusted servers and missing credentials fail before connecting", async () => {
  await assert.rejects(
    connectMcp({ ...stdio(), trusted: false }, signal(), () => {}),
    (e) => e.exitCode === 3,
  );
  await assert.rejects(
    connectMcp(
      { ...stdio(), keyEnv: "RIVET_MCP_MISSING_TEST_KEY" },
      signal(),
      () => {},
    ),
    /Set RIVET_MCP_MISSING_TEST_KEY/,
  );
});

test("stdio initializes, maps names, isolates credentials, and shuts down", async (t) => {
  const selected = "mcp-test-credential";
  process.env.RIVET_MCP_TEST_KEY = selected;
  process.env.RIVET_PROVIDER_TEST_KEY = "provider-private-value";
  t.after(() => {
    delete process.env.RIVET_MCP_TEST_KEY;
    delete process.env.RIVET_PROVIDER_TEST_KEY;
  });
  const { client, events } = await connect(t, {
    ...stdio(),
    keyEnv: "RIVET_MCP_TEST_KEY",
  });
  assert.equal(client.tools[0].name, "mcp_local_echo_value");
  const result = JSON.parse(
    await client.call(client.tools[0].name, { query: "你好" }, signal()),
  );
  assert.equal(result.name, "echo.value");
  assert.deepEqual(result.args, { query: "你好" });
  assert.equal(result.selected, "[REDACTED]");
  assert.equal(result.leaked, undefined);
  assert.equal(result.cwd, process.cwd());
  assert.ok(!JSON.stringify(events).includes("private server diagnostic"));
  await assert.rejects(
    client.call("mcp_local_fail", {}, signal()),
    /tool rejected input/,
  );
  assert.equal(
    await client.call("mcp_local_structured", {}, signal()),
    '{"count":7}',
  );
  await assert.rejects(
    client.call("unknown", {}, signal()),
    /Unknown MCP tool/,
  );
  await assert.rejects(
    client.call(client.tools[0].name, { x: "a".repeat(65536) }, signal()),
    /64 KiB/,
  );
  await client.close();
  assert.throws(() => process.kill(result.pid, 0));
  await assert.rejects(
    client.call(client.tools[0].name, {}, signal()),
    /closed/,
  );
});

test("stdio spawn, malformed, oversized, version, and unexpected-exit failures settle", async (t) => {
  await assert.rejects(
    connectMcp(
      { ...stdio(), command: "rivet-missing-executable-9823" },
      signal(),
      () => {},
      { timeoutMs: 2000 },
    ),
    /cannot start/,
  );
  for (const [mode, pattern] of [
    ["malformed", /malformed JSON/],
    ["utf8", /invalid UTF-8/],
    ["oversized", /exceeds/],
    ["version", /unsupported protocol/],
  ])
    await assert.rejects(
      connectMcp(stdio(mode), signal(), () => {}, { timeoutMs: 2000 }),
      pattern,
    );
  const { client } = await connect(t, stdio("exit"));
  await assert.rejects(
    client.call(client.tools[0].name, {}, signal()),
    /server exited/,
  );
});

test("stdio initialization has a deadline and honors pre-cancellation", async () => {
  await assert.rejects(
    connectMcp(stdio("hang"), signal(), () => {}, { timeoutMs: 150 }),
    /timed out/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(connectMcp(stdio(), controller.signal, () => {}));
});

test("HTTP JSON carries session, negotiated version, and explicit credentials through shutdown", async (t) => {
  process.env.RIVET_MCP_TEST_KEY = "http-test-key";
  t.after(() => delete process.env.RIVET_MCP_TEST_KEY);
  const env = await http(t);
  const { client } = await connect(t, {
    ...env.config,
    keyEnv: "RIVET_MCP_TEST_KEY",
  });
  assert.equal(await client.call("mcp_remote_echo", {}, signal()), "hello");
  await client.close();
  assert.deepEqual(
    env.requests.map((r) => r.message.method ?? r.method),
    [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "DELETE",
    ],
  );
  for (const request of env.requests)
    assert.equal(request.headers.authorization, "Bearer http-test-key");
  for (const request of env.requests.slice(1)) {
    assert.equal(request.headers["mcp-session-id"], "fixture-session");
    assert.equal(request.headers["mcp-protocol-version"], "2025-06-18");
  }
  assert.equal(
    env.requests[0].headers.accept,
    "application/json, text/event-stream",
  );
});

test("HTTP SSE handles notifications and ping, refuses server requests, and stops after its response", async (t) => {
  const env = await http(t, (_req, res, message) => {
    if (message.method !== "tools/call") return false;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [
      { jsonrpc: "2.0", method: "notifications/progress", params: {} },
      { jsonrpc: "2.0", id: "ping-id", method: "ping" },
      {
        jsonrpc: "2.0",
        id: "sampling-id",
        method: "sampling/createMessage",
        params: {},
      },
    ])
      res.write(`data: ${JSON.stringify(item)}\r\n\r\n`);
    // Let the two server requests complete before returning the original result.
    const timer = setTimeout(
      () =>
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "streamed ✓" }] } })}\n\n`,
        ),
      50,
    );
    res.on("close", () => clearTimeout(timer));
    return true;
  });
  const { client } = await connect(t, env.config);
  assert.equal(
    await client.call("mcp_remote_echo", {}, signal()),
    "streamed ✓",
  );
  assert.deepEqual(
    env.requests.find((r) => r.message.id === "ping-id").message.result,
    {},
  );
  assert.equal(
    env.requests.find((r) => r.message.id === "sampling-id").message.error.code,
    -32601,
  );
});

test("HTTP refuses redirects and never retries failed calls", async (t) => {
  const env = await http(t, (_req, res, message) => {
    if (message.method !== "tools/call") return false;
    res.writeHead(503);
    res.end("private remote error");
    return true;
  });
  const { client } = await connect(t, env.config);
  await assert.rejects(
    client.call("mcp_remote_echo", {}, signal()),
    /HTTP 503/,
  );
  assert.equal(
    env.requests.filter((r) => r.message.method === "tools/call").length,
    1,
  );
  const redirect = await http(t, (_req, res) => {
    res.writeHead(307, { location: env.config.url });
    res.end();
    return true;
  });
  const before = env.requests.length;
  await assert.rejects(
    connectMcp(redirect.config, signal(), () => {}),
    /request failed/,
  );
  assert.equal(env.requests.length, before);
});

test("HTTP rejects malformed, mismatched, oversized, and incomplete replies", async (t) => {
  for (const mode of [
    "malformed",
    "mismatch",
    "oversized",
    "incomplete",
    "batch",
    "content-type",
  ]) {
    const env = await http(t, (_req, res, message) => {
      if (message.method !== "tools/call") return false;
      if (mode === "incomplete") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("event: message\n\n");
      } else if (mode === "mismatch") json(res, -1, {});
      else {
        res.writeHead(200, {
          "content-type":
            mode === "content-type" ? "text/plain" : "application/json",
        });
        res.end(
          mode === "oversized"
            ? "x".repeat(1024 * 1024 + 1)
            : mode === "batch"
              ? "[]"
              : "not-json",
        );
      }
      return true;
    });
    const { client } = await connect(t, env.config);
    await assert.rejects(
      client.call("mcp_remote_echo", {}, signal()),
      /malformed|does not match|exceeds|ended before|batch|content type/,
    );
    await client.close();
  }
});

test("HTTP deadlines and cancellation abort in-flight requests without replay", async (t) => {
  const env = await http(
    t,
    (_req, _res, message) => message.method === "tools/call",
  );
  const { client } = await connect(t, env.config, { timeoutMs: 150 });
  await assert.rejects(
    client.call("mcp_remote_echo", {}, signal()),
    /timed out/,
  );
  const controller = new AbortController();
  const pending = client.call("mcp_remote_echo", {}, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (e) => e.exitCode === 130);
  assert.equal(
    env.requests.filter((r) => r.message.method === "tools/call").length,
    2,
  );
});

test("discovery bounds tools, skips colliding names, and rejects looping pagination", async (t) => {
  const env = await http(t, (_req, res, message) => {
    if (message.method !== "tools/list") return false;
    json(res, message.id, {
      tools: [
        tool("same.name"),
        tool("same_name"),
        { name: "bad", inputSchema: { type: "string" } },
        ...Array.from({ length: 80 }, (_, i) => tool(`tool${i}`)),
      ],
    });
    return true;
  });
  const { client, events } = await connect(t, env.config);
  assert.equal(client.tools.length, 64);
  assert.equal(new Set(client.tools.map((tool) => tool.name)).size, 64);
  assert.ok(events.some((event) => event.message.includes("collision")));
  const looping = await http(t, (_req, res, message) => {
    if (message.method !== "tools/list") return false;
    json(res, message.id, { tools: [], nextCursor: "same" });
    return true;
  });
  await assert.rejects(
    connectMcp(looping.config, signal(), () => {}),
    /repeated pagination cursor/,
  );
});

test("tool output is sanitized and byte bounded", async (t) => {
  const env = await http(t, (_req, res, message) => {
    if (message.method !== "tools/call") return false;
    json(res, message.id, {
      content: [{ type: "text", text: "\u001b[31m" + "你好".repeat(1000) }],
    });
    return true;
  });
  const { client } = await connect(t, env.config, { outputBytes: 80 });
  const text = await client.call("mcp_remote_echo", {}, signal());
  assert.ok(Buffer.byteLength(text) <= 80);
  assert.ok(!text.includes("\u001b") && !text.includes("\ufffd"));
  assert.match(text, /truncated/);
});

test("connecting a set fails closed and closes previous servers", async (t) => {
  const env = await http(t);
  await assert.rejects(
    connectAll(
      [env.config, { ...stdio(), trusted: false }],
      signal(),
      () => {},
    ),
    (e) => e.exitCode === 3,
  );
  assert.equal(env.requests.at(-1).method, "DELETE");
});

test("names that collide across servers fail instead of changing tool ownership", async (t) => {
  const first = await http(t, (_req, res, message) => {
    if (message.method !== "tools/list") return false;
    json(res, message.id, { tools: [tool("b_echo")] });
    return true;
  });
  const second = await http(t);
  await assert.rejects(
    connectAll(
      [
        { ...first.config, name: "a" },
        { ...second.config, name: "a_b" },
      ],
      signal(),
      () => {},
    ),
    /name collision/,
  );
  assert.equal(first.requests.at(-1).method, "DELETE");
  assert.equal(second.requests.at(-1).method, "DELETE");
});

test("known credentials are removed before output truncation can expose a prefix", async (t) => {
  const secret = "private-session-key-value-that-crosses-the-output-boundary";
  const env = await http(t, (_req, res, message) => {
    if (message.method !== "tools/call") return false;
    json(res, message.id, {
      content: [
        { type: "text", text: "x".repeat(30) + secret + "z".repeat(100) },
      ],
    });
    return true;
  });
  const { client } = await connect(t, env.config, {
    outputBytes: 64,
    secrets: [secret],
  });
  const result = await client.call("mcp_remote_echo", {}, signal());
  assert.ok(!result.includes("private"));
  assert.ok(Buffer.byteLength(result) <= 64);
});

test("closing a client rejects outstanding HTTP calls and terminates the session", async (t) => {
  let received;
  const started = new Promise((resolve) => {
    received = resolve;
  });
  const env = await http(t, (_req, _res, message) => {
    if (message.method !== "tools/call") return false;
    received();
    return true;
  });
  const { client } = await connect(t, env.config);
  const rejected = assert.rejects(
    client.call("mcp_remote_echo", {}, signal()),
    /closed/,
  );
  await started;
  await client.close();
  await rejected;
  assert.equal(env.requests.at(-1).method, "DELETE");
});
