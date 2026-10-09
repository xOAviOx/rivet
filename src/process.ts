import { spawn } from "node:child_process";
import { RivetError } from "./types.js";

export function childEnvironment(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(
        k,
      )
    )
      env[k] = v;
  return { ...env, ...extra };
}
export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 30000,
  maxBytes = 32768,
  env = childEnvironment(),
): Promise<{ code: number; output: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = Buffer.alloc(0);
    let stopped = "";
    let settled = false;
    const kill = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill",
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
    };
    const abort = () =>
      kill("Command cancelled; side effects may have occurred");
    const timer = setTimeout(
      () => kill("Command timed out; side effects may have occurred"),
      timeout,
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const collect = (chunk: Buffer) => {
      const remaining = maxBytes - output.length;
      output = Buffer.concat([
        output,
        chunk.subarray(0, Math.max(0, remaining)),
      ]);
      if (chunk.length > remaining)
        kill("Command output limit exceeded; side effects may have occurred");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopped) reject(new RivetError(stopped, signal.aborted ? 130 : 1));
      else resolve({ code: code ?? 1, output: output.toString("utf8") });
    });
  });
}
