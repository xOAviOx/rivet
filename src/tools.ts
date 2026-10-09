import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ToolCall, ToolDefinition } from "./types.js";
import { Policy } from "./security.js";

/** Tool execution context; approval and mode policy are enforced by Policy. */
export type ToolContext = {
  workspace: string;
  policy: Policy;
  signal?: AbortSignal;
};
export interface ToolRunner {
  definitions: ToolDefinition[];
  execute(call: ToolCall, context: ToolContext): Promise<string>;
}

const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 48 * 1024;
const MAX_ENTRIES = 2000;
const protectedNames = new Set([".git", ".rivet"]);

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
const str = { type: "string" };
const definitions: ToolDefinition[] = [
  {
    name: "file_list",
    description:
      "List workspace files recursively; skips symlinks, .git, .rivet, and dependency directories.",
    parameters: schema({
      path: str,
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
  },
  {
    name: "file_read",
    description:
      "Read a UTF-8 workspace file (up to 1 MiB), returning contents and SHA-256 for a guarded patch.",
    parameters: schema({ path: str }, ["path"]),
  },
  {
    name: "file_search",
    description:
      "Find literal text in workspace UTF-8 files with bounded traversal and output.",
    parameters: schema(
      {
        query: str,
        path: str,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      ["query"],
    ),
  },
  {
    name: "file_patch",
    description:
      'Atomically replace one unique exact text match after checking SHA-256. To create a file, use create:true, expectedHash:null, oldText:"". Requires edit approval.',
    parameters: schema(
      {
        path: str,
        expectedHash: { type: ["string", "null"] },
        oldText: str,
        newText: str,
        create: { type: "boolean" },
      },
      ["path", "expectedHash", "oldText", "newText"],
    ),
  },
  {
    name: "command",
    description:
      "Run an executable directly, without a shell. Requires edit approval. Permission-controlled, NOT sandboxed: executable can access the host. Never retries.",
    parameters: schema(
      {
        command: str,
        args: { type: "array", items: str },
        cwd: str,
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      },
      ["command"],
    ),
  },
  {
    name: "git",
    description:
      "Run Git in the workspace. A narrow set of read-only commands works in plan mode; everything else requires edit approval. NOT sandboxed.",
    parameters: schema(
      {
        args: { type: "array", items: str },
        cwd: str,
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      },
      ["args"],
    ),
  },
];

function checkAbort(context: ToolContext): void {
  context.signal?.throwIfAborted();
}
/** Mode and allow/ask/deny decisions live at the policy boundary, not in tools. */
async function check(
  context: ToolContext,
  call: ToolCall,
  effect: "read" | "write" | "exec",
): Promise<void> {
  await context.policy.check(
    call.name,
    call.arguments,
    effect,
    context.signal ?? new AbortController().signal,
  );
}
function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  const value = args[key] ?? fallback;
  if (typeof value !== "string" || value.includes("\0"))
    throw new Error(`${key} must be a string without NUL bytes`);
  return value;
}
function integerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = args[key] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new Error(`${key} must be an integer from 1 to ${max}`);
  return value;
}
function argv(args: Record<string, unknown>, key: string): string[] {
  const value = args[key] ?? [];
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some(
      (arg: unknown) =>
        typeof arg !== "string" || arg.includes("\0") || arg.length > 8192,
    )
  )
    throw new Error(`${key} must contain at most 128 bounded strings`);
  return value as string[];
}
function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function safeRelative(input: string): string {
  if (
    input.length > 4096 ||
    path.isAbsolute(input) ||
    /^[a-z]:/i.test(input) ||
    input.startsWith("\\") ||
    input.includes(":")
  )
    throw new Error("Path must be relative to the workspace");
  const parts = input.split(/[\\/]+/);
  if (
    parts.some(
      (part) =>
        part === ".." ||
        protectedNames.has(part.toLowerCase()) ||
        (/[. ]$/.test(part) && part !== ".") ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Protected or unsafe workspace path");
  return parts.filter((part) => part !== "." && part !== "").join(path.sep);
}
async function resolvePath(
  root: string,
  input: string,
  allowMissing = false,
): Promise<string> {
  const relative = safeRelative(input);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error("Symlinks are not allowed in workspace tool paths");
    } catch (error) {
      if (allowMissing && isMissing(error)) continue;
      throw error;
    }
  }
  return current;
}
async function readFileBounded(filename: string): Promise<Buffer> {
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Path is not a regular file");
    if (stat.size > MAX_FILE) throw new Error("File exceeds the 1 MiB limit");
    const buffer = Buffer.alloc(MAX_FILE + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE) throw new Error("File exceeds the 1 MiB limit");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
function utf8(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error("Binary files are not supported");
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}
async function walk(
  root: string,
  start: string,
  limit: number,
  context: ToolContext,
): Promise<{ files: string[]; truncated: boolean }> {
  const pending = [start];
  const files: string[] = [];
  let visited = 0;
  while (pending.length) {
    checkAbort(context);
    const current = pending.pop()!;
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      files.push(path.relative(root, current).split(path.sep).join("/"));
      if (files.length >= limit)
        return { files, truncated: pending.length > 0 };
    } else if (stat.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (++visited > MAX_ENTRIES) return { files, truncated: true };
        if (
          protectedNames.has(entry.name.toLowerCase()) ||
          ["node_modules", ".pnpm", "dist"].includes(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        pending.push(path.join(current, entry.name));
      }
    }
  }
  return { files, truncated: false };
}

// Only exact safe flag grammars qualify; arbitrary Git options may execute helpers or write files.
function readOnlyGit(args: string[]): boolean {
  const [verb, ...flags] = args;
  if (verb === "status")
    return flags.every((flag) =>
      /^(--short|-s|--branch|-b|--porcelain(?:=[12])?|--untracked-files(?:=(?:no|normal|all))?)$/.test(
        flag,
      ),
    );
  if (verb === "diff")
    return flags.every((flag) =>
      /^(--stat|--numstat|--shortstat|--name-only|--name-status|--cached|--staged|--check|--no-color|--color=never|--exit-code|--quiet|--unified=[0-9]{1,3})$/.test(
        flag,
      ),
    );
  if (verb === "log")
    return flags.every((flag) =>
      /^(--oneline|--no-decorate|--decorate=short|--no-color|--all|--max-count=[0-9]{1,4}|-[0-9]{1,4})$/.test(
        flag,
      ),
    );
  return (
    verb === "branch" &&
    flags.every((flag) =>
      /^(--list|--all|-a|--remotes|-r|--show-current|--no-color)$/.test(flag),
    )
  );
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  context: ToolContext,
): Promise<string> {
  checkAbort(context);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
      },
    });
    let output = "";
    let bytes = 0;
    let truncated = false;
    let stopped: "timeout" | "cancelled" | undefined;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (data: Buffer): void => {
      const available = Math.max(0, MAX_OUTPUT - bytes);
      if (data.length > available) truncated = true;
      output += data.subarray(0, available).toString("utf8");
      bytes += Math.min(data.length, available);
    };
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      context.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else
        resolve(
          JSON.stringify({
            exitCode: code,
            signal,
            output,
            truncated,
            ...(stopped ? { stopped } : {}),
          }),
        );
    };
    const kill = (reason: "timeout" | "cancelled"): void => {
      if (stopped || settled) return;
      stopped = reason;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill.exe",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill("SIGKILL"));
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      // A detached descendant may keep inherited pipes open after process termination.
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill("SIGKILL");
        finish(null, "SIGKILL");
      }, 2000);
    };
    const abort = (): void => kill("cancelled");
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) abort();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export function createToolRunner(): ToolRunner {
  return {
    definitions,
    async execute(input: ToolCall, context: ToolContext): Promise<string> {
      try {
        checkAbort(context);
        const call = structuredClone(input);
        const definition = definitions.find((item) => item.name === call.name);
        if (!definition) throw new Error(`Unknown tool: ${call.name}`);
        const args = call.arguments;
        if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          Buffer.byteLength(JSON.stringify(args)) > 3 * MAX_FILE
        )
          throw new Error(
            "Tool arguments must be an object smaller than 3 MiB",
          );
        const properties = definition.parameters.properties as Record<
          string,
          unknown
        >;
        if (Object.keys(args).some((key) => !(key in properties)))
          throw new Error("Unknown tool argument");
        for (const key of definition.parameters.required as string[])
          if (!(key in args))
            throw new Error(`Missing required argument: ${key}`);
        const root = await realpath(context.workspace);
        if (call.name === "file_list" || call.name === "file_search") {
          const start = await resolvePath(root, stringArg(args, "path", "."));
          const limit = integerArg(
            args,
            "limit",
            100,
            call.name === "file_list" ? 500 : 200,
          );
          if (call.name === "file_list")
            return JSON.stringify(await walk(root, start, limit, context));
          const query = stringArg(args, "query");
          if (!query || query.length > 4096)
            throw new Error("query must contain 1 to 4096 characters");
          const listing = await walk(root, start, 256, context);
          const matches: Array<{ path: string; line: number; text: string }> =
            [];
          let scannedBytes = 0;
          let outputBytes = 0;
          let truncated = listing.truncated;
          search: for (const relative of listing.files) {
            checkAbort(context);
            let buffer: Buffer;
            let contents: string;
            try {
              buffer = await readFileBounded(await resolvePath(root, relative));
              contents = utf8(buffer);
            } catch {
              continue;
            }
            scannedBytes += buffer.length;
            if (scannedBytes > 8 * MAX_FILE) {
              truncated = true;
              break;
            }
            const lines = contents.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i]!.includes(query)) continue;
              const match = {
                path: relative,
                line: i + 1,
                text: lines[i]!.slice(0, 1000),
              };
              outputBytes += Buffer.byteLength(JSON.stringify(match));
              if (matches.length >= limit || outputBytes > MAX_OUTPUT) {
                truncated = true;
                break search;
              }
              matches.push(match);
            }
          }
          return JSON.stringify({ matches, truncated });
        }
        if (call.name === "file_read") {
          const filename = await resolvePath(root, stringArg(args, "path"));
          const buffer = await readFileBounded(filename);
          const contents = utf8(buffer);
          return JSON.stringify({
            path: args.path,
            sha256: sha256(buffer),
            contents: contents.slice(0, MAX_OUTPUT),
            truncated: contents.length > MAX_OUTPUT,
          });
        }
        if (call.name === "file_patch") {
          const relative = stringArg(args, "path");
          if (!safeRelative(relative))
            throw new Error("Cannot patch the workspace root");
          const oldText = stringArg(args, "oldText");
          const newText = stringArg(args, "newText");
          if (args.create !== undefined && typeof args.create !== "boolean")
            throw new Error("create must be a boolean");
          const create = args.create === true;
          if (
            create
              ? args.expectedHash !== null || oldText !== ""
              : typeof args.expectedHash !== "string" ||
                !/^[a-f0-9]{64}$/.test(args.expectedHash)
          )
            throw new Error(
              "A SHA-256 expectedHash is required, or null and empty oldText for creation",
            );
          const filename = await resolvePath(root, relative, create);
          await check(context, call, "write");
          checkAbort(context);
          await resolvePath(root, relative, create);
          let before: Buffer | undefined;
          if (create) {
            try {
              await lstat(filename);
              throw new Error("File already exists");
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
          } else before = await readFileBounded(filename);
          if (before && sha256(before) !== args.expectedHash)
            throw new Error("File changed: expectedHash does not match");
          const original = before ? utf8(before) : "";
          if (
            !create &&
            (!oldText ||
              original.indexOf(oldText) < 0 ||
              original.indexOf(oldText, original.indexOf(oldText) + 1) >= 0)
          )
            throw new Error("oldText must match exactly once");
          const updated = create
            ? newText
            : original.replace(oldText, () => newText);
          const result = Buffer.from(updated, "utf8");
          if (result.length > MAX_FILE)
            throw new Error("Result exceeds the 1 MiB limit");
          // Parent directories must exist: avoids approving implicit directory creation.
          await resolvePath(root, path.relative(root, path.dirname(filename)));
          const temporary = path.join(
            path.dirname(filename),
            `.rivet-patch-${randomUUID()}.tmp`,
          );
          const mode = before ? (await lstat(filename)).mode : 0o600;
          const handle = await open(temporary, "wx", mode);
          try {
            await handle.writeFile(result);
            await handle.sync();
            await handle.close();
            checkAbort(context);
            await resolvePath(root, relative, create);
            if (
              before &&
              sha256(await readFileBounded(filename)) !== args.expectedHash
            )
              throw new Error("File changed during patch");
            if (create) {
              // Hard-link publication provides atomic create-without-overwrite semantics.
              const { link } = await import("node:fs/promises");
              await link(temporary, filename);
            } else await rename(temporary, filename);
          } finally {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
          }
          return JSON.stringify({
            path: relative,
            sha256: sha256(result),
            bytes: result.length,
            created: create,
          });
        }
        const processArgs = argv(args, "args");
        const cwd = await resolvePath(root, stringArg(args, "cwd", "."));
        if (!(await lstat(cwd)).isDirectory())
          throw new Error("cwd must be a directory");
        const timeoutMs = integerArg(args, "timeoutMs", 30000, 120000);
        if (call.name === "git") {
          if (processArgs.length === 0)
            throw new Error("git args must include a subcommand");
          if (!readOnlyGit(processArgs)) await check(context, call, "exec");
          const safeArgs = [
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            ...processArgs,
          ];
          if (processArgs[0] === "diff")
            safeArgs.push("--no-ext-diff", "--no-textconv");
          return await runProcess("git", safeArgs, cwd, timeoutMs, context);
        }
        const executable = stringArg(args, "command");
        if (!executable || executable.length > 4096)
          throw new Error("command must contain 1 to 4096 characters");
        await check(context, call, "exec");
        return await runProcess(
          executable,
          processArgs,
          cwd,
          timeoutMs,
          context,
        );
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
