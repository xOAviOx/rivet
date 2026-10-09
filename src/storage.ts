import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Message,
  RivetEvent,
  Session,
  SessionStore,
  ToolCall,
} from "./contracts.js";

const SCHEMA_VERSION = 1;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCall(value: unknown): value is ToolCall {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    record(value.arguments)
  );
}

function isMessage(value: unknown): value is Message {
  return (
    record(value) &&
    ["system", "user", "assistant", "tool"].includes(String(value.role)) &&
    typeof value.content === "string" &&
    (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
    (value.toolCalls === undefined ||
      (Array.isArray(value.toolCalls) && value.toolCalls.every(isCall)))
  );
}

function isEvent(value: unknown): value is RivetEvent {
  return (
    record(value) &&
    typeof value.type === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.timestamp === "string"
  );
}

function decode<T>(
  value: unknown,
  valid: (value: unknown) => value is T,
  description: string,
): T {
  try {
    if (typeof value !== "string") throw new Error("expected JSON text");
    const parsed: unknown = JSON.parse(value);
    if (!valid(parsed)) throw new Error("invalid data shape");
    return parsed;
  } catch (cause) {
    throw new Error(
      `Cannot read stored ${description}: invalid or corrupt data`,
      { cause },
    );
  }
}

function sessionFromRow(row: Record<string, unknown>): Session {
  if (
    typeof row.id !== "string" ||
    typeof row.workspace !== "string" ||
    typeof row.model !== "string" ||
    typeof row.created_at !== "string"
  ) {
    throw new Error("Cannot read stored session: invalid or corrupt data");
  }
  return {
    id: row.id,
    workspace: row.workspace,
    model: row.model,
    createdAt: row.created_at,
  };
}

/** Opens a single-writer store. The OS releases its SQLite lease after a crash. */
export function openSessionStore(directory: string): SessionStore {
  const storeDirectory = resolve(directory);
  mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
  let lease: DatabaseSync | undefined;
  let database: DatabaseSync | undefined;
  try {
    // A separate database holds an exclusive transaction for this store's lifetime.
    // Unlike PID files, SQLite locks cannot accidentally evict a live or reused PID.
    lease = new DatabaseSync(join(storeDirectory, "writer.sqlite"));
    try {
      lease.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    } catch (cause) {
      throw new Error(
        `Cannot acquire session-store writer lock at ${storeDirectory}; another Rivet process may be using it`,
        { cause },
      );
    }
    database = new DatabaseSync(join(storeDirectory, "sessions.sqlite"));
    database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number" || version > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported session-store schema version: ${String(version)}`,
      );
    }
    if (version === 0) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          workspace TEXT NOT NULL,
          model TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX messages_session ON messages(session_id, sequence);
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          payload TEXT NOT NULL CHECK(json_valid(payload))
        );
        CREATE INDEX events_session ON events(session_id, sequence);
        CREATE TABLE actions (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          call TEXT NOT NULL CHECK(json_valid(call)),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          result TEXT
        );
        CREATE INDEX actions_session ON actions(session_id, sequence);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  } catch (cause) {
    try {
      database?.close();
    } finally {
      lease?.close();
    }
    throw new Error(
      `Cannot open session store: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const db = database;
  const writerLease = lease;
  let closed = false;
  function assertOpen(): void {
    if (closed) throw new Error("Session store is closed");
  }
  function requireSession(id: string): void {
    assertOpen();
    if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(id))
      throw new Error(`Session not found: ${id}`);
  }

  return {
    createSession(workspace, model) {
      assertOpen();
      const session: Session = {
        id: randomUUID(),
        workspace: resolve(workspace),
        model,
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO sessions (id, workspace, model, created_at) VALUES (?, ?, ?, ?)",
      ).run(session.id, session.workspace, session.model, session.createdAt);
      return session;
    },
    getSession(id) {
      assertOpen();
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
      return row ? sessionFromRow(row) : undefined;
    },
    listSessions() {
      assertOpen();
      return db
        .prepare("SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC")
        .all()
        .map(sessionFromRow);
    },
    appendMessage(sessionId, message) {
      requireSession(sessionId);
      if (!isMessage(message)) throw new Error("Invalid message");
      db.prepare(
        "INSERT INTO messages (session_id, payload) VALUES (?, ?)",
      ).run(sessionId, JSON.stringify(message));
    },
    getMessages(sessionId) {
      requireSession(sessionId);
      return db
        .prepare(
          "SELECT payload FROM messages WHERE session_id = ? ORDER BY sequence",
        )
        .all(sessionId)
        .map((row) => decode(row.payload, isMessage, "message"));
    },
    appendEvent(event) {
      assertOpen();
      if (!isEvent(event)) throw new Error("Invalid event");
      requireSession(event.sessionId);
      db.prepare("INSERT INTO events (session_id, payload) VALUES (?, ?)").run(
        event.sessionId,
        JSON.stringify(event),
      );
    },
    getEvents(sessionId) {
      requireSession(sessionId);
      return db
        .prepare(
          "SELECT payload FROM events WHERE session_id = ? ORDER BY sequence",
        )
        .all(sessionId)
        .map((row) => decode(row.payload, isEvent, "event"));
    },
    beginAction(sessionId, call) {
      requireSession(sessionId);
      if (!isCall(call)) throw new Error("Invalid tool call");
      const id = randomUUID();
      // Autocommit is durable before the caller starts the external action.
      db.prepare(
        "INSERT INTO actions (id, session_id, call, started_at) VALUES (?, ?, ?, ?)",
      ).run(id, sessionId, JSON.stringify(call), new Date().toISOString());
      return id;
    },
    finishAction(actionId, result) {
      assertOpen();
      const changed = db
        .prepare(
          "UPDATE actions SET finished_at = ?, result = ? WHERE id = ? AND finished_at IS NULL",
        )
        .run(new Date().toISOString(), result, actionId).changes;
      if (changed === 0)
        throw new Error(`Action not found or already finished: ${actionId}`);
    },
    getPendingActions(sessionId) {
      requireSession(sessionId);
      return db
        .prepare(
          "SELECT id, call FROM actions WHERE session_id = ? AND finished_at IS NULL ORDER BY sequence",
        )
        .all(sessionId)
        .map((row) => {
          if (typeof row.id !== "string")
            throw new Error("Cannot read stored action: invalid id");
          return { id: row.id, call: decode(row.call, isCall, "tool call") };
        });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        writerLease.close();
      }
    },
  };
}
