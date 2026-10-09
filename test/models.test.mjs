import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { configSchema } from "../dist/config.js";
import {
  changeModel,
  listModels,
  modelLines,
  modelsUrl,
  planModelChange,
  resolveModel,
} from "../dist/models.js";

const KEY = "sk-test-model-listing-key-1234567890";

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}/v1`;
}

const config = (overrides = {}) =>
  configSchema.parse({
    provider: "compatible",
    endpoint: "http://127.0.0.1:9/v1",
    model: { id: "small", tools: true, context: 8192, maxOutput: 1024 },
    ...overrides,
  });

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const rejectsWith = (promise, pattern, exitCode) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.name, "RivetError");
    assert.match(error.message, pattern);
    if (exitCode !== undefined) assert.equal(error.exitCode, exitCode);
    return true;
  });

const throwsWith = (fn, pattern, exitCode) =>
  assert.throws(fn, (error) => {
    assert.equal(error.name, "RivetError");
    assert.match(error.message, pattern);
    if (exitCode !== undefined) assert.equal(error.exitCode, exitCode);
    return true;
  });

test("model listing URLs use the official or explicitly configured destination", () => {
  assert.equal(
    modelsUrl(config({ provider: "openai", endpoint: undefined })),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    modelsUrl(config({ provider: "anthropic", endpoint: undefined })),
    "https://api.anthropic.com/v1/models?limit=1000",
  );
  assert.equal(
    modelsUrl(config({ endpoint: "https://llm.example.test/v1/" })),
    "https://llm.example.test/v1/models",
  );
});

test("listing parses reported limits, skips unsafe identifiers, and sorts", async (t) => {
  let request;
  const endpoint = await serve(t, (req, res) => {
    request = {
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
    };
    json(res, 200, {
      object: "list",
      data: [
        { id: "zeta", context_length: 131072, max_completion_tokens: 8192 },
        { id: "alpha", context_window: 32768 },
        { id: "alpha", context_window: 1 },
        { id: "vllm-model", max_model_len: 16384, max_tokens: 2048 },
        { id: "bad\u001b[31mred" },
        { id: "has space" },
        { id: 42 },
        { id: "huge", context_length: 1e12, max_output_tokens: -5 },
        "not-an-object",
      ],
    });
  });
  const listing = await listModels(
    config({ endpoint }),
    KEY,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(request, {
    method: "GET",
    url: "/v1/models",
    auth: `Bearer ${KEY}`,
  });
  assert.deepEqual(listing, {
    truncated: false,
    models: [
      { id: "alpha", context: 32768 },
      { id: "huge" },
      { id: "vllm-model", context: 16384, maxOutput: 2048 },
      { id: "zeta", context: 131072, maxOutput: 8192 },
    ],
  });
});

test("listing marks paged results as truncated", async (t) => {
  const endpoint = await serve(t, (_req, res) =>
    json(res, 200, { data: [{ id: "one" }], has_more: true }),
  );
  const listing = await listModels(
    config({ endpoint }),
    KEY,
    AbortSignal.timeout(5000),
  );
  assert.equal(listing.truncated, true);
  assert.deepEqual(modelLines(listing, "one"), [
    "one  context not reported  (current)",
    "List truncated; enter a model identifier directly",
  ]);
});

test("listing failures never echo remote bodies or credentials", async (t) => {
  const endpoint = await serve(t, (_req, res) =>
    json(res, 401, { error: { message: `bad key ${KEY}` } }),
  );
  await assert.rejects(
    listModels(config({ endpoint }), KEY, AbortSignal.timeout(5000)),
    (error) => {
      assert.equal(error.message, "Model listing failed (HTTP 401)");
      assert.ok(!error.message.includes(KEY));
      return true;
    },
  );
});

test("listing rejects redirects, non-JSON, malformed, and oversized bodies", async (t) => {
  const endpoint = await serve(t, (_req, res) => {
    res.writeHead(302, { location: "https://elsewhere.example.test/models" });
    res.end();
  });
  await rejectsWith(
    listModels(config({ endpoint }), KEY, AbortSignal.timeout(5000)),
    /Provider connection failed/,
  );

  let mode = "html";
  const second = await serve(t, (_req, res) => {
    if (mode === "html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    } else if (mode === "malformed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    } else if (mode === "shape") {
      json(res, 200, { models: [] });
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let i = 0; i < 5; i++) res.write(chunk);
      res.end("{}");
    }
  });
  const run = () =>
    listModels(config({ endpoint: second }), KEY, AbortSignal.timeout(5000));
  await rejectsWith(run(), /expected JSON/);
  mode = "malformed";
  await rejectsWith(run(), /malformed JSON/);
  mode = "shape";
  await rejectsWith(run(), /expected a data array/);
  mode = "oversized";
  await rejectsWith(run(), /exceeds 4 MiB/);
});

test("listing honours cancellation and rejects unusable keys", async (t) => {
  const endpoint = await serve(t, () => {});
  const controller = new AbortController();
  const pending = listModels(config({ endpoint }), KEY, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await rejectsWith(pending, /Model listing cancelled/, 130);
  await rejectsWith(
    listModels(config({ endpoint }), "a\nb", AbortSignal.timeout(5000)),
    /valid provider credential/,
    2,
  );
});

test("resolveModel uses reported limits and refuses to exceed them", () => {
  const listing = {
    truncated: false,
    models: [{ id: "big", context: 200000, maxOutput: 64000 }, { id: "bare" }],
  };
  assert.deepEqual(resolveModel("big", { listing }), {
    id: "big",
    tools: true,
    context: 200000,
    maxOutput: 50000,
  });
  assert.deepEqual(
    resolveModel("big", {
      listing,
      context: 100000,
      maxOutput: 8000,
      inputPrice: 3,
      outputPrice: 15,
    }),
    {
      id: "big",
      tools: true,
      context: 100000,
      maxOutput: 8000,
      inputPrice: 3,
      outputPrice: 15,
    },
  );
  throwsWith(
    () => resolveModel("big", { listing, context: 400000 }),
    /exceeds the reported 200000/,
    2,
  );
  throwsWith(
    () => resolveModel("big", { listing, maxOutput: 128000 }),
    /exceeds the reported 64000/,
    2,
  );
  throwsWith(
    () => resolveModel("bare", { listing }),
    /does not report a context window/,
    2,
  );
  assert.equal(
    resolveModel("bare", { listing, context: 16384 }).maxOutput,
    4096,
  );
  throwsWith(
    () => resolveModel("missing", { listing, context: 16384 }),
    /not offered by this endpoint/,
    2,
  );
  assert.equal(
    resolveModel("missing", {
      listing: { ...listing, truncated: true },
      context: 16384,
    }).id,
    "missing",
  );
  throwsWith(
    () => resolveModel("bad id", { context: 8192 }),
    /Invalid model identifier/,
    2,
  );
  throwsWith(
    () => resolveModel("tiny", { context: 2048 }),
    /Invalid model settings/,
    2,
  );
  throwsWith(
    () => resolveModel("eq", { context: 8192, maxOutput: 8192 }),
    /maxOutput must be smaller than context/,
    2,
  );
});

const turn = (text) => [
  { role: "user", content: text },
  { role: "assistant", content: "ok" },
];

test("planModelChange reports omitted turns without altering inputs", () => {
  const current = config({
    model: { id: "large", tools: true, context: 65536, maxOutput: 4096 },
  });
  const history = [
    ...turn("a".repeat(3000)),
    ...turn("b".repeat(3000)),
    ...turn("c".repeat(3000)),
  ];
  const snapshot = structuredClone({ current, history });
  const next = resolveModel("small", { context: 8192, maxOutput: 1024 });
  const plan = planModelChange(current, next, history, "system");
  assert.equal(plan.omitted, 1);
  assert.equal(plan.config.model.id, "small");
  assert.equal(plan.config.endpoint, current.endpoint);
  assert.deepEqual({ current, history }, snapshot);
  assert.equal(
    planModelChange(current, current.model, history, "system").omitted,
    0,
  );
});

test("planModelChange refuses unsafe switches", () => {
  const current = config();
  const small = resolveModel("small-2", { context: 4096, maxOutput: 1024 });
  throwsWith(
    () =>
      planModelChange(
        current,
        small,
        [
          { role: "user", content: "run" },
          {
            role: "assistant",
            content: "",
            calls: [{ id: "c1", name: "exec", arguments: {} }],
          },
        ],
        "",
      ),
    /reconcile 1 unfinished tool call/,
    2,
  );
  throwsWith(
    () => planModelChange(current, small, turn("x".repeat(5000)), ""),
    /current turn does not fit small-2/,
    4,
  );
  throwsWith(
    () => planModelChange(current, small, [], "s".repeat(2000)),
    /too little context for instructions/,
    4,
  );
  const limited = config({
    model: {
      id: "priced",
      tools: true,
      context: 8192,
      maxOutput: 1024,
      inputPrice: 1,
      outputPrice: 2,
    },
    limits: { cost: 1 },
  });
  throwsWith(
    () =>
      planModelChange(
        limited,
        resolveModel("unpriced", { context: 8192 }),
        [],
        "",
      ),
    /Model unchanged: Cost limits require both per-million-token prices/,
    2,
  );
  assert.equal(
    planModelChange(
      limited,
      resolveModel("priced-2", {
        context: 8192,
        inputPrice: 0.5,
        outputPrice: 1,
      }),
      [],
      "",
    ).config.model.inputPrice,
    0.5,
  );
});

const passingProvider = (seen) => ({
  async step(_system, _messages, tools, _max, _signal, _emit) {
    seen.push(tools.map((t) => t.name));
    return {
      message: {
        role: "assistant",
        content: "",
        calls: [
          {
            id: "p1",
            name: "rivet_capability_check",
            arguments: { word: "ready" },
          },
        ],
      },
      usage: { input: 12, output: 4 },
    };
  },
});

test("changeModel probes the new model before returning a new configuration", async () => {
  const current = config();
  const next = resolveModel("other", { context: 16384 });
  const connected = [];
  const seen = [];
  const result = await changeModel(current, next, {
    key: KEY,
    history: turn("hello"),
    system: "system",
    signal: AbortSignal.timeout(5000),
    connect: (c, key) => {
      connected.push([c.model.id, key]);
      return passingProvider(seen);
    },
  });
  assert.deepEqual(connected, [["other", KEY]]);
  assert.deepEqual(seen, [["rivet_capability_check"]]);
  assert.equal(result.config.model.id, "other");
  assert.deepEqual(result.usage, { input: 12, output: 4 });
  assert.equal(current.model.id, "small");

  const unchanged = await changeModel(
    current,
    { ...current.model, maxOutput: 512 },
    {
      key: KEY,
      history: [],
      system: "",
      signal: AbortSignal.timeout(5000),
      connect: () => assert.fail("same model must not be probed"),
    },
  );
  assert.equal(unchanged.usage, null);
  assert.equal(unchanged.config.model.maxOutput, 512);
});

test("changeModel leaves configuration unchanged when the probe fails", async () => {
  const current = config();
  const textOnly = {
    async step() {
      return {
        message: { role: "assistant", content: "I cannot call tools" },
        usage: { input: 5, output: 5 },
      };
    },
  };
  await rejectsWith(
    changeModel(current, resolveModel("text-only", { context: 8192 }), {
      key: KEY,
      history: [],
      system: "",
      signal: AbortSignal.timeout(5000),
      connect: () => textOnly,
    }),
    /did not pass the tool-calling check; configuration unchanged/,
    2,
  );
  assert.equal(current.model.id, "small");
});

test("changeModel probes through the real provider adapter over SSE", async (t) => {
  let body;
  const endpoint = await serve(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data) =>
      res.write(
        `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
      );
    send({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: {
                  name: "rivet_capability_check",
                  arguments: '{"word":"ready"}',
                },
              },
            ],
          },
        },
      ],
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } });
    send("[DONE]");
    res.end();
  });
  const result = await changeModel(
    config({ endpoint }),
    resolveModel("served-model", { context: 32768 }),
    {
      key: KEY,
      history: turn("hello"),
      system: "system",
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(body.model, "served-model");
  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    ["rivet_capability_check"],
  );
  assert.equal(result.config.model.id, "served-model");
  assert.deepEqual(result.usage, { input: 20, output: 6 });
});
