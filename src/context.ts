import type { Message, ToolCall } from "./types.js";
import { RivetError } from "./types.js";

/** Providers reject transcripts with tool calls that have no recorded result. */
export function unresolvedCalls(messages: Message[]): ToolCall[] {
  const results = new Set(
    messages.flatMap((m) => (m.role === "tool" ? [m.callId] : [])),
  );
  return messages.flatMap((m) =>
    m.role === "assistant"
      ? (m.calls ?? []).filter((call) => !results.has(call.id))
      : [],
  );
}

// A UTF-8 byte per token is deliberately conservative; no undocumented tokenizer is assumed.
export const estimate = (value: unknown) =>
  Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
export function compact(
  messages: Message[],
  budget: number,
): { messages: Message[]; omitted: number } {
  if (budget < 1024) throw new RivetError("Context budget is too small", 4);
  const groups: Message[][] = [];
  for (const m of messages) {
    if (m.role === "user" || groups.length === 0) groups.push([]);
    groups.at(-1)!.push(m);
  }
  const kept: Message[][] = [];
  let used = 256;
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = estimate(groups[i]);
    if (cost + used > budget) {
      if (i === groups.length - 1)
        throw new RivetError(
          "Current turn exceeds context budget; start a new session or select a larger context",
          4,
        );
      break;
    }
    kept.unshift(groups[i]!);
    used += cost;
  }
  const omitted = groups.length - kept.length;
  const result = kept.flat();
  if (omitted)
    result.unshift({
      role: "user",
      content: `[${omitted} earlier complete turns omitted to fit context. Original transcript retained locally. Do not assume omitted facts; inspect files again when necessary.]`,
    });
  return { messages: result, omitted };
}
