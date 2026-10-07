import {
  createInterface,
  emitKeypressEvents,
  type Interface,
} from "node:readline";
import { sep } from "node:path";
import { clean, type Decision } from "./security.js";
import type { AgentEvent, ToolCall } from "./types.js";

export type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};
export type TerminalOutput = NodeJS.WritableStream & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  hasColors?: () => boolean;
};
export type TerminalOptions = {
  input?: TerminalInput;
  output?: TerminalOutput;
  /** Raw-mode editor; defaults to true when both streams are TTYs. */
  interactive?: boolean;
  color?: boolean;
  columns?: number;
  workspace?: string;
  /** Overrides the destination shown in approval prompts. */
  destination?: (name: string, args: Record<string, unknown>) => string;
  /** Ctrl+C while work is active, or while an approval is open. */
  onInterrupt?: () => void;
  /** Rewrites a submitted message before it is echoed or kept in history. */
  conceal?: (text: string) => string;
  flushMs?: number;
};
export type HeaderInfo = {
  workspace: string;
  provider: string;
  model: string;
  mode: string;
};
export interface Terminal {
  readonly interactive: boolean;
  header(info: HeaderInfo): void;
  render(event: AgentEvent): void;
  print(text: string): void;
  /** Resolves null when the user exits (idle Ctrl+C or Ctrl+D) or input ends. */
  prompt(): Promise<string | null>;
  approve(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Decision>;
  /** Reads one visible line; null when cancelled (Esc, Ctrl+C, abort) or input ends. */
  ask(question: string, signal?: AbortSignal): Promise<string | null>;
  /** Reads a value without echo; null when cancelled or empty. */
  secret(label: string): Promise<string | null>;
  /** Yes/no question. Only "y" answers yes; Enter, Esc, and Ctrl+C answer no. */
  confirm(question: string, signal?: AbortSignal): Promise<boolean>;
  close(): void;
}

type Key = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
};
type Modal = {
  line: string;
  key(ch: string | undefined, key: Key): void;
  paste?(text: string): void;
  cancel(): void;
};

const MAX_INPUT = 512 * 1024;
const MAX_SECRET = 16 * 1024;
const MAX_ANSWER = 4096;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
const wideRanges: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];
/* eslint-disable no-control-regex -- Terminal output deliberately inspects control characters. */
const unsafe =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
const controlChar = /[\u0000-\u001f\u007f]/;
const controlChars = /[\u0000-\u001f\u007f]/g;
// CSI-u Enter: ConPTY reports Alt+Enter as ESC[13;3u, which Node leaves unnamed.
const modifiedEnter = /^\x1b\[13;(\d+)u$/;
// An escape sequence split across stream deltas is held back until it completes.
const incompleteEscape = /\x1b(?:\][^\x07\x1b]*|\[[0-?]*[ -/]*)?$/;
/* eslint-enable no-control-regex */

function cellWidth(grapheme: string): number {
  if (zeroWidth.test(grapheme)) return 0;
  const cp = grapheme.codePointAt(0) ?? 0;
  if (
    grapheme.includes("\ufe0f") ||
    wideRanges.some(([low, high]) => cp >= low && cp <= high)
  )
    return 2;
  return 1;
}
export function width(text: string): number {
  let total = 0;
  for (const { segment } of segmenter.segment(text))
    total += cellWidth(segment);
  return total;
}
/** Where text ends when written from column 0 with terminal auto-wrap. */
function place(text: string, cols: number) {
  let row = 0;
  let col = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = cellWidth(segment);
    if (!w) continue;
    if (col + w > cols) {
      row++;
      col = 0;
    }
    col += w;
  }
  return { row, col };
}
function wrapRows(text: string, cols: number): string[] {
  const rows = [""];
  let col = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = cellWidth(segment);
    if (w && col + w > cols && col > 0) {
      rows.push("");
      col = 0;
    }
    rows[rows.length - 1] += segment;
    col += w;
  }
  return rows;
}
export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = cellWidth(segment);
    if (used + w > max - 1) break;
    out += segment;
    used += w;
  }
  return out + "…";
}
function truncateStart(text: string, max: number): string {
  if (width(text) <= max) return text;
  const parts = [...segmenter.segment(text)].map((s) => s.segment);
  let out = "";
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const w = cellWidth(parts[i]!);
    if (used + w > max - 1) break;
    out = parts[i] + out;
    used += w;
  }
  return "…" + out;
}
const hex = (c: string) => c.charCodeAt(0).toString(16).padStart(4, "0");
/** Exact JSON with every terminal-affecting character escaped. */
export const jsonVisible = (value: unknown) =>
  (JSON.stringify(value) ?? "undefined").replace(unsafe, (c) => `\\u${hex(c)}`);
/** Text with controls and bidi characters shown as `<U+XXXX>`; tabs and newlines kept. */
export const textVisible = (text: string) =>
  text.replace(unsafe, (c) => `<U+${hex(c).toUpperCase()}>`);
const oneLine = (text: string) => clean(text.replace(/\s+/g, " ")).trim();
const display = (text: string) => text.replace(/\t/g, "    ");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function summarize(call: ToolCall): string {
  const a = call.arguments;
  const list = Array.isArray(a.args)
    ? a.args.filter((x): x is string => typeof x === "string")
    : [];
  let detail: string;
  if (call.name === "git") detail = list.join(" ");
  else if (typeof a.command === "string")
    detail = [a.command, ...list].join(" ");
  else if (typeof a.path === "string")
    detail = a.path + (typeof a.query === "string" ? ` "${a.query}"` : "");
  else if (typeof a.query === "string") detail = `"${a.query}"`;
  else detail = Object.keys(a).length ? (JSON.stringify(a) ?? "") : "";
  return oneLine(`${call.name} ${detail}`);
}
function outcome(result: string, error: boolean): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const r = parsed as Record<string, unknown>;
    if (typeof r.error === "string") return `failed: ${oneLine(r.error)}`;
    const notes: string[] = [];
    if (r.stopped === "timeout") notes.push("timed out");
    else if (typeof r.stopped === "string") notes.push(oneLine(r.stopped));
    if (typeof r.exitCode === "number" && r.exitCode !== 0)
      notes.push(`exit ${r.exitCode}`);
    if (r.truncated === true) notes.push("output truncated");
    if (notes.length) return (error ? "failed: " : "") + notes.join(", ");
  }
  if (!error) return "";
  return `failed: ${oneLine(result.split("\n")[0] ?? "") || "no details"}`;
}
function approvalBlock(
  name: string,
  args: Record<string, unknown>,
  destination: string,
): string {
  const lines = [
    `approval required: ${textVisible(name)}`,
    `  destination: ${textVisible(destination)}`,
  ];
  const entries = Object.entries(args);
  if (!entries.length) lines.push("  arguments: none");
  for (const [key, value] of entries) {
    const label = `  ${textVisible(key)}:`;
    if (typeof value === "string" && value.includes("\n")) {
      const parts = value.split("\n");
      const trailing = parts.at(-1) === "";
      if (trailing) parts.pop();
      lines.push(
        `${label} ${plural(parts.length, "line")}${trailing ? ", ending with a newline" : ""}`,
      );
      for (const part of parts) lines.push(`    | ${textVisible(part)}`);
    } else lines.push(`${label} ${jsonVisible(value)}`);
  }
  return lines.join("\n") + "\n";
}
function decisionLabel(decision: string): string {
  return decision === "once"
    ? "approved once"
    : decision === "session"
      ? "approved for this session (same tool and arguments)"
      : decision === "deny"
        ? "denied"
        : `approval ${oneLine(decision)}`;
}
const choices: Record<string, Decision> = {
  o: "once",
  "1": "once",
  s: "session",
  "2": "session",
  d: "deny",
  n: "deny",
  "3": "deny",
};
function parseDecision(answer: string | null): Decision {
  const a = (answer ?? "").trim().toLowerCase();
  if (a === "once") return "once";
  if (a === "session") return "session";
  return choices[a] ?? "deny";
}

export function createTerminal(options: TerminalOptions = {}): Terminal {
  const input: TerminalInput = options.input ?? process.stdin;
  const output: TerminalOutput = options.output ?? process.stdout;
  const interactive =
    options.interactive ??
    (!!input.isTTY && !!output.isTTY && typeof input.setRawMode === "function");
  const color =
    options.color ??
    (!!output.isTTY &&
      !process.env.NO_COLOR &&
      process.env.TERM !== "dumb" &&
      (output.hasColors?.() ?? true));
  const flushMs = options.flushMs ?? 16;
  // In-process SIGINT listeners run without the forced termination process.kill causes on Windows.
  const interrupt =
    options.onInterrupt ?? (() => void process.emit("SIGINT", "SIGINT"));
  const cyan = (text: string) => (color ? `\x1b[36m${text}\x1b[39m` : text);
  const columns = () =>
    Math.max(
      2,
      options.columns ??
        (interactive || output.isTTY ? output.columns || 80 : Infinity),
    );
  const destinationOf = (name: string, args: Record<string, unknown>) => {
    if (options.destination) return options.destination(name, args);
    const root = options.workspace ?? process.cwd();
    if (name.startsWith("mcp_")) return `MCP server tool ${name}`;
    const target =
      typeof args.path === "string"
        ? args.path
        : typeof args.cwd === "string"
          ? args.cwd
          : "";
    const where = target && target !== "." ? `${root}${sep}${target}` : root;
    const host =
      name === "command" ||
      name === "git" ||
      typeof args.command === "string" ||
      Array.isArray(args.args);
    return host ? `host process in ${where} (not sandboxed)` : where;
  };

  let closed = false;
  let wrote = false;
  let batch = "";
  let partial = "";
  let atLineStart = true;
  let timer: NodeJS.Timeout | undefined;
  const running = new Map<string, ToolCall>();
  let working = false;
  let interrupting = false;
  let usage:
    { total: number; cost: number | null; estimated: boolean } | undefined;
  let ownsApprovals = false;

  let buffer = "";
  let cursor = 0;
  const history: string[] = [];
  let historyIndex = 0;
  let draft = "";
  const queued: string[] = [];
  let pendingPrompt: ((value: string | null) => void) | undefined;
  let modal: Modal | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let pasting = false;
  let pasted = "";
  let pasteCR = false;
  let pasteOverflow = false;

  let drawn = false;
  let liveCursorRow = 0;
  let drawScheduled = false;

  function clearLive(): string {
    if (!drawn) return "";
    drawn = false;
    return (
      "\r" + (liveCursorRow > 0 ? `\x1b[${liveCursorRow}A` : "") + "\x1b[J"
    );
  }
  function liveLines() {
    const cols = columns();
    const lines: Array<{ plain: string; text: string }> = [];
    const add = (plain: string, text = plain) => lines.push({ plain, text });
    if (partial) add(partial);
    for (const call of running.values())
      add(truncate(`  running ${summarize(call)}`, cols - 1));
    if (modal) {
      add(modal.line, cyan(modal.line));
      return { lines, cursor: { line: lines.length - 1, before: modal.line } };
    }
    if (working && !pendingPrompt) {
      const status =
        (interrupting ? "  interrupting…" : "  working · Ctrl+C interrupts") +
        (queued.length ? ` · ${queued.length} queued` : "");
      add(truncate(status, cols - 1));
    }
    const editor = buffer.split("\n");
    const prefix = (i: number) => (i === 0 ? "> " : "  ");
    const cursorLine = buffer.slice(0, cursor).split("\n").length - 1;
    const lineStart = buffer.lastIndexOf("\n", cursor - 1) + 1;
    const rowsPer = editor.map(
      (l, i) => place(prefix(i) + display(l), cols).row + 1,
    );
    const available = Math.max(3, (output.rows || 24) - 1 - lines.length);
    let first = 0;
    let last = editor.length - 1;
    if (rowsPer.reduce((a, b) => a + b, 0) > available) {
      // Show a window around the cursor so the live region never exceeds the screen.
      first = last = cursorLine;
      let used = rowsPer[cursorLine]!;
      const budget = available - 2;
      for (let grew = true; grew;) {
        grew = false;
        if (last + 1 < editor.length && used + rowsPer[last + 1]! <= budget) {
          used += rowsPer[++last]!;
          grew = true;
        }
        if (first > 0 && used + rowsPer[first - 1]! <= budget) {
          used += rowsPer[--first]!;
          grew = true;
        }
      }
    }
    if (first > 0) add(`  … ${plural(first, "more line")} above`);
    let cursorIndex = 0;
    for (let i = first; i <= last; i++) {
      const body = display(editor[i]!);
      if (i === cursorLine) cursorIndex = lines.length;
      add(prefix(i) + body, (i === 0 ? cyan(">") + " " : "  ") + body);
    }
    if (last < editor.length - 1)
      add(`  … ${plural(editor.length - 1 - last, "more line")} below`);
    return {
      lines,
      cursor: {
        line: cursorIndex,
        before: prefix(cursorLine) + display(buffer.slice(lineStart, cursor)),
      },
    };
  }
  function drawLive(): string {
    const cols = columns();
    const { lines, cursor: target } = liveLines();
    let out = "";
    let total = 0;
    const starts: number[] = [];
    lines.forEach((line, i) => {
      if (i) out += "\r\n";
      out += line.text;
      starts.push(total);
      total += place(line.plain, cols).row + 1;
    });
    const at = place(target.before, cols);
    let row = (starts[target.line] ?? 0) + at.row;
    let col = at.col;
    if (col >= cols) {
      row++;
      col = 0;
    }
    // Carriage return clears any pending-wrap state before relative cursor moves.
    out += "\r";
    if (row > total - 1) {
      out += "\n";
      total = row + 1;
    }
    const up = total - 1 - row;
    if (up > 0) out += `\x1b[${up}A`;
    if (col > 0) out += `\x1b[${col}C`;
    liveCursorRow = row;
    drawn = true;
    return out;
  }
  function paint(commit = "") {
    if (closed) return;
    if (commit) wrote = true;
    if (!interactive) {
      if (commit) {
        output.write(commit);
        atLineStart = commit.endsWith("\n");
      }
      return;
    }
    // Raw mode disables output newline translation, so every LF needs an explicit CR.
    output.write(clearLive() + commit.replace(/\r?\n/g, "\r\n") + drawLive());
  }
  function draw() {
    if (drawScheduled || !interactive) return;
    drawScheduled = true;
    setImmediate(() => {
      drawScheduled = false;
      paint();
    });
  }

  function flushText(all = false) {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!batch) return;
    let raw = batch;
    batch = "";
    if (!all) {
      const match = incompleteEscape.exec(raw);
      if (match && raw.length - match.index <= 256) {
        batch = raw.slice(match.index);
        raw = raw.slice(0, match.index);
      }
    }
    const text = display(clean(raw.replace(/\r\n/g, "\n")));
    if (!text) return;
    if (!interactive) {
      paint(text);
      return;
    }
    const joined = partial + text;
    const newline = joined.lastIndexOf("\n");
    let commit = newline >= 0 ? joined.slice(0, newline + 1) : "";
    let rest = joined.slice(newline + 1);
    // Commit complete visual rows so the live region keeps at most one partial row.
    const rows = wrapRows(rest, columns());
    if (rows.length > 1) {
      commit += rows.slice(0, -1).join("\n") + "\n";
      rest = rows.at(-1) ?? "";
    }
    partial = rest;
    paint(commit);
  }
  function scheduleFlush() {
    if (!timer) timer = setTimeout(() => flushText(), flushMs);
  }
  /** Ends any partially streamed line; returns text to commit before the next line. */
  function finalize(): string {
    flushText(true);
    if (interactive) {
      const rest = partial;
      partial = "";
      return rest ? rest + "\n" : "";
    }
    if (!atLineStart) {
      atLineStart = true;
      return "\n";
    }
    return "";
  }
  const commitLines = (text: string) => paint(finalize() + text + "\n");

  function echo(text: string) {
    const lines = text
      .split("\n")
      .map((line, i) => (i ? "  " : "> ") + display(line));
    paint(finalize() + (wrote ? "\n" : "") + lines.join("\n") + "\n");
  }
  function insert(text: string) {
    let value = clean(text.replace(/\r\n?/g, "\n"));
    if (!value) return;
    if (buffer.length + value.length > MAX_INPUT) {
      value = value.slice(0, Math.max(0, MAX_INPUT - buffer.length));
      paint("  input limit reached (512 KiB); extra text was not inserted\n");
    }
    buffer = buffer.slice(0, cursor) + value + buffer.slice(cursor);
    cursor += value.length;
  }
  function previous(i: number): number {
    if (i <= 0) return 0;
    const start = Math.max(0, i - 64);
    let last = start;
    for (const { index } of segmenter.segment(buffer.slice(start, i)))
      last = start + index;
    return last;
  }
  function following(i: number): number {
    for (const { segment } of segmenter.segment(buffer.slice(i, i + 64)))
      return i + segment.length;
    return buffer.length;
  }
  const lineStartOf = (i: number) => buffer.lastIndexOf("\n", i - 1) + 1;
  const lineEndOf = (i: number) => {
    const end = buffer.indexOf("\n", i);
    return end < 0 ? buffer.length : end;
  };
  function wordLeft(i: number) {
    while (i > 0 && /\s/.test(buffer[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(buffer[i - 1]!)) i--;
    return i;
  }
  function wordRight(i: number) {
    while (i < buffer.length && /\s/.test(buffer[i]!)) i++;
    while (i < buffer.length && !/\s/.test(buffer[i]!)) i++;
    return i;
  }
  function atColumn(from: number, to: number, column: number) {
    let used = 0;
    for (const { index, segment } of segmenter.segment(
      buffer.slice(from, to),
    )) {
      const w = width(display(segment));
      if (used + w > column) return from + index;
      used += w;
    }
    return to;
  }
  function remove(from: number, to: number) {
    buffer = buffer.slice(0, from) + buffer.slice(to);
    cursor = from;
  }
  function recall(index: number) {
    if (historyIndex === history.length) draft = buffer;
    historyIndex = index;
    buffer = index === history.length ? draft : history[index]!;
    cursor = buffer.length;
  }
  function moveVertical(direction: -1 | 1) {
    const start = lineStartOf(cursor);
    const column = width(display(buffer.slice(start, cursor)));
    if (direction < 0) {
      if (start === 0) {
        if (historyIndex > 0) recall(historyIndex - 1);
        return;
      }
      cursor = atColumn(lineStartOf(start - 1), start - 1, column);
    } else {
      const end = lineEndOf(cursor);
      if (end === buffer.length) {
        if (historyIndex < history.length) recall(historyIndex + 1);
        return;
      }
      cursor = atColumn(end + 1, lineEndOf(end + 1), column);
    }
  }
  const shown = (text: string) => options.conceal?.(text) ?? text;
  function submit() {
    const text = buffer;
    if (!text.trim()) return;
    if (history.at(-1) !== shown(text)) history.push(shown(text));
    if (history.length > 100) history.shift();
    historyIndex = history.length;
    draft = "";
    buffer = "";
    cursor = 0;
    const resolve = pendingPrompt;
    if (resolve) {
      pendingPrompt = undefined;
      working = true;
      echo(shown(text));
      resolve(text);
    } else if (queued.length < 10) {
      queued.push(text);
      draw();
    } else paint("  queue is full; message not queued\n");
  }
  function editorKey(ch: string | undefined, key: Key) {
    const name = key.name;
    const modified = modifiedEnter.exec(key.sequence ?? "");
    if (modified) {
      if (Number(modified[1]) <= 1) return submit();
      insert("\n");
    } else if (key.ctrl && name === "c") {
      if (pendingPrompt) {
        if (!buffer) return finishPrompt(null);
        buffer = "";
        cursor = 0;
        historyIndex = history.length;
      } else {
        // Interrupting hands control back: queued messages return to the draft unsent.
        if (queued.length) {
          buffer = [...queued.splice(0), ...(buffer ? [buffer] : [])].join(
            "\n\n",
          );
          cursor = buffer.length;
        }
        interrupting = true;
        interrupt();
      }
    } else if (key.ctrl && name === "d") {
      if (!buffer && pendingPrompt) return finishPrompt(null);
      remove(cursor, following(cursor));
    } else if (name === "return") {
      if (key.meta) insert("\n");
      else if (buffer[cursor - 1] === "\\") {
        buffer = buffer.slice(0, cursor - 1) + "\n" + buffer.slice(cursor);
      } else return submit();
    } else if (name === "enter" || (key.ctrl && name === "j")) insert("\n");
    else if (name === "backspace") {
      remove(key.meta ? wordLeft(cursor) : previous(cursor), cursor);
    } else if (name === "delete") remove(cursor, following(cursor));
    else if (name === "left")
      cursor = key.ctrl || key.meta ? wordLeft(cursor) : previous(cursor);
    else if (name === "right")
      cursor = key.ctrl || key.meta ? wordRight(cursor) : following(cursor);
    else if (name === "home" || (key.ctrl && name === "a"))
      cursor = lineStartOf(cursor);
    else if (name === "end" || (key.ctrl && name === "e"))
      cursor = lineEndOf(cursor);
    else if (name === "up") moveVertical(-1);
    else if (name === "down") moveVertical(1);
    else if (key.ctrl && name === "u") remove(lineStartOf(cursor), cursor);
    else if (key.ctrl && name === "k") {
      buffer = buffer.slice(0, cursor) + buffer.slice(lineEndOf(cursor));
    } else if (key.ctrl && name === "w") remove(wordLeft(cursor), cursor);
    else if (key.meta && name === "b") cursor = wordLeft(cursor);
    else if (key.meta && name === "f") cursor = wordRight(cursor);
    else if (name === "tab") insert("\t");
    else if (ch && !key.ctrl && !key.meta && !controlChar.test(ch)) insert(ch);
    else return;
    draw();
  }
  function finishPrompt(value: string | null) {
    const resolve = pendingPrompt;
    pendingPrompt = undefined;
    paint();
    resolve?.(value);
  }
  function onKey(ch: string | undefined, key: Key | undefined) {
    if (closed) return;
    const k: Key = key ?? { sequence: ch };
    if (k.name === "paste-start") {
      pasting = true;
      pasted = "";
      pasteCR = false;
      pasteOverflow = false;
      return;
    }
    if (k.name === "paste-end") {
      pasting = false;
      const text = pasted;
      pasted = "";
      if (pasteOverflow)
        paint("  paste exceeded 512 KiB; extra text was not inserted\n");
      if (modal) modal.paste?.(text);
      else insert(text);
      draw();
      return;
    }
    if (pasting) {
      // Pasted line breaks stay in the editor; only a typed Enter submits.
      let piece = "";
      if (k.name === "return") {
        piece = "\n";
        pasteCR = true;
      } else if (k.name === "enter" && pasteCR) pasteCR = false;
      else {
        pasteCR = false;
        piece = k.name === "enter" ? "\n" : k.name === "tab" ? "\t" : ch || "";
      }
      if (pasted.length + piece.length > MAX_INPUT) pasteOverflow = true;
      else pasted += piece;
      return;
    }
    if (modal) {
      modal.key(ch, k);
      return;
    }
    editorKey(ch, k);
  }

  let reader: Interface | undefined;
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let ended = false;
  function nextLine(signal?: AbortSignal): Promise<string | null> {
    if (!reader) {
      reader = createInterface({ input, terminal: false, crlfDelay: Infinity });
      reader.on("line", (line) => {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      });
      reader.on("close", () => {
        ended = true;
        for (const waiter of waiters.splice(0)) waiter(null);
      });
    }
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (ended || closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (line: string | null) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve(null);
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task);
    chain = result.catch(() => undefined);
    return result;
  }

  const onResize = () => paint();
  if (interactive) {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKey);
    input.resume();
    output.on("resize", onResize);
    output.write("\x1b[?2004h");
    paint();
  }

  return {
    interactive,
    header(info) {
      const cols = columns();
      const rest = oneLine(` / ${info.provider}:${info.model} / ${info.mode}`);
      const room = cols - 1 - width("rivet  ") - width(rest) - 1;
      const workspace = truncateStart(
        oneLine(info.workspace),
        Math.max(8, room),
      );
      commitLines(truncate(`rivet  ${workspace} ${rest}`, cols - 1));
    },
    render(event) {
      if (closed) return;
      if (event.type === "text") {
        working = true;
        batch += event.text;
        if (batch.length > 65536) flushText();
        else scheduleFlush();
        return;
      }
      const cols = columns();
      switch (event.type) {
        case "session":
          commitLines(
            truncate(
              `  session ${oneLine(event.id)} · ${oneLine(event.model)} via ${oneLine(event.destination)}`,
              cols - 1,
            ),
          );
          return;
        case "status":
          working = true;
          commitLines(`  ${oneLine(event.message)}`);
          return;
        case "approval":
          if (event.decision && !ownsApprovals)
            commitLines(
              `  ${decisionLabel(event.decision)}: ${oneLine(event.tool)}`,
            );
          return;
        case "tool.start":
          working = true;
          running.set(event.call.id, event.call);
          paint(finalize());
          return;
        case "tool.end": {
          const call = running.get(event.id) ?? {
            id: event.id,
            name: "tool",
            arguments: {},
          };
          running.delete(event.id);
          const summary = `  ${summarize(call)}`;
          const result = outcome(event.result, event.error);
          const tail = result ? ` · ${result}` : "";
          const room = cols - 1 - width(tail);
          commitLines(
            !result
              ? truncate(summary, cols - 1)
              : room >= 16
                ? truncate(summary, room) + tail
                : `${truncate(summary, cols - 1)}\n${truncate(`    ${result}`, cols - 1)}`,
          );
          return;
        }
        case "usage":
          usage = {
            total: event.total,
            cost: event.cost,
            estimated: !!event.usage.estimated,
          };
          return;
        case "error":
          commitLines(`error: ${clean(event.message)}`);
          return;
        case "done": {
          working = false;
          interrupting = false;
          running.clear();
          const u = usage;
          usage = undefined;
          const line =
            event.reason === "cancelled"
              ? "  interrupted"
              : event.reason === "limit"
                ? "  stopped: limit reached"
                : event.reason === "error"
                  ? "  stopped after an error"
                  : u
                    ? `  ${u.total.toLocaleString("en-US")} tokens${u.estimated ? " (estimated)" : ""}${u.cost === null ? "" : ` · $${u.cost.toFixed(4)}`}`
                    : "";
          if (line) commitLines(line);
          else paint(finalize());
          return;
        }
      }
    },
    print(text) {
      if (closed) return;
      const body = clean(text.replace(/\r\n/g, "\n")).replace(/\n$/, "");
      commitLines(display(body));
    },
    prompt() {
      if (closed) return Promise.resolve(null);
      working = false;
      interrupting = false;
      // A turn that threw before "done" must not leave tools shown as running.
      running.clear();
      if (!interactive)
        return (async () => {
          paint(finalize());
          for (;;) {
            const line = await nextLine();
            if (line === null || line.trim()) return line;
          }
        })();
      if (pendingPrompt)
        return Promise.reject(new Error("A prompt is already pending"));
      const next = queued.shift();
      if (next !== undefined) {
        working = true;
        echo(shown(next));
        return Promise.resolve(next);
      }
      return new Promise((resolve) => {
        pendingPrompt = resolve;
        paint(finalize());
      });
    },
    approve(name, args, signal) {
      ownsApprovals = true;
      return exclusive(
        () =>
          new Promise<Decision>((resolve) => {
            if (closed || signal.aborted) return resolve("deny");
            const block = approvalBlock(name, args, destinationOf(name, args));
            let done = false;
            const finish = (decision: Decision, label: string) => {
              if (done) return;
              done = true;
              signal.removeEventListener("abort", onAbort);
              modal = undefined;
              commitLines(`  ${label}`);
              resolve(decision);
            };
            const onAbort = () => finish("deny", "cancelled");
            signal.addEventListener("abort", onAbort, { once: true });
            if (!interactive) {
              paint(
                finalize() +
                  block +
                  "approve? once (o), session rule (s), deny (d): ",
              );
              void nextLine(signal).then((answer) => {
                if (done) return;
                const decision = parseDecision(answer);
                paint("\n");
                finish(decision, decisionLabel(decision));
              });
              return;
            }
            modal = {
              line: "approve: once (o) · session rule (s) · deny (d) · Esc cancels",
              key(ch, key) {
                if (key.ctrl && key.name === "c") {
                  finish("deny", "cancelled");
                  interrupting = true;
                  interrupt();
                  return;
                }
                if (key.name === "escape") return finish("deny", "cancelled");
                if (key.ctrl || key.meta) return;
                // Enter and unknown keys are ignored: there is no default choice.
                const choice = choices[(ch ?? "").toLowerCase()];
                if (choice) finish(choice, decisionLabel(choice));
              },
              cancel: () => finish("deny", "cancelled"),
            };
            paint(finalize() + block);
          }),
      );
    },
    ask(question, signal) {
      return exclusive(
        () =>
          new Promise<string | null>((resolve) => {
            if (closed || signal?.aborted) return resolve(null);
            const label = oneLine(question);
            let done = false;
            const finish = (answer: string | null) => {
              if (done) return;
              done = true;
              signal?.removeEventListener("abort", onAbort);
              modal = undefined;
              commitLines(
                `  ${label} ${answer === null ? "(cancelled)" : textVisible(answer)}`,
              );
              resolve(answer);
            };
            const onAbort = () => finish(null);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (!interactive) {
              paint(finalize() + `${label} `);
              void nextLine(signal).then((line) => {
                if (done) return;
                paint("\n");
                finish(line);
              });
              return;
            }
            let value = "";
            const prompt: Modal = {
              line: `${label} `,
              key(ch, key) {
                if ((key.ctrl && key.name === "c") || key.name === "escape")
                  return finish(null);
                if (key.name === "return" || key.name === "enter")
                  return finish(value);
                if (key.name === "backspace")
                  value = Array.from(value).slice(0, -1).join("");
                else if (ch && !key.ctrl && !key.meta) append(ch);
                else return;
                prompt.line = `${label} ${value}`;
                draw();
              },
              paste(text) {
                append(text);
                prompt.line = `${label} ${value}`;
              },
              cancel: () => finish(null),
            };
            const append = (text: string) => {
              const piece = text.replace(controlChars, "").replace(unsafe, "");
              if (value.length + piece.length <= MAX_ANSWER) value += piece;
            };
            modal = prompt;
            paint(finalize());
          }),
      );
    },
    secret(label) {
      return exclusive(
        () =>
          new Promise<string | null>((resolve) => {
            if (closed) return resolve(null);
            const name = oneLine(label) || "secret";
            if (!interactive) {
              paint(finalize() + `${name}: `);
              void nextLine().then((line) => {
                paint("\n");
                resolve(line ? line.trim() || null : null);
              });
              return;
            }
            let value = "";
            const finish = (result: string | null) => {
              modal = undefined;
              value = "";
              commitLines(`  ${name}: ${result ? "received" : "cancelled"}`);
              resolve(result);
            };
            const append = (text: string) => {
              const piece = text.replace(controlChars, "");
              if (value.length + piece.length <= MAX_SECRET) value += piece;
            };
            modal = {
              line: `${name} (input hidden): `,
              key(ch, key) {
                if ((key.ctrl && key.name === "c") || key.name === "escape")
                  return finish(null);
                if (key.name === "return" || key.name === "enter")
                  return finish(value.trim() || null);
                if (key.name === "backspace") {
                  value = Array.from(value).slice(0, -1).join("");
                  return;
                }
                if (ch && !key.ctrl && !key.meta) append(ch);
              },
              paste: append,
              cancel: () => finish(null),
            };
            paint(finalize());
          }),
      );
    },
    confirm(question, signal) {
      return exclusive(
        () =>
          new Promise<boolean>((resolve) => {
            if (closed || signal?.aborted) return resolve(false);
            const text = `${oneLine(question)} [y/N]`;
            let done = false;
            const finish = (yes: boolean) => {
              if (done) return;
              done = true;
              signal?.removeEventListener("abort", onAbort);
              modal = undefined;
              commitLines(`  ${text} ${yes ? "yes" : "no"}`);
              resolve(yes);
            };
            const onAbort = () => finish(false);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (!interactive) {
              paint(finalize() + `${text}: `);
              void nextLine(signal).then((answer) => {
                if (done) return;
                paint("\n");
                finish(/^y(es)?$/i.test((answer ?? "").trim()));
              });
              return;
            }
            modal = {
              line: `${text} `,
              key(ch, key) {
                if (
                  (key.ctrl && key.name === "c") ||
                  key.name === "escape" ||
                  key.name === "return" ||
                  key.name === "enter"
                )
                  return finish(false);
                if (key.ctrl || key.meta) return;
                const c = (ch ?? "").toLowerCase();
                if (c === "y") finish(true);
                else if (c === "n") finish(false);
              },
              cancel: () => finish(false),
            };
            paint(finalize());
          }),
      );
    },
    close() {
      if (closed) return;
      modal?.cancel();
      const tail = finalize();
      running.clear();
      working = false;
      if (interactive)
        output.write(
          clearLive() + tail.replace(/\r?\n/g, "\r\n") + "\x1b[?2004l",
        );
      else if (tail) output.write(tail);
      closed = true;
      if (timer) clearTimeout(timer);
      if (interactive) {
        input.off("keypress", onKey);
        input.setRawMode?.(false);
        input.pause();
        output.off("resize", onResize);
      }
      reader?.close();
      for (const waiter of waiters.splice(0)) waiter(null);
      const resolve = pendingPrompt;
      pendingPrompt = undefined;
      resolve?.(null);
    },
  };
}
