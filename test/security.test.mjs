import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configSchema } from "../dist/config.js";
import { Workspace, Policy, clean, redact, hash } from "../dist/security.js";

function workspace(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rivet-ws-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function trySymlink(target, path) {
  try {
    symlinkSync(
      target,
      path,
      process.platform === "win32" ? "junction" : "dir",
    );
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return false;
    throw error;
  }
}
const baseConfig = (overrides = {}) =>
  configSchema.parse({
    provider: "openai",
    model: { id: "m", tools: true, context: 8192, maxOutput: 1024 },
    ...overrides,
  });

test("workspace rejects absolute, drive, UNC, NUL, and parent paths", async (t) => {
  const root = workspace(t);
  const ws = await Workspace.open(root);
  for (const input of [
    "/etc/passwd",
    "C:\\Windows",
    "c:/x",
    "\\\\server\\share",
    "//server/share",
    "a\0b",
  ])
    await assert.rejects(ws.path(input), /relative workspace path/);
  for (const input of ["..", "../x", "a/../../b", "a/..\\..\\b"])
    await assert.rejects(ws.path(input), /Protected or unsafe path/);
});

test("workspace protects Git internals, state, secrets, and reserved Windows names", async (t) => {
  const root = workspace(t);
  const ws = await Workspace.open(root);
  for (const input of [
    ".git/config",
    "GIT~1/config",
    "nested/SECRET~1.TXT",
    "sub/.git/HEAD",
    ".rivet/sessions.db",
    ".ssh/id_rsa",
    ".aws/credentials",
    ".env",
    ".env.local",
    "CON",
    "nul.txt",
    "COM1",
    "dir/aux",
    "trailing.",
    "trailing ",
    "bad:name",
    "wild*card",
    "q?",
    "pipe|x",
  ])
    await assert.rejects(ws.path(input), /Protected or unsafe path/, input);
  // Lookalikes that are not protected must pass.
  mkdirSync(join(root, "gitbook"));
  writeFileSync(join(root, "environment.ts"), "x");
  assert.equal(await ws.path("gitbook"), join(root, "gitbook"));
  assert.equal(await ws.path("environment.ts"), join(root, "environment.ts"));
  assert.equal(await ws.path("."), root);
});

test("missing paths are allowed only for the final segment when requested", async (t) => {
  const root = workspace(t);
  const ws = await Workspace.open(root);
  await assert.rejects(ws.path("new.txt"), { code: "ENOENT" });
  assert.equal(await ws.path("new.txt", true), join(root, "new.txt"));
  await assert.rejects(ws.path("missing-dir/new.txt", true), {
    code: "ENOENT",
  });
});

test("symlinks, junctions, and hard links are refused", async (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  const ws = await Workspace.open(root);
  writeFileSync(join(outside, "secret.txt"), "outside");
  writeFileSync(join(root, "a.txt"), "inside");
  if (trySymlink(outside, join(root, "link"))) {
    await assert.rejects(ws.path("link"), /Symlinks and junctions/);
    await assert.rejects(ws.path("link/secret.txt"), /Symlinks and junctions/);
    const listing = await ws.files();
    assert.ok(!listing.files.some((f) => f.startsWith("link")));
  } else t.diagnostic("symlink creation not permitted; skipped symlink cases");
  linkSync(join(root, "a.txt"), join(root, "b.txt"));
  await assert.rejects(ws.path("a.txt"), /Hard-linked/);
  await assert.rejects(ws.read("b.txt"), /Hard-linked/);
});

test("read enforces regular files, size, and binary bounds", async (t) => {
  const root = workspace(t);
  const ws = await Workspace.open(root);
  mkdirSync(join(root, "dir"));
  writeFileSync(join(root, "small.txt"), "hello");
  writeFileSync(join(root, "big.txt"), "x".repeat(2000));
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  assert.equal(await ws.read("small.txt"), "hello");
  await assert.rejects(ws.read("dir"), /Not a regular file/);
  await assert.rejects(ws.read("big.txt", 1000), /exceeds 1000 bytes/);
  await assert.rejects(ws.read("bin.dat"), /Binary or oversized/);
  await assert.rejects(ws.read("missing.txt"), { code: "ENOENT" });
});

test("file discovery is sorted, skips dependency and protected directories, and reports truncation", async (t) => {
  const root = workspace(t);
  const ws = await Workspace.open(root);
  for (const dir of [
    "node_modules/pkg",
    "dist",
    ".cache",
    "coverage",
    ".git",
    "src/b",
    "src/a",
  ])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "node_modules/pkg/index.js"), "");
  writeFileSync(join(root, "dist/out.js"), "");
  writeFileSync(join(root, ".cache/x"), "");
  writeFileSync(join(root, "coverage/x"), "");
  writeFileSync(join(root, ".git/HEAD"), "");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "src/b/two.ts"), "");
  writeFileSync(join(root, "src/a/one.ts"), "");
  writeFileSync(join(root, "zeta.md"), "");
  const all = await ws.files();
  assert.deepEqual(all, {
    files: ["src/a/one.ts", "src/b/two.ts", "zeta.md"],
    truncated: false,
  });
  const limited = await ws.files(".", 2);
  assert.equal(limited.files.length, 2);
  assert.equal(limited.truncated, true);
  const scoped = await ws.files("src/b");
  assert.deepEqual(scoped.files, ["src/b/two.ts"]);
  await assert.rejects(ws.files(".git"), /Protected or unsafe path/);
});

test("scoped instructions are collected from root to target and bounded", async (t) => {
  const root = workspace(t);
  const ws = await Workspace.open(root);
  mkdirSync(join(root, "pkg/deep"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root rules");
  writeFileSync(join(root, "pkg/AGENTS.md"), "pkg rules");
  writeFileSync(join(root, "pkg/deep/file.ts"), "");
  assert.equal(await ws.instructions(), "Scope .:\nroot rules");
  const nested = await ws.instructions("pkg/deep/file.ts");
  assert.match(nested, /^Scope \.:\nroot rules\n\nScope pkg:\npkg rules$/);
  assert.equal(await ws.instructions("pkg/deep/new.ts"), nested);
  writeFileSync(join(root, "pkg/deep/AGENTS.md"), "y".repeat(20000));
  await assert.rejects(
    ws.instructions("pkg/deep/file.ts"),
    /exceeds 16384 bytes/,
  );
  rmSync(join(root, "pkg/deep/AGENTS.md"));
  writeFileSync(join(root, "AGENTS.md"), "r".repeat(16000));
  writeFileSync(join(root, "pkg/AGENTS.md"), "p".repeat(16000));
  writeFileSync(join(root, "pkg/deep/AGENTS.md"), "d".repeat(1000));
  await assert.rejects(ws.instructions("pkg/deep/file.ts"), /exceed 32 KiB/);
});

test("plan mode allows reads and denies every other effect without prompting", async () => {
  let prompted = 0;
  const events = [];
  const policy = new Policy(
    baseConfig({ mode: "plan" }),
    async () => {
      prompted++;
      return "once";
    },
    (e) => events.push(e),
  );
  const signal = new AbortController().signal;
  await policy.check("file_read", { path: "a" }, "read", signal);
  for (const effect of ["write", "exec", "mcp"])
    await assert.rejects(policy.check("x", {}, effect, signal), (error) => {
      assert.match(error.message, /Policy denies x/);
      assert.equal(error.exitCode, 3);
      return true;
    });
  assert.equal(prompted, 0);
  assert.deepEqual(events, []);
});

test("edit mode asks once per call, remembers session grants per exact arguments, and denies", async () => {
  const decisions = ["once", "once", "session", "deny"];
  const events = [];
  const policy = new Policy(
    baseConfig({ mode: "edit" }),
    async () => decisions.shift(),
    (e) => events.push(e),
  );
  const signal = new AbortController().signal;
  const args = { command: "git", args: ["status"] };
  await policy.check("command", args, "exec", signal);
  await policy.check("command", args, "exec", signal);
  assert.equal(decisions.length, 2, "once grants nothing");
  await policy.check("command", args, "exec", signal);
  await policy.check("command", args, "exec", signal);
  await policy.check("command", { ...args }, "exec", signal);
  assert.equal(decisions.length, 1, "session grant covers identical arguments");
  await assert.rejects(
    policy.check("command", { command: "git", args: ["push"] }, "exec", signal),
    (error) => {
      assert.match(error.message, /Approval denied for command/);
      assert.equal(error.exitCode, 3);
      return true;
    },
  );
  assert.equal(decisions.length, 0);
  const approvals = events.filter((e) => e.type === "approval");
  assert.equal(approvals.length, 8);
  assert.equal(approvals[0].decision, undefined);
  assert.equal(approvals[1].decision, "once");
  assert.equal(approvals.at(-1).decision, "deny");
  assert.deepEqual(approvals.at(-1).args, { command: "git", args: ["push"] });
});

test("custom mode follows per-tool rules and defaults to asking", async () => {
  let prompted = 0;
  const policy = new Policy(
    baseConfig({
      mode: "custom",
      policy: { file_read: "deny", command: "allow" },
    }),
    async () => {
      prompted++;
      return "once";
    },
    () => {},
  );
  const signal = new AbortController().signal;
  await assert.rejects(
    policy.check("file_read", {}, "read", signal),
    /Policy denies/,
  );
  await policy.check("command", { command: "x" }, "exec", signal);
  assert.equal(prompted, 0);
  await policy.check("file_patch", { path: "a" }, "write", signal);
  assert.equal(prompted, 1);
});

test("cancellation before or during approval never approves", async () => {
  const controller = new AbortController();
  let called = 0;
  const policy = new Policy(
    baseConfig({ mode: "edit" }),
    async () => {
      called++;
      controller.abort();
      return "session";
    },
    () => {},
  );
  await assert.rejects(
    policy.check("command", { command: "x" }, "exec", controller.signal),
    { name: "AbortError" },
  );
  assert.equal(called, 1);
  // The aborted prompt returned "session" but must not have been recorded as a grant.
  const fresh = new AbortController();
  await policy.check("command", { command: "x" }, "exec", fresh.signal);
  assert.equal(called, 2);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(policy.check("file_read", {}, "read", aborted.signal), {
    name: "AbortError",
  });
});

test("clean strips terminal controls and bidi overrides but keeps text, tabs, and newlines", () => {
  assert.equal(
    clean("a\x1b[31mred\x1b[0m\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c"),
    "aredbc",
  );
  assert.equal(clean("x\u202ey\u2066z\x7f\x9b\x00"), "xyz");
  assert.equal(clean("line1\n\tline2\r\n"), "line1\n\tline2\n");
  assert.equal(
    clean("plain ascii and ünïcödé 日本"),
    "plain ascii and ünïcödé 日本",
  );
});

test("redact masks environment secrets and key-shaped tokens", () => {
  process.env.RIVET_TEST_SECRET_KEY = "super-secret-value";
  process.env.RIVET_TEST_SHORT_KEY = "abc";
  process.env.RIVET_TEST_PLAIN = "visible-value";
  try {
    const text =
      "key=super-secret-value short=abc plain=visible-value sk-abcdefghijklmnop Bearer abcdefghijklmnop123";
    const out = redact(text);
    assert.ok(!out.includes("super-secret-value"));
    assert.ok(out.includes("short=abc"), "short values are not redacted");
    assert.ok(out.includes("visible-value"), "non-secret names are kept");
    assert.ok(!out.includes("sk-abcdefghijklmnop"));
    assert.ok(!/Bearer abcdefghijklmnop123/.test(out));
    assert.equal((out.match(/\[REDACTED\]/g) || []).length, 3);
  } finally {
    delete process.env.RIVET_TEST_SECRET_KEY;
    delete process.env.RIVET_TEST_SHORT_KEY;
    delete process.env.RIVET_TEST_PLAIN;
  }
});

test("hash is a stable hex SHA-256", () => {
  assert.equal(
    hash("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
