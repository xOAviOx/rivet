import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createTerminal, width } from "../dist/terminal.js";

const ESC = "\x1b";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Minimal VT emulator: auto-wrap, CR, LF, cursor up/right, erase below. */
function emulate(text, cols) {
  const rows = [[]];
  let r = 0;
  let c = 0;
  const row = () => (rows[r] ??= []);
  const tokens =
    text.match(/\x1b\[\??[0-9;]*[A-Za-z~]|\r|\n|\x1b|[^\x1b\r\n]+/g) ?? [];
  for (const token of tokens) {
    if (token === "\r") c = 0;
    else if (token === "\n") {
      r++;
      c = Math.min(c, cols - 1);
      row();
    } else if (token[0] === ESC) {
      const m = /^\x1b\[(\??)([0-9;]*)([A-Za-z~])$/.exec(token);
      if (!m) throw new Error(`Unexpected escape ${JSON.stringify(token)}`);
      const n = Number(m[2] || 1);
      if (m[1] || m[3] === "m") continue;
      if (m[3] === "A") {
        r = Math.max(0, r - n);
        c = Math.min(c, cols - 1);
      } else if (m[3] === "C") c = Math.min(c + n, cols - 1);
      else if (m[3] === "J") {
        row().length = Math.min(row().length, c);
        rows.length = r + 1;
      } else throw new Error(`Unsupported sequence ${JSON.stringify(token)}`);
    } else
      for (const { segment } of segmenter.segment(token)) {
        const w = width(segment);
        if (!w) continue;
        if (c + w > cols) {
          r++;
          c = 0;
        }
        const cells = row();
        while (cells.length < c) cells.push(" ");
        cells[c] = segment;
        for (let k = 1; k < w; k++) cells[c + k] = "";
        c += w;
      }
  }
  return rows.map((cells) => (cells ?? []).join("").trimEnd()).join("\n");
}

function fakeTty({ columns = 60, rows = 24, tty = true } = {}) {
  const input = new PassThrough();
  input.isTTY = tty;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
    return input;
  };
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  output.isTTY = tty;
  output.columns = columns;
  output.rows = rows;
  const all = () => chunks.join("");
  return {
    input,
    output,
    chunks,
    all,
    /** Raw output with CRLF normalized; exact text as written. */
    raw: () => all().replace(/\r\n/g, "\n"),
    screen: () => emulate(all(), columns),
  };
}
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};
async function type(input, text) {
  input.write(text);
  await settle();
}
function open(t, options = {}, streams = fakeTty(options)) {
  const terminal = createTerminal({
    input: streams.input,
    output: streams.output,
    color: false,
    workspace: "/work",
    flushMs: 1,
    ...options,
  });
  t.after(() => terminal.close());
  return { terminal, ...streams };
}
const never = () => new AbortController().signal;

test("Enter submits while Alt+Enter, Ctrl+J and a trailing backslash insert newlines", async (t) => {
  const { terminal, input, screen } = open(t);
  const reply = terminal.prompt();
  await type(input, `first${ESC}\rsecond\nthird\\\rfourth\r`);
  assert.equal(await reply, "first\nsecond\nthird\nfourth");
  assert.equal(
    screen(),
    "> first\n  second\n  third\n  fourth\n  working · Ctrl+C interrupts\n>",
  );
});

test("CSI-u modified Enter inserts newlines; unmodified CSI-u Enter submits", async (t) => {
  const { terminal, input } = open(t);
  const reply = terminal.prompt();
  // ConPTY reports Alt+Enter as ESC[13;3u and Shift+Enter as ESC[13;2u.
  await type(input, `a${ESC}[13;3ub${ESC}[13;2uc${ESC}[13;1u`);
  assert.equal(await reply, "a\nb\nc");
});

test("bracketed paste keeps line breaks in the editor until Enter", async (t) => {
  const { terminal, input, screen } = open(t);
  let resolved = false;
  const reply = terminal.prompt().then((value) => {
    resolved = true;
    return value;
  });
  await type(input, `${ESC}[200~line one\r\nline two\rline three${ESC}[201~`);
  assert.equal(resolved, false, "pasted newlines must not submit");
  assert.equal(screen(), "> line one\n  line two\n  line three");
  await type(input, "!\r");
  assert.equal(await reply, "line one\nline two\nline three!");
});

test("editing keys move by grapheme and recall history", async (t) => {
  const { terminal, input } = open(t);
  let reply = terminal.prompt();
  await type(input, `abc${ESC}[D${ESC}[DX\x7f\x7fé😀${ESC}[H>\r`);
  assert.equal(await reply, ">é😀bc");
  reply = terminal.prompt();
  await type(input, `${ESC}[A${ESC}[F!\r`);
  assert.equal(await reply, ">é😀bc!");
});

test("narrow wrapping, exact-width rows and wide characters redraw cleanly", async (t) => {
  const { terminal, input, screen } = open(t, { columns: 10 });
  void terminal.prompt();
  await type(input, "abcdefgh");
  // A full row leaves the cursor at the start of the next row.
  assert.equal(screen(), "> abcdefgh\n");
  await type(input, "ijklm");
  await type(input, `${ESC}\r中文字`);
  assert.equal(screen(), "> abcdefgh\nijklm\n  中文字");
  await type(input, "\x7f".repeat(9));
  assert.equal(screen(), "> abcdefgh\n");
  await type(input, "\x7f");
  assert.equal(screen(), "> abcdefg");
});

test("tall drafts show a window around the cursor that fits the screen", async (t) => {
  const { terminal, input, screen } = open(t, { rows: 6 });
  void terminal.prompt();
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  await type(input, `${ESC}[200~${lines.join("\n")}${ESC}[201~`);
  assert.equal(screen(), "  … 17 more lines above\n  l18\n  l19\n  l20");
  await type(input, `${ESC}[A`.repeat(19));
  assert.equal(screen(), "> l1\n  l2\n  l3\n  … 17 more lines below");
});

test("idle Ctrl+C clears a draft first and exits on an empty editor", async (t) => {
  const { terminal, input } = open(t);
  const reply = terminal.prompt();
  await type(input, "draft\x03");
  await type(input, "\x03");
  assert.equal(await reply, null);
  const second = terminal.prompt();
  await type(input, "\x04");
  assert.equal(await second, null);
});

test("Ctrl+C during work interrupts and keeps the session", async (t) => {
  let interrupts = 0;
  const { terminal, input, screen } = open(t, {
    onInterrupt: () => interrupts++,
  });
  const first = terminal.prompt();
  await type(input, "run it\r");
  assert.equal(await first, "run it");
  await type(input, "\x03");
  assert.equal(interrupts, 1);
  assert.match(screen(), /interrupting…\n>$/);
  terminal.render({ type: "done", reason: "cancelled" });
  const next = terminal.prompt();
  await type(input, "again\r");
  assert.equal(await next, "again");
  assert.match(screen(), /> run it\n {2}interrupted\n\n> again\n/);
});

test("messages typed during work are queued for the next prompt", async (t) => {
  const { terminal, input, screen } = open(t);
  const first = terminal.prompt();
  await type(input, "one\r");
  await first;
  await type(input, "two\r");
  assert.match(screen(), /working · Ctrl\+C interrupts · 1 queued\n>$/);
  terminal.render({ type: "done", reason: "complete" });
  assert.equal(await terminal.prompt(), "two");
});

test("approval shows exact arguments and destination, never truncated, with no default", async (t) => {
  const { terminal, input, all, raw, screen } = open(t, { columns: 20 });
  const long = "x".repeat(300);
  const decision = terminal.approve(
    "file_patch",
    {
      path: "src/a.ts",
      expectedHash: long,
      oldText: "a\n\tb\x1b]0;owned\x07\n",
      newText: "c\u202e",
    },
    never(),
  );
  await settle();
  const shown = raw();
  assert.match(shown, /approval required: file_patch\n/);
  assert.match(shown, /destination: \/work.src\/a\.ts\n/);
  assert.ok(shown.includes(`expectedHash: "${long}"\n`), "full argument");
  assert.match(shown, /oldText: 2 lines, ending with a newline\n/);
  assert.match(shown, /\| a\n {4}\| \tb<U\+001B>\]0;owned<U\+0007>\n/);
  assert.ok(shown.includes('newText: "c\\u202e"\n'));
  assert.ok(!all().includes("\x1b]0;owned"), "raw OSC never reaches output");
  assert.ok(!all().includes("\u202e"), "bidi override never reaches output");
  assert.ok(
    screen()
      .split("\n")
      .every((line) => width(line) <= 20),
  );
  let settled = false;
  void decision.then(() => (settled = true));
  await type(input, "\rx");
  assert.equal(settled, false, "Enter and unknown keys never approve");
  await type(input, "o");
  assert.equal(await decision, "once");
  const session = terminal.approve("command", { command: "pnpm" }, never());
  await settle();
  assert.match(raw(), /host process in \/work \(not sandboxed\)/);
  await type(input, "s");
  assert.equal(await session, "session");
  const denied = terminal.approve("command", {}, never());
  await settle();
  await type(input, "d");
  assert.equal(await denied, "deny");
  assert.match(
    raw(),
    / {2}approved once\n[^]* {2}approved for this session \(same tool and arguments\)\n[^]*destination: host process in \/work \(not sandboxed\)\n {2}arguments: none\n[^]* {2}denied\n/,
  );
  assert.match(screen(), /\n {2}denied\n>$/);
});

test("Escape, Ctrl+C and abort cancel approvals without approving", async (t) => {
  let interrupts = 0;
  const { terminal, input, screen } = open(t, {
    onInterrupt: () => interrupts++,
  });
  const push = { args: ["push"] };
  const escaped = terminal.approve("git", push, never());
  await settle();
  await type(input, ESC);
  await delay(600);
  assert.equal(await escaped, "deny");
  const interrupted = terminal.approve("git", push, never());
  await settle();
  await type(input, "\x03");
  assert.equal(await interrupted, "deny");
  assert.equal(interrupts, 1);
  const controller = new AbortController();
  const aborted = terminal.approve("git", push, controller.signal);
  await settle();
  controller.abort();
  assert.equal(await aborted, "deny");
  const lines = screen().split("\n");
  assert.equal(lines.filter((line) => line === "  cancelled").length, 3);
  const pre = new AbortController();
  pre.abort();
  assert.equal(await terminal.approve("git", {}, pre.signal), "deny");
});

test("streaming text is batched, sanitized, and keeps the editor below it", async (t) => {
  const { terminal, chunks, all, screen } = open(t);
  void terminal.prompt();
  await settle();
  const before = chunks.length;
  const pieces = ["Hello", ", ", "world", `${ESC}]0;title${ESC}\\`];
  for (const piece of [...pieces, `${ESC}[3`, "1mred", "\n", "next"])
    terminal.render({ type: "text", text: piece });
  assert.equal(chunks.length, before, "no write per delta");
  await delay(20);
  assert.equal(chunks.length, before + 1, "one batched write");
  assert.ok(!all().includes("]0;title"));
  assert.ok(!all().includes(`${ESC}[31m`));
  assert.equal(screen(), "Hello, worldred\nnext\n>");
});

test("tool lines summarize, truncate on narrow screens, and show failures in words", async (t) => {
  const { terminal, all, screen } = open(t, { columns: 30 });
  terminal.render({ type: "text", text: "Reading" });
  terminal.render({
    type: "tool.start",
    call: {
      id: "1",
      name: "file_read",
      arguments: { path: "src/a/very/long/path/to/file.ts" },
    },
  });
  assert.match(all(), /running file_read src/);
  terminal.render({ type: "tool.end", id: "1", result: "{}", error: false });
  terminal.render({
    type: "tool.start",
    call: {
      id: "2",
      name: "command",
      arguments: { command: "pnpm", args: ["test"] },
    },
  });
  terminal.render({
    type: "tool.end",
    id: "2",
    result: '{"exitCode":1,"output":"boom"}',
    error: false,
  });
  terminal.render({
    type: "tool.start",
    call: { id: "3", name: "file_patch", arguments: { path: "a" } },
  });
  terminal.render({
    type: "tool.end",
    id: "3",
    result: '{"error":"File changed: expectedHash does not match"}',
    error: true,
  });
  assert.equal(
    screen(),
    [
      "Reading",
      "  file_read src/a/very/long/…",
      "  command pnpm test · exit 1",
      "  file_patch a",
      "    failed: File changed: ex…",
      "  working · Ctrl+C interrupts",
      ">",
    ].join("\n"),
  );
});

test("header, usage, and done lines use plain words", async (t) => {
  const { terminal, screen } = open(t);
  terminal.header({
    workspace: "/work",
    provider: "openai",
    model: "gpt-test",
    mode: "plan",
  });
  terminal.render({
    type: "usage",
    usage: { input: 1000, output: 234 },
    total: 1234,
    cost: 0.01,
  });
  terminal.render({ type: "done", reason: "complete" });
  terminal.render({ type: "error", message: "Provider failed (HTTP 500)" });
  terminal.render({ type: "done", reason: "limit" });
  terminal.print("details\n\x1b[2Jline two\n");
  assert.equal(
    screen(),
    [
      "rivet  /work / openai:gpt-test / plan",
      "  1,234 tokens · $0.0100",
      "error: Provider failed (HTTP 500)",
      "  stopped: limit reached",
      "details",
      "line two",
      ">",
    ].join("\n"),
  );
});

test("color is off for tests and NO_COLOR; cyan marks only prompts", async (t) => {
  const monochrome = open(t);
  void monochrome.terminal.prompt();
  await settle();
  assert.ok(!monochrome.all().includes(`${ESC}[36m`));
  const colored = open(t, { color: true });
  colored.terminal.header({
    workspace: "/w",
    provider: "p",
    model: "m",
    mode: "edit",
  });
  void colored.terminal.prompt();
  await settle();
  assert.ok(colored.all().includes(`${ESC}[36m>${ESC}[39m`));
  assert.ok(colored.all().includes("rivet  /w / p:m / edit"));
  const sgr = colored.all().match(/\x1b\[[0-9;]*m/g) ?? [];
  assert.ok(
    sgr.every((code) => code === `${ESC}[36m` || code === `${ESC}[39m`),
  );
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const streams = fakeTty();
    streams.output.hasColors = () => true;
    const env = createTerminal({
      input: streams.input,
      output: streams.output,
    });
    void env.prompt();
    await settle();
    env.close();
    assert.ok(!streams.all().includes(`${ESC}[36m`));
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  }
});

test("secret input never echoes and cancels on Escape", async (t) => {
  const { terminal, input, all, screen } = open(t);
  const key = terminal.secret("OpenAI key");
  await settle();
  await type(input, `sk-test-secret-value${ESC}[200~-pasted${ESC}[201~\r`);
  assert.equal(await key, "sk-test-secret-value-pasted");
  assert.ok(!all().includes("secret-value"));
  assert.match(screen(), /^ {2}OpenAI key: received\n>$/);
  const cancelled = terminal.secret("key");
  await settle();
  await type(input, "abc");
  await type(input, ESC);
  await delay(600);
  assert.equal(await cancelled, null);
});

test("line mode reads prompts and approvals from piped input without control sequences", async (t) => {
  const { terminal, input, all } = open(t, {}, fakeTty({ tty: false }));
  assert.equal(terminal.interactive, false);
  input.write("\n  \nhello\no\n");
  assert.equal(await terminal.prompt(), "hello");
  terminal.render({ type: "text", text: `streamed${ESC}[2Jtext` });
  const decision = terminal.approve("command", { command: "ls" }, never());
  assert.equal(await decision, "once");
  input.end();
  assert.equal(await terminal.prompt(), null);
  assert.ok(!all().includes(ESC), JSON.stringify(all()));
  assert.match(all(), /streamedtext\napproval required: command\n/);
  assert.match(all(), /\n {2}approved once\n$/);
});

test("close restores the terminal and resolves pending work", async (t) => {
  const { terminal, input, all } = open(t);
  assert.equal(input.isRaw, true);
  assert.ok(all().startsWith(`${ESC}[?2004h`));
  const reply = terminal.prompt();
  const approval = terminal.approve("git", {}, never());
  await settle();
  terminal.close();
  assert.equal(await reply, null);
  assert.equal(await approval, "deny");
  assert.equal(input.isRaw, false);
  assert.ok(all().endsWith(`${ESC}[?2004l`));
});
