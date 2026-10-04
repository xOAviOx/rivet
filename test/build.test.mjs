import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const project = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rivet-build-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "scripts"));
  cpSync(join(project, "scripts/clean.mjs"), join(base, "scripts/clean.mjs"));
  return base;
}
test("clean removes only generated dist, independent of the caller's directory", (t) => {
  const base = fixture(t);
  mkdirSync(join(base, "dist"));
  mkdirSync(join(base, "caller"));
  writeFileSync(join(base, "dist/stale.js"), "stale");
  writeFileSync(join(base, "keep.txt"), "keep");
  execFileSync(process.execPath, [join(base, "scripts/clean.mjs")], {
    cwd: join(base, "caller"),
  });
  assert.equal(existsSync(join(base, "dist")), false);
  assert.equal(readFileSync(join(base, "keep.txt"), "utf8"), "keep");
  execFileSync(process.execPath, [join(base, "scripts/clean.mjs")]);
});
test("clean refuses a linked dist and preserves its target", (t) => {
  const base = fixture(t);
  const outside = realpathSync(
    mkdtempSync(join(tmpdir(), "rivet-build-outside-")),
  );
  const link = join(base, "dist");
  t.after(() => {
    if (existsSync(link)) unlinkSync(link);
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, "keep.txt"), "keep");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () =>
      execFileSync(process.execPath, [join(base, "scripts/clean.mjs")], {
        stdio: "pipe",
      }),
    /expected a real directory/,
  );
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
  unlinkSync(link);
});
test("build output matches current source modules and has an executable CLI header", () => {
  const expected = readdirSync(join(project, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -3))
    .sort();
  const actual = readdirSync(join(project, "dist"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.slice(0, -3))
    .sort();
  assert.deepEqual(actual, expected);
  assert.ok(
    readFileSync(join(project, "dist/cli.js"), "utf8").startsWith(
      "#!/usr/bin/env node\n",
    ),
  );
});
