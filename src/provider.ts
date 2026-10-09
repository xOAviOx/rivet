import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { destination, type Config } from "./config.js";
import type {
  Message,
  Provider,
  ToolDefinition,
  Emit,
  ToolCall,
  Usage,
} from "./types.js";
import { RivetError } from "./types.js";

export async function* sse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) throw new RivetError("Response has no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.length;
      if (total > 4 * 1024 * 1024)
        throw new RivetError("Response stream exceeds 4 MiB");
      pending += decoder.decode(value, { stream: true });
      // Normalize CRLF only after complete lines are available, including split CR/LF chunks.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const packet = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const data = packet
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
      if (pending.length > 1024 * 1024)
        throw new RivetError("Oversized SSE event");
    }
    if (pending.trim()) throw new RivetError("Truncated SSE event");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  emit?: Emit,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (attempt < 2 && [429, 502, 503, 504].includes(response.status)) {
      const retry = Number(response.headers.get("retry-after"));
      const ms = Math.min(
        5000,
        Math.max(
          250,
          Number.isFinite(retry) && retry > 0
            ? retry * 1000
            : 500 * 2 ** attempt,
        ),
      );
      emit?.({
        type: "status",
        message: `Provider HTTP ${response.status}; retry ${attempt + 1}/2`,
      });
      await delay(ms, undefined, { signal });
      continue;
    }
    throw new RivetError(
      `Provider HTTP ${response.status}${[401, 403].includes(response.status) ? "; check credentials and account access" : ""}`,
    );
  }
}
const callSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()),
});
const chunkSchema = z.object({
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(99),
                  id: z.string().optional(),
                  function: z
                    .object({
                      name: z.string().optional(),
                      arguments: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          })
          .default({}),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
    })
    .nullable()
    .optional(),
});
const anthropicSchema = z.object({
  type: z.string(),
  index: z.number().int().min(0).max(99).optional(),
  message: z
    .object({
      usage: z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      }),
    })
    .optional(),
  content_block: z
    .object({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
  usage: z.object({ output_tokens: z.number() }).optional(),
});
export class HttpProvider implements Provider {
  constructor(
    private config: Config,
    private key: string,
  ) {}
  async step(
    system: string,
    messages: Message[],
    tools: ToolDefinition[],
    maxOutput: number,
    signal: AbortSignal,
    emit: Emit,
  ) {
    return this.config.provider === "anthropic"
      ? this.anthropic(system, messages, tools, maxOutput, signal, emit)
      : this.openai(system, messages, tools, maxOutput, signal, emit);
  }
  private async openai(
    system: string,
    messages: Message[],
    tools: ToolDefinition[],
    maxOutput: number,
    signal: AbortSignal,
    emit: Emit,
  ) {
    const converted = messages.map((m) =>
      m.role === "tool"
        ? { role: "tool", tool_call_id: m.callId, content: m.content }
        : m.role === "assistant"
          ? {
              role: "assistant",
              content: m.content || null,
              ...(m.calls?.length
                ? {
                    tool_calls: m.calls.map((c) => ({
                      id: c.id,
                      type: "function",
                      function: {
                        name: c.name,
                        arguments: JSON.stringify(c.arguments),
                      },
                    })),
                  }
                : {}),
            }
          : m,
    );
    const body = {
      model: this.config.model.id,
      messages: [{ role: "system", content: system }, ...converted],
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxOutput,
    };
    const response = await post(
      destination(this.config),
      { Authorization: `Bearer ${this.key}` },
      body,
      signal,
      emit,
    );
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel();
      throw new RivetError("Provider did not return SSE");
    }
    let content = "";
    let done = false;
    let finish = "";
    let usage: Usage | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of sse(response, signal)) {
      if (data === "[DONE]") {
        done = true;
        break;
      }
      const chunk = chunkSchema.parse(JSON.parse(data));
      if (chunk.error) throw new RivetError("Provider returned a stream error");
      if (chunk.usage)
        usage = {
          input: chunk.usage.prompt_tokens,
          output: chunk.usage.completion_tokens,
        };
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      if (choice.delta.content) {
        content += choice.delta.content;
        emit({ type: "text", text: choice.delta.content });
      }
      for (const fragment of choice.delta.tool_calls || []) {
        const c = calls.get(fragment.index) || { id: "", name: "", args: "" };
        c.id += fragment.id || "";
        c.name += fragment.function?.name || "";
        c.args += fragment.function?.arguments || "";
        calls.set(fragment.index, c);
      }
    }
    if (!done || !["stop", "tool_calls"].includes(finish))
      throw new RivetError(
        `Incomplete provider response (${finish || "disconnected"}); no tools executed`,
      );
    const parsed = [...calls.values()].map((c) =>
      callSchema.parse({
        id: c.id,
        name: c.name,
        arguments: JSON.parse(c.args || "{}"),
      }),
    );
    if (new Set(parsed.map((c) => c.id)).size !== parsed.length)
      throw new RivetError("Duplicate provider tool IDs");
    return {
      message: { role: "assistant" as const, content, calls: parsed },
      usage: usage || {
        input: JSON.stringify(body).length,
        output: content.length + JSON.stringify(parsed).length,
        estimated: true,
      },
    };
  }
  private async anthropic(
    system: string,
    messages: Message[],
    tools: ToolDefinition[],
    maxOutput: number,
    signal: AbortSignal,
    emit: Emit,
  ) {
    const converted: { role: string; content: unknown[] }[] = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content =
        m.role === "tool"
          ? [
              {
                type: "tool_result",
                tool_use_id: m.callId,
                content: m.content,
                is_error: !!m.error,
              },
            ]
          : m.role === "assistant"
            ? [
                ...(m.content ? [{ type: "text", text: m.content }] : []),
                ...(m.calls || []).map((c) => ({
                  type: "tool_use",
                  id: c.id,
                  name: c.name,
                  input: c.arguments,
                })),
              ]
            : [{ type: "text", text: m.content }];
      if (converted.at(-1)?.role === role)
        converted.at(-1)!.content.push(...content);
      else converted.push({ role, content });
    }
    const body = {
      model: this.config.model.id,
      system,
      messages: converted,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      max_tokens: maxOutput,
      stream: true,
    };
    const response = await post(
      destination(this.config),
      { "x-api-key": this.key, "anthropic-version": "2023-06-01" },
      body,
      signal,
      emit,
    );
    let content = "";
    let done = false;
    let stop = "";
    const usage: Usage = { input: 0, output: 0 };
    let hasUsage = false;
    const calls = new Map<
      number,
      {
        id: string;
        name: string;
        args: string;
        initial: Record<string, unknown>;
      }
    >();
    for await (const data of sse(response, signal)) {
      const event = anthropicSchema.parse(JSON.parse(data));
      if (event.type === "error")
        throw new RivetError("Anthropic returned a stream error");
      if (event.type === "message_start" && event.message) {
        const u = event.message.usage;
        usage.input =
          u.input_tokens +
          (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0);
        usage.output = u.output_tokens;
        hasUsage = true;
      }
      if (
        event.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      )
        calls.set(event.index!, {
          id: event.content_block.id || "",
          name: event.content_block.name || "",
          args: "",
          initial: event.content_block.input || {},
        });
      if (event.delta?.text) {
        content += event.delta.text;
        emit({ type: "text", text: event.delta.text });
      }
      if (event.delta?.partial_json) {
        const c = calls.get(event.index!);
        if (!c) throw new RivetError("Unexpected tool argument fragment");
        c.args += event.delta.partial_json;
      }
      if (event.delta?.stop_reason) stop = event.delta.stop_reason;
      if (event.usage) usage.output = event.usage.output_tokens;
      if (event.type === "message_stop") {
        done = true;
        break;
      }
    }
    if (!done || !["end_turn", "tool_use"].includes(stop))
      throw new RivetError(
        `Incomplete Anthropic response (${stop || "disconnected"}); no tools executed`,
      );
    const parsed = calls.size
      ? [...calls.values()].map((c) =>
          callSchema.parse({
            id: c.id,
            name: c.name,
            arguments: c.args ? JSON.parse(c.args) : c.initial,
          }),
        )
      : [];
    if (new Set(parsed.map((c) => c.id)).size !== parsed.length)
      throw new RivetError("Duplicate provider tool IDs");
    return {
      message: { role: "assistant" as const, content, calls: parsed },
      usage: hasUsage
        ? usage
        : {
            input: JSON.stringify(body).length,
            output: content.length + JSON.stringify(parsed).length,
            estimated: true,
          },
    };
  }
}
export async function probe(provider: Provider, signal: AbortSignal) {
  const tool: ToolDefinition = {
    name: "rivet_capability_check",
    description: "Return the supplied word",
    parameters: {
      type: "object",
      properties: { word: { type: "string" } },
      required: ["word"],
      additionalProperties: false,
    },
  };
  const result = await provider.step(
    "Call rivet_capability_check with word ready. Do not reply with text.",
    [{ role: "user", content: "Check tool calling now." }],
    [tool],
    128,
    signal,
    () => {},
  );
  if (
    !result.message.calls?.some(
      (c: ToolCall) => c.name === tool.name && c.arguments.word === "ready",
    )
  )
    throw new RivetError(
      "Model did not pass the tool-calling check; configuration unchanged",
      2,
    );
  return result.usage;
}
