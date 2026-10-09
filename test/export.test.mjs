import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportSession } from "../dist/export.js";
import { Store } from "../dist/store.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "rivet-export-"));
  const store = new Store(join(dir, "sessions.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = store.create(dir, "test-model");
  return { dir, store, session };
}

test("JSON export retains ordered messages, events, calls, and pending actions", (t) => {
  const { store, session } = fixture(t);
  const call = {
    id: "call-1",
    name: "command",
    arguments: { command: "node", args: ["--version"] },
  };
  const messages = [
    { role: "user", content: "Check the runtime." },
    { role: "assistant", content: "", calls: [call] },
    { role: "tool", callId: call.id, content: "v22.19.0", error: false },
    { role: "assistant", content: "Runtime checked." },
  ];
  for (const message of messages) store.append(session.id, message);
  const events = [
    { type: "tool.start", call },
    { type: "tool.end", id: call.id, result: "v22.19.0", error: false },
    { type: "done", reason: "complete" },
  ];
  for (const event of events) store.event(session.id, event);
  const finished = store.begin(session.id, call);
  store.finish(finished, "v22.19.0");
  const pending = { ...call, id: "call-2" };
  const actionId = store.begin(session.id, pending);
  const output = exportSession(store, session.id);
  assert.equal(output.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(output), {
    schemaVersion: 1,
    session,
    messages,
    events,
    pending: [{ id: actionId, call: pending }],
  });
  assert.deepEqual(store.pending(session.id), [
    { id: actionId, call: pending },
  ]);
});

test("export is isolated to the requested session and survives store restart", (t) => {
  const { dir, store, session } = fixture(t);
  const other = store.create(dir, "other-model");
  store.append(session.id, { role: "user", content: "requested transcript" });
  store.append(other.id, { role: "user", content: "unrelated transcript" });
  store.event(other.id, { type: "text", text: "unrelated event" });
  store.begin(other.id, {
    id: "other-call",
    name: "command",
    arguments: { command: "other-command" },
  });
  store.close();
  const reopened = new Store(join(dir, "sessions.sqlite"));
  try {
    const output = exportSession(reopened, session.id);
    assert.match(output, /requested transcript/);
    assert.doesNotMatch(output, /unrelated|other-command|other-model/);
  } finally {
    reopened.close();
  }
});

test("known secrets are redacted recursively without mutating stored records", (t) => {
  const { store, session } = fixture(t);
  const key = 'session-only"key\\with\nescapes';
  const message = {
    role: "assistant",
    content: `Credential: ${key}`,
    calls: [
      {
        id: "sensitive-call",
        name: "mcp_test",
        arguments: { nested: [{ credential: key }], literal: "[REDACTED]" },
      },
    ],
  };
  const event = { type: "text", text: `Credential: ${key}` };
  store.append(session.id, message);
  store.event(session.id, event);
  const actionId = store.begin(session.id, message.calls[0]);
  for (const format of ["json", "markdown"]) {
    const output = exportSession(store, session.id, format, [key, "", key]);
    assert.doesNotMatch(output, /session-only/);
    assert.match(output, /\[REDACTED\]/);
  }
  assert.deepEqual(store.messages(session.id), [message]);
  assert.deepEqual(store.events(session.id), [event]);
  assert.deepEqual(store.pending(session.id), [
    { id: actionId, call: message.calls[0] },
  ]);
});

test("environment secrets and provider-shaped tokens are redacted", (t) => {
  const { store, session } = fixture(t);
  const variable = "RIVET_EXPORT_TEST_SECRET";
  const previous = process.env[variable];
  process.env[variable] = "export-environment-sensitive-value";
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  store.append(session.id, {
    role: "user",
    content: `${process.env[variable]} sk-1234567890abcdefgh Bearer 1234567890abcdefgh`,
  });
  for (const format of ["json", "markdown"]) {
    const output = exportSession(store, session.id, format);
    assert.doesNotMatch(output, /export-environment|1234567890abcdefgh/);
  }
});

test("JSON encodes untrusted controls without discarding original event content", (t) => {
  const { store, session } = fixture(t);
  const text = "\x1b[31mred\x1b[0m\x00\x9b\u202e\u2066";
  store.event(session.id, { type: "text", text });
  const output = exportSession(store, session.id);
  assert.equal(output.includes("\x1b"), false);
  assert.equal(output.includes("\x00"), false);
  assert.equal(output.includes("\x9b"), false);
  assert.equal(output.includes("\u202e"), false);
  assert.equal(output.includes("\u2066"), false);
  assert.equal(JSON.parse(output).events[0].text, text);
});

test("Markdown contains literal transcript text and terminal-safe event details", (t) => {
  const { store, session } = fixture(t);
  const call = {
    id: "call-1",
    name: "file_patch",
    arguments: {
      path: "example.txt",
      newText: "```html\n<script>alert(1)</script>\n```",
    },
  };
  store.append(session.id, {
    role: "user",
    content: "# injected heading\r\n<script>alert(1)</script>\n```",
  });
  store.append(session.id, { role: "assistant", content: "", calls: [call] });
  store.append(session.id, {
    role: "tool",
    callId: call.id,
    content: "\x1b]0;fake title\x07\x1b[31mfailed\x1b[0m\u202e",
    error: true,
  });
  store.event(session.id, { type: "tool.start", call });
  store.begin(session.id, call);
  const output = exportSession(store, session.id, "markdown");
  assert.match(output, /    # injected heading\n    <script>/);
  assert.match(output, /\n    ```\n/);
  assert.match(output, /### tool\n\n    failed/);
  assert.match(output, /"callId": "call-1"/);
  assert.match(output, /"error": true/);
  assert.match(output, /Do not replay them automatically/);
  assert.equal(output.includes("\x1b"), false);
  assert.equal(output.includes("\u202e"), false);
  assert.equal(output.includes("\r"), false);
  assert.doesNotMatch(output, /^<script>|^```|^# injected/m);
});

test("empty sessions export clearly in both formats", (t) => {
  const { store, session } = fixture(t);
  const json = JSON.parse(exportSession(store, session.id));
  assert.deepEqual(json.messages, []);
  assert.deepEqual(json.events, []);
  assert.deepEqual(json.pending, []);
  const markdown = exportSession(store, session.id, "markdown");
  assert.match(markdown, /No messages/);
  assert.match(markdown, /No pending actions/);
});

test("unknown sessions and invalid export options fail without writes", (t) => {
  const { store, session } = fixture(t);
  assert.throws(
    () => exportSession(store, "missing"),
    (error) => error.exitCode === 2 && /Session not found/.test(error.message),
  );
  assert.throws(() => exportSession(store, session.id, "csv"), /Export format/);
  assert.throws(
    () => exportSession(store, session.id, "json", [undefined]),
    /Export secrets/,
  );
  assert.deepEqual(store.messages(session.id), []);
  assert.deepEqual(store.events(session.id), []);
});

test("redaction masks longer overlapping secrets first", (t) => {
  const { store, session } = fixture(t);
  store.append(session.id, { role: "user", content: "short short-longer" });
  const json = JSON.parse(
    exportSession(store, session.id, "json", ["short", "short-longer"]),
  );
  assert.equal(json.messages[0].content, "[REDACTED] [REDACTED]");
});
