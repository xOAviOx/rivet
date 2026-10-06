import type {
  AgentEvent,
  Emit,
  Message,
  Provider,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { RivetError, errorText } from "./types.js";
import type { Config } from "./config.js";
import { compact, estimate, unresolvedCalls } from "./context.js";
import type { Policy, Workspace } from "./security.js";
import { redact } from "./security.js";
import type { Session, Store } from "./store.js";
import { createToolRunner, type ToolContext } from "./tools.js";
import {
  loadInstructions,
  type InstructionSource,
  type ScopedInstructions,
} from "./instructions.js";

/** Minimal MCP surface from src/mcp.ts; the agent loop treats servers as plain tools. */
export interface McpTools {
  tools: ToolDefinition[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string>;
}

export type DoneReason = "complete" | "cancelled" | "limit" | "error";

export interface TurnResult {
  reason: DoneReason;
  exitCode: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
}

export interface AgentOptions {
  config: Config;
  provider: Provider;
  store: Store;
  session: Session;
  workspace: Workspace;
  policy: Policy;
  mcp?: McpTools;
  secrets?: string[];
  signal: AbortSignal;
  emit: Emit;
}

const MODE_PROMPT = {
  plan: "Mode: plan. You may inspect, search, and run read-only Git; modifying tools and commands are denied by policy. Report proposed changes as text.",
  edit: "Mode: edit. Modifying tools and commands require user approval; state each intended change plainly.",
  custom:
    "Mode: custom policy. Per-tool allow/ask/deny rules govern every action.",
} as const;

export function systemPrompt(config: Config, instructions: string): string {
  const parts = [
    "You are Rivet, a local terminal coding agent. Work inside the user's workspace only.",
    MODE_PROMPT[config.mode],
    "Exact tool arguments are shown to the user for approval; keep them minimal and final.",
    "Tools may defer a call to provide new or changed AGENTS.md instructions. Review those instructions before issuing another call. Apply them only to the labeled scope; the latest snapshot replaces earlier instructions for that scope.",
  ];
  if (instructions) parts.push(instructions);
  return parts.join("\n\n");
}

/** The loop and the CLI (/model budget checks) must agree on the system prompt. */
export async function buildSystem(
  config: Config,
  workspace: Workspace,
  signal: AbortSignal,
): Promise<string> {
  const scoped = await loadInstructions(workspace, ".", { signal });
  return systemPrompt(config, scoped.text);
}

const toolError = (call: ToolCall, error: string): Message => ({
  role: "tool",
  content: JSON.stringify({ error }),
  callId: call.id,
  error: true,
});

const isError = (result: string) => {
  // MCP tools may return plain text; built-in failures use JSON envelopes.
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return false;
  }
  return (
    !!parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    (parsed.error === true || typeof parsed.error === "string")
  );
};

const NOT_EXECUTED = "Not executed: the turn stopped before this call started.";

/**
 * Restores call/result pairs after a crash without replaying anything. Calls that never
 * started, and calls whose result was stored, are recorded automatically. A started call
 * with an unknown outcome is recorded as aborted only when `confirm` agrees.
 * Returns the number of calls that remain unresolved.
 */
export async function reconcileSession(
  store: Store,
  sessionId: string,
  confirm: (call: ToolCall) => Promise<boolean>,
): Promise<number> {
  const actions = store.actions(sessionId);
  let unresolved = 0;
  for (const call of unresolvedCalls(store.messages(sessionId))) {
    const action = actions.findLast((entry) => entry.call.id === call.id);
    if (!action) store.append(sessionId, toolError(call, NOT_EXECUTED));
    else if (action.result !== null)
      store.append(sessionId, {
        role: "tool",
        content: action.result,
        callId: call.id,
        error: isError(action.result),
      });
    else if (await confirm(call))
      store.complete(
        action.id,
        sessionId,
        toolError(
          call,
          "Interrupted before completion; the outcome is unknown. Recorded as aborted during reconciliation and not replayed.",
        ),
      );
    else unresolved++;
  }
  return unresolved;
}

const signature = (call: ToolCall) =>
  `${call.name} ${JSON.stringify(
    Object.keys(call.arguments)
      .sort()
      .map((key) => [key, call.arguments[key]]),
  )}`;

export async function runAgent(
  options: AgentOptions,
  input: string,
  history: Message[] = [],
): Promise<TurnResult> {
  const { config, provider, store, session, workspace, policy, signal, emit } =
    options;
  const mcp = options.mcp;
  const emitAll = (event: AgentEvent) => {
    emit(event);
    store.event(session.id, event);
  };
  const runner = createToolRunner();
  const definitions = [...runner.definitions, ...(mcp?.tools ?? [])];
  const knownInstructions = new Map<string, InstructionSource>();
  const pendingInstructions = new Map<string, ScopedInstructions>();
  const inScope = (source: InstructionSource, target: string) =>
    source.scope === "." ||
    target === source.scope ||
    target.startsWith(source.scope + "/");
  const conceal = (text: string) => {
    text = redact(text);
    for (const secret of options.secrets ?? [])
      if (secret) text = text.split(secret).join("[REDACTED]");
    return text;
  };
  const instructionPreview = async (
    call: ToolCall,
  ): Promise<string | undefined> => {
    let target: unknown;
    if (["file_list", "file_search"].includes(call.name))
      target = call.arguments.path ?? ".";
    else if (["file_read", "file_patch"].includes(call.name))
      target = call.arguments.path;
    else if (["command", "git"].includes(call.name))
      target = call.arguments.cwd ?? ".";
    if (typeof target !== "string") return;
    const scoped = await loadInstructions(workspace, target, { signal });
    const removed = [...knownInstructions.values()].filter(
      (source) =>
        inScope(source, scoped.target) &&
        !scoped.sources.some((next) => next.path === source.path),
    );
    const changed = scoped.sources.some(
      (source) => knownInstructions.get(source.path)?.text !== source.text,
    );
    if (!changed && !removed.length) return;
    const result = conceal(
      JSON.stringify({
        deferred: true,
        target: scoped.target,
        instructions: scoped.text,
        removed: removed.map((source) => source.path),
        message:
          "No operation was performed. Review these scoped instructions, then issue a new call. Removed instruction files no longer apply.",
      }),
    );
    if (Buffer.byteLength(result) > config.limits.outputBytes)
      throw new RivetError(
        "Scoped instruction preview exceeds the tool output limit; increase limits.outputBytes",
        4,
      );
    pendingInstructions.set(scoped.target, scoped);
    return result;
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  const costKnown =
    config.model.inputPrice !== undefined &&
    config.model.outputPrice !== undefined;
  let toolCalls = 0;
  let toolErrors = 0;
  let steps = 0;
  let previous = "";
  let twice = false;
  let batch: ToolCall[] = [];
  let started = 0;

  const unfinished = unresolvedCalls(history).length;
  if (unfinished) {
    emitAll({
      type: "error",
      message: `Session has ${unfinished} unfinished tool call(s) from an interrupted turn; reconcile them (rivet resume ${session.id} in a terminal) before continuing`,
    });
    return finish("error", 2);
  }

  const userMessage: Message = { role: "user", content: input };
  store.append(session.id, userMessage);
  const messages = [...history, userMessage];

  const usage = (u: { input: number; output: number }) => {
    inputTokens += u.input;
    outputTokens += u.output;
    if (costKnown)
      cost +=
        (u.input * (config.model.inputPrice ?? 0) +
          u.output * (config.model.outputPrice ?? 0)) /
        1_000_000;
    emitAll({
      type: "usage",
      usage: u,
      total: inputTokens + outputTokens,
      cost: costKnown ? cost : null,
    });
    if (inputTokens + outputTokens > config.limits.tokens)
      throw new RivetError(`Token limit exceeded (${config.limits.tokens})`, 4);
    if (costKnown && config.limits.cost && cost > config.limits.cost)
      throw new RivetError(`Cost limit exceeded (${config.limits.cost})`, 4);
  };

  const context: ToolContext = { workspace: workspace.root, policy, signal };
  let instructionDeferred = false;
  const execute = async (call: ToolCall): Promise<string> => {
    instructionDeferred = false;
    if (call.name.startsWith("mcp_")) {
      if (!mcp) throw new Error("MCP servers are not connected");
      await policy.check(call.name, call.arguments, "mcp", signal);
      return await mcp.call(call.name, call.arguments, signal);
    }
    const preview = await instructionPreview(call);
    if (preview !== undefined) {
      instructionDeferred = true;
      return preview;
    }
    return await runner.execute(call, context);
  };

  try {
    for (;;) {
      signal.throwIfAborted();
      if (++steps > config.limits.steps)
        throw new RivetError(`Step limit exceeded (${config.limits.steps})`, 4);
      if (toolCalls >= config.limits.tools)
        throw new RivetError(`Tool limit exceeded (${config.limits.tools})`, 4);

      const rootInstructions = await loadInstructions(workspace, ".", {
        signal,
      });
      const system = systemPrompt(config, rootInstructions.text);
      const budget =
        config.model.context - config.model.maxOutput - estimate(system);
      if (budget < 2048)
        throw new RivetError(
          "Too little context remains for workspace instructions",
          4,
        );
      const { messages: bounded } = compact(messages, budget);
      // Current-turn tool results survive compaction. A whole assistant batch must
      // finish before its instruction previews can count as seen by the model.
      for (const scoped of pendingInstructions.values()) {
        for (const source of knownInstructions.values())
          if (inScope(source, scoped.target))
            knownInstructions.delete(source.path);
        for (const source of scoped.sources)
          knownInstructions.set(source.path, source);
      }
      pendingInstructions.clear();
      knownInstructions.delete("AGENTS.md");
      for (const source of rootInstructions.sources)
        knownInstructions.set(source.path, source);
      const step = await provider.step(
        system,
        bounded,
        definitions,
        config.model.maxOutput,
        signal,
        emitAll,
      );
      usage(step.usage);
      store.append(session.id, step.message);
      messages.push(step.message);
      batch = step.message.calls ?? [];
      started = 0;
      if (!batch.length) return finish("complete", 0);

      for (const call of batch) {
        signal.throwIfAborted();
        if (++toolCalls > config.limits.tools)
          throw new RivetError(
            `Tool limit exceeded (${config.limits.tools})`,
            4,
          );
        // Three identical consecutive calls mean the model is stuck.
        const current = signature(call);
        if (current === previous) {
          if (twice)
            throw new RivetError(
              "Loop detected: the same tool call repeated three times",
              4,
            );
          twice = true;
        } else {
          previous = current;
          twice = false;
        }

        emitAll({ type: "tool.start", call });
        const actionId = store.begin(session.id, call);
        started++;
        let result: string;
        let error = false;
        let fatal: RivetError | undefined;
        try {
          result = await execute(call);
          if (typeof result !== "string" || !result)
            throw new Error("Tool returned no result");
          error = isError(result);
        } catch (e) {
          result = JSON.stringify({ error: errorText(e) });
          error = true;
          if (e instanceof RivetError && e.exitCode === 4) fatal = e;
        }
        result = conceal(result);
        const toolMessage: Message = {
          role: "tool",
          content: result,
          callId: call.id,
          error,
        };
        store.complete(actionId, session.id, toolMessage);
        emitAll({ type: "tool.end", id: call.id, result, error });
        messages.push(toolMessage);
        if (instructionDeferred) {
          previous = "";
          twice = false;
        }
        if (fatal) throw fatal;
        toolErrors = error ? toolErrors + 1 : 0;
        if (toolErrors >= 8)
          throw new RivetError("Too many consecutive tool errors", 4);
      }
      if (signal.aborted) throw new RivetError("Cancelled", 130);
    }
  } catch (e) {
    // Calls that never started get a definite result so the next request stays valid.
    for (const call of batch.slice(started))
      store.append(session.id, toolError(call, NOT_EXECUTED));
    batch = [];
    const code = e instanceof RivetError ? e.exitCode : 1;
    if (signal.aborted || code === 130) return finish("cancelled", 130);
    emitAll({ type: "error", message: errorText(e) });
    return finish(code === 4 ? "limit" : "error", code);
  }

  function finish(reason: DoneReason, exitCode: number): TurnResult {
    emitAll({ type: "done", reason });
    return {
      reason,
      exitCode,
      inputTokens,
      outputTokens,
      cost: costKnown ? cost : null,
    };
  }
}
