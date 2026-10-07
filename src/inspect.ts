import { destination, keyName, type Config } from "./config.js";
import { mask } from "./export.js";
import { hash } from "./security.js";
import { jsonVisible, textVisible } from "./terminal.js";
import type { Message, ToolCall } from "./types.js";

type ToolMessage = Extract<Message, { role: "tool" }>;
export type ToolRecord = { call: ToolCall; result: ToolMessage | undefined };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const count = (n: number) => n.toLocaleString("en-US");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const longestFirst = (secrets: string[]) =>
  [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);

/**
 * Every tool call in transcript order with the result recorded for it. Results are matched
 * within the tool messages that directly follow their assistant message, because some
 * compatible endpoints reuse call ids across turns.
 */
export function toolHistory(messages: Message[]): ToolRecord[] {
  const records: ToolRecord[] = [];
  messages.forEach((message, i) => {
    if (message.role !== "assistant" || !message.calls?.length) return;
    const results = new Map<string, ToolMessage>();
    for (let j = i + 1; messages[j]?.role === "tool"; j++) {
      const result = messages[j] as ToolMessage;
      if (!results.has(result.callId)) results.set(result.callId, result);
    }
    for (const call of message.calls)
      records.push({ call, result: results.get(call.id) });
  });
  return records;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Multi-line strings become literal `|` rows and arrays one item per row; nothing is truncated. */
function field(label: string, value: unknown, indent: string): string[] {
  const head = `${indent}${textVisible(label)}:`;
  if (typeof value === "string" && value.includes("\n")) {
    const crlf = value.includes("\r\n");
    const parts = (crlf ? value.replace(/\r\n/g, "\n") : value).split("\n");
    const trailing = parts.at(-1) === "";
    if (trailing) parts.pop();
    const notes = [plural(parts.length, "line")];
    if (trailing) notes.push("ending with a newline");
    if (crlf) notes.push("CRLF line endings");
    return [
      `${head} ${notes.join(", ")}`,
      ...parts.map((part) => `${indent}  | ${textVisible(part)}`),
    ];
  }
  if (Array.isArray(value) && value.length)
    return [
      `${head} ${plural(value.length, "item")}`,
      ...value.map((item) => `${indent}  - ${jsonVisible(item)}`),
    ];
  return [`${head} ${jsonVisible(value)}`];
}

function block(label: string, value: unknown, indent: string): string[] {
  if (!isRecord(value)) return field(label, value, indent);
  const entries = Object.entries(value);
  if (!entries.length) return [`${indent}${label}: none`];
  return [
    `${indent}${label}:`,
    ...entries.flatMap(([key, item]) => field(key, item, `${indent}  `)),
  ];
}

function status(record: ToolRecord, parsed: unknown): string {
  if (!record.result)
    return "no result recorded (interrupted; outcome unknown)";
  if (isRecord(parsed) && parsed.deferred === true)
    return "deferred: scoped instructions were returned and nothing ran";
  return record.result.error ? "failed" : "completed";
}

/**
 * The exact arguments and complete stored result of the last `last` tool calls.
 * Stored results were redacted when recorded; known secrets are masked again here
 * because a /key value may postdate them.
 */
export function toolDetails(
  messages: Message[],
  last: number,
  secrets: string[] = [],
): string {
  const keys = longestFirst(secrets);
  const records = toolHistory(messages);
  if (!records.length) return "· no tool calls in this session";
  const shown = records.slice(-Math.max(1, last));
  const offset = records.length - shown.length;
  return shown
    .map((record, i) => {
      const parsed = record.result
        ? mask(parse(record.result.content), keys)
        : undefined;
      const lines = [
        `tool call ${offset + i + 1} of ${records.length}: ${textVisible(record.call.name)} (id ${textVisible(record.call.id)}) · ${status(record, parsed)}`,
        ...block("arguments", mask(record.call.arguments, keys), "  "),
      ];
      if (record.result) lines.push(...block("result", parsed, "  "));
      return lines.join("\n");
    })
    .join("\n\n");
}

const MODES: Record<Config["mode"], string> = {
  plan: "reads and read-only Git run without approval; edits, commands, other Git, and MCP tools are refused",
  edit: "reads and read-only Git run without approval; edits, commands, other Git, and MCP tools ask first",
  custom:
    "each tool follows its policy rule; tools without a rule, including reads, ask first",
};

const variable = (name: string) =>
  `${name} (${process.env[name] ? "set" : "not set"})`;

function credentialSource(config: Config): string {
  return config.credential === "environment"
    ? `environment variable ${variable(keyName(config))}`
    : `OS credential store, service "rivet", account ${hash(destination(config))}`;
}

function prices(model: Config["model"]): string {
  const { inputPrice: input, outputPrice: output } = model;
  if (input !== undefined && output !== undefined)
    return `$${input} input, $${output} output per million tokens`;
  const set = [
    input === undefined ? "" : `$${input} input`,
    output === undefined ? "" : `$${output} output`,
  ].filter(Boolean);
  return `${set.length ? `${set.join(", ")} per million tokens; ` : ""}not both set, so cost is not tracked`;
}

function policyLines(config: Config): string[] {
  const rules = Object.entries(config.policy).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const custom = config.mode === "custom";
  if (!rules.length) return custom ? ["  policy: no rules"] : [];
  return [
    custom ? "  policy:" : "  policy (used only in custom mode):",
    ...rules.map(([tool, rule]) => `    ${tool}: ${rule}`),
  ];
}

function mcpLines(config: Config): string[] {
  if (!config.mcp.length) return ["  MCP servers: none"];
  return [
    "  MCP servers:",
    ...config.mcp.map((server) => {
      const where =
        server.transport === "http"
          ? `http ${server.url}`
          : `stdio ${jsonVisible([server.command, ...server.args])} (host process, not sandboxed)`;
      const trust = server.trusted
        ? "trusted"
        : "not trusted; turns stop until it is trusted or removed";
      const key = server.keyEnv ? ` · key ${variable(server.keyEnv)}` : "";
      return `    ${server.name}: ${where} · ${trust}${key}`;
    }),
  ];
}

export type SettingsInfo = {
  configFile: string;
  database: string;
  session: string;
  workspace: string;
  /** True when /key supplied a process-only key; its value is never needed here. */
  sessionKey: boolean;
};

/** The effective configuration of a session. Keys are never shown, only where they come from. */
export function settingsReport(config: Config, info: SettingsInfo): string {
  const { model, limits } = config;
  const credential = info.sessionKey
    ? `session key from /key (this process only, not saved); configured source: ${credentialSource(config)}`
    : credentialSource(config);
  const lines = [
    `settings for this session (loaded from ${info.configFile}; /model and /key changes are not saved)`,
    `  provider: ${config.provider}`,
    `  destination: ${destination(config)}`,
    `  credential: ${credential}`,
    `  model: ${model.id}`,
    `    context: ${count(model.context)} tokens`,
    `    max output: ${count(model.maxOutput)} tokens per step`,
    `    prices: ${prices(model)}`,
    `  mode: ${config.mode} (${MODES[config.mode]})`,
    ...policyLines(config),
    "  limits per turn:",
    `    steps: ${count(limits.steps)}`,
    `    tool calls: ${count(limits.tools)}`,
    `    tokens: ${count(limits.tokens)}`,
    `    cost: ${limits.cost === undefined ? "none" : `$${limits.cost}`}`,
    `  request timeout: ${count(limits.timeoutMs)} ms (provider and MCP requests)`,
    `  tool output: ${count(limits.outputBytes)} bytes per result sent to the model`,
    ...mcpLines(config),
    `  workspace: ${info.workspace}`,
    `  session: ${info.session}`,
    `  session store: ${info.database}`,
  ];
  return textVisible(String(mask(lines.join("\n"), [])));
}
