import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runSetup } from "../dist/setup.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const key = "setup-fixture-provider-credential";

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "rivet-setup-"));
  const previous = process.env.RIVET_HOME;
  process.env.RIVET_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.RIVET_HOME;
    else process.env.RIVET_HOME = previous;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return { dir, file: join(dir, "config.json") };
}

/** Answers are consumed in order; an exhausted script behaves like end of input. */
function scriptedIO(answers, secrets = []) {
  const asked = [];
  const printed = [];
  return {
    asked,
    printed,
    io: {
      ask: async (question) => {
        asked.push(question);
        return answers.length ? answers.shift() : null;
      },
      secret: async (label) => {
        asked.push(label);
        return secrets.length ? secrets.shift() : null;
      },
      print: (text) => printed.push(text),
    },
  };
}
const never = () => new AbortController().signal;

test("setup re-asks invalid answers, checks the model, and saves a key-free config once", async (t) => {
  const { file } = home(t);
  process.env.RIVET_SETUP_TEST_KEY = key;
  t.after(() => delete process.env.RIVET_SETUP_TEST_KEY);
  const { io, asked, printed } = scriptedIO([
    "gemini",
    "Compatible",
    "",
    "http://example.com/v1",
    "http://127.0.0.1:9/v1",
    "",
    "lower_case",
    "RIVET_SETUP_TEST_KEY",
    "has space",
    "local-coder",
    "1000",
    "32,768",
    "40000",
    "",
  ]);
  const checks = [];
  const config = await runSetup(io, {
    signal: never(),
    check: async (c, k) => checks.push([c.model.id, k]),
    storeKey: async () => assert.fail("environment keys are never stored"),
  });
  assert.deepEqual(checks, [["local-coder", key]]);
  assert.equal(asked.filter((q) => q.startsWith("Provider")).length, 2);
  assert.ok(
    asked.includes("Environment variable holding the key [RIVET_API_KEY]:"),
  );
  assert.ok(asked.includes("Max output tokens per step [4096]:"));
  for (const problem of [
    "  Choose one of: openai, anthropic, compatible",
    "  Enter the endpoint URL",
    "  Use HTTPS, or HTTP on loopback; credentials, query strings and fragments are forbidden",
    "  Use upper-case letters, digits, and underscores, not starting with a digit",
    "  Enter the model id: 1 to 200 characters without spaces",
    "  Enter a whole number of at least 4096",
    "  Enter a whole number from 1 to 32767 (below the context window)",
  ])
    assert.ok(printed.includes(problem), `missing ${problem}`);
  assert.ok(printed.includes("The model passed the tool-calling check."));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved, JSON.parse(JSON.stringify(config)));
  assert.equal(saved.endpoint, "http://127.0.0.1:9/v1");
  assert.equal(saved.keyEnv, "RIVET_SETUP_TEST_KEY");
  assert.equal(saved.credential, "environment");
  assert.equal(saved.mode, "plan");
  assert.deepEqual(saved.model, {
    id: "local-coder",
    tools: true,
    context: 32768,
    maxOutput: 4096,
  });
  assert.ok(!readFileSync(file, "utf8").includes(key));
});

test("setup with the OS store asks for a hidden key, checks it, then stores it", async (t) => {
  const { file } = home(t);
  const { io, asked, printed } = scriptedIO(
    ["anthropic", "os", "claude-test", "200000", "8192"],
    [key],
  );
  const order = [];
  await runSetup(io, {
    signal: never(),
    readKey: async () => undefined,
    check: async (_c, k) => order.push(["check", k]),
    storeKey: async (c, k) => order.push(["store", c.credential, k]),
  });
  assert.deepEqual(order, [
    ["check", key],
    ["store", "os", key],
  ]);
  assert.ok(
    asked.includes(
      "Key for https://api.anthropic.com/v1/messages (hidden; Enter skips)",
    ),
  );
  assert.ok(!asked.some((q) => q.startsWith("Environment variable")));
  assert.ok(printed.includes("Saved the key in the OS credential store."));
  const saved = readFileSync(file, "utf8");
  assert.ok(!saved.includes(key));
  assert.equal(JSON.parse(saved).credential, "os");
  assert.equal(JSON.parse(saved).keyEnv, undefined);
});

test("a store failure is reported and the config is still saved", async (t) => {
  const { file } = home(t);
  const { io, printed } = scriptedIO(
    ["openai", "os", "gpt-test", "128000", ""],
    [key],
  );
  await runSetup(io, {
    signal: never(),
    readKey: async () => undefined,
    check: async () => {},
    storeKey: async () => {
      throw new Error("Keychain is read-only from Rivet");
    },
  });
  assert.ok(
    printed.includes(
      "The key was not saved in the OS credential store: Keychain is read-only from Rivet",
    ),
  );
  assert.ok(existsSync(file));
});

test("a failed capability check saves nothing and never stores the key", async (t) => {
  const { file } = home(t);
  const { io } = scriptedIO(
    ["openai", "os", "gpt-unreachable", "128000", ""],
    [key],
  );
  await assert.rejects(
    runSetup(io, {
      signal: never(),
      readKey: async () => undefined,
      check: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      storeKey: async () => assert.fail("must not store after a failed check"),
    }),
    (error) =>
      error.message === "Nothing was saved: connect ECONNREFUSED" &&
      error.exitCode === 1,
  );
  assert.ok(!existsSync(file));
});

test("a missing key skips the check with guidance and still saves", async (t) => {
  const { file } = home(t);
  delete process.env.RIVET_SETUP_MISSING_KEY;
  const { io, printed } = scriptedIO([
    "openai",
    "environment",
    "RIVET_SETUP_MISSING_KEY",
    "gpt-test",
    "16384",
    "",
  ]);
  const config = await runSetup(io, {
    signal: never(),
    check: async () => assert.fail("no key, no check"),
  });
  assert.equal(config.model.maxOutput, 4096);
  assert.ok(
    printed.includes(
      "RIVET_SETUP_MISSING_KEY is not set, so the tool-calling check was skipped. Set it, then run rivet models check.",
    ),
  );
  assert.ok(existsSync(file));
});

test("setup refuses an existing config before asking and cancels cleanly", async (t) => {
  const { file } = home(t);
  writeFileSync(file, "{}\n");
  const existing = scriptedIO(["openai"]);
  await assert.rejects(
    runSetup(existing.io, { signal: never() }),
    (error) => /already exists/.test(error.message) && error.exitCode === 2,
  );
  assert.deepEqual(existing.asked, []);
  assert.equal(readFileSync(file, "utf8"), "{}\n");
  rmSync(file);

  const ended = scriptedIO(["openai", "environment"]);
  await assert.rejects(
    runSetup(ended.io, { signal: never() }),
    (error) =>
      /cancelled; nothing was saved/.test(error.message) &&
      error.exitCode === 130,
  );
  assert.ok(!existsSync(file));

  const controller = new AbortController();
  const aborted = scriptedIO([
    "openai",
    "environment",
    "",
    "gpt-test",
    "16384",
    "",
  ]);
  const ask = aborted.io.ask;
  aborted.io.ask = async (question) => {
    if (question.startsWith("Model id")) controller.abort();
    return ask(question);
  };
  await assert.rejects(
    runSetup(aborted.io, { signal: controller.signal }),
    (error) => error.exitCode === 130,
  );
  assert.ok(!existsSync(file));
});

/** A compatible endpoint that answers the capability probe with the expected tool call. */
async function probeServer(t, { pass = true } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const data of req) body += data;
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(body),
    });
    const delta = pass
      ? {
          tool_calls: [
            {
              index: 0,
              id: "probe",
              type: "function",
              function: {
                name: "rivet_capability_check",
                arguments: '{"word":"ready"}',
              },
            },
          ],
        }
      : { content: "I cannot call tools." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: pass ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

function runCli(state, input, env = {}) {
  const child = spawn(process.execPath, [cli, "setup"], {
    windowsHide: true,
    env: { ...process.env, RIVET_HOME: state, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function stateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "rivet-setup-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

test(
  "rivet setup reads piped answers, probes the endpoint, and writes the config",
  { timeout: 15000 },
  async (t) => {
    const server = await probeServer(t);
    const state = stateDir(t);
    const answers = [
      "compatible",
      `${server.base}/v1`,
      "",
      "",
      "fixture-model",
      "16384",
      "1024",
    ];
    const result = await runCli(state, `${answers.join("\n")}\n`, {
      RIVET_API_KEY: key,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, "/v1/chat/completions");
    assert.equal(server.requests[0].auth, `Bearer ${key}`);
    assert.equal(server.requests[0].body.model, "fixture-model");
    assert.equal(
      server.requests[0].body.tools[0].function.name,
      "rivet_capability_check",
    );
    assert.match(
      result.stdout,
      /^ {2}Provider \(openai, anthropic, compatible\): compatible$/m,
    );
    assert.match(result.stdout, /The model passed the tool-calling check\./);
    assert.match(result.stdout, /Saved .*config\.json\./);
    assert.ok(!result.stdout.includes(key));
    const text = readFileSync(join(state, "config.json"), "utf8");
    assert.ok(!text.includes(key));
    assert.deepEqual(JSON.parse(text).model, {
      id: "fixture-model",
      tools: true,
      context: 16384,
      maxOutput: 1024,
    });
  },
);

test(
  "rivet setup exits 2 without saving when the model fails the check",
  { timeout: 15000 },
  async (t) => {
    const server = await probeServer(t, { pass: false });
    const state = stateDir(t);
    const answers = [
      "compatible",
      `${server.base}/v1`,
      "",
      "",
      "text-only",
      "16384",
      "",
    ];
    const result = await runCli(state, `${answers.join("\n")}\n`, {
      RIVET_API_KEY: key,
    });
    assert.equal(result.code, 2, result.stdout);
    assert.match(
      result.stderr,
      /Nothing was saved: Model did not pass the tool-calling check/,
    );
    assert.ok(!existsSync(join(state, "config.json")));
  },
);

test(
  "rivet setup exits 130 at end of input and 2 when a config exists",
  { timeout: 15000 },
  async (t) => {
    const state = stateDir(t);
    const ended = await runCli(state, "openai\nenvironment\n");
    assert.equal(ended.code, 130, ended.stderr);
    assert.match(ended.stderr, /Setup cancelled; nothing was saved/);
    assert.ok(!existsSync(join(state, "config.json")));

    writeFileSync(join(state, "config.json"), "{}\n");
    const existing = await runCli(state, "openai\n");
    assert.equal(existing.code, 2);
    assert.match(existing.stderr, /config\.json already exists/);
    assert.ok(!existing.stdout.includes("Provider"));
    assert.equal(readFileSync(join(state, "config.json"), "utf8"), "{}\n");
  },
);
