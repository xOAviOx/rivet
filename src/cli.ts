import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  configDir,
  configSchema,
  destination,
  keyName,
  loadConfig,
  privateDir,
  saveConfig,
  type Config,
} from "./config.js";
import { credential } from "./credentials.js";
import { createProvider, probe } from "./providers.js";
import { clean, Policy, Workspace, type Decision } from "./security.js";
import type { Session, Store } from "./store.js";
import { buildSystem, runAgent } from "./agent.js";
import { changeModel, listModels, modelLines, resolveModel } from "./models.js";
import { exportSession } from "./export.js";
import { workspaceDiff } from "./diff.js";
import { createTerminal, type Terminal } from "./terminal.js";
import { RivetError, errorText, type AgentEvent, type Emit } from "./types.js";

const database = () => join(configDir(), "sessions.sqlite");

function ask(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.on("SIGINT", () => done(null));
    rl.on("close", () => done(null));
    rl.question(question, (answer) => done(answer));
  });
}

/** Text is batched; non-text events flush it so lines stay whole. */
function renderer(json: boolean) {
  let buffer = "";
  const flush = () => {
    if (buffer) process.stdout.write(buffer);
    buffer = "";
  };
  const line = (text: string) => {
    flush();
    process.stdout.write(`${text}\n`);
  };
  const summary = (args: Record<string, unknown>) => {
    const flat = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
  };
  return {
    render(event: AgentEvent) {
      if (json) {
        flush();
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      }
      switch (event.type) {
        case "text":
          buffer += clean(event.text);
          return;
        case "status":
          line(`· ${clean(event.message)}`);
          return;
        case "tool.start":
          line(`· ${event.call.name} ${clean(summary(event.call.arguments))}`);
          return;
        case "tool.end":
          if (event.error) {
            let detail = "";
            try {
              detail = String(JSON.parse(event.result).error ?? "");
            } catch {
              // Result text that is not JSON has no detail to show.
            }
            line(`· error ${clean(detail.slice(0, 200))}`);
          }
          return;
        case "usage":
          line(
            `· ${event.total} tokens${event.cost === null ? "" : ` $${event.cost.toFixed(4)}`}`,
          );
          return;
        case "approval":
          if (event.decision)
            line(`· approval ${event.tool}: ${event.decision}`);
          return;
        case "error":
          line(`error: ${clean(event.message)}`);
          return;
        case "done":
          if (event.reason !== "complete") line(`· ${event.reason}`);
          return;
      }
    },
    flush,
  };
}

interface Ctx {
  config: Config;
  store: Store;
  session: Session;
  workspace: Workspace;
  json: boolean;
  sessionKey?: string;
  /** Interactive sessions only; one-shot commands write to stdout directly. */
  terminal?: Terminal;
  /** Kept for the whole session so "session" approvals outlive one turn. */
  policy?: Policy;
  emit?: Emit;
}

/** Interactive output goes through the terminal so it never tears the live editor. */
const say = (ctx: Ctx, text: string) => {
  if (ctx.terminal) ctx.terminal.print(text);
  else process.stdout.write(`${text}\n`);
};

const approve =
  (ctx: Ctx) =>
  async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Decision> => {
    if (ctx.json || !process.stdin.isTTY) {
      if (!ctx.json)
        say(ctx, `· approval ${name}: denied (no interactive terminal)`);
      return "deny";
    }
    if (ctx.terminal) return await ctx.terminal.approve(name, args, signal);
    // Exact, untruncated arguments; the decision belongs to the user alone.
    process.stdout.write(
      `\n${name} ${JSON.stringify(args, null, 2)}\nApprove? [o]nce / [s]ession / [d]eny: `,
    );
    const answer = await ask("");
    signal.throwIfAborted();
    process.stdout.write("\n");
    const value = (answer ?? "").trim().toLowerCase();
    if (value === "o" || value === "once" || value === "y") return "once";
    if (value === "s" || value === "session") return "session";
    return "deny";
  };

async function runTurn(
  ctx: Ctx,
  input: string,
  signal: AbortSignal,
  emit: Emit,
) {
  const key = await credential(ctx.config, ctx.sessionKey).catch((e) => {
    throw e instanceof RivetError ? e : new RivetError(errorText(e), 2);
  });
  ctx.emit = emit;
  const policy = (ctx.policy ??= new Policy(ctx.config, approve(ctx), (e) =>
    ctx.emit?.(e),
  ));
  policy.config = ctx.config;
  return await runAgent(
    {
      config: ctx.config,
      provider: createProvider(ctx.config, key),
      secrets: [key],
      store: ctx.store,
      session: ctx.session,
      workspace: ctx.workspace,
      policy,
      signal,
      emit,
    },
    input,
    ctx.store.messages(ctx.session.id),
  );
}

const HELP = `rivet - a local, permission-controlled terminal coding agent

Usage:
  rivet                     start an interactive session
  rivet run "prompt"        run one prompt non-interactively
  rivet run --json "prompt" print JSONL lifecycle, tool, and usage events
  rivet setup               create ~/.rivet/config.json
  rivet models              show the configured model
  rivet models check        verify the model passes the tool-calling check
  rivet sessions            list saved sessions
  rivet resume <id>         continue a session in its workspace
  rivet export <id> [file]  export a session's events as JSONL
  rivet help                show this help

Session commands: /help /key /model /diff /sessions /export /exit

Session keys: Enter sends, Alt+Enter or Ctrl+J adds a line, Ctrl+C
interrupts work (or clears the draft; again on an empty draft exits).

Exit codes: 0 success, 1 error, 2 configuration or credential,
3 policy or approval denial, 4 limit reached, 130 cancelled.`;

function exitFor(result: { reason: string; exitCode: number }) {
  process.exitCode = result.reason === "complete" ? 0 : result.exitCode;
}

/** Uncertain actions are shown and never replayed; recording them restores call/result pairs. */
async function reconcile(ctx: Ctx, terminal: Terminal) {
  for (const action of ctx.store.pending(ctx.session.id)) {
    if (!process.stdin.isTTY || ctx.json) {
      say(
        ctx,
        `· pending action ${action.call.id} (${action.call.name}) requires reconciliation; run rivet resume ${ctx.session.id} in a terminal`,
      );
      continue;
    }
    terminal.print(
      `Interrupted action: ${action.call.name} ${JSON.stringify(action.call.arguments)}`,
    );
    if (!(await terminal.confirm("Record as aborted?"))) continue;
    const recorded =
      "Interrupted before completion; recorded as aborted during reconciliation and not replayed.";
    ctx.store.finish(action.id, JSON.stringify({ error: recorded }));
    ctx.store.append(ctx.session.id, {
      role: "tool",
      content: recorded,
      callId: action.call.id,
      error: true,
    });
  }
}

const COMMANDS =
  "/help /key [secret] /model [id] /diff [--staged] [path] /sessions /export [file] /exit";

async function command(
  ctx: Ctx,
  input: string,
  signal: AbortSignal,
): Promise<"exit" | undefined> {
  const [name, ...rest] = input.slice(1).split(/\s+/);
  switch (name) {
    case "help":
      say(ctx, COMMANDS);
      return undefined;
    case "key": {
      // Without an argument the key is read hidden, so it never reaches scrollback.
      const value =
        rest[0] ||
        (ctx.terminal?.interactive
          ? await ctx.terminal.secret(`${keyName(ctx.config)} for this session`)
          : null);
      if (!value) {
        if (ctx.terminal?.interactive) return undefined;
        throw new RivetError("Usage: /key <secret>", 2);
      }
      ctx.sessionKey = value;
      say(ctx, "· session key set (not saved)");
      return undefined;
    }
    case "model": {
      if (!rest.length) {
        say(ctx, `· ${ctx.config.model.id}`);
        return undefined;
      }
      const key = await credential(ctx.config, ctx.sessionKey);
      // Listing first: resolveModel refuses ids the endpoint does not offer.
      const listing = await listModels(ctx.config, key, signal);
      const id = rest[0];
      if (!id) throw new RivetError("Usage: /model <id>", 2);
      const next = resolveModel(id, { listing });
      const result = await changeModel(ctx.config, next, {
        key,
        history: ctx.store.messages(ctx.session.id),
        system: await buildSystem(ctx.config, ctx.workspace, signal),
        signal,
      });
      ctx.config = result.config;
      say(
        ctx,
        `· model ${next.id} passed the capability check${result.omitted ? ` (${result.omitted} earlier turn(s) will stay out of context)` : ""}`,
      );
      return undefined;
    }
    case "diff": {
      // Parsed from the raw input so spaces inside the path survive.
      const flag = /(^|\s)--staged(?=\s|$)/g;
      const args = input.trim().replace(/^\/\S+\s*/, "");
      const staged = flag.test(args);
      const path = args.replace(flag, " ").trim();
      const result = await workspaceDiff(ctx.workspace, signal, {
        staged,
        ...(path ? { path } : {}),
      });
      // The text already carries its own truncation notice.
      say(ctx, result.text || "· no changes");
      return undefined;
    }
    case "sessions":
      for (const s of ctx.store.list().slice(0, 20))
        say(ctx, `${s.id} ${s.createdAt} ${s.model}`);
      return undefined;
    case "export": {
      const target = await writeExport(
        ctx.store,
        ctx.session.id,
        rest[0],
        ctx.sessionKey,
      );
      say(ctx, `· exported session ${ctx.session.id} to ${target}`);
      return undefined;
    }
    case "exit":
    case "quit":
      return "exit";
    default:
      throw new RivetError(`Unknown command ${name}; try ${COMMANDS}`, 1);
  }
}

/** The CLI owns destination choice; export never overwrites an existing file. */
async function writeExport(
  store: Store,
  id: string,
  file: string | undefined,
  sessionKey?: string,
  markdown = false,
) {
  const target = resolve(
    file || `rivet-export-${id}.${markdown ? "md" : "json"}`,
  );
  const content = exportSession(
    store,
    id,
    markdown ? "markdown" : "json",
    sessionKey ? [sessionKey] : [],
  );
  await writeFile(target, content, { flag: "wx" });
  return target;
}

async function repl(ctx: Ctx) {
  let active: AbortController | undefined;
  const interrupt = () => active?.abort();
  // JSON sessions stay in line mode so stdout carries only event lines.
  const terminal = createTerminal({
    workspace: ctx.workspace.root,
    onInterrupt: interrupt,
    conceal: (text) => (/^\s*\/key\s+\S/.test(text) ? "/key [hidden]" : text),
    ...(ctx.json ? { interactive: false, color: false } : {}),
  });
  ctx.terminal = terminal;
  try {
    if (!ctx.json)
      terminal.header({
        workspace: ctx.workspace.root,
        provider: ctx.config.provider,
        model: ctx.config.model.id,
        mode: ctx.config.mode,
      });
    await reconcile(ctx, terminal);
    for (;;) {
      const input = await terminal.prompt();
      if (input === null) return;
      const trimmed = input.trim();
      if (!trimmed) continue;
      const controller = (active = new AbortController());
      // Raw mode reports Ctrl+C through onInterrupt; SIGINT covers line mode and kill.
      process.on("SIGINT", interrupt);
      try {
        if (trimmed.startsWith("/")) {
          if ((await command(ctx, trimmed, controller.signal)) === "exit")
            return;
          continue;
        }
        const result = await runTurn(
          ctx,
          trimmed,
          controller.signal,
          ctx.json ? renderer(true).render : terminal.render,
        );
        exitFor(result);
      } catch (e) {
        // A failed command or turn reports and keeps the session.
        say(ctx, `error: ${clean(errorText(e))}`);
        if (!trimmed.startsWith("/"))
          process.exitCode = e instanceof RivetError ? e.exitCode : 1;
      } finally {
        active = undefined;
        process.removeListener("SIGINT", interrupt);
      }
    }
  } finally {
    terminal.close();
    ctx.terminal = undefined;
  }
}

async function openWorkspace() {
  try {
    return await Workspace.open(process.cwd());
  } catch (e) {
    throw new RivetError(`Cannot open workspace: ${errorText(e)}`, 2);
  }
}

async function withStore<T>(work: (store: Store) => Promise<T>): Promise<T> {
  // Loaded lazily so help and version do not trigger the SQLite warning.
  const { Store } = await import("./store.js");
  await privateDir(configDir());
  const store = new Store(database());
  try {
    return await work(store);
  } finally {
    store.close();
  }
}

async function cmdSetup() {
  if (!process.stdin.isTTY)
    throw new RivetError("rivet setup requires an interactive terminal", 2);
  console.log(
    "Rivet setup — provider account keys stay in your environment or OS credential store.",
  );
  const pick = async (prompt: string, valid: string[]): Promise<string> => {
    for (;;) {
      const answer = await ask(prompt);
      const value = (answer ?? "").trim().toLowerCase();
      if (valid.includes(value)) return value;
      console.log(`Choose one of: ${valid.join(", ")}`);
    }
  };
  const provider = await pick("Provider [openai/anthropic/compatible]: ", [
    "openai",
    "anthropic",
    "compatible",
  ]);
  const endpoint =
    provider === "compatible"
      ? ((await ask("Endpoint URL: ")) ?? "").trim()
      : undefined;
  const source = await pick("Credential source [environment/os]: ", [
    "environment",
    "os",
  ]);
  const modelId = ((await ask("Model id: ")) ?? "").trim();
  const context = Number(
    ((await ask("Context window (tokens): ")) ?? "").trim(),
  );
  const maxOutput = Number(
    ((await ask("Max output tokens [4096]: ")) ?? "4096").trim() || "4096",
  );
  const parsed = configSchema.parse({
    provider,
    ...(endpoint ? { endpoint } : {}),
    credential: source,
    model: { id: modelId, tools: true, context, maxOutput },
  });
  const key = await credential(parsed).catch(() => undefined);
  if (key) {
    console.log("Checking tool calling with the configured model...");
    await probe(createProvider(parsed, key), new AbortController().signal);
    console.log("Model passed the capability check.");
  } else {
    console.log(
      `No ${keyName(parsed)} available now; run rivet models check after setting it.`,
    );
  }
  await saveConfig(parsed);
  console.log(
    `Saved ${join(configDir(), "config.json")}. Run rivet inside a project directory.`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  const [cmd] = positional;
  if (!cmd) {
    await withStore(async (store) => {
      const workspace = await openWorkspace();
      const config = await loadConfig();
      const session = store.create(resolve(process.cwd()), config.model.id);
      store.event(session.id, {
        type: "session",
        id: session.id,
        model: config.model.id,
        destination: destination(config),
      });
      await repl({ config, store, session, workspace, json });
    });
    return;
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cmd === "--version") {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`rivet ${pkg.version}\n`);
    return;
  }
  const rest = positional.slice(1);
  if (cmd === "setup") return await cmdSetup();
  if (cmd === "models") {
    const config = await loadConfig();
    if (rest[0] === "check") {
      const key = await credential(config);
      await probe(createProvider(config, key), new AbortController().signal);
      process.stdout.write("· model passed the capability check\n");
      return;
    }
    const key = await credential(config);
    const listing = await listModels(config, key, new AbortController().signal);
    for (const line of modelLines(listing, config.model.id))
      process.stdout.write(`${line}\n`);
    return;
  }
  if (cmd === "run") {
    const prompt = rest.join(" ").trim();
    if (!prompt) throw new RivetError('Usage: rivet run "prompt"', 2);
    const config = await loadConfig();
    const workspace = await openWorkspace();
    return await withStore(async (store) => {
      const session = store.create(resolve(process.cwd()), config.model.id);
      store.event(session.id, {
        type: "session",
        id: session.id,
        model: config.model.id,
        destination: destination(config),
      });
      const render = renderer(json);
      const result = await runTurn(
        { config, store, session, workspace, json },
        prompt,
        new AbortController().signal,
        (event) => render.render(event),
      );
      render.flush();
      exitFor(result);
    });
  }
  if (cmd === "sessions") {
    return await withStore(async (store) => {
      for (const s of store.list())
        process.stdout.write(
          `${s.id} ${s.createdAt} ${s.model} ${s.workspace}\n`,
        );
    });
  }
  if (cmd === "resume" || cmd === "export") {
    const id = rest[0];
    if (!id) throw new RivetError(`Usage: rivet ${cmd} <session id>`, 2);
    const config = await loadConfig();
    const workspace = await openWorkspace();
    return await withStore(async (store) => {
      const session = store.get(id);
      if (!session) throw new RivetError(`No session ${id}`, 2);
      if (resolve(session.workspace) !== resolve(process.cwd()))
        throw new RivetError(
          `Session ${id} belongs to ${session.workspace}; run rivet there`,
          2,
        );
      if (cmd === "export") {
        const target = await writeExport(
          store,
          id,
          rest.find((a, i) => i > 0 && !a.startsWith("--")),
          undefined,
          rest.includes("--markdown"),
        );
        process.stdout.write(`· exported session ${id} to ${target}\n`);
        return;
      }
      await repl({ config, store, session, workspace, json });
    });
  }
  throw new RivetError(`Unknown command ${cmd}; see rivet help`, 2);
}

main().catch((e) => {
  process.stderr.write(`error: ${errorText(e)}\n`);
  process.exitCode = e instanceof RivetError ? e.exitCode : 1;
});
