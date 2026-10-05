import { spawn, type ChildProcess } from "node:child_process";
import { mcpSchema, type McpConfig } from "./config.js";
import { childEnvironment } from "./process.js";
import { clean, redact } from "./security.js";
import { RivetError, type Emit, type ToolDefinition } from "./types.js";

const PROTOCOL = "2025-06-18";
const SUPPORTED = new Set(["2025-06-18", "2025-03-26"]);
const MESSAGE_BYTES = 1024 * 1024;
const ARG_BYTES = 65536;
const SCHEMA_BYTES = 16384;
const DESCRIPTION_CHARS = 1024;
const MAX_TOOLS = 64;
const MAX_PAGES = 8;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const summary = (value: unknown, max = 200) =>
  clean(string(value)).slice(0, max);
function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const suffix = "\n[MCP result truncated]".slice(0, bytes);
  const budget = Math.max(0, bytes - Buffer.byteLength(suffix));
  return (
    new TextDecoder()
      .decode(Buffer.from(text).subarray(0, budget))
      .replace(/\ufffd$/, "") + suffix
  );
}

export type McpOptions = {
  /** Per-request deadline; also bounds initialization. */
  timeoutMs?: number;
  /** Maximum bytes of tool result text returned to the model. */
  outputBytes?: number;
  /** Working directory for stdio servers. */
  cwd?: string;
  /** Process-only credentials to remove before truncating tool results. */
  secrets?: string[];
};
export interface McpServer {
  readonly name: string;
  /** Tool definitions exposed to the model, named `mcp_<server>_<tool>`. */
  readonly tools: ToolDefinition[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string>;
  close(): Promise<void>;
}

interface Transport {
  send(message: Json, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
type Inbound = (message: unknown) => void;

async function* sse(
  response: Response,
  signal: AbortSignal,
  name: string,
): AsyncGenerator<string> {
  if (!response.body) throw new RivetError(`MCP ${name}: empty response`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    data: string[] = [],
    bytes = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MESSAGE_BYTES)
        throw new RivetError(`MCP ${name}: response exceeds 1 MiB`);
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === "\r" && end === buffer.length - 1) break;
        const line = buffer.slice(0, end);
        const separator = buffer.slice(end, end + 2) === "\r\n" ? 2 : 1;
        buffer = buffer.slice(end + separator);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
async function readJson(
  response: Response,
  signal: AbortSignal,
  name: string,
): Promise<unknown> {
  if (!response.body) throw new RivetError(`MCP ${name}: empty response`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MESSAGE_BYTES)
        throw new RivetError(`MCP ${name}: response exceeds 1 MiB`);
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new RivetError(`MCP ${name}: malformed JSON response`);
  }
}
const isResponseTo = (message: unknown, id: unknown) => {
  const m = object(message);
  return !!m && m.method === undefined && m.id === id;
};

class StdioTransport implements Transport {
  private child: ChildProcess;
  private buffer = "";
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private bytes = 0;
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private name: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    private inbound: Inbound,
    private died: (error: RivetError) => void,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin!.on("error", () => {});
    this.child.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdout!.on("end", () => {
      try {
        this.decoder.decode();
      } catch {
        this.fail(new RivetError(`MCP ${name}: invalid UTF-8 from server`));
      }
    });
    // Drain logs without retaining or echoing server-provided secrets.
    this.child.stderr!.resume();
    this.child.on("error", (error: NodeJS.ErrnoException) =>
      this.fail(
        new RivetError(
          `MCP ${name}: cannot start ${command} (${error.code ?? "error"})`,
          2,
        ),
      ),
    );
    this.child.on("close", (code, signal) =>
      this.fail(
        new RivetError(
          `MCP ${name}: server exited (${code ?? signal ?? "unknown"})`,
        ),
      ),
    );
  }
  private read(chunk: Buffer) {
    if (this.closed) return;
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > 16 * MESSAGE_BYTES) {
      this.fail(
        new RivetError(`MCP ${this.name}: connection output exceeds 16 MiB`),
      );
      return;
    }
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    } catch {
      this.fail(new RivetError(`MCP ${this.name}: invalid UTF-8 from server`));
      return;
    }
    if (Buffer.byteLength(this.buffer) > MESSAGE_BYTES) {
      this.fail(new RivetError(`MCP ${this.name}: message exceeds 1 MiB`));
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.fail(
          new RivetError(`MCP ${this.name}: malformed JSON from server`),
        );
        return;
      }
      this.inbound(parsed);
    }
  }
  private fail(error: RivetError) {
    if (this.closed) return;
    this.closed = true;
    this.kill();
    this.died(error);
  }
  send(message: Json, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      if (this.closed || !this.child.stdin?.writable)
        return reject(new RivetError(`MCP ${this.name}: server is closed`));
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        signal.removeEventListener("abort", abort);
        if (error) reject(new RivetError(`MCP ${this.name}: write failed`));
        else resolve();
      });
    });
  }
  private kill() {
    if (!this.child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(this.child.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
          env: childEnvironment(),
        },
      );
      killer.on("error", () => this.child.kill("SIGKILL"));
    } else {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        return resolve();
      const grace = setTimeout(() => this.kill(), 250);
      const deadline = setTimeout(() => {
        this.kill();
        this.child.stdin?.destroy();
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        this.child.unref();
        finish();
      }, 2000);
      const finish = () => {
        clearTimeout(grace);
        clearTimeout(deadline);
        this.child.removeListener("close", finish);
        resolve();
      };
      this.child.once("close", finish);
      this.child.stdin?.end();
    });
    return this.closing;
  }
}

class HttpTransport implements Transport {
  private session?: string;
  protocol?: string;
  constructor(
    private name: string,
    private url: string,
    private key: string | undefined,
    private inbound: Inbound,
  ) {}
  private headers(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    if (this.session) headers["mcp-session-id"] = this.session;
    if (this.protocol) headers["mcp-protocol-version"] = this.protocol;
    return headers;
  }
  private async fetch(init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.url, { ...init, redirect: "error" });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      // Fetch errors are not forwarded: they may echo the URL or headers.
      throw new RivetError(`MCP ${this.name}: request failed`);
    }
  }
  async send(message: Json, signal: AbortSignal) {
    const response = await this.fetch({
      method: "POST",
      signal,
      headers: this.headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }),
      body: JSON.stringify(message),
    });
    const session = response.headers.get("mcp-session-id");
    if (session && !this.session && message.method === "initialize") {
      if (!/^[\x21-\x7e]{1,256}$/.test(session)) {
        await response.body?.cancel();
        throw new RivetError(`MCP ${this.name}: invalid session id`);
      }
      this.session = session;
    }
    const request =
      message.id !== undefined && typeof message.method === "string";
    if (response.status === 202 && !request) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RivetError(`MCP ${this.name}: HTTP ${response.status}`);
    }
    if (!request) {
      await response.body?.cancel();
      throw new RivetError(
        `MCP ${this.name}: expected HTTP 202 for notification or response`,
      );
    }
    const type = (response.headers.get("content-type") || "").toLowerCase();
    const deliver = (parsed: unknown) => {
      if (Array.isArray(parsed))
        throw new RivetError(`MCP ${this.name}: unexpected JSON-RPC batch`);
      this.inbound(parsed);
      return isResponseTo(parsed, message.id);
    };
    if (type.includes("application/json")) {
      if (!deliver(await readJson(response, signal, this.name)))
        throw new RivetError(
          `MCP ${this.name}: response id does not match request`,
        );
      return;
    }
    if (type.includes("text/event-stream")) {
      for await (const data of sse(response, signal, this.name)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new RivetError(`MCP ${this.name}: malformed event`);
        }
        // The stream may stay open after the reply; stop reading once ours arrives.
        if (deliver(parsed)) return;
      }
      throw new RivetError(`MCP ${this.name}: stream ended before response`);
    }
    await response.body?.cancel();
    throw new RivetError(`MCP ${this.name}: unexpected content type`);
  }
  async close() {
    if (!this.session) return;
    const headers = this.headers();
    this.session = undefined;
    await this.fetch({
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => response.body?.cancel())
      .catch(() => {});
  }
}

type Waiter = { resolve: (result: Json) => void; reject: (e: unknown) => void };
class Client implements McpServer {
  readonly name: string;
  readonly tools: ToolDefinition[] = [];
  private originals = new Map<string, string>();
  private transport?: Transport;
  private next = 1;
  private pending = new Map<number, Waiter>();
  private dead?: RivetError;
  private timeoutMs: number;
  private outputBytes: number;
  private secrets: string[];
  private serverRequests = 0;
  constructor(
    private config: McpConfig,
    private emit: Emit,
    options: McpOptions,
  ) {
    this.name = config.name;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.outputBytes = options.outputBytes ?? 32768;
    this.secrets = [...(options.secrets ?? [])];
  }
  async open(key: string | undefined, cwd: string, signal: AbortSignal) {
    if (key) this.secrets.push(key);
    const inbound: Inbound = (message) => this.inbound(message);
    if (this.config.transport === "stdio") {
      const extra: Record<string, string> = {};
      if (this.config.keyEnv && key) extra[this.config.keyEnv] = key;
      this.transport = new StdioTransport(
        this.name,
        this.config.command!,
        this.config.args,
        childEnvironment(extra),
        cwd,
        inbound,
        (error) => this.fail(error),
      );
    } else
      this.transport = new HttpTransport(
        this.name,
        this.config.url!,
        key,
        inbound,
      );
    const init = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "rivet", version: "0.1.0" },
      },
      signal,
    );
    const version = string(init.protocolVersion);
    if (!SUPPORTED.has(version))
      throw new RivetError(
        `MCP ${this.name}: unsupported protocol version ${summary(version, 32) || "(missing)"}`,
      );
    if (this.transport instanceof HttpTransport)
      this.transport.protocol = version;
    await this.notify("notifications/initialized", undefined, signal);
    if (object(init.capabilities)?.tools === undefined) {
      this.emit({
        type: "status",
        message: `MCP ${this.name}: server offers no tools`,
      });
      return;
    }
    await this.discover(signal);
    this.emit({
      type: "status",
      message: `MCP ${this.name}: connected, ${this.tools.length} tool${this.tools.length === 1 ? "" : "s"}`,
    });
  }
  private async discover(signal: AbortSignal) {
    let cursor: string | undefined;
    const skip = (reason: string) =>
      this.emit({ type: "status", message: `MCP ${this.name}: ${reason}` });
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request(
        "tools/list",
        cursor ? { cursor } : undefined,
        signal,
      );
      if (!Array.isArray(result.tools))
        throw new RivetError(`MCP ${this.name}: invalid tool listing`);
      for (const raw of array(result.tools)) {
        if (this.tools.length >= MAX_TOOLS) {
          skip(`only the first ${MAX_TOOLS} tools are exposed`);
          return;
        }
        const tool = object(raw);
        const original = string(tool?.name);
        if (
          !tool ||
          !original ||
          original.length > 128 ||
          clean(original) !== original
        ) {
          skip("skipped a tool with an invalid name");
          continue;
        }
        const exposed =
          `mcp_${this.name}_${original.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(
            0,
            64,
          );
        if (this.originals.has(exposed)) {
          skip(`skipped ${summary(original, 64)}: name collision`);
          continue;
        }
        const schema = object(tool.inputSchema);
        if (
          !schema ||
          schema.type !== "object" ||
          Buffer.byteLength(JSON.stringify(schema)) > SCHEMA_BYTES
        ) {
          skip(`skipped ${summary(original, 64)}: unsupported input schema`);
          continue;
        }
        this.originals.set(exposed, original);
        this.tools.push({
          name: exposed,
          description: `[MCP ${this.name}] ${summary(tool.description, DESCRIPTION_CHARS)}`,
          parameters: {
            properties: {},
            ...schema,
            type: "object",
          },
        });
      }
      if (
        result.nextCursor !== undefined &&
        (typeof result.nextCursor !== "string" ||
          result.nextCursor.length > 4096)
      )
        throw new RivetError(`MCP ${this.name}: invalid pagination cursor`);
      const nextCursor = string(result.nextCursor) || undefined;
      if (nextCursor && nextCursor === cursor)
        throw new RivetError(`MCP ${this.name}: repeated pagination cursor`);
      cursor = nextCursor;
      if (!cursor) return;
    }
    skip(`discovery stopped after ${MAX_PAGES} pages`);
  }
  private inbound(raw: unknown) {
    if (this.dead) return;
    const message = object(raw);
    if (!message || message.jsonrpc !== "2.0") {
      this.fail(new RivetError(`MCP ${this.name}: invalid JSON-RPC message`));
      return;
    }
    if (typeof message.method === "string") {
      if (
        message.id !== undefined &&
        message.id !== null &&
        ++this.serverRequests > 32
      ) {
        this.fail(new RivetError(`MCP ${this.name}: too many server requests`));
        return;
      }
      // Server-initiated requests (sampling, roots, elicitation) are refused; notifications are ignored.
      if (message.id !== undefined && message.id !== null)
        void this.transport
          ?.send(
            message.method === "ping"
              ? { jsonrpc: "2.0", id: message.id, result: {} }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32601,
                    message: "Method not supported by this client",
                  },
                },
            AbortSignal.timeout(this.timeoutMs),
          )
          .catch(() => {});
      return;
    }
    const waiter =
      typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiter) return;
    const error = object(message.error);
    if ((message.result !== undefined) === (message.error !== undefined)) {
      waiter.reject(
        new RivetError(`MCP ${this.name}: invalid response envelope`),
      );
      return;
    }
    if (error)
      waiter.reject(
        new RivetError(`MCP ${this.name}: server returned a JSON-RPC error`),
      );
    else {
      const result = object(message.result);
      if (result) waiter.resolve(result);
      else
        waiter.reject(
          new RivetError(`MCP ${this.name}: response has no result`),
        );
    }
  }
  private fail(error: RivetError, report = true) {
    if (this.dead) return;
    this.dead = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    if (report) this.emit({ type: "status", message: error.message });
  }
  private notify(
    method: string,
    params?: Json,
    signal = new AbortController().signal,
  ) {
    return this.transport!.send(
      { jsonrpc: "2.0", method, ...(params ? { params } : {}) },
      AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    );
  }
  private request(
    method: string,
    params: Json | undefined,
    signal: AbortSignal,
  ): Promise<Json> {
    signal.throwIfAborted();
    if (this.dead) throw this.dead;
    const id = this.next++;
    const controller = new AbortController();
    return new Promise<Json>((resolve, reject) => {
      const finish = (error: unknown, result?: Json) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.abort();
        if (result) resolve(result);
        else reject(error);
      };
      const cancel = (error: RivetError) => {
        finish(error);
        if (method !== "initialize")
          void this.notify(
            "notifications/cancelled",
            {
              requestId: id,
              reason: "cancelled",
            },
            AbortSignal.timeout(1000),
          ).catch(() => {});
      };
      const timer = setTimeout(
        () => cancel(new RivetError(`MCP ${this.name}: ${method} timed out`)),
        this.timeoutMs,
      );
      const abort = () => cancel(new RivetError("Cancelled", 130));
      this.pending.set(id, {
        resolve: (result) => finish(undefined, result),
        reject: finish,
      });
      signal.addEventListener("abort", abort, { once: true });
      this.transport!.send(
        { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
        controller.signal,
      ).catch(finish);
    });
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const original = this.originals.get(name);
    if (!original) throw new RivetError(`Unknown MCP tool ${name}`);
    if (!object(args) || Buffer.byteLength(JSON.stringify(args)) > ARG_BYTES)
      throw new RivetError("Arguments must be an object under 64 KiB");
    const result = await this.request(
      "tools/call",
      { name: original, arguments: args },
      signal,
    );
    const texts: string[] = [];
    if (!Array.isArray(result.content))
      throw new RivetError(`MCP ${this.name}: invalid tool result`);
    for (const raw of array(result.content)) {
      const part = object(raw);
      if (!part) continue;
      if (part.type === "text") texts.push(clean(string(part.text)));
      else if (typeof part.type === "string")
        texts.push(`[${summary(part.type, 32)} content omitted]`);
    }
    if (!texts.length && result.structuredContent !== undefined)
      texts.push(clean(JSON.stringify(result.structuredContent)));
    let safe = redact(texts.join("\n"));
    for (const secret of this.secrets)
      if (secret) safe = safe.split(secret).join("[REDACTED]");
    const text = bounded(safe, this.outputBytes);
    if (result.isError === true)
      throw new RivetError(text || `MCP ${this.name}: tool failed`);
    return text || "[MCP returned no text]";
  }
  async close() {
    this.fail(new RivetError(`MCP ${this.name}: closed`), false);
    await this.transport?.close();
  }
}

export async function connectMcp(
  config: McpConfig,
  signal: AbortSignal,
  emit: Emit,
  options: McpOptions = {},
): Promise<McpServer> {
  signal.throwIfAborted();
  config = mcpSchema.parse(config);
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 600000)
  )
    throw new RivetError("MCP timeout must be between 1 and 600000 ms", 2);
  if (
    options.outputBytes !== undefined &&
    (!Number.isInteger(options.outputBytes) ||
      options.outputBytes < 1 ||
      options.outputBytes > MESSAGE_BYTES)
  )
    throw new RivetError(
      "MCP output limit must be between 1 byte and 1 MiB",
      2,
    );
  if (!config.trusted)
    throw new RivetError(
      `MCP server ${config.name} is not trusted. Review it, then set "trusted": true in config`,
      3,
    );
  const key = config.keyEnv ? process.env[config.keyEnv] : undefined;
  if (config.keyEnv && !key)
    throw new RivetError(
      `Set ${config.keyEnv} for MCP server ${config.name}`,
      2,
    );
  if (key && /[\r\n]/.test(key))
    throw new RivetError(`Invalid credential for MCP ${config.name}`, 2);
  const client = new Client(config, emit, options);
  try {
    await client.open(key, options.cwd ?? process.cwd(), signal);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export interface McpSet {
  readonly tools: ToolDefinition[];
  owner(name: string): McpServer | undefined;
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string>;
  close(): Promise<void>;
}
/** Connect all explicitly configured servers, closing earlier connections on failure. */
export async function connectAll(
  configs: McpConfig[],
  signal: AbortSignal,
  emit: Emit,
  options: McpOptions = {},
): Promise<McpSet> {
  const servers: McpServer[] = [];
  const owners = new Map<string, McpServer>();
  for (const config of configs) {
    try {
      const server = await connectMcp(config, signal, emit, options);
      servers.push(server);
      for (const tool of server.tools) {
        if (owners.has(tool.name))
          throw new RivetError(`MCP tool name collision: ${tool.name}`, 2);
        owners.set(tool.name, server);
      }
    } catch (error) {
      await Promise.all(servers.map((s) => s.close().catch(() => {})));
      throw error;
    }
  }
  return {
    tools: servers.flatMap((s) => s.tools),
    owner: (name) => owners.get(name),
    call: async (name, args, signal) => {
      const server = owners.get(name);
      if (!server) throw new RivetError(`Unknown MCP tool ${name}`);
      return server.call(name, args, signal);
    },
    close: async () => {
      await Promise.all(servers.map((s) => s.close().catch(() => {})));
    },
  };
}
