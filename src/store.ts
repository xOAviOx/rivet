import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import {
  RivetError,
  type AgentEvent,
  type Message,
  type ToolCall,
} from "./types.js";

export type Session = {
  id: string;
  workspace: string;
  model: string;
  createdAt: string;
};

function regularFile(path: string) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new RivetError(
        "Session database must be a regular, unlinked file",
        2,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** One process owns a store; SQLite releases the separate writer lock on crashes. */
export class Store {
  private db!: DatabaseSync;
  private lock!: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
    for (const suffix of [
      "",
      "-wal",
      "-shm",
      "-journal",
      ".writer-lock",
      ".writer-lock-journal",
    ]) {
      regularFile(canonical + suffix);
    }
    try {
      this.lock = new DatabaseSync(canonical + ".writer-lock");
      chmodSync(canonical + ".writer-lock", 0o600);
      try {
        this.lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      } catch {
        throw new RivetError(
          "Session store is already open by another writer",
          2,
        );
      }
      this.db = new DatabaseSync(canonical);
      chmodSync(canonical, 0o600);
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL",
      );
      const version = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version.user_version > 1)
        throw new RivetError(
          "Session database was created by a newer Rivet version",
          2,
        );
      if (version.user_version === 0) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, model TEXT NOT NULL, createdAt TEXT NOT NULL);
          CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
          CREATE INDEX messages_session ON messages(session,seq);
          CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
          CREATE INDEX events_session ON events(session,seq);
          CREATE TABLE actions (id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id), call TEXT NOT NULL, result TEXT, createdAt TEXT NOT NULL);
          CREATE INDEX actions_session ON actions(session);
          PRAGMA user_version=1; COMMIT;`);
      }
    } catch (error) {
      this.db?.close();
      this.lock?.close();
      throw error;
    }
  }

  create(workspace: string, model: string): Session {
    const session = {
      id: randomUUID(),
      workspace,
      model,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,?,?)")
      .run(session.id, workspace, model, session.createdAt);
    return session;
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    return row ? ({ ...row } as Session) : undefined;
  }

  list(): Session[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY createdAt DESC, rowid DESC")
      .all()
      .map((row) => ({ ...row }) as Session);
  }

  messages(id: string): Message[] {
    return this.db
      .prepare("SELECT body FROM messages WHERE session=? ORDER BY seq")
      .all(id)
      .map((row) => JSON.parse(String(row.body)) as Message);
  }

  append(id: string, message: Message) {
    this.db
      .prepare("INSERT INTO messages(session,body) VALUES (?,?)")
      .run(id, JSON.stringify(message));
  }

  event(id: string, event: AgentEvent) {
    this.db
      .prepare("INSERT INTO events(session,body) VALUES (?,?)")
      .run(id, JSON.stringify(event));
  }

  events(id: string): AgentEvent[] {
    return this.db
      .prepare("SELECT body FROM events WHERE session=? ORDER BY seq")
      .all(id)
      .map((row) => JSON.parse(String(row.body)) as AgentEvent);
  }

  begin(id: string, call: ToolCall): string {
    const actionId = randomUUID();
    this.db
      .prepare("INSERT INTO actions VALUES (?,?,?,?,?)")
      .run(actionId, id, JSON.stringify(call), null, new Date().toISOString());
    return actionId;
  }

  finish(actionId: string, result: string) {
    const updated = this.db
      .prepare("UPDATE actions SET result=? WHERE id=? AND result IS NULL")
      .run(result, actionId);
    if (updated.changes !== 1)
      throw new RivetError("Action is missing or already resolved");
  }

  /** Unfinished actions require user reconciliation; this store never replays them. */
  pending(id: string): Array<{ id: string; call: ToolCall }> {
    return this.db
      .prepare(
        "SELECT id,call FROM actions WHERE session=? AND result IS NULL ORDER BY rowid",
      )
      .all(id)
      .map((row) => ({
        id: String(row.id),
        call: JSON.parse(String(row.call)) as ToolCall,
      }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.lock.close();
    }
  }
}
