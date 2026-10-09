import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { configSchema } from "../dist/config.js";
import { createProvider, probe } from "../dist/providers.js";

const KEY = "sk-test-key-0123456789abcdef";
const model = { id: "test-model", tools: true, context: 8192, maxOutput: 512 };
const tools = [
  {
    name: "file_read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];
const live = () => new AbortController().signal;

async function fakeServer(t) {
  const requests = [];
  let handler = (_entry, res) => res.writeHead(500).end();
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      requests.push(entry);
      handler(entry, res, req);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    base,
    requests,
    on: (next) => (handler = next),
    config: (overrides = {}) =>
      configSchema.parse({
        provider: "compatible",
        endpoint: base,
        model,
        limits: { timeoutMs: 5000 },
        ...overrides,
      }),
    anthropic(t2, overrides = {}) {
      // Anthropic's destination is fixed; route it to the local server for parsing tests.
      const real = globalThis.fetch;
      globalThis.fetch = (url, init) =>
        real(
          String(url).replace(
            "https://api.anthropic.com/v1/messages",
            `${base}/messages`,
          ),
          init,
        );
      t2.after(() => (globalThis.fetch = real));
      return configSchema.parse({
        provider: "anthropic",
        model,
        limits: { timeoutMs: 5000 },
        ...overrides,
      });
    },
  };
}
function sse(
  res,
  events,
  { end = true, status = 200, type = "text/event-stream" } = {},
) {
  res.writeHead(status, { "content-type": type });
  for (const event of events)
    res.write(
      typeof event === "string"
        ? `data: ${event}\r\n\r\n`
        : `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
    );
  if (end) res.end();
}
const chunk = (delta, finish = null, extra = {}) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
const openaiToolStream = (name = "file_read", id = "call_1") => [
  chunk({ role: "assistant", content: "Hel" }),
  chunk({ content: "lo" }),
  chunk({
    tool_calls: [
      { index: 0, id, type: "function", function: { name, arguments: '{"pa' } },
    ],
  }),
  chunk({
    tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }],
  }),
  chunk({}, "tool_calls"),
  JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
  "[DONE]",
];
const collect = () => {
  const events = [];
  return { events, emit: (e) => events.push(e) };
};

test("credentials are validated before any request", (t) => {
  assert.throws(
    () => createProvider(configSchema.parse({ provider: "openai", model }), ""),
    (e) => e.exitCode === 2,
  );
  assert.throws(
    () =>
      createProvider(configSchema.parse({ provider: "openai", model }), "a\nb"),
    /valid provider credential/,
  );
  t.diagnostic("no network used");
});

test("OpenAI-compatible streams: text deltas, assembled tool calls, usage, request shape", async (t) => {
  const server = await fakeServer(t);
  server.on((_entry, res) => sse(res, openaiToolStream()));
  const provider = createProvider(server.config(), KEY);
  const { events, emit } = collect();
  const messages = [
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      content: "",
      calls: [{ id: "c0", name: "file_read", arguments: { path: "z" } }],
    },
    { role: "tool", content: "zzz", callId: "c0" },
  ];
  const result = await provider.step(
    "SYSTEM",
    messages,
    tools,
    4096,
    live(),
    emit,
  );
  assert.deepEqual(result.message, {
    role: "assistant",
    content: "Hello",
    calls: [{ id: "call_1", name: "file_read", arguments: { path: "a.txt" } }],
  });
  assert.deepEqual(result.usage, { input: 10, output: 5 });
  assert.deepEqual(
    events.filter((e) => e.type === "text").map((e) => e.text),
    ["Hel", "lo"],
  );
  const [request] = server.requests;
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.match(request.headers.accept, /text\/event-stream/);
  assert.equal(request.body.model, "test-model");
  assert.equal(request.body.stream, true);
  assert.equal(
    request.body.max_tokens,
    512,
    "output allowance is capped by the model",
  );
  assert.deepEqual(request.body.messages[0], {
    role: "system",
    content: "SYSTEM",
  });
  assert.deepEqual(request.body.messages[2].tool_calls[0], {
    id: "c0",
    type: "function",
    function: { name: "file_read", arguments: '{"path":"z"}' },
  });
  assert.deepEqual(request.body.messages[3], {
    role: "tool",
    tool_call_id: "c0",
    content: "zzz",
  });
  assert.deepEqual(request.body.tools[0], {
    type: "function",
    function: tools[0],
  });
});

test("OpenAI official endpoint uses max_completion_tokens", async (t) => {
  const server = await fakeServer(t);
  server.on((_entry, res) =>
    sse(res, [chunk({ content: "ok" }, "stop"), "[DONE]"]),
  );
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    real(String(url).replace("https://api.openai.com/v1", server.base), init);
  t.after(() => (globalThis.fetch = real));
  const provider = createProvider(
    configSchema.parse({ provider: "openai", model }),
    KEY,
  );
  const result = await provider.step(
    "s",
    [{ role: "user", content: "hi" }],
    [],
    100,
    live(),
    () => {},
  );
  assert.equal(result.message.content, "ok");
  assert.equal(server.requests[0].body.max_completion_tokens, 100);
  assert.equal(server.requests[0].body.max_tokens, undefined);
  assert.deepEqual(
    result.usage.estimated,
    true,
    "usage is marked estimated when the stream omits it",
  );
});

test("Anthropic streams: headers, merged roles, tool_use blocks, cache-aware usage", async (t) => {
  const server = await fakeServer(t);
  server.on((_entry, res) =>
    sse(res, [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
        },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index: 0 },
      },
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "file_read",
            input: {},
          },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"a.txt"}' },
        },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index: 1 },
      },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 7 },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]),
  );
  const provider = createProvider(server.anthropic(t), KEY);
  const messages = [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "",
      calls: [{ id: "c1", name: "file_read", arguments: { path: "z" } }],
    },
    { role: "tool", content: "result", callId: "c1", error: true },
    { role: "user", content: "next" },
  ];
  const result = await provider.step(
    "SYS",
    messages,
    tools,
    4096,
    live(),
    () => {},
  );
  assert.deepEqual(result.message, {
    role: "assistant",
    content: "Hi",
    calls: [{ id: "toolu_1", name: "file_read", arguments: { path: "a.txt" } }],
  });
  assert.deepEqual(result.usage, { input: 15, output: 7 });
  const [request] = server.requests;
  assert.equal(request.url, "/v1/messages");
  assert.equal(request.headers["x-api-key"], KEY);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.body.system, "SYS");
  assert.equal(request.body.max_tokens, 512);
  assert.deepEqual(request.body.tools[0], {
    name: "file_read",
    description: "Read a file",
    input_schema: tools[0].parameters,
  });
  assert.deepEqual(
    request.body.messages.map((m) => m.role),
    ["user", "assistant", "user"],
    "consecutive same-role messages are merged",
  );
  assert.deepEqual(request.body.messages[2].content, [
    {
      type: "tool_result",
      tool_use_id: "c1",
      content: "result",
      is_error: true,
    },
    { type: "text", text: "next" },
  ]);
});

test("transient statuses are retried at most twice with status events; others fail at once", async (t) => {
  const server = await fakeServer(t);
  const statuses = [429, 503];
  server.on((_entry, res) => {
    const status = statuses.shift();
    if (status) {
      res.writeHead(status, { "retry-after": "0" });
      res.end("busy sk-leaked-secret-value-123456");
    } else sse(res, [chunk({ content: "ok" }, "stop"), "[DONE]"]);
  });
  const { events, emit } = collect();
  const provider = createProvider(server.config(), KEY);
  const result = await provider.step(
    "s",
    [{ role: "user", content: "hi" }],
    [],
    100,
    live(),
    emit,
  );
  assert.equal(result.message.content, "ok");
  assert.equal(server.requests.length, 3);
  assert.deepEqual(
    events.filter((e) => e.type === "status").map((e) => e.message),
    ["Provider busy; retrying (1/2)", "Provider busy; retrying (2/2)"],
  );

  server.requests.length = 0;
  server.on((_entry, res) => {
    res.writeHead(429, { "retry-after": "0" });
    res.end("sk-leaked-secret-value-123456");
  });
  await assert.rejects(
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      [],
      100,
      live(),
      () => {},
    ),
    (error) => {
      assert.equal(error.message, "Provider request failed (HTTP 429)");
      assert.ok(!error.message.includes("leaked"));
      return true;
    },
  );
  assert.equal(server.requests.length, 3, "bounded retries");

  server.requests.length = 0;
  server.on((_entry, res) => {
    res.writeHead(400);
    res.end('{"error":"bad sk-leaked-secret-value-123456"}');
  });
  await assert.rejects(
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      [],
      100,
      live(),
      () => {},
    ),
    /Provider request failed \(HTTP 400\)/,
  );
  assert.equal(server.requests.length, 1, "client errors are not retried");
});

test("redirects are never followed", async (t) => {
  const server = await fakeServer(t);
  server.on((entry, res) => {
    if (entry.url.endsWith("/elsewhere"))
      return sse(res, [chunk({ content: "x" }, "stop"), "[DONE]"]);
    res.writeHead(302, { location: `${server.base}/elsewhere` });
    res.end();
  });
  const provider = createProvider(server.config(), KEY);
  await assert.rejects(
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      [],
      100,
      live(),
      () => {},
    ),
    /Provider connection failed/,
  );
  assert.ok(!server.requests.some((r) => r.url.endsWith("/elsewhere")));
});

test("malformed and incomplete streams are rejected with specific reasons", async (t) => {
  const server = await fakeServer(t);
  const provider = createProvider(server.config(), KEY);
  const step = () =>
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      tools,
      100,
      live(),
      () => {},
    );
  const cases = [
    [[chunk({ content: "ok" }, "stop")], /stream ended before completion/],
    [["{not json", "[DONE]"], /malformed JSON/],
    [[JSON.stringify([1, 2]), "[DONE]"], /Invalid provider response/],
    [
      [chunk({ content: "ok" }, "length"), "[DONE]"],
      /interrupted or reached its output limit/,
    ],
    [[chunk({ content: "ok" }), "[DONE]"], /stream ended before completion/],
    [[JSON.stringify({ error: { message: "boom" } })], /stream error/],
    [
      [JSON.stringify({ choices: [{ index: 1, delta: { content: "x" } }] })],
      /unexpected choice index/,
    ],
    [openaiToolStream("unknown_tool"), /unknown tool or duplicate call ID/],
    [[...openaiToolStream().slice(0, 2), chunk({}, "stop"), "[DONE]"], null],
    [
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "c",
              function: { name: "file_read", arguments: "{}" },
            },
          ],
        }),
        chunk({}, "stop"),
        "[DONE]",
      ],
      /tool calls without tool completion/,
    ],
    [
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "c",
              function: { name: "file_read", arguments: "{oops" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ],
      /malformed JSON/,
    ],
  ];
  for (const [events, expected] of cases) {
    server.on((_entry, res) => sse(res, events));
    if (expected)
      await assert.rejects(
        step(),
        expected,
        JSON.stringify(events).slice(0, 80),
      );
    else assert.equal((await step()).message.content, "Hello");
  }
  server.on((_entry, res) =>
    sse(res, [chunk({ content: "ok" }, "stop"), "[DONE]"], {
      type: "application/json",
    }),
  );
  await assert.rejects(step(), /expected an event stream/);
  server.on((_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + chunk({ content: "ok" }, "stop") + "\n");
  });
  await assert.rejects(step(), /incomplete event/);
});

test("duplicate tool call ids and tool-call counts beyond the limit are rejected", async (t) => {
  const server = await fakeServer(t);
  const call = (index, id) =>
    chunk({
      tool_calls: [
        {
          index,
          id,
          type: "function",
          function: { name: "file_read", arguments: '{"path":"x"}' },
        },
      ],
    });
  server.on((_entry, res) =>
    sse(res, [
      call(0, "dup"),
      call(1, "dup"),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]),
  );
  const provider = createProvider(server.config(), KEY);
  await assert.rejects(
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      tools,
      100,
      live(),
      () => {},
    ),
    /unknown tool or duplicate call ID/,
  );
  server.on((_entry, res) =>
    sse(res, [call(0, "a"), call(1, "b"), chunk({}, "tool_calls"), "[DONE]"]),
  );
  const limited = createProvider(
    server.config({ limits: { tools: 1, timeoutMs: 5000 } }),
    KEY,
  );
  await assert.rejects(
    limited.step(
      "s",
      [{ role: "user", content: "hi" }],
      tools,
      100,
      live(),
      () => {},
    ),
    /too many tool calls/,
  );
});

test("oversized text and oversized tool arguments are bounded", async (t) => {
  const server = await fakeServer(t);
  server.on((_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const piece = chunk({ content: "x".repeat(4000) });
    for (let i = 0; i < 300; i++) res.write(`data: ${piece}\n\n`);
    res.write(`data: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  const provider = createProvider(server.config(), KEY);
  await assert.rejects(
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      [],
      100,
      live(),
      () => {},
    ),
    /text exceeds 1 MiB/,
  );
  server.requests.length = 0;
  await assert.rejects(
    provider.step(
      "s",
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          calls: [
            {
              id: "c",
              name: "file_read",
              arguments: { path: "y".repeat(70000) },
            },
          ],
        },
        { role: "tool", content: "r", callId: "c" },
      ],
      tools,
      100,
      live(),
      () => {},
    ),
    /Tool arguments exceed 64 KiB/,
  );
  assert.equal(server.requests.length, 0, "rejected before any request");
  await assert.rejects(
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      [],
      0,
      live(),
      () => {},
    ),
    /allowance must be positive/,
  );
});

test("tool results in the transcript are truncated to the configured output bound", async (t) => {
  const server = await fakeServer(t);
  server.on((_entry, res) =>
    sse(res, [chunk({ content: "ok" }, "stop"), "[DONE]"]),
  );
  const provider = createProvider(
    server.config({ limits: { outputBytes: 1024, timeoutMs: 5000 } }),
    KEY,
  );
  await provider.step(
    "s",
    [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        calls: [{ id: "c", name: "file_read", arguments: {} }],
      },
      { role: "tool", content: "r".repeat(5000), callId: "c" },
    ],
    tools,
    100,
    live(),
    () => {},
  );
  const sent = server.requests[0].body.messages.find(
    (m) => m.role === "tool",
  ).content;
  assert.ok(Buffer.byteLength(sent) <= 1024);
  assert.match(sent, /\[Tool result truncated\]$/);
});

test("cancellation mid-stream rejects with exit code 130 and closes the connection", async (t) => {
  const server = await fakeServer(t);
  let closed = false;
  server.on((_entry, res, req) => {
    req.on("close", () => (closed = true));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${chunk({ content: "partial" })}\n\n`);
  });
  const controller = new AbortController();
  const provider = createProvider(server.config(), KEY);
  const pending = provider.step(
    "s",
    [{ role: "user", content: "hi" }],
    [],
    100,
    controller.signal,
    (e) => {
      if (e.type === "text") controller.abort();
    },
  );
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "Provider request cancelled");
    assert.equal(error.exitCode, 130);
    return true;
  });
  for (let i = 0; i < 50 && !closed; i++) await delay(20);
  assert.equal(closed, true);
});

test("a stalled provider times out without retrying", async (t) => {
  const server = await fakeServer(t);
  server.on((_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${chunk({ content: "slow" })}\n\n`);
  });
  const provider = createProvider(
    server.config({ limits: { timeoutMs: 300 } }),
    KEY,
  );
  const started = Date.now();
  await assert.rejects(
    provider.step(
      "s",
      [{ role: "user", content: "hi" }],
      [],
      100,
      live(),
      () => {},
    ),
    /Provider request timed out/,
  );
  assert.ok(Date.now() - started < 3000);
  assert.equal(server.requests.length, 1);
});

test("probe accepts only a correct tool call and otherwise leaves configuration unchanged", async (t) => {
  const server = await fakeServer(t);
  const provider = createProvider(server.config(), KEY);
  server.on((_entry, res) =>
    sse(res, [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "p1",
            type: "function",
            function: {
              name: "rivet_capability_check",
              arguments: '{"word":"ready"}',
            },
          },
        ],
      }),
      chunk({}, "tool_calls"),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      "[DONE]",
    ]),
  );
  assert.deepEqual(await probe(provider, live()), { input: 3, output: 2 });
  assert.equal(
    server.requests[0].body.tools[0].function.name,
    "rivet_capability_check",
  );
  server.on((_entry, res) =>
    sse(res, [chunk({ content: "I cannot call tools" }, "stop"), "[DONE]"]),
  );
  await assert.rejects(probe(provider, live()), (error) => {
    assert.match(error.message, /did not pass the tool-calling check/);
    assert.equal(error.exitCode, 2);
    return true;
  });
  server.on((_entry, res) =>
    sse(res, [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "p2",
            type: "function",
            function: {
              name: "rivet_capability_check",
              arguments: '{"word":"wrong"}',
            },
          },
        ],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]),
  );
  await assert.rejects(probe(provider, live()), /did not pass/);
});
