import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { childEnvironment } from "./process.js";
import { clean, redact, type Workspace } from "./security.js";
import { RivetError } from "./types.js";

export type DiffOptions = {
  staged?: boolean;
  path?: string;
  context?: number;
  maxBytes?: number;
  timeoutMs?: number;
};
export type DiffResult = {
  text: string;
  truncated: boolean;
  staged: boolean;
};

const gitOptions = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=true",
];
const diffOptions = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--ignore-submodules=all",
  "--submodule=short",
  "--relative",
  "-O/dev/null",
];

function integer(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RivetError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
      2,
    );
  return value;
}

async function git(
  workspace: Workspace,
  args: string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ output: Buffer; truncated: boolean }> {
  signal.throwIfAborted();
  // Leave room for Git's executable path and Windows argument quoting.
  if ([...gitOptions, ...args].join(" ").length > 24000)
    throw new RivetError(
      "Diff arguments are too large; select a narrower path",
    );
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...gitOptions, ...args], {
      cwd: workspace.root,
      env: childEnvironment({
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        LC_ALL: "C",
      }),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = Buffer.alloc(0);
    let errors = Buffer.alloc(0);
    let truncated = false;
    let stopped = false;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(cleanupTimer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else if (code !== 0 && !truncated)
        reject(
          new RivetError(
            `Cannot read Git diff: ${redact(clean(redact(errors.toString("utf8")))).trim() || `Git exited with code ${code}`}`,
          ),
        );
      else resolve({ output, truncated });
    };
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill.exe",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.on("error", () => child.kill());
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
        finish(null);
      }, 2000);
    };
    const abort = () => stop();
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - output.length;
      output = Buffer.concat([output, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) {
        truncated = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors = Buffer.concat([
        errors,
        chunk.subarray(0, Math.max(0, 8192 - errors.length)),
      ]);
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function checkedPath(workspace: Workspace, path: string) {
  // Deleted directories have no on-disk parent to resolve. Validate the full
  // spelling first, then check each remaining ancestor without following links.
  let current = path;
  for (;;) {
    try {
      await workspace.path(current, true);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === ".")
        throw error;
      current = dirname(current);
    }
  }
}

function display(output: Buffer, truncated: boolean, maxBytes: number) {
  // Never expose a partial final line, which might cut a secret in half before
  // redaction, or leave a partial terminal escape sequence at the output limit.
  if (truncated)
    output = output.subarray(0, Math.max(0, output.lastIndexOf(10) + 1));
  let text = redact(clean(redact(new StringDecoder("utf8").write(output))));
  if (Buffer.byteLength(text) > maxBytes) truncated = true;
  if (truncated) {
    const marker = "[Diff truncated; select a narrower path]\n";
    const bytes = Buffer.from(text).subarray(
      0,
      maxBytes - Buffer.byteLength(marker),
    );
    text =
      bytes
        .subarray(0, Math.max(0, bytes.lastIndexOf(10) + 1))
        .toString("utf8") + marker;
  }
  return { text, truncated };
}

export async function workspaceDiff(
  workspace: Workspace,
  signal: AbortSignal,
  options: DiffOptions = {},
): Promise<DiffResult> {
  signal.throwIfAborted();
  if (options.staged !== undefined && typeof options.staged !== "boolean")
    throw new RivetError("staged must be a boolean", 2);
  if (options.path !== undefined && typeof options.path !== "string")
    throw new RivetError("path must be a relative workspace path", 2);
  const context = integer(options.context ?? 3, "context", 0, 100);
  const maxBytes = integer(options.maxBytes ?? 32768, "maxBytes", 256, 1048576);
  const timeout = integer(options.timeoutMs ?? 30000, "timeoutMs", 1, 600000);
  const staged = options.staged ?? false;
  const path = (options.path ?? ".").replace(/\\/g, "/");
  await checkedPath(workspace, path);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new RivetError("Git diff timed out", 1)),
    timeout,
  );
  const active = AbortSignal.any([signal, controller.signal]);
  try {
    // --no-textconv does not disable clean/process filters. Enumerate their
    // names without running them, then override each driver for this command.
    const config = await git(
      workspace,
      ["config", "--null", "--list", "--name-only"],
      active,
      65536,
    );
    if (config.truncated)
      throw new RivetError("Git configuration is too large for a safe diff");
    const filters: string[] = [];
    const drivers = new Set<string>();
    for (const key of config.output.toString("utf8").split("\0")) {
      const match = /^(filter\..+)\.(?:clean|process|required)$/i.exec(key);
      if (!match) continue;
      const driver = match[1]!;
      if (/[\s=]/u.test(driver))
        throw new RivetError("Cannot safely disable a Git filter name");
      drivers.add(driver);
    }
    for (const driver of drivers)
      filters.push(
        "-c",
        `${driver}.clean=`,
        "-c",
        `${driver}.process=`,
        "-c",
        `${driver}.required=false`,
      );
    const mode = staged ? ["--cached"] : [];
    const names = await git(
      workspace,
      [...filters, ...diffOptions, ...mode, "--name-only", "-z", "--", path],
      active,
      65536,
    );
    if (names.truncated)
      throw new RivetError("Too many changed paths; select a narrower path");
    const paths: string[] = [];
    for (const name of names.output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)) {
      active.throwIfAborted();
      try {
        await checkedPath(workspace, name);
        paths.push(name);
      } catch (error) {
        if (!(error instanceof RivetError)) throw error;
        // Protected files, symlinks and hard links are not previewed.
      }
    }
    if (paths.length === 0) return { text: "", truncated: false, staged };
    const result = await git(
      workspace,
      [
        ...filters,
        ...diffOptions,
        ...mode,
        "--patch",
        `--unified=${context}`,
        "--inter-hunk-context=0",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--line-prefix=",
        "--",
        ...paths,
      ],
      active,
      maxBytes,
    );
    return { ...display(result.output, result.truncated, maxBytes), staged };
  } finally {
    clearTimeout(timer);
  }
}
