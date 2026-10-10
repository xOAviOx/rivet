import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Policy } from "../dist/security.js";
import { createToolRunner } from "../dist/tools.js";

const runner = createToolRunner();
const node = process.execPath;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const forward = (path) => path.replace(/\\/g, "/");

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Tools inherit this process environment; keep user and system Git settings out of results.
const gitHome = mkdtempSync(join(tmpdir(), "rivet-tools-git-"));
writeFileSync(join(gitHome, "config"), "");
process.env.GIT_CONFIG_GLOBAL = join(gitHome, "config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.on("exit", () => rmSync(gitHome, { recursive: true, force: true }));

function removeLink(path) {
  try {
    unlinkSync(path);
  } catch {
    try {
      rmdirSync(path);
    } catch {
      // Already gone.
    }
  }
}

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), "rivet-tools-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside secret\n");
  const links = [];
  t.after(() => {
    // Links go first so recursive cleanup can never traverse into a target.
    for (const link of links) removeLink(link);
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });
  return { root, outside, links };
}

function junction(env, name) {
  const path = join(env.root, name);
  symlinkSync(env.outside, path, "junction");
  env.links.push(path);
  return path;
}

function tools(root, { mode = "edit", policy = {}, answers = [] } = {}) {
  const prompts = [];
  const events = [];
  const pending = [...answers];
  const gate = new Policy(
    { mode, policy },
    async (name, args) => {
      prompts.push({ name, args });
      return pending.shift() ?? "deny";
    },
    (event) => events.push(event),
  );
  let id = 0;
  const raw = (name, args, signal) =>
    runner.execute(
      { id: `call-${++id}`, name, arguments: args },
      { workspace: root, policy: gate, signal },
    );
  const run = async (name, args, signal) => {
    const output = await raw(name, args, signal);
    assert.equal(typeof output, "string");
    return JSON.parse(output);
  };
  return { run, raw, prompts, events };
}

function initRepository(root) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "rivet@example.invalid");
  git("config", "user.name", "Rivet Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "initial");
  return git;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitFor(predicate, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

test("tool definitions are unique, closed object schemas", () => {
  const names = runner.definitions.map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length);
  for (const expected of [
    "file_list",
    "file_read",
    "file_search",
    "file_patch",
    "command",
    "git",
  ])
    assert.ok(names.includes(expected), `missing ${expected}`);
  for (const definition of runner.definitions) {
    assert.ok(definition.description.length > 0);
    assert.equal(definition.parameters.type, "object");
    assert.equal(definition.parameters.additionalProperties, false);
    for (const key of definition.parameters.required)
      assert.ok(key in definition.parameters.properties, key);
  }
});

test("malformed calls fail before any approval prompt", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, "a.txt"), "a");
  const { run, raw, prompts } = tools(env.root, {
    answers: Array(20).fill("once"),
  });
  const cases = [
    ["unknown_tool", {}],
    ["file_read", {}],
    ["file_read", { path: "a.txt", extra: true }],
    ["file_read", { path: "a\0.txt" }],
    ["file_read", { path: 42 }],
    ["file_list", { limit: 501 }],
    ["file_list", { limit: 1.5 }],
    ["file_search", { query: "" }],
    ["file_search", { query: "x".repeat(4097) }],
    [
      "file_patch",
      { path: "a.txt", expectedHash: "abc", oldText: "a", newText: "b" },
    ],
    ["file_patch", { path: "a.txt", oldText: "a", newText: "b" }],
    [
      "file_patch",
      {
        path: "a.txt",
        expectedHash: sha256("a"),
        oldText: "a",
        newText: "b",
        create: "yes",
      },
    ],
    [
      "file_patch",
      {
        path: "new.txt",
        expectedHash: sha256("a"),
        oldText: "",
        newText: "b",
        create: true,
      },
    ],
    [
      "file_patch",
      {
        path: "new.txt",
        expectedHash: null,
        oldText: "x",
        newText: "b",
        create: true,
      },
    ],
    [
      "file_patch",
      { path: ".", expectedHash: sha256("a"), oldText: "a", newText: "b" },
    ],
    ["command", { command: "" }],
    ["command", { command: node, args: Array(129).fill("x") }],
    ["command", { command: node, args: [42] }],
    ["command", { command: node, args: ["x".repeat(8193)] }],
    ["command", { command: node, timeoutMs: 0 }],
    ["command", { command: node, timeoutMs: 120001 }],
    ["command", { command: node, cwd: "a.txt" }],
    ["command", { command: node, cwd: "missing" }],
    ["git", { args: [] }],
  ];
  for (const [name, args] of cases) {
    const result = await run(name, args);
    assert.equal(
      typeof result.error,
      "string",
      `${name} ${JSON.stringify(args).slice(0, 80)} should fail`,
    );
  }
  for (const args of [null, [], "path"]) {
    const result = JSON.parse(await raw("file_read", args));
    assert.equal(typeof result.error, "string");
  }
  assert.equal(prompts.length, 0);
  assert.equal(readFileSync(join(env.root, "a.txt"), "utf8"), "a");
  assert.equal(existsSync(join(env.root, "new.txt")), false);
});

test("unsafe and protected paths are refused by every path-taking tool", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, "a.txt"), "a");
  mkdirSync(join(env.root, ".git", "hooks"), { recursive: true });
  writeFileSync(join(env.root, ".git", "config"), "[core]\n");
  mkdirSync(join(env.root, "sub", ".git"), { recursive: true });
  writeFileSync(join(env.root, "sub", ".git", "config"), "[core]\n");
  mkdirSync(join(env.root, ".rivet"));
  writeFileSync(join(env.root, ".rivet", "state.db"), "state");
  const unsafe = [
    join(env.outside, "secret.txt"),
    join(env.root, "a.txt"),
    "/etc/passwd",
    "C:relative.txt",
    "\\\\server\\share\\x.txt",
    "../outside/secret.txt",
    "..\\outside\\secret.txt",
    "sub/../../outside/secret.txt",
    ".git/config",
    ".GIT/config",
    ".git/hooks/pre-commit",
    "sub/.git/config",
    "sub\\.git\\config",
    ".rivet/state.db",
    "a.txt:hidden",
    "trailing.",
    "trailing ",
    "nul",
    "con.txt",
    "COM1",
    "lpt9.log",
  ];
  const { run, prompts } = tools(env.root, {
    answers: Array(100).fill("once"),
  });
  for (const path of unsafe) {
    assert.ok((await run("file_read", { path })).error, `read ${path}`);
    assert.ok((await run("file_list", { path })).error, `list ${path}`);
    assert.ok(
      (await run("file_search", { query: "core", path })).error,
      `search ${path}`,
    );
    assert.ok(
      (
        await run("file_patch", {
          path,
          expectedHash: null,
          oldText: "",
          newText: "#!/bin/sh\n",
          create: true,
        })
      ).error,
      `create ${path}`,
    );
    assert.ok(
      (await run("command", { command: node, args: ["-e", "0"], cwd: path }))
        .error,
      `cwd ${path}`,
    );
  }
  assert.equal(prompts.length, 0);
  assert.equal(
    existsSync(join(env.root, ".git", "hooks", "pre-commit")),
    false,
  );
  assert.deepEqual(readdirSync(env.outside), ["secret.txt"]);
});

test("junctions and symlinks are never followed", async (t) => {
  const env = setup(t);
  junction(env, "link");
  writeFileSync(join(env.root, "inside.txt"), "inside\n");
  const { run, prompts } = tools(env.root, {
    answers: Array(10).fill("once"),
  });
  assert.ok((await run("file_read", { path: "link/secret.txt" })).error);
  assert.ok((await run("file_list", { path: "link" })).error);
  assert.ok(
    (await run("file_search", { query: "secret", path: "link" })).error,
  );
  assert.ok(
    (
      await run("file_patch", {
        path: "link/secret.txt",
        expectedHash: sha256("outside secret\n"),
        oldText: "outside",
        newText: "changed",
      })
    ).error,
  );
  assert.ok(
    (
      await run("file_patch", {
        path: "link/new.txt",
        expectedHash: null,
        oldText: "",
        newText: "x",
        create: true,
      })
    ).error,
  );
  assert.ok(
    (await run("command", { command: node, args: ["-e", "0"], cwd: "link" }))
      .error,
  );
  assert.deepEqual((await run("file_list", {})).files, ["inside.txt"]);
  assert.deepEqual((await run("file_search", { query: "secret" })).matches, []);
  assert.equal(prompts.length, 0);
  assert.equal(
    readFileSync(join(env.outside, "secret.txt"), "utf8"),
    "outside secret\n",
  );
  assert.deepEqual(readdirSync(env.outside), ["secret.txt"]);
});
