import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../dist/store.js";

function temporaryStore(t, close = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "rivet-store-"));
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const open = (directory) => new Store(join(directory, "sessions.sqlite"));

test("sessions, ordered messages, events, and pending actions survive restart", (t) => {
  let store;
  const directory = temporaryStore(t, () => store?.close());
  store = open(directory);
  const session = store.create(".", "test-model");
  const other = store.create(".", "second-model");
  const call = {
    id: "call-1",
    name: "exec",
    arguments: { command: "example" },
  };
  const messages = [
    { role: "user", content: "Run example" },
    { role: "assistant", content: "", calls: [call] },
    { role: "tool", content: "{}", callId: "call-1" },
  ];
  for (const message of messages) store.append(session.id, message);
  store.append(other.id, { role: "user", content: "unrelated" });
  const event = { type: "session", id: session.id, model: "test-model" };
  store.event(session.id, event);
  const pendingId = store.begin(session.id, call);
  const finishedId = store.begin(session.id, { ...call, id: "call-2" });
  store.finish(finishedId, "complete");
  store.close();
  store = open(directory);
  assert.deepEqual(store.get(session.id), session);
  assert.deepEqual(store.messages(session.id), messages);
  assert.deepEqual(store.events(session.id), [event]);
  assert.deepEqual(store.pending(session.id), [{ id: pendingId, call }]);
  assert.deepEqual(store.pending(other.id), []);
  assert.equal(store.list().length, 2);
  store.finish(pendingId, "confirmed by user");
  assert.deepEqual(store.pending(session.id), []);
  assert.throws(
    () => store.finish(pendingId, "overwrite"),
    /missing or already resolved/,
  );
  assert.throws(
    () => store.finish("missing", ""),
    /missing or already resolved/,
  );
});

test("a second writer is rejected until the first store closes", (t) => {
  let first, second;
  const directory = temporaryStore(t, () => {
    second?.close();
    first?.close();
  });
  first = open(directory);
  assert.throws(() => open(directory), /already open by another writer/);
  first.create(".", "test-model");
  first.close();
  first.close();
  assert.throws(() => first.list(), /database is not open/);
  second = open(directory);
  assert.equal(second.list().length, 1);
});

test("a terminated writer releases its lease and retains uncertain actions", async (t) => {
  let store, child;
  const directory = temporaryStore(t, async () => {
    store?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  });
  const moduleUrl = new URL("../dist/store.js", import.meta.url).href;
  const database = join(directory, "sessions.sqlite");
  const code = `
    import { Store } from ${JSON.stringify(moduleUrl)};
    const store = new Store(process.argv[1]);
    const session = store.create('.', 'crash-test');
    store.begin(session.id, { id: 'uncertain', name: 'exec', arguments: { command: 'example' } });
    console.log(session.id);
    setInterval(() => {}, 1000);
  `;
  child = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, database],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`Child startup timed out: ${stderr}`)),
      10000,
    );
    child.stdout.on("data", (data) => {
      stdout += String(data);
      if (stdout.includes("\n")) {
        clearTimeout(timer);
        resolveReady(stdout.trim());
      }
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Child exited before startup: ${stderr}`));
    });
  });
  const sessionId = await ready;
  assert.throws(() => open(directory), /already open by another writer/);
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
  store = open(directory);
  assert.equal(store.pending(sessionId)[0].call.id, "uncertain");
});

test("unsupported schemas fail without leaking the writer lease", (t) => {
  const directory = temporaryStore(t);
  const database = join(directory, "sessions.sqlite");
  const first = open(directory);
  first.close();
  const db = new DatabaseSync(database);
  db.exec("PRAGMA user_version = 999;");
  db.close();
  assert.throws(() => open(directory), /newer Rivet version/);
  assert.throws(() => open(directory), /newer Rivet version/);
});
