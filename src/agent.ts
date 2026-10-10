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
import { compact, estimate } from "./context.js";
import type { Policy, Workspace } from "./security.js";
import { redact } from "./security.js";
import type { Session, Store } from "./store.js";
import { createToolRunner, type ToolContext } from "./tools.js";
import { loadInstructions } from "./instructions.js";

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
  const system = await buildSystem(config, workspace, signal);
  const budget = Math.max(
    2048,
    config.model.context - config.model.maxOutput - estimate(system),
  );

  const userMessage: Message = { role: "user", content: input };
  store.append(session.id, userMessage);
  const messages = [...history, userMessage];

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
  const execute = async (call: ToolCall): Promise<string> => {
    if (call.name.startsWith("mcp_")) {
      if (!mcp) throw new Error("MCP servers are not connected");
      await policy.check(call.name, call.arguments, "mcp", signal);
      return await mcp.call(call.name, call.arguments, signal);
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

      const { messages: bounded } = compact(messages, budget);
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
      if (!step.message.calls?.length) return finish("complete", 0);

      for (const call of step.message.calls) {
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
        let result: string;
        let error = false;
        try {
          result = await execute(call);
          if (typeof result !== "string" || !result)
            throw new Error("Tool returned no result");
          // MCP tools may return plain text; built-in failures use JSON envelopes.
          let parsed: unknown;
          try {
            parsed = JSON.parse(result);
          } catch {
            parsed = undefined;
          }
          if (parsed && typeof parsed === "object" && "error" in parsed)
            error = parsed.error === true || typeof parsed.error === "string";
        } catch (e) {
          result = JSON.stringify({ error: errorText(e) });
          error = true;
        }
        result = redact(result);
        for (const secret of options.secrets ?? [])
          if (secret) result = result.split(secret).join("[REDACTED]");
        store.finish(actionId, result);
        emitAll({ type: "tool.end", id: call.id, result, error });
        const toolMessage: Message = {
          role: "tool",
          content: result,
          callId: call.id,
          error,
        };
        store.append(session.id, toolMessage);
        messages.push(toolMessage);
        toolErrors = error ? toolErrors + 1 : 0;
        if (toolErrors >= 8)
          throw new RivetError("Too many consecutive tool errors", 4);
      }
      if (signal.aborted) throw new RivetError("Cancelled", 130);
    }
  } catch (e) {
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
