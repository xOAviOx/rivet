import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openSessionStore } from "../dist/storage.js";

function temporaryStore(t, close = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "rivet-storage-"));
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("sessions, ordered messages, events, and pending actions survive restart", (t) => {
  let store;
  const directory = temporaryStore(t, () => store?.close());
  store = openSessionStore(directory);
  const session = store.createSession(".", "test-model");
  const other = store.createSession(".", "second-model");
  const call = {
    id: "call-1",
    name: "exec",
    arguments: { command: "example" },
  };
  const messages = [
    { role: "user", content: "Run example" },
    { role: "assistant", content: "", toolCalls: [call] },
  ];
  for (const message of messages) store.appendMessage(session.id, message);
  store.appendMessage(other.id, { role: "user", content: "unrelated" });
  const event = {
    type: "tool.started",
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    tool: call.name,
  };
  store.appendEvent(event);
  const pendingId = store.beginAction(session.id, call);
  const finishedId = store.beginAction(session.id, { ...call, id: "call-2" });
  store.finishAction(finishedId, "complete");
  store.close();
  store = openSessionStore(directory);
  assert.deepEqual(store.getSession(session.id), {
    ...session,
    workspace: resolve("."),
  });
  assert.deepEqual(store.getMessages(session.id), messages);
  assert.deepEqual(store.getEvents(session.id), [event]);
  assert.deepEqual(store.getPendingActions(session.id), [
    { id: pendingId, call },
  ]);
  assert.deepEqual(store.getPendingActions(other.id), []);
  assert.equal(store.listSessions().length, 2);
  store.finishAction(pendingId, "confirmed by user");
  assert.deepEqual(store.getPendingActions(session.id), []);
  assert.throws(
    () => store.finishAction(pendingId, "overwrite"),
    /already finished/,
  );
  assert.throws(() => store.finishAction("missing", ""), /not found/);
});

test("a second writer is rejected until the first store closes", (t) => {
  let first, second;
  const directory = temporaryStore(t, () => {
    second?.close();
    first?.close();
  });
  first = openSessionStore(directory);
  assert.throws(() => openSessionStore(directory), /writer lock/);
  first.createSession(".", "test-model");
  first.close();
  first.close();
  assert.throws(() => first.listSessions(), /closed/);
  second = openSessionStore(directory);
  assert.equal(second.listSessions().length, 1);
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
  const moduleUrl = new URL("../dist/storage.js", import.meta.url).href;
  const code = `
    import { openSessionStore } from ${JSON.stringify(moduleUrl)};
    const store = openSessionStore(process.argv[1]);
    const session = store.createSession('.', 'crash-test');
    store.beginAction(session.id, { id: 'uncertain', name: 'exec', arguments: { command: 'example' } });
    console.log(session.id);
    setInterval(() => {}, 1000);
  `;
  child = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, directory],
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
  assert.throws(() => openSessionStore(directory), /writer lock/);
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
  store = openSessionStore(directory);
  assert.equal(store.getPendingActions(sessionId)[0].call.id, "uncertain");
});

test("missing sessions and corrupt records fail clearly", (t) => {
  let store;
  const directory = temporaryStore(t, () => store?.close());
  store = openSessionStore(directory);
  assert.equal(store.getSession("missing"), undefined);
  assert.throws(() => store.getMessages("missing"), /Session not found/);
  assert.throws(
    () => store.appendMessage("missing", { role: "user", content: "x" }),
    /Session not found/,
  );
  const session = store.createSession(".", "test-model");
  store.close();
  const db = new DatabaseSync(join(directory, "sessions.sqlite"));
  db.prepare("INSERT INTO messages (session_id, payload) VALUES (?, ?)").run(
    session.id,
    "{}",
  );
  db.close();
  store = openSessionStore(directory);
  assert.throws(
    () => store.getMessages(session.id),
    /Cannot read stored message/,
  );
});

test("unsupported schemas fail without leaking the writer lease", (t) => {
  const directory = temporaryStore(t);
  const db = new DatabaseSync(join(directory, "sessions.sqlite"));
  db.exec("PRAGMA user_version = 999;");
  db.close();
  assert.throws(() => openSessionStore(directory), /Unsupported.*999/);
  assert.throws(() => openSessionStore(directory), /Unsupported.*999/);
});
