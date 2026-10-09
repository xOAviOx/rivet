import type { Store } from "./store.js";
import { clean, redact } from "./security.js";
import { RivetError } from "./types.js";

export type ExportFormat = "json" | "markdown";
export type ExportStore = Pick<
  Store,
  "get" | "messages" | "events" | "pending"
>;

function mask(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return redact(text);
  }
  if (Array.isArray(value)) return value.map((item) => mask(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mask(item, secrets)]),
    );
  }
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// Indentation makes arbitrary model/tool text literal Markdown, including fences and HTML.
function literal(value: unknown): string {
  const text = clean(typeof value === "string" ? value : json(value)).replace(
    /\r\n?/g,
    "\n",
  );
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/**
 * Read-only export. JSON retains stored event order and control characters as escapes;
 * Markdown strips terminal controls. Both redact known keys without changing the store.
 * Process-only credentials must be supplied explicitly because they are not in process.env.
 */
export function exportSession(
  store: ExportStore,
  id: string,
  format: ExportFormat = "json",
  secrets: string[] = [],
): string {
  if (format !== "json" && format !== "markdown")
    throw new RivetError("Export format must be json or markdown", 2);
  if (!Array.isArray(secrets) || secrets.some((key) => typeof key !== "string"))
    throw new RivetError("Export secrets must be strings", 2);
  const session = store.get(id);
  if (!session) throw new RivetError("Session not found", 2);
  const keys = [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const snapshot = {
    schemaVersion: 1,
    session,
    messages: store.messages(id),
    events: store.events(id),
    pending: store.pending(id),
  };
  if (format === "json") return json(mask(snapshot, keys)) + "\n";

  const blocks = [
    "# Rivet session",
    "## Session",
    literal(mask(session, keys)),
    "## Conversation",
  ];
  for (const message of snapshot.messages) {
    blocks.push(`### ${message.role}`, literal(mask(message.content, keys)));
    if (message.role === "assistant" && message.calls?.length)
      blocks.push("Tool calls:", literal(mask(message.calls, keys)));
    if (message.role === "tool")
      blocks.push(
        literal(
          mask({ callId: message.callId, error: message.error ?? false }, keys),
        ),
      );
  }
  if (snapshot.messages.length === 0) blocks.push("No messages.");
  blocks.push("## Events", literal(mask(snapshot.events, keys)));
  blocks.push("## Pending actions");
  if (snapshot.pending.length)
    blocks.push(
      "These actions have no recorded result. Inspect their effects before resuming. Do not replay them automatically.",
      literal(mask(snapshot.pending, keys)),
    );
  else blocks.push("No pending actions.");
  return blocks.join("\n\n") + "\n";
}
