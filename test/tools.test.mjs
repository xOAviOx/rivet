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

test("plan mode reads freely and denies writes and commands without prompting", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, "a.txt"), "alpha\n");
  const marker = join(env.root, "marker.txt");
  const { run, prompts, events } = tools(env.root, {
    mode: "plan",
    answers: Array(5).fill("session"),
  });
  const read = await run("file_read", { path: "a.txt" });
  assert.deepEqual(read, {
    path: "a.txt",
    sha256: sha256("alpha\n"),
    contents: "alpha\n",
    truncated: false,
  });
  assert.match(
    (
      await run("file_patch", {
        path: "a.txt",
        expectedHash: read.sha256,
        oldText: "alpha",
        newText: "beta",
      })
    ).error,
    /Policy denies file_patch/,
  );
  assert.match(
    (
      await run("file_patch", {
        path: "b.txt",
        expectedHash: null,
        oldText: "",
        newText: "x",
        create: true,
      })
    ).error,
    /Policy denies file_patch/,
  );
  assert.match(
    (
      await run("command", {
        command: node,
        args: [
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
        ],
      })
    ).error,
    /Policy denies command/,
  );
  assert.equal(readFileSync(join(env.root, "a.txt"), "utf8"), "alpha\n");
  assert.equal(existsSync(join(env.root, "b.txt")), false);
  assert.equal(existsSync(marker), false);
  assert.equal(prompts.length, 0);
  assert.deepEqual(events, []);
});

test("edit mode prompts with exact arguments; once, session, and deny differ", async (t) => {
  const env = setup(t);
  const { run, prompts, events } = tools(env.root, {
    answers: ["deny", "once", "once", "session", "once"],
  });
  const args = { command: node, args: ["-e", "process.stdout.write('ok')"] };
  assert.match(
    (await run("command", args)).error,
    /Approval denied for command/,
  );
  const once = await run("command", args);
  assert.equal(once.exitCode, 0);
  assert.equal(once.output, "ok");
  assert.equal((await run("command", args)).output, "ok");
  assert.equal(prompts.length, 3, "once does not persist");
  assert.equal((await run("command", args)).output, "ok");
  assert.equal((await run("command", args)).output, "ok");
  assert.equal(prompts.length, 4, "session persists for identical arguments");
  const other = {
    command: node,
    args: ["-e", "process.stdout.write('other')"],
  };
  assert.equal((await run("command", other)).output, "other");
  assert.equal(prompts.length, 5, "session grants do not cover new arguments");
  assert.deepEqual(
    prompts.map((prompt) => prompt.name),
    Array(5).fill("command"),
  );
  assert.deepEqual(prompts[0].args, args);
  assert.deepEqual(prompts[4].args, other);
  assert.deepEqual(events.slice(0, 2), [
    { type: "approval", tool: "command", args },
    { type: "approval", tool: "command", args, decision: "deny" },
  ]);
});

test("custom policy rules allow, deny, or ask per tool", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, "a.txt"), "alpha\n");
  const { run, prompts } = tools(env.root, {
    mode: "custom",
    policy: { command: "allow", file_patch: "deny" },
    answers: ["deny"],
  });
  assert.equal(
    (
      await run("command", {
        command: node,
        args: ["-e", "process.stdout.write('allowed')"],
      })
    ).output,
    "allowed",
  );
  assert.equal(prompts.length, 0);
  assert.match(
    (
      await run("file_patch", {
        path: "a.txt",
        expectedHash: sha256("alpha\n"),
        oldText: "alpha",
        newText: "beta",
      })
    ).error,
    /Policy denies file_patch/,
  );
  assert.equal(prompts.length, 0);
  assert.equal(readFileSync(join(env.root, "a.txt"), "utf8"), "alpha\n");
});

test("file_patch replaces exactly one literal match against the expected hash", async (t) => {
  const env = setup(t);
  const file = join(env.root, "notes.txt");
  const original = "one\r\ntwo\r\nthree\r\n";
  writeFileSync(file, original);
  const { run } = tools(env.root, { answers: Array(20).fill("once") });
  const patch = (args) =>
    run("file_patch", {
      path: "notes.txt",
      expectedHash: sha256(original),
      ...args,
    });
  assert.match(
    (await patch({ expectedHash: sha256("x"), oldText: "two", newText: "2" }))
      .error,
    /expectedHash does not match/,
  );
  assert.match(
    (await patch({ oldText: "four", newText: "4" })).error,
    /exactly once/,
  );
  assert.match(
    (await patch({ oldText: "", newText: "4" })).error,
    /exactly once/,
  );
  assert.match(
    (await patch({ oldText: "\r\n", newText: "\n" })).error,
    /exactly once/,
  );
  assert.equal(readFileSync(file, "utf8"), original);

  const result = await patch({ oldText: "two", newText: "$& and $1" });
  const expected = "one\r\n$& and $1\r\nthree\r\n";
  assert.equal(readFileSync(file, "utf8"), expected);
  assert.deepEqual(result, {
    path: "notes.txt",
    sha256: sha256(expected),
    bytes: Buffer.byteLength(expected),
    created: false,
  });
  assert.equal(
    (await run("file_read", { path: "notes.txt" })).sha256,
    result.sha256,
  );
  assert.match(
    (await patch({ oldText: "one", newText: "1" })).error,
    /expectedHash does not match/,
    "a hash cannot be reused after the file changes",
  );
  assert.match(
    (
      await run("file_patch", {
        path: "notes.txt",
        expectedHash: result.sha256,
        oldText: "one",
        newText: "x".repeat(1024 * 1024),
      })
    ).error,
    /1 MiB/,
  );
  assert.equal(readFileSync(file, "utf8"), expected);
  assert.deepEqual(readdirSync(env.root), ["notes.txt"], "no temporary files");
});

test("file_patch creation never overwrites and never creates directories", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, "existing.txt"), "keep\n");
  const { run, prompts } = tools(env.root, { answers: Array(10).fill("once") });
  const create = (path, newText = "hello\n") =>
    run("file_patch", {
      path,
      expectedHash: null,
      oldText: "",
      newText,
      create: true,
    });
  assert.ok((await create("src/new.txt")).error);
  assert.equal(existsSync(join(env.root, "src")), false);
  assert.ok((await create("existing.txt", "replaced\n")).error);
  assert.equal(readFileSync(join(env.root, "existing.txt"), "utf8"), "keep\n");

  mkdirSync(join(env.root, "src"));
  assert.deepEqual(await create("src/new.txt"), {
    path: "src/new.txt",
    sha256: sha256("hello\n"),
    bytes: 6,
    created: true,
  });
  assert.equal(
    readFileSync(join(env.root, "src", "new.txt"), "utf8"),
    "hello\n",
  );
  assert.match(
    (await create("src/new.txt", "again\n")).error,
    /already exists/,
  );
  assert.equal(
    readFileSync(join(env.root, "src", "new.txt"), "utf8"),
    "hello\n",
  );
  assert.equal(prompts.length, 1, "invalid creations fail before approval");
  assert.deepEqual(prompts[0].args, {
    path: "src/new.txt",
    expectedHash: null,
    oldText: "",
    newText: "hello\n",
    create: true,
  });
  assert.deepEqual(readdirSync(env.root).sort(), ["existing.txt", "src"]);
  assert.deepEqual(readdirSync(join(env.root, "src")), ["new.txt"]);
});

test("file_read bounds size, rejects binary and invalid UTF-8, and truncates output", async (t) => {
  const env = setup(t);
  mkdirSync(join(env.root, "dir"));
  writeFileSync(join(env.root, "big.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
  writeFileSync(join(env.root, "zero.dat"), Buffer.from("a\0b"));
  writeFileSync(join(env.root, "bad.txt"), Buffer.from([0xc3, 0x28]));
  const medium = "m".repeat(60000);
  writeFileSync(join(env.root, "medium.txt"), medium);
  const { run } = tools(env.root, { mode: "plan" });
  assert.match((await run("file_read", { path: "big.txt" })).error, /1 MiB/);
  assert.match((await run("file_read", { path: "zero.dat" })).error, /Binary/);
  assert.ok((await run("file_read", { path: "bad.txt" })).error);
  assert.ok((await run("file_read", { path: "dir" })).error);
  assert.ok((await run("file_read", { path: "missing.txt" })).error);
  const read = await run("file_read", { path: "medium.txt" });
  assert.equal(read.truncated, true);
  assert.equal(read.contents.length, 48 * 1024);
  assert.equal(read.sha256, sha256(medium), "hash covers the full file");
});

test("file_list is ordered, bounded, and skips protected and dependency directories", async (t) => {
  const env = setup(t);
  for (const file of [
    "b.txt",
    "a/one.txt",
    "a/two.txt",
    "node_modules/pkg/index.js",
    "dist/out.js",
    ".git/HEAD",
    ".rivet/state.db",
  ]) {
    mkdirSync(join(env.root, file, ".."), { recursive: true });
    writeFileSync(join(env.root, file), "x");
  }
  const { run } = tools(env.root, { mode: "plan" });
  assert.deepEqual(await run("file_list", {}), {
    files: ["a/one.txt", "a/two.txt", "b.txt"],
    truncated: false,
  });
  assert.deepEqual(await run("file_list", { limit: 2 }), {
    files: ["a/one.txt", "a/two.txt"],
    truncated: true,
  });
  assert.deepEqual(await run("file_list", { path: "a" }), {
    files: ["a/one.txt", "a/two.txt"],
    truncated: false,
  });
});

test("file_search matches literal text with bounded results", async (t) => {
  const env = setup(t);
  for (const [file, contents] of [
    ["src/a.txt", "abc\na.c\nA.C\n"],
    ["src/b.bin", "a.c\0"],
    ["other/c.txt", "first a.c\n"],
    [".git/config", "a.c\n"],
  ]) {
    mkdirSync(join(env.root, file, ".."), { recursive: true });
    writeFileSync(join(env.root, file), contents);
  }
  const { run } = tools(env.root, { mode: "plan" });
  assert.deepEqual(await run("file_search", { query: "a.c", path: "src" }), {
    matches: [{ path: "src/a.txt", line: 2, text: "a.c" }],
    truncated: false,
  });
  const all = await run("file_search", { query: "a.c" });
  assert.equal(all.truncated, false);
  assert.deepEqual(
    all.matches.map((match) => `${match.path}:${match.line}`).sort(),
    ["other/c.txt:1", "src/a.txt:2"],
  );
  const limited = await run("file_search", { query: "a.c", limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  assert.deepEqual((await run("file_search", { query: "zzz" })).matches, []);
});

test("command runs without a shell and reports exit status and bounded output", async (t) => {
  const env = setup(t);
  mkdirSync(join(env.root, "sub"));
  const { run } = tools(env.root, { answers: Array(10).fill("once") });
  const literal = "a & echo injected | more > out.txt";
  assert.equal(
    (
      await run("command", {
        command: node,
        args: ["-e", "process.stdout.write(process.argv[1])", literal],
      })
    ).output,
    literal,
  );
  assert.equal(existsSync(join(env.root, "out.txt")), false);
  const failed = await run("command", {
    command: node,
    args: ["-e", "process.stderr.write('bad'); process.exit(3)"],
  });
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.output, "bad");
  const big = await run("command", {
    command: node,
    args: ["-e", "process.stdout.write('x'.repeat(100000))"],
  });
  assert.equal(big.exitCode, 0);
  assert.equal(big.truncated, true);
  assert.equal(big.output.length, 48 * 1024);
  const cwd = await run("command", {
    command: node,
    args: ["-e", "process.stdout.write(process.cwd())"],
    cwd: "sub",
  });
  assert.equal(
    cwd.output.toLowerCase(),
    realpathSync.native(join(env.root, "sub")).toLowerCase(),
  );
  assert.ok(
    (await run("command", { command: `rivet-missing-${randomUUID()}` })).error,
  );
});

test(
  "timeouts and cancellation stop the whole process tree",
  { timeout: 90000 },
  async (t) => {
    const env = setup(t);
    const pids = [];
    t.after(() => {
      for (const pid of pids)
        try {
          process.kill(pid);
        } catch {
          // Already stopped.
        }
    });
    const keepAlive = "setInterval(() => {}, 1000)";
    const tree = (pidFile) =>
      [
        `const c = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(keepAlive)}], { stdio: "inherit" });`,
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
        keepAlive,
      ].join("\n");
    const { run } = tools(env.root, { answers: Array(4).fill("once") });

    let started = Date.now();
    const timedOut = await run("command", {
      command: node,
      args: ["-e", tree("timeout.pid")],
      timeoutMs: 2000,
    });
    assert.equal(timedOut.stopped, "timeout");
    assert.ok(Date.now() - started < 20000, "timeout settles promptly");
    const timeoutChild = Number(
      readFileSync(join(env.root, "timeout.pid"), "utf8"),
    );
    pids.push(timeoutChild);
    assert.ok(
      await waitFor(() => !alive(timeoutChild)),
      "descendant stopped after timeout",
    );

    const controller = new AbortController();
    started = Date.now();
    const pending = run(
      "command",
      { command: node, args: ["-e", tree("cancel.pid")] },
      controller.signal,
    );
    assert.ok(await waitFor(() => existsSync(join(env.root, "cancel.pid"))));
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.stopped, "cancelled");
    assert.ok(Date.now() - started < 20000, "cancellation settles promptly");
    const cancelChild = Number(
      readFileSync(join(env.root, "cancel.pid"), "utf8"),
    );
    pids.push(cancelChild);
    assert.ok(
      await waitFor(() => !alive(cancelChild)),
      "descendant stopped after cancellation",
    );

    const aborted = new AbortController();
    aborted.abort();
    const marker = join(env.root, "never.txt");
    assert.ok(
      (
        await run(
          "command",
          {
            command: node,
            args: [
              "-e",
              `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
            ],
          },
          aborted.signal,
        )
      ).error,
    );
    assert.equal(existsSync(marker), false);
  },
);

test(
  "read-only Git runs in plan mode without repository helpers; other Git needs approval",
  { skip: !gitAvailable && "git is not installed", timeout: 60000 },
  async (t) => {
    const env = setup(t);
    const git = initRepository(env.root);
    writeFileSync(join(env.root, "a.txt"), "two\n");
    const marker = join(env.outside, "external-diff-ran");
    const script = join(env.outside, "external.js");
    writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
    );
    git("config", "diff.external", `"${forward(node)}" "${forward(script)}"`);
    git("diff");
    assert.ok(existsSync(marker), "control: plain git diff runs diff.external");
    rmSync(marker);

    const plan = tools(env.root, { mode: "plan" });
    const status = await plan.run("git", { args: ["status", "--short"] });
    assert.equal(status.exitCode, 0);
    assert.match(status.output, /a\.txt/);
    const diff = await plan.run("git", { args: ["diff", "--no-color"] });
    assert.equal(diff.exitCode, 0);
    assert.match(diff.output, /^-one$/m);
    assert.match(diff.output, /^\+two$/m);
    assert.equal(existsSync(marker), false, "diff.external must not run");
    assert.match(
      (await plan.run("git", { args: ["log", "--oneline", "-1"] })).output,
      /initial/,
    );
    assert.match(
      (await plan.run("git", { args: ["commit", "-qam", "plan"] })).error,
      /Policy denies git/,
    );
    assert.match(
      (await plan.run("git", { args: ["diff", "--output=leak.txt"] })).error,
      /Policy denies git/,
    );
    assert.equal(existsSync(join(env.root, "leak.txt")), false);
    assert.equal(plan.prompts.length, 0);
    assert.equal(git("rev-list", "--count", "HEAD").trim(), "1");

    const edit = tools(env.root, { answers: ["deny", "once"] });
    const commit = { args: ["commit", "-qam", "second"] };
    assert.match((await edit.run("git", commit)).error, /Approval denied/);
    assert.equal(git("rev-list", "--count", "HEAD").trim(), "1");
    assert.equal((await edit.run("git", commit)).exitCode, 0);
    assert.equal(git("rev-list", "--count", "HEAD").trim(), "2");
    assert.deepEqual(
      edit.prompts.map((prompt) => prompt.args),
      [commit, commit],
    );
  },
);

test(
  "read-only Git does not run a repository fsmonitor hook",
  { skip: !gitAvailable && "git is not installed", timeout: 60000 },
  async (t) => {
    const env = setup(t);
    const git = initRepository(env.root);
    const marker = join(env.outside, "fsmonitor-ran");
    const script = join(env.outside, "fsmonitor.js");
    writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
    );
    git("config", "core.fsmonitor", `"${forward(node)}" "${forward(script)}"`);
    try {
      git("status", "--short");
    } catch {
      // The hook output is not a valid fsmonitor response; only execution matters.
    }
    if (!existsSync(marker)) {
      t.skip("this Git version does not run core.fsmonitor hooks for status");
      return;
    }
    rmSync(marker);
    const { run } = tools(env.root, { mode: "plan" });
    assert.equal(
      (await run("git", { args: ["status", "--short"] })).exitCode,
      0,
    );
    assert.equal(existsSync(marker), false);
  },
);

// Regression coverage for the tool-boundary defects recorded in PROGRESS.md.

test("environment and credential files are refused like other protected paths", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, ".env"), "API_KEY=sk-rivet-test-value\n");
  writeFileSync(join(env.root, ".env.local"), "TOKEN=value\n");
  mkdirSync(join(env.root, ".ssh"));
  writeFileSync(join(env.root, ".ssh", "id_ed25519"), "private\n");
  const { run } = tools(env.root, { mode: "plan" });
  for (const path of [".env", ".env.local", ".ssh/id_ed25519"])
    assert.ok((await run("file_read", { path })).error, path);
  assert.deepEqual((await run("file_list", {})).files, []);
  assert.deepEqual((await run("file_search", { query: "=" })).matches, []);
});

test("hard links to files outside the workspace are refused", async (t) => {
  const env = setup(t);
  try {
    linkSync(join(env.outside, "secret.txt"), join(env.root, "alias.txt"));
  } catch {
    t.skip("hard links are unavailable on this file system");
    return;
  }
  const { run } = tools(env.root, { mode: "plan" });
  assert.ok((await run("file_read", { path: "alias.txt" })).error);
  assert.deepEqual((await run("file_search", { query: "secret" })).matches, []);
});

test(
  "Windows 8.3 short names cannot alias .git",
  {
    skip: process.platform !== "win32" && "Windows only",
  },
  async (t) => {
    const env = setup(t);
    mkdirSync(join(env.root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(env.root, ".git", "config"), "[core]\n");
    if (!existsSync(join(env.root, "GIT~1", "config"))) {
      t.skip("8.3 short names are disabled on this volume");
      return;
    }
    const { run } = tools(env.root, { answers: ["once"] });
    assert.ok((await run("file_read", { path: "GIT~1/config" })).error);
    assert.ok(
      (
        await run("file_patch", {
          path: "GIT~1/hooks/pre-commit",
          expectedHash: null,
          oldText: "",
          newText: "#!/bin/sh\n",
          create: true,
        })
      ).error,
    );
    assert.equal(
      existsSync(join(env.root, ".git", "hooks", "pre-commit")),
      false,
    );
  },
);

test("commands do not inherit provider credentials from the agent process", async (t) => {
  const env = setup(t);
  const name = "RIVET_TOOLS_TEST_API_KEY";
  process.env[name] = `sk-rivet-test-${randomUUID()}`;
  t.after(() => delete process.env[name]);
  const { run } = tools(env.root, { answers: ["once"] });
  const result = await run("command", {
    command: node,
    args: ["-e", `process.stdout.write(process.env.${name} ?? "absent")`],
  });
  assert.equal(result.output, "absent");
});

test("custom policy rules also govern read tools and read-only Git", async (t) => {
  const env = setup(t);
  writeFileSync(join(env.root, "a.txt"), "alpha\n");
  const { run, prompts } = tools(env.root, {
    mode: "custom",
    policy: {
      file_read: "deny",
      file_list: "deny",
      file_search: "deny",
      git: "deny",
    },
  });
  for (const [name, args] of [
    ["file_read", { path: "a.txt" }],
    ["file_list", {}],
    ["file_search", { query: "alpha" }],
    ["git", { args: ["status", "--short"] }],
  ])
    assert.match((await run(name, args)).error ?? "", /Policy denies/, name);
  assert.equal(prompts.length, 0);
  const asking = tools(env.root, {
    mode: "custom",
    policy: { file_read: "ask" },
    answers: ["deny", "once"],
  });
  assert.match(
    (await asking.run("file_read", { path: "a.txt" })).error,
    /Approval denied/,
  );
  assert.equal(
    (await asking.run("file_read", { path: "a.txt" })).contents,
    "alpha\n",
  );
  assert.equal(asking.prompts.length, 2);
});
