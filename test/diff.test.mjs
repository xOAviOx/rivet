import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { workspaceDiff } from "../dist/diff.js";
import { Workspace } from "../dist/security.js";

const signal = () => new AbortController().signal;

async function repository(t, files = { "note.txt": "before\n" }) {
  const root = mkdtempSync(join(tmpdir(), "rivet-diff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", ...args],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "--quiet");
  function write(name, contents) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  for (const [name, contents] of Object.entries(files)) write(name, contents);
  git("add", "--all");
  // The index provides an unstaged baseline without commits or author overrides.
  return { root, git, write, workspace: await Workspace.open(root) };
}

test("working-tree preview returns a unified diff without changing the index", async (t) => {
  const repo = await repository(t);
  repo.write("note.txt", "after\n");
  const index = readFileSync(join(repo.root, ".git", "index"));
  const result = await workspaceDiff(repo.workspace, signal());
  assert.equal(result.staged, false);
  assert.equal(result.truncated, false);
  assert.match(result.text, /^diff --git a\/note\.txt b\/note\.txt/m);
  assert.match(result.text, /^-before\n\+after$/m);
  assert.deepEqual(readFileSync(join(repo.root, ".git", "index")), index);
  assert.equal(readFileSync(join(repo.root, "note.txt"), "utf8"), "after\n");
});

test("staged preview works before the first commit and ignores unstaged edits", async (t) => {
  const repo = await repository(t);
  repo.write("note.txt", "worktree only\n");
  const result = await workspaceDiff(repo.workspace, signal(), {
    staged: true,
  });
  assert.equal(result.staged, true);
  assert.match(result.text, /new file mode/);
  assert.match(result.text, /^\+before$/m);
  assert.doesNotMatch(result.text, /worktree only/);
});

test("clean tracked files and untracked files do not produce a diff", async (t) => {
  const repo = await repository(t);
  repo.write("untracked.txt", "not part of a tracked diff\n");
  assert.deepEqual(await workspaceDiff(repo.workspace, signal()), {
    text: "",
    truncated: false,
    staged: false,
  });
});

test("context size is explicit and missing final newlines remain visible", async (t) => {
  const repo = await repository(t, {
    "note.txt": "first\nsecond\nbefore\nfourth\nfifth\n",
  });
  repo.write("note.txt", "first\nsecond\nafter\nfourth\nfifth\n");
  const result = await workspaceDiff(repo.workspace, signal(), { context: 0 });
  assert.match(result.text, /@@ -3 \+3 @@/);
  assert.doesNotMatch(result.text, /^ (?:second|fourth)$/m);
  repo.write("note.txt", "after without newline");
  const noNewline = await workspaceDiff(repo.workspace, signal());
  assert.match(noNewline.text, /\\ No newline at end of file/);
});

test("path filters are literal and support spaces, leading dashes, and directories", async (t) => {
  const repo = await repository(t, {
    "folder/a[1].txt": "one\n",
    "folder/a1.txt": "two\n",
    "space name.txt": "three\n",
    "--output=result.txt": "four\n",
  });
  for (const name of [
    "folder/a[1].txt",
    "folder/a1.txt",
    "space name.txt",
    "--output=result.txt",
  ])
    repo.write(name, `changed ${name}\n`);
  const literal = await workspaceDiff(repo.workspace, signal(), {
    path: "folder\\a[1].txt",
    context: 0,
  });
  assert.match(literal.text, /changed folder\/a\[1\]\.txt/);
  assert.doesNotMatch(literal.text, /changed folder\/a1\.txt/);
  const spaced = await workspaceDiff(repo.workspace, signal(), {
    path: "space name.txt",
  });
  assert.match(spaced.text, /changed space name\.txt/);
  const dash = await workspaceDiff(repo.workspace, signal(), {
    path: "--output=result.txt",
  });
  assert.match(dash.text, /changed --output=result\.txt/);
  assert.equal(existsSync(join(repo.root, "result.txt")), false);
  const directory = await workspaceDiff(repo.workspace, signal(), {
    path: "folder",
  });
  assert.match(directory.text, /changed folder\/a1\.txt/);
  assert.doesNotMatch(directory.text, /space name/);
});

test("a subdirectory workspace cannot disclose sibling changes", async (t) => {
  const repo = await repository(t, {
    "child/local.txt": "before\n",
    "sibling.txt": "outside before\n",
  });
  repo.write("child/local.txt", "inside after\n");
  repo.write("sibling.txt", "outside after\n");
  const workspace = await Workspace.open(join(repo.root, "child"));
  const result = await workspaceDiff(workspace, signal());
  assert.match(result.text, /inside after/);
  assert.doesNotMatch(result.text, /outside|sibling|child\//);
});

test("deletions remain visible when the entire parent directory is removed", async (t) => {
  const repo = await repository(t, { "removed/nested/file.txt": "deleted\n" });
  rmSync(join(repo.root, "removed"), { recursive: true });
  const result = await workspaceDiff(repo.workspace, signal(), {
    path: "removed/nested/file.txt",
  });
  assert.match(result.text, /deleted file mode/);
  assert.match(result.text, /^-deleted$/m);
});

test("protected paths are excluded from broad previews and rejected explicitly", async (t) => {
  const repo = await repository(t, {
    ".env.local": "PRIVATE_BEFORE\n",
    ".aws/config": "ACCOUNT_BEFORE\n",
    "note.txt": "before\n",
  });
  repo.write(".env.local", "PRIVATE_AFTER\n");
  repo.write(".aws/config", "ACCOUNT_AFTER\n");
  repo.write("note.txt", "after\n");
  const result = await workspaceDiff(repo.workspace, signal());
  assert.match(result.text, /^\+after$/m);
  assert.doesNotMatch(result.text, /PRIVATE|ACCOUNT|\.env|\.aws/);
  for (const path of [
    "../outside",
    ".git/config",
    ".env.local",
    ".aws/config",
    "C:\\outside",
    "file:stream",
    "NUL",
  ])
    await assert.rejects(
      workspaceDiff(repo.workspace, signal(), { path }),
      /Protected|relative workspace path/,
    );
});

test("hard-linked paths are not previewed", async (t) => {
  const repo = await repository(t);
  linkSync(join(repo.root, "note.txt"), join(repo.root, "alias.txt"));
  repo.write("note.txt", "hard-link contents\n");
  assert.equal((await workspaceDiff(repo.workspace, signal())).text, "");
  await assert.rejects(
    workspaceDiff(repo.workspace, signal(), { path: "note.txt" }),
    /Hard-linked/,
  );
});

test("directory symlinks and junctions are rejected rather than followed", async (t) => {
  const repo = await repository(t);
  const outside = mkdtempSync(join(tmpdir(), "rivet-diff-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.txt"), "outside content\n");
  symlinkSync(outside, join(repo.root, "link"), "junction");
  await assert.rejects(
    workspaceDiff(repo.workspace, signal(), { path: "link/secret.txt" }),
    /Symlinks and junctions/,
  );
});

test("terminal controls and known secrets are removed from diff output", async (t) => {
  const repo = await repository(t);
  const key = "RIVET_DIFF_TEST_SECRET";
  const previous = process.env[key];
  process.env[key] = "sample-private-value-123456";
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  repo.write(
    "note.txt",
    `\x1b[31mred\x1b[0m \x1b]0;fake title\x07 ${process.env[key]}\nsample-\x1b[31mprivate-value-123456\n`,
  );
  const result = await workspaceDiff(repo.workspace, signal());
  assert.match(result.text, /red .*?\[REDACTED\]/);
  assert.doesNotMatch(result.text, /\x1b|sample-private-value|fake title/);
});

test("large previews are bounded and mark truncation without partial secrets", async (t) => {
  const repo = await repository(t);
  repo.write(
    "note.txt",
    "safe line\n".repeat(20) +
      "sk-" +
      "x".repeat(500) +
      "\n" +
      "later\n".repeat(500),
  );
  const result = await workspaceDiff(repo.workspace, signal(), {
    maxBytes: 400,
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 400);
  assert.match(result.text, /\[Diff truncated; select a narrower path\]\n$/);
  assert.doesNotMatch(result.text, /sk-x/);
  assert.doesNotMatch(result.text, /\ufffd/);
});

test("UTF-8 content survives chunk boundaries and truncation", async (t) => {
  const repo = await repository(t);
  repo.write("note.txt", "こんにちは world\n".repeat(100));
  const full = await workspaceDiff(repo.workspace, signal());
  assert.match(full.text, /こんにちは world/);
  const limited = await workspaceDiff(repo.workspace, signal(), {
    maxBytes: 256,
  });
  assert.equal(limited.truncated, true);
  assert.doesNotMatch(limited.text, /\ufffd/);
  assert.ok(Buffer.byteLength(limited.text) <= 256);
});

test("binary files produce notices instead of binary patches", async (t) => {
  const repo = await repository(t, { "data.bin": Buffer.from([0, 1, 2]) });
  repo.write("data.bin", Buffer.from([0, 3, 4]));
  const result = await workspaceDiff(repo.workspace, signal());
  assert.match(result.text, /Binary files .* differ/);
  assert.doesNotMatch(result.text, /GIT binary patch|\0/);
});

test("diff never invokes configured helpers, filters, or fsmonitor hooks", async (t) => {
  const repo = await repository(t);
  const marker = join(repo.root, "helper-ran");
  const helper = join(repo.root, "helper.cjs");
  writeFileSync(
    helper,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(1);`,
  );
  const command = `"${process.execPath.replace(/\\/g, "/")}" "${helper.replace(/\\/g, "/")}"`;
  repo.git("config", "diff.external", command);
  repo.git("config", "diff.unsafe.command", command);
  repo.git("config", "diff.unsafe.textconv", command);
  repo.git("config", "filter.unsafe.clean", command);
  repo.git("config", "filter.unsafe.process", command);
  repo.git("config", "filter.unsafe.required", "true");
  repo.git("config", "core.fsmonitor", command);
  repo.git("config", "diff.orderFile", "missing-order-file");
  repo.write(".gitattributes", "*.txt diff=unsafe filter=unsafe\n");
  repo.write("note.txt", "safe diff\n");
  const result = await workspaceDiff(repo.workspace, signal());
  assert.match(result.text, /^\+safe diff$/m);
  assert.equal(existsSync(marker), false);
});

test("redaction expansion still respects the final output byte limit", async (t) => {
  const repo = await repository(t);
  const key = "RIVET_DIFF_TEST_SECRET";
  const previous = process.env[key];
  process.env[key] = "val789";
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  repo.write("note.txt", "val789\n".repeat(12));
  const result = await workspaceDiff(repo.workspace, signal(), {
    maxBytes: 256,
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 256);
  assert.doesNotMatch(result.text, /val789/);
});

test("inherited Git overrides cannot redirect the diff to another repository", async (t) => {
  const repo = await repository(t);
  const other = await repository(t, { "other.txt": "unrelated\n" });
  repo.write("note.txt", "local change\n");
  other.write("other.txt", "must not appear\n");
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.root, ".git");
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  });
  const result = await workspaceDiff(repo.workspace, signal());
  assert.match(result.text, /local change/);
  assert.doesNotMatch(result.text, /must not appear|other\.txt/);
});

test("invalid options fail before invoking Git", async (t) => {
  const repo = await repository(t);
  for (const options of [
    { context: -1 },
    { context: 101 },
    { context: 1.5 },
    { maxBytes: 1 },
    { maxBytes: 1048577 },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { staged: "yes" },
    { path: 12 },
  ])
    await assert.rejects(
      workspaceDiff(repo.workspace, signal(), options),
      /must be/,
    );
});

test("pre-cancelled and active-cancelled previews stop without retrying", async (t) => {
  const repo = await repository(t);
  repo.write("note.txt", "after\n");
  const before = new AbortController();
  before.abort(new Error("cancelled before"));
  await assert.rejects(
    workspaceDiff(repo.workspace, before.signal),
    /cancelled before/,
  );
  const active = new AbortController();
  const result = workspaceDiff(repo.workspace, active.signal);
  const timer = setTimeout(
    () => active.abort(new Error("cancelled active")),
    5,
  );
  try {
    await assert.rejects(result, /cancelled active/);
  } finally {
    clearTimeout(timer);
  }
});

test("an expired deadline fails clearly", async (t) => {
  const repo = await repository(t);
  await assert.rejects(
    workspaceDiff(repo.workspace, signal(), { timeoutMs: 1 }),
    /Git diff timed out/,
  );
});

test("directories without a repository report a readable error", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rivet-diff-no-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    workspaceDiff(await Workspace.open(root), signal()),
    /Cannot read Git diff:/,
  );
});
