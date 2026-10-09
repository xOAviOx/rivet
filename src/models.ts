import { configSchema, modelSchema, type Config } from "./config.js";
import { compact, estimate } from "./context.js";
import { createProvider, probe } from "./providers.js";
import { clean } from "./security.js";
import {
  RivetError,
  type Message,
  type Provider,
  type Usage,
} from "./types.js";

export type ModelSpec = Config["model"];
/** Metadata reported by the endpoint itself; nothing here is guessed. */
export type ListedModel = { id: string; context?: number; maxOutput?: number };
export type ModelListing = { models: ListedModel[]; truncated: boolean };
export type ModelChoice = {
  listing?: ModelListing;
  context?: number;
  maxOutput?: number;
  inputPrice?: number;
  outputPrice?: number;
};
export type ModelChange = { config: Config; omitted: number };

const LIST_BYTES = 4 * 1024 * 1024;
const LIST_LIMIT = 1000;
const MAX_TOKENS = 100_000_000;
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const tokens = (...values: unknown[]): number | undefined => {
  for (const value of values)
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_TOKENS
    )
      return value;
  return undefined;
};
const invalid = (detail: string): never => {
  throw new RivetError(`Invalid model listing: ${detail}`);
};

export function modelsUrl(config: Config): string {
  if (config.provider === "openai") return "https://api.openai.com/v1/models";
  // Anthropic pages at 20 by default; 1000 is its documented maximum page size.
  if (config.provider === "anthropic")
    return "https://api.anthropic.com/v1/models?limit=1000";
  return `${config.endpoint!.replace(/\/$/, "")}/models`;
}

async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return invalid("missing body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
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
      if (bytes > LIST_BYTES) return invalid("response exceeds 4 MiB");
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    return invalid("response is not UTF-8");
  }
}

function parseListing(text: string): ModelListing {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return invalid("malformed JSON");
  }
  const data = object(body).data;
  if (!Array.isArray(data)) return invalid("expected a data array");
  const seen = new Map<string, ListedModel>();
  for (const value of data) {
    const item = object(value);
    const id = item.id;
    // Identifiers are displayed and sent back to the provider; skip anything that is not plain.
    if (typeof id !== "string" || !MODEL_ID.test(id) || clean(id) !== id)
      continue;
    if (seen.has(id)) continue;
    const context = tokens(
      item.context_length,
      item.context_window,
      item.max_input_tokens,
      item.max_model_len,
    );
    const maxOutput = tokens(
      item.max_output_tokens,
      item.max_completion_tokens,
      object(item.top_provider).max_completion_tokens,
      item.max_tokens,
    );
    seen.set(id, {
      id,
      ...(context ? { context } : {}),
      ...(maxOutput ? { maxOutput } : {}),
    });
  }
  const models = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    models: models.slice(0, LIST_LIMIT),
    truncated: models.length > LIST_LIMIT || object(body).has_more === true,
  };
}

/** Lists models offered by the configured destination. Remote error bodies are never surfaced. */
export async function listModels(
  config: Config,
  key: string,
  signal: AbortSignal,
): Promise<ModelListing> {
  if (!key || /[\r\n]/.test(key))
    throw new RivetError("A valid provider credential is required", 2);
  const timeout = AbortSignal.timeout(Math.min(config.limits.timeoutMs, 30000));
  const combined = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(modelsUrl(config), {
      method: "GET",
      redirect: "error",
      signal: combined,
      headers: {
        accept: "application/json",
        ...(config.provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${key}` }),
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RivetError(`Model listing failed (HTTP ${response.status})`);
    }
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    ) {
      await response.body?.cancel().catch(() => {});
      return invalid("expected JSON");
    }
    return parseListing(await readBounded(response, combined));
  } catch (error) {
    if (signal.aborted) throw new RivetError("Model listing cancelled", 130);
    if (timeout.aborted) throw new RivetError("Model listing timed out");
    if (error instanceof RivetError) throw error;
    throw new RivetError(
      "Provider connection failed; check the configured destination and network",
    );
  }
}

/**
 * Builds a model specification from explicit values and endpoint-reported limits.
 * Explicit values may narrow reported limits but never exceed them.
 */
export function resolveModel(id: string, choice: ModelChoice = {}): ModelSpec {
  if (!MODEL_ID.test(id)) throw new RivetError("Invalid model identifier", 2);
  const listed = choice.listing?.models.find((m) => m.id === id);
  if (choice.listing && !listed && !choice.listing.truncated)
    throw new RivetError(`Model ${id} is not offered by this endpoint`, 2);
  if (
    choice.context !== undefined &&
    listed?.context !== undefined &&
    choice.context > listed.context
  )
    throw new RivetError(
      `Context ${choice.context} exceeds the reported ${listed.context} for ${id}`,
      2,
    );
  if (
    choice.maxOutput !== undefined &&
    listed?.maxOutput !== undefined &&
    choice.maxOutput > listed.maxOutput
  )
    throw new RivetError(
      `Output ${choice.maxOutput} exceeds the reported ${listed.maxOutput} for ${id}`,
      2,
    );
  const context = choice.context ?? listed?.context;
  if (context === undefined)
    throw new RivetError(
      `The endpoint does not report a context window for ${id}; specify it explicitly`,
      2,
    );
  // Default output leaves at least three quarters of the window for instructions and history.
  const maxOutput =
    choice.maxOutput ??
    Math.min(listed?.maxOutput ?? 4096, Math.floor(context / 4));
  const parsed = modelSchema.safeParse({
    id,
    tools: true,
    context,
    maxOutput,
    ...(choice.inputPrice === undefined
      ? {}
      : { inputPrice: choice.inputPrice }),
    ...(choice.outputPrice === undefined
      ? {}
      : { outputPrice: choice.outputPrice }),
  });
  if (!parsed.success)
    throw new RivetError(
      `Invalid model settings for ${id}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      2,
    );
  if (parsed.data.maxOutput >= parsed.data.context)
    throw new RivetError("maxOutput must be smaller than context", 2);
  return parsed.data;
}

function unresolvedCalls(history: Message[]): string[] {
  const results = new Set(
    history.flatMap((m) => (m.role === "tool" ? [m.callId] : [])),
  );
  return history.flatMap((m) =>
    m.role === "assistant"
      ? (m.calls ?? []).filter((c) => !results.has(c.id)).map((c) => c.id)
      : [],
  );
}

/**
 * Validates a switch without contacting the provider. The stored transcript is never altered;
 * `omitted` reports how many earlier turns the new window will leave out of context.
 */
export function planModelChange(
  config: Config,
  next: ModelSpec,
  history: Message[],
  system: string,
): ModelChange {
  const parsed = configSchema.safeParse({ ...config, model: next });
  if (!parsed.success)
    throw new RivetError(
      `Model unchanged: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      2,
    );
  const pending = unresolvedCalls(history);
  if (pending.length)
    throw new RivetError(
      `Model unchanged: reconcile ${pending.length} unfinished tool call(s) first`,
      2,
    );
  const budget = next.context - next.maxOutput - estimate(system);
  if (budget < 2048)
    throw new RivetError(
      `Model unchanged: ${next.id} leaves too little context for instructions`,
      4,
    );
  try {
    return { config: parsed.data, omitted: compact(history, budget).omitted };
  } catch (error) {
    if (error instanceof RivetError)
      throw new RivetError(
        `Model unchanged: the current turn does not fit ${next.id}'s context window`,
        4,
      );
    throw error;
  }
}

/**
 * Switches models only after the transcript fits and the new model passes the tool-calling check.
 * On any failure the caller's configuration is left as it was.
 */
export async function changeModel(
  config: Config,
  next: ModelSpec,
  options: {
    key: string;
    history: Message[];
    system: string;
    signal: AbortSignal;
    connect?: (config: Config, key: string) => Provider;
  },
): Promise<ModelChange & { usage: Usage | null }> {
  const plan = planModelChange(config, next, options.history, options.system);
  if (next.id === config.model.id) return { ...plan, usage: null };
  const provider = (options.connect ?? createProvider)(
    plan.config,
    options.key,
  );
  const usage = await probe(provider, options.signal);
  return { ...plan, usage };
}

/** Plain-text rows for a model picker; limits that the endpoint does not report are said so. */
export function modelLines(listing: ModelListing, current?: string): string[] {
  const lines = listing.models.map((m) =>
    [
      m.id,
      m.context ? `context ${m.context}` : "context not reported",
      ...(m.maxOutput ? [`output ${m.maxOutput}`] : []),
      ...(m.id === current ? ["(current)"] : []),
    ].join("  "),
  );
  if (!lines.length) lines.push("No models reported by this endpoint");
  if (listing.truncated)
    lines.push("List truncated; enter a model identifier directly");
  return lines;
}
