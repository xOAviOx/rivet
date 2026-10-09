import assert from "node:assert/strict";
import test from "node:test";
import { configSchema } from "../dist/config.js";
import { credential } from "../dist/credentials.js";

const config = (overrides = {}) =>
  configSchema.parse({
    provider: "openai",
    model: { id: "m", tools: true, context: 8192 },
    ...overrides,
  });

test("a process-only session key wins over every stored source", async () => {
  process.env.OPENAI_API_KEY = "env-key-value";
  try {
    assert.equal(await credential(config(), "session-key"), "session-key");
    assert.equal(
      await credential(config({ credential: "os" }), "session-key"),
      "session-key",
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("environment credentials use the provider default or the configured name", async () => {
  process.env.OPENAI_API_KEY = "env-key-value";
  process.env.CUSTOM_KEY_NAME = "custom-value";
  try {
    assert.equal(await credential(config()), "env-key-value");
    assert.equal(
      await credential(config({ keyEnv: "CUSTOM_KEY_NAME" })),
      "custom-value",
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CUSTOM_KEY_NAME;
  }
});

test("a missing environment key fails with exit code 2 and names the variable", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(
    credential(config({ provider: "anthropic" })),
    (error) => {
      assert.match(error.message, /Set ANTHROPIC_API_KEY or use \/key/);
      assert.equal(error.exitCode, 2);
      return true;
    },
  );
  // An empty value is treated as missing, never sent as a credential.
  process.env.ANTHROPIC_API_KEY = "";
  try {
    await assert.rejects(
      credential(config({ provider: "anthropic" })),
      /Set ANTHROPIC_API_KEY/,
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("an absent OS credential fails closed with guidance instead of a plaintext fallback", async () => {
  // Nothing is stored for this never-used compatible endpoint; the helper must fail cleanly.
  process.env.RIVET_API_KEY = "must-not-be-used";
  try {
    await assert.rejects(
      credential(
        config({
          provider: "compatible",
          endpoint: "https://never-stored.invalid/v1",
          credential: "os",
        }),
      ),
      (error) => {
        assert.match(error.message, /environment key/);
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
  } finally {
    delete process.env.RIVET_API_KEY;
  }
});
