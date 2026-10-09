import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadInstructions } from "../dist/instructions.js";
import { Workspace } from "../dist/security.js";

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "rivet-instructions-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "other"));
  await writeFile(join(base, "AGENTS.md"), "Do not load outside workspace");
  await writeFile(join(root, "AGENTS.md"), "Root rules");
  await writeFile(join(root, "src", "AGENTS.md"), "Source rules");
  await writeFile(join(root, "src", "nested", "AGENTS.md"), "Nested rules");
  await writeFile(join(root, "other", "AGENTS.md"), "Sibling rules");
  await writeFile(join(root, "src", "nested", "file.ts"), "export {};");
  return { base, root, workspace: await Workspace.open(root) };
}

test("loads root instructions only for the workspace root", async (t) => {
  const { workspace } = await fixture(t);
  for (const target of [".", "", "./"]) {
    const result = await loadInstructions(workspace, target);
    assert.equal(result.target, ".");
    assert.deepEqual(result.sources, [
      { path: "AGENTS.md", scope: ".", text: "Root rules" },
    ]);
    assert.match(result.text, /More specific instructions take precedence/);
    assert.doesNotMatch(
      result.text,
      /Source rules|Sibling rules|outside workspace/,
    );
  }
});

test("directory targets include their own instructions and normalize separators", async (t) => {
  const { workspace } = await fixture(t);
  for (const target of ["src/nested", "src/nested/", "src\\nested"]) {
    const result = await loadInstructions(workspace, target);
    assert.equal(result.target, "src/nested");
    assert.deepEqual(
      result.sources.map(({ scope }) => scope),
      [".", "src", "src/nested"],
    );
    assert.deepEqual(
      result.sources.map(({ text }) => text),
      ["Root rules", "Source rules", "Nested rules"],
    );
  }
});

test("existing and new file targets load root-to-leaf ancestor scopes only", async (t) => {
  const { workspace } = await fixture(t);
  for (const target of ["src/nested/file.ts", "src/nested/new.ts"]) {
    const result = await loadInstructions(workspace, target);
    assert.equal(result.target, target);
    assert.deepEqual(
      result.sources.map(({ path }) => path),
      ["AGENTS.md", "src/AGENTS.md", "src/nested/AGENTS.md"],
    );
    assert.ok(
      result.text.indexOf("Root rules") < result.text.indexOf("Source rules"),
    );
    assert.ok(
      result.text.indexOf("Source rules") < result.text.indexOf("Nested rules"),
    );
    assert.doesNotMatch(result.text, /Sibling rules|outside workspace/);
  }
  const sibling = await loadInstructions(workspace, "other/new.ts");
  assert.deepEqual(
    sibling.sources.map(({ text }) => text),
    ["Root rules", "Sibling rules"],
  );
  const rootFile = await loadInstructions(workspace, "new.ts");
  assert.equal(rootFile.sources.length, 1);
});

test("missing instruction files are skipped without discarding other scopes", async (t) => {
  const { root, workspace } = await fixture(t);
  await rm(join(root, "src", "AGENTS.md"));
  const result = await loadInstructions(workspace, "src/nested/file.ts");
  assert.deepEqual(
    result.sources.map(({ scope }) => scope),
    [".", "src/nested"],
  );
  await rm(join(root, "AGENTS.md"));
  await rm(join(root, "src", "nested", "AGENTS.md"));
  const empty = await loadInstructions(workspace, "src/nested/file.ts");
  assert.deepEqual(empty.sources, []);
  assert.equal(empty.text, "");
});

test("empty instructions remain visible and instruction content is not rewritten", async (t) => {
  const { root, workspace } = await fixture(t);
  const original = "# Rules\n\nKeep π and emoji 😀 intact.\r\n";
  await writeFile(join(root, "AGENTS.md"), "");
  await writeFile(join(root, "src", "AGENTS.md"), original);
  const result = await loadInstructions(workspace, "src");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].text, "");
  assert.equal(result.sources[1].text, original);
  assert.ok(result.text.includes(original));
});

test("instruction budgets count UTF-8 bytes and the rendered scope labels", async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(root, "AGENTS.md"), "é".repeat(8));
  await assert.rejects(
    loadInstructions(workspace, ".", { maxFileBytes: 15 }),
    /exceeds 15 bytes/,
  );
  const result = await loadInstructions(workspace, ".", { maxFileBytes: 16 });
  const bytes = Buffer.byteLength(result.text);
  await assert.rejects(
    loadInstructions(workspace, ".", { maxTotalBytes: bytes - 1 }),
    /including scope labels/,
  );
  assert.deepEqual(
    await loadInstructions(workspace, ".", { maxTotalBytes: bytes }),
    result,
  );
  await assert.rejects(
    loadInstructions(workspace, "src/nested", { maxTotalBytes: bytes }),
    /Scoped instructions exceed/,
  );
});

test("invalid limits and deeply nested target scopes fail closed", async (t) => {
  const { workspace } = await fixture(t);
  for (const options of [
    { maxFileBytes: 0 },
    { maxFileBytes: 65537 },
    { maxTotalBytes: NaN },
    { maxTotalBytes: Infinity },
    { maxTotalBytes: 262145 },
    { maxDepth: -1 },
    { maxDepth: 1.5 },
    { maxDepth: 65 },
  ])
    await assert.rejects(
      loadInstructions(workspace, ".", options),
      /Invalid instruction/,
    );
  await assert.rejects(
    loadInstructions(workspace, "src/nested/new.ts", { maxDepth: 1 }),
    /depth limit/,
  );
  assert.equal(
    (await loadInstructions(workspace, "src/nested", { maxDepth: 2 })).sources
      .length,
    3,
  );
});

test("unsafe targets, protected paths, and nonexistent parents are rejected", async (t) => {
  const { base, workspace } = await fixture(t);
  for (const target of [
    "../AGENTS.md",
    join(base, "AGENTS.md"),
    ".git/file",
    ".rivet/config",
    ".env",
    "src/../other",
    "C:\\outside",
    "\\\\server\\share",
    "src/nested/new.ts:stream",
    "src\nnested",
    "src\u202enested",
    "x".repeat(4097),
    null,
  ])
    await assert.rejects(loadInstructions(workspace, target));
  await assert.rejects(loadInstructions(workspace, "missing-parent/new.ts"), {
    code: "ENOENT",
  });
});

test("instruction directories, binary content, and invalid UTF-8 are not ignored", async (t) => {
  const { root, workspace } = await fixture(t);
  const filename = join(root, "AGENTS.md");
  await rm(filename);
  await mkdir(filename);
  await assert.rejects(loadInstructions(workspace), /regular, unlinked file/);
  await rm(filename, { recursive: true });
  for (const contents of [
    Buffer.from([65, 0, 66]),
    Buffer.from([0xc3, 0x28]),
  ]) {
    await writeFile(filename, contents);
    await assert.rejects(loadInstructions(workspace), /UTF-8 text/);
  }
});

test("hard-linked instruction files are rejected", async (t) => {
  const { base, root, workspace } = await fixture(t);
  const source = join(base, "shared-instructions");
  await writeFile(source, "Shared rules");
  await rm(join(root, "AGENTS.md"));
  await link(source, join(root, "AGENTS.md"));
  await assert.rejects(loadInstructions(workspace), /Hard-linked|unlinked/);
});

test("junction targets and instruction-file symlinks are not followed", async (t) => {
  const { base, root, workspace } = await fixture(t);
  const outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "AGENTS.md"), "Outside rules");
  await symlink(
    outside,
    join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    loadInstructions(workspace, "linked/new.ts"),
    /Symlinks|junctions/,
  );
  try {
    await symlink(
      join(outside, "AGENTS.md"),
      join(root, "src", "linked.md"),
      "file",
    );
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic(
        "File-symlink check unavailable without Windows symlink privilege; junction check passed.",
      );
      return;
    }
    throw error;
  }
  await rm(join(root, "AGENTS.md"));
  await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"), "file");
  await assert.rejects(loadInstructions(workspace), /Symlinks|junctions/);
});

test("cancellation before and during scope loading stops further work", async (t) => {
  const { workspace } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadInstructions(workspace, ".", { signal: controller.signal }),
    { name: "AbortError" },
  );
  const during = new AbortController();
  const original = workspace.path.bind(workspace);
  let visits = 0;
  workspace.path = async (...args) => {
    visits++;
    const result = await original(...args);
    if (args[0] === "src/AGENTS.md") during.abort();
    return result;
  };
  await assert.rejects(
    loadInstructions(workspace, "src/nested", { signal: during.signal }),
    { name: "AbortError" },
  );
  const stoppedAt = visits;
  await new Promise((done) => setImmediate(done));
  assert.equal(visits, stoppedAt);
});
