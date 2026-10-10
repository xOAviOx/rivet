import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configSchema,
  configDir,
  destination,
  keyName,
  loadConfig,
  saveConfig,
  privateDir,
} from "../dist/config.js";

const model = { id: "gpt-test", tools: true, context: 128000, maxOutput: 4096 };
const valid = (overrides = {}) => ({ provider: "openai", model, ...overrides });
const issues = (input) => {
  const result = configSchema.safeParse(input);
  assert.equal(result.success, false, "expected rejection");
  return result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("\n");
};
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "rivet-home-"));
  const previous = process.env.RIVET_HOME;
  process.env.RIVET_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.RIVET_HOME;
    else process.env.RIVET_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("defaults are applied: plan mode, environment credentials, bounded limits, no MCP", () => {
  const config = configSchema.parse(valid());
  assert.equal(config.mode, "plan");
  assert.equal(config.credential, "environment");
  assert.deepEqual(config.policy, {});
  assert.deepEqual(config.limits, {
    steps: 30,
    tools: 100,
    tokens: 100000,
    timeoutMs: 120000,
    outputBytes: 32768,
  });
  assert.deepEqual(config.mcp, []);
  assert.equal(config.model.maxOutput, 4096);
});

test("models must declare tool support and a usable context window", () => {
  assert.match(issues(valid({ model: { ...model, tools: false } })), /true/i);
  assert.match(issues(valid({ model: { id: "x", context: 8192 } })), /tools/i);
  assert.match(issues(valid({ model: { ...model, context: 2048 } })), /4096/);
  assert.match(
    issues(valid({ model: { ...model, context: 4096, maxOutput: 4096 } })),
    /maxOutput must be smaller than context/,
  );
  assert.match(
    issues(valid({ model: { ...model, id: "" } })),
    />=1|at least 1/i,
  );
});

test("unknown keys are rejected everywhere", () => {
  assert.match(issues(valid({ extra: 1 })), /unrecognized/i);
  assert.match(
    issues(valid({ model: { ...model, extra: 1 } })),
    /unrecognized/i,
  );
  assert.match(
    issues(valid({ limits: { steps: 1, extra: 1 } })),
    /unrecognized/i,
  );
});

test("endpoints require HTTPS or loopback HTTP and forbid credentials, queries, and fragments", () => {
  for (const endpoint of [
    "http://example.com/v1",
    "https://user:pw@example.com/v1",
    "https://example.com/v1?x=1",
    "https://example.com/v1#frag",
    "ftp://example.com",
  ])
    assert.match(
      issues(valid({ provider: "compatible", endpoint })),
      /HTTPS|url|URL/i,
      endpoint,
    );
  for (const endpoint of [
    "https://example.com/v1",
    "http://localhost:8080/v1",
    "http://127.0.0.1:11434/v1",
  ]) {
    const config = configSchema.parse(
      valid({ provider: "compatible", endpoint }),
    );
    assert.equal(destination(config), `${endpoint}/chat/completions`);
  }
  const trailing = configSchema.parse(
    valid({ provider: "compatible", endpoint: "https://example.com/v1/" }),
  );
  assert.equal(
    destination(trailing),
    "https://example.com/v1/chat/completions",
  );
});

// Zod runs refinements even after the URL shape check fails.
test("an unparsable endpoint is a validation issue, not a thrown TypeError", () => {
  const result = configSchema.safeParse(
    valid({ provider: "compatible", endpoint: "not a url" }),
  );
  assert.equal(result.success, false);
});

test("compatible providers need an endpoint and official providers refuse one", () => {
  assert.match(issues(valid({ provider: "compatible" })), /explicit endpoint/);
  assert.match(
    issues(valid({ endpoint: "https://example.com/v1" })),
    /Use compatible for a custom endpoint/,
  );
  assert.equal(
    destination(configSchema.parse(valid())),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    destination(configSchema.parse(valid({ provider: "anthropic" }))),
    "https://api.anthropic.com/v1/messages",
  );
});

test("credential names default per provider and must be environment-safe", () => {
  assert.equal(keyName(configSchema.parse(valid())), "OPENAI_API_KEY");
  assert.equal(
    keyName(configSchema.parse(valid({ provider: "anthropic" }))),
    "ANTHROPIC_API_KEY",
  );
  assert.equal(
    keyName(
      configSchema.parse(
        valid({ provider: "compatible", endpoint: "https://x.example/v1" }),
      ),
    ),
    "RIVET_API_KEY",
  );
  assert.equal(
    keyName(configSchema.parse(valid({ keyEnv: "MY_KEY" }))),
    "MY_KEY",
  );
  assert.match(issues(valid({ keyEnv: "lower" })), /invalid/i);
  assert.match(issues(valid({ keyEnv: "1BAD" })), /invalid/i);
  assert.match(issues(valid({ credential: "file" })), /invalid/i);
});

test("limits are positive integers inside documented ceilings", () => {
  assert.match(
    issues(valid({ limits: { steps: 0 } })),
    /greater than 0|positive|>0/i,
  );
  assert.match(issues(valid({ limits: { steps: 1001 } })), /1000/);
  assert.match(issues(valid({ limits: { tools: 10001 } })), /10000/);
  assert.match(issues(valid({ limits: { timeoutMs: 600001 } })), /600000/);
  assert.match(issues(valid({ limits: { outputBytes: 1048577 } })), /1048576/);
  assert.match(issues(valid({ limits: { tokens: 1.5 } })), /int/i);
  const partial = configSchema.parse(valid({ limits: { steps: 5 } }));
  assert.equal(partial.limits.steps, 5);
  assert.equal(partial.limits.tools, 100);
});

test("cost limits require both prices", () => {
  assert.match(
    issues(valid({ limits: { cost: 1 }, model: { ...model, inputPrice: 1 } })),
    /both per-million-token prices/,
  );
  const config = configSchema.parse(
    valid({
      limits: { cost: 1 },
      model: { ...model, inputPrice: 1, outputPrice: 2 },
    }),
  );
  assert.equal(config.limits.cost, 1);
  assert.match(
    issues(valid({ limits: { cost: 0 } })),
    /greater than 0|positive|>0/i,
  );
  assert.match(issues(valid({ model: { ...model, inputPrice: -1 } })), /0/);
});

test("MCP servers are untrusted by default, transport-consistent, uniquely named, and bounded", () => {
  const stdio = {
    name: "fs",
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
  };
  const http = {
    name: "remote",
    transport: "http",
    url: "https://mcp.example/mcp",
    keyEnv: "MCP_KEY",
  };
  const config = configSchema.parse(valid({ mcp: [stdio, http] }));
  assert.equal(config.mcp[0].trusted, false);
  assert.deepEqual(config.mcp[1].args, []);
  assert.match(
    issues(valid({ mcp: [{ ...stdio, url: http.url }] })),
    /command for stdio or url for HTTP/,
  );
  assert.match(
    issues(valid({ mcp: [{ name: "x", transport: "http" }] })),
    /command for stdio or url for HTTP/,
  );
  assert.match(
    issues(valid({ mcp: [{ ...http, command: "node" }] })),
    /command for stdio or url for HTTP/,
  );
  assert.match(
    issues(valid({ mcp: [stdio, { ...http, name: "fs" }] })),
    /unique/,
  );
  assert.match(
    issues(valid({ mcp: [{ ...stdio, name: "bad name" }] })),
    /invalid/i,
  );
  assert.match(
    issues(valid({ mcp: [{ ...stdio, name: "a".repeat(25) }] })),
    /invalid/i,
  );
  assert.match(
    issues(valid({ mcp: [{ ...http, url: "http://mcp.example/mcp" }] })),
    /HTTPS/,
  );
  const many = Array.from({ length: 17 }, (_, i) => ({
    ...stdio,
    name: `s${i}`,
  }));
  assert.match(issues(valid({ mcp: many })), /16/);
  assert.match(
    issues(valid({ mcp: [{ ...stdio, trusted: "yes" }] })),
    /boolean/i,
  );
});

test("configDir honors RIVET_HOME and privateDir refuses symlinks", async (t) => {
  const dir = home(t);
  assert.equal(configDir(), dir);
  await privateDir(join(dir, "nested"));
  assert.ok(statSync(join(dir, "nested")).isDirectory());
  const real = join(dir, "real");
  mkdirSync(real);
  try {
    symlinkSync(
      real,
      join(dir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.diagnostic("symlink creation not permitted; skipped");
      return;
    }
    throw error;
  }
  await assert.rejects(privateDir(join(dir, "linked")), (error) => {
    assert.match(error.message, /must not be a symlink/);
    assert.equal(error.exitCode, 2);
    return true;
  });
});

test("saveConfig writes once with private permissions and loadConfig validates the result", async (t) => {
  const dir = home(t);
  const config = configSchema.parse(valid({ mode: "edit" }));
  await saveConfig(config);
  const file = join(dir, "config.json");
  const text = readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), config);
  if (process.platform !== "win32")
    assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await loadConfig(), config);
  // Existing files are never overwritten silently.
  await assert.rejects(saveConfig(config), { code: "EEXIST" });
  await assert.rejects(
    saveConfig({ ...config, limits: { ...config.limits, steps: 0 } }),
  );
});

test("loadConfig fails with exit code 2 and setup guidance for missing or invalid files", async (t) => {
  const dir = home(t);
  await assert.rejects(loadConfig(), (error) => {
    assert.match(error.message, /Cannot load .*Run rivet setup/);
    assert.equal(error.exitCode, 2);
    return true;
  });
  const file = join(dir, "config.json");
  writeFileSync(file, "{ not json");
  await assert.rejects(loadConfig(file), /Cannot load .*Run rivet setup/);
  writeFileSync(file, JSON.stringify({ provider: "openai" }));
  await assert.rejects(loadConfig(file), (error) => {
    assert.match(error.message, /model/);
    assert.equal(error.exitCode, 2);
    return true;
  });
  writeFileSync(file, JSON.stringify(valid()));
  assert.equal((await loadConfig(file)).provider, "openai");
});
