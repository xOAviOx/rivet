import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { childEnvironment, runProcess } from "../dist/process.js";

const node = process.execPath;
const live = () => new AbortController().signal;
function cwd(t) {
  const dir = mkdtempSync(join(tmpdir(), "rivet-proc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("childEnvironment passes only a safe allowlist plus explicit extras", () => {
  process.env.RIVET_TEST_LEAK = "leak";
  try {
    const env = childEnvironment({ EXTRA_VALUE: "1" });
    assert.equal(env.RIVET_TEST_LEAK, undefined);
    assert.equal(env.EXTRA_VALUE, "1");
    for (const key of Object.keys(env))
      assert.match(
        key,
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL|EXTRA_VALUE)$/i,
        key,
      );
  } finally {
    delete process.env.RIVET_TEST_LEAK;
  }
});

test("exit codes and interleaved stdout/stderr are returned", async (t) => {
  const result = await runProcess(
    node,
    [
      "-e",
      "process.stdout.write('out');process.stderr.write('err');process.exitCode=3",
    ],
    cwd(t),
    live(),
  );
  assert.equal(result.code, 3);
  assert.ok(result.output.includes("out"));
  assert.ok(result.output.includes("err"));
});

test("arguments are passed literally without a shell", async (t) => {
  const result = await runProcess(
    node,
    ["-p", "process.argv[1]", "a && echo pwned; $HOME %TEMP% | cat"],
    cwd(t),
    live(),
  );
  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), "a && echo pwned; $HOME %TEMP% | cat");
});

test("the child sees only the filtered environment", async (t) => {
  process.env.RIVET_TEST_LEAK = "leak";
  try {
    const result = await runProcess(
      node,
      ["-p", "JSON.stringify(Object.keys(process.env))"],
      cwd(t),
      live(),
    );
    const keys = JSON.parse(result.output.trim());
    assert.ok(!keys.includes("RIVET_TEST_LEAK"));
    assert.ok(keys.some((k) => k.toUpperCase() === "PATH"));
  } finally {
    delete process.env.RIVET_TEST_LEAK;
  }
});

test("output beyond the byte limit stops the process and reports uncertainty", async (t) => {
  await assert.rejects(
    runProcess(
      node,
      ["-e", "setInterval(()=>process.stdout.write('x'.repeat(4096)),1)"],
      cwd(t),
      live(),
      10000,
      2048,
    ),
    (error) => {
      assert.match(
        error.message,
        /output limit exceeded; side effects may have occurred/,
      );
      assert.equal(error.exitCode, 1);
      return true;
    },
  );
});

test("timeouts kill the process tree including grandchildren", async (t) => {
  const dir = cwd(t);
  const marker = join(dir, "grandchild-alive");
  // The grandchild writes a marker only if it survives past the parent's timeout.
  const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const started = Date.now();
  await assert.rejects(
    runProcess(node, ["-e", parent], dir, live(), 400),
    (error) => {
      assert.match(error.message, /timed out; side effects may have occurred/);
      assert.equal(error.exitCode, 1);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, "timeout fired promptly");
  await delay(2000);
  assert.equal(
    existsSync(marker),
    false,
    "grandchild was killed with the parent",
  );
});

test("cancellation kills the process and uses exit code 130", async (t) => {
  const controller = new AbortController();
  const pending = runProcess(
    node,
    ["-e", "setInterval(()=>{},1000)"],
    cwd(t),
    controller.signal,
    10000,
  );
  await delay(150);
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /cancelled; side effects may have occurred/);
    assert.equal(error.exitCode, 130);
    return true;
  });
});

test("an already-cancelled signal refuses to start anything", (t) => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      runProcess(
        node,
        ["-e", "require('fs').writeFileSync('started','x')"],
        cwd(t),
        controller.signal,
      ),
    { name: "AbortError" },
  );
});

test("missing executables fail with the spawn error, never a shell lookup", async (t) => {
  await assert.rejects(
    runProcess("rivet-definitely-missing-binary", [], cwd(t), live()),
    { code: "ENOENT" },
  );
});
