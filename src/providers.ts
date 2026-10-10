import { setTimeout as delay } from "node:timers/promises";
import { destination, type Config } from "./config.js";
import {
  RivetError,
  type Emit,
  type Message,
  type Provider,
  type ToolCall,
  type ToolDefinition,
  type Usage,
} from "./types.js";

const ARG_BYTES = 65536;
const RESPONSE_BYTES = 16 * 1024 * 1024;
const TEXT_BYTES = 1024 * 1024;
type Json = Record<string, unknown>;
type PendingCall = {
  id: string;
  name: string;
  json: string;
  extra?: Record<string, unknown>;
};
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const invalid = (detail: string): never => {
  throw new RivetError(`Invalid provider response: ${detail}`);
};

function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const suffix = "\n[Tool result truncated]";
  const budget = Math.max(0, bytes - Buffer.byteLength(suffix));
  // Decode only complete UTF-8 characters at the cut point.
  const decoded = new TextDecoder().decode(
    Buffer.from(text).subarray(0, budget),
  );
  return decoded.replace(/\ufffd$/, "") + suffix;
}

function parse(data: string): Json {
  try {
    const value: unknown = JSON.parse(data);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return invalid("expected an object");
    return value as Json;
  } catch {
    return invalid("malformed JSON");
  }
}

async function* events(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) return invalid("missing stream");
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  )
    return invalid("expected an event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    data: string[] = [],
    bytes = 0,
    eventBytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_BYTES) return invalid("stream is too large");
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
          eventBytes = 0;
        } else if (line.startsWith("data:")) {
          const piece = line.slice(5).replace(/^ /, "");
          eventBytes += Buffer.byteLength(piece);
          if (eventBytes > TEXT_BYTES) return invalid("event is too large");
          data.push(piece);
        }
      }
      if (Buffer.byteLength(buffer) > TEXT_BYTES)
        return invalid("event is too large");
    }
    decoder.decode();
    if (buffer.trim() || data.length) return invalid("incomplete event");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function transcript(messages: Message[], config: Config): Json[] {
  if (config.provider !== "anthropic")
    return messages.map((message) => {
      if (message.role === "tool")
        return {
          role: "tool",
          tool_call_id: message.callId,
          content: bounded(message.content, config.limits.outputBytes),
        };
      if (message.role === "assistant" && message.calls?.length)
        return {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
            ...(call.extra ? { extra_content: call.extra } : {}),
          })),
        };
      return { role: message.role, content: message.content };
    });
  const result: Json[] = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content: Json[] =
      message.role === "tool"
        ? [
            {
              type: "tool_result",
              tool_use_id: message.callId,
              content: bounded(message.content, config.limits.outputBytes),
              is_error: !!message.error,
            },
          ]
        : [
            ...(message.content
              ? [{ type: "text", text: message.content }]
              : []),
            ...(message.role === "assistant"
              ? (message.calls || []).map((call) => ({
                  type: "tool_use",
                  id: call.id,
                  name: call.name,
                  input: call.arguments,
                }))
              : []),
          ];
    const previous = result.at(-1);
    if (previous?.role === role) (previous.content as Json[]).push(...content);
    else result.push({ role, content });
  }
  return result;
}

function requestBody(
  config: Config,
  system: string,
  messages: Message[],
  tools: ToolDefinition[],
  maxOutput: number,
): string {
  for (const message of messages)
    if (message.role === "assistant")
      for (const call of message.calls || []) {
        if (Buffer.byteLength(JSON.stringify(call.arguments)) > ARG_BYTES)
          throw new RivetError("Tool arguments exceed 64 KiB");
      }
  const common = { model: config.model.id, stream: true };
  const body =
    config.provider === "anthropic"
      ? {
          ...common,
          system,
          messages: transcript(messages, config),
          max_tokens: maxOutput,
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters,
                })),
              }
            : {}),
        }
      : {
          ...common,
          messages: [
            { role: "system", content: system },
            ...transcript(messages, config),
          ],
          ...(config.provider === "openai"
            ? { max_completion_tokens: maxOutput }
            : { max_tokens: maxOutput }),
          stream_options: { include_usage: true },
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: "function",
                  function: tool,
                })),
              }
            : {}),
        };
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > RESPONSE_BYTES)
    throw new RivetError("Provider request exceeds 16 MiB");
  return encoded;
}

async function request(
  config: Config,
  key: string,
  body: string,
  signal: AbortSignal,
  emit: Emit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetch(destination(config), {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(config.provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${key}` }),
      },
      body,
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (
      attempt >= 2 ||
      ![408, 429, 500, 502, 503, 504, 529].includes(response.status)
    ) {
      // Never include remote error bodies or fetch error messages: they may echo credentials.
      throw new RivetError(`Provider request failed (HTTP ${response.status})`);
    }
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const wait =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.min(seconds * 1000, 5000)
        : 250 * 2 ** attempt;
    emit({
      type: "status",
      message: `Provider busy; retrying (${attempt + 1}/2)`,
    });
    await delay(wait, undefined, { signal });
  }
}

async function collect(
  response: Response,
  config: Config,
  tools: ToolDefinition[],
  body: string,
  signal: AbortSignal,
  emit: Emit,
) {
  let text = "",
    textBytes = 0,
    completed = false,
    finished = false,
    stopReason = "";
  let input: number | undefined, output: number | undefined;
  const pending = new Map<number, PendingCall>();
  const textDelta = (delta: unknown) => {
    if (delta === undefined || delta === null) return;
    if (typeof delta !== "string") return invalid("text delta is not text");
    textBytes += Buffer.byteLength(delta);
    if (textBytes > TEXT_BYTES) return invalid("text exceeds 1 MiB");
    text += delta;
    if (delta) emit({ type: "text", text: delta });
  };
  const append = (
    index: unknown,
    id: unknown,
    name: unknown,
    args: unknown,
    extra?: unknown,
  ) => {
    const slot = count(index);
    if (slot === undefined || slot >= 128) return invalid("tool index");
    let call = pending.get(slot);
    if (!call) {
      if (pending.size >= Math.min(64, config.limits.tools))
        return invalid("too many tool calls");
      call = { id: "", name: "", json: "" };
      pending.set(slot, call);
    }
    if (
      extra &&
      typeof extra === "object" &&
      !Array.isArray(extra) &&
      !call.extra
    )
      call.extra = extra as Record<string, unknown>;
    call.id += string(id);
    call.name += string(name);
    call.json += string(args);
    if (
      call.id.length > 200 ||
      call.name.length > 128 ||
      Buffer.byteLength(call.json) > ARG_BYTES
    )
      return invalid("tool call exceeds size limit");
  };
  for await (const data of events(response, signal)) {
    if (config.provider !== "anthropic" && data === "[DONE]") {
      completed = true;
      break;
    }
    const event = parse(data);
    if (event.error || event.type === "error")
      throw new RivetError("Provider reported a stream error");
    if (config.provider === "anthropic") {
      const delta = object(event.delta);
      if (event.type === "message_start") {
        const usage = object(object(event.message).usage);
        const base = count(usage.input_tokens);
        input =
          base === undefined
            ? undefined
            : base +
              (count(usage.cache_creation_input_tokens) || 0) +
              (count(usage.cache_read_input_tokens) || 0);
        output = count(usage.output_tokens);
      } else if (event.type === "content_block_start") {
        const block = object(event.content_block);
        if (block.type === "tool_use")
          append(event.index, block.id, block.name, "");
        else if (block.type === "text") textDelta(block.text);
      } else if (event.type === "content_block_delta") {
        if (delta.type === "text_delta") textDelta(delta.text);
        else if (delta.type === "input_json_delta") {
          if (!pending.has(count(event.index) ?? -1))
            return invalid("tool delta without a tool");
          append(event.index, "", "", delta.partial_json);
        }
      } else if (event.type === "message_delta") {
        stopReason = string(delta.stop_reason);
        finished = !!stopReason;
        output = count(object(event.usage).output_tokens) ?? output;
      } else if (event.type === "message_stop") {
        completed = true;
        break;
      }
    } else {
      const usage = object(event.usage);
      input = count(usage.prompt_tokens) ?? input;
      output = count(usage.completion_tokens) ?? output;
      for (const item of array(event.choices)) {
        const choice = object(item);
        if (choice.index !== 0) return invalid("unexpected choice index");
        const delta = object(choice.delta);
        textDelta(delta.content);
        const calls = array(delta.tool_calls);
        calls.forEach((value, position) => {
          const call = object(value),
            fn = object(call.function);
          // Gemini's OpenAI stream omits the per-call index. Fall back to the
          // position in this delta, which is stable for a one-chunk call.
          append(
            call.index ?? position,
            call.id,
            fn.name,
            fn.arguments,
            call.extra_content,
          );
        });
        if (choice.finish_reason) {
          finished = true;
          stopReason = string(choice.finish_reason);
          // Gemini delivers a tool call in one chunk and finishes with "stop".
          // A split call that ends this way is still incomplete.
          if (
            stopReason === "stop" &&
            pending.size &&
            [...pending.values()].every((call) => {
              if (!call.id || !call.name || !call.json) return false;
              try {
                const parsed: unknown = JSON.parse(call.json);
                return (
                  parsed !== null &&
                  typeof parsed === "object" &&
                  !Array.isArray(parsed)
                );
              } catch {
                return false;
              }
            })
          )
            stopReason = "tool_calls";
        }
      }
    }
  }
  if (!completed || !finished) return invalid("stream ended before completion");
  if (
    !["stop", "tool_calls", "end_turn", "tool_use", "stop_sequence"].includes(
      stopReason,
    )
  )
    throw new RivetError(
      "Provider response was interrupted or reached its output limit",
    );
  if (pending.size && !["tool_calls", "tool_use"].includes(stopReason))
    return invalid("tool calls without tool completion");
  const ids = new Set<string>();
  const calls: ToolCall[] = [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => {
      if (
        !call.id ||
        ids.has(call.id) ||
        !tools.some((tool) => tool.name === call.name)
      )
        return invalid("unknown tool or duplicate call ID");
      ids.add(call.id);
      return {
        id: call.id,
        name: call.name,
        arguments: parse(call.json || "{}"),
        ...(call.extra ? { extra: call.extra } : {}),
      };
    });
  const estimated = input === undefined || output === undefined;
  const usage: Usage = {
    input: input ?? Math.ceil(Buffer.byteLength(body) / 3),
    output:
      output ?? Math.ceil(Buffer.byteLength(text + JSON.stringify(calls)) / 3),
    ...(estimated ? { estimated: true } : {}),
  };
  return {
    message: {
      role: "assistant" as const,
      content: text,
      ...(calls.length ? { calls } : {}),
    },
    usage,
  };
}

/** A single model step. Tool execution belongs exclusively to the agent loop. */
export function createProvider(config: Config, key: string): Provider {
  if (!key || /[\r\n]/.test(key))
    throw new RivetError("A valid provider credential is required", 2);
  return {
    async step(system, messages, tools, maxOutput, signal, emit) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0)
        throw new RivetError("Output token allowance must be positive");
      const body = requestBody(
        config,
        system,
        messages,
        tools,
        Math.min(maxOutput, config.model.maxOutput),
      );
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), config.limits.timeoutMs);
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        const response = await request(config, key, body, combined, emit);
        return await collect(response, config, tools, body, combined, emit);
      } catch (error) {
        if (signal.aborted)
          throw new RivetError("Provider request cancelled", 130);
        if (timeout.signal.aborted)
          throw new RivetError("Provider request timed out");
        if (error instanceof RivetError) throw error;
        throw new RivetError(
          "Provider connection failed; check the configured destination and network",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Capability check: a model that cannot call a tool must not be selected. */
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
