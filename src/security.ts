import { lstat, realpath, readFile, readdir } from "node:fs/promises";
import { resolve, relative, sep, join, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Emit } from "./types.js";
import { RivetError } from "./types.js";

export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/* eslint-disable no-control-regex -- Terminal sanitization intentionally matches control characters. */
export function clean(text: string): string {
  // Strip entire OSC/CSI sequences, then all remaining terminal controls and bidi overrides.
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
/* eslint-enable no-control-regex */
export function redact(text: string): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && /KEY|TOKEN|SECRET|PASSWORD/i.test(key))
      text = text.split(value).join("[REDACTED]");
  }
  return text.replace(
    /\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\-/+=]{12,})/g,
    "[REDACTED]",
  );
}
const blocked = (part: string) =>
  /^(?:\.git|\.rivet|\.ssh|\.aws|\.codex|\.agents)$/i.test(part) ||
  /^\.env(?:\.|$)/i.test(part);
export class Workspace {
  private constructor(public root: string) {}
  static async open(root: string) {
    return new Workspace(await realpath(root));
  }
  async path(input: string, allowMissing = false): Promise<string> {
    if (
      input.includes("\0") ||
      isAbsolute(input) ||
      /^[a-z]:|^[/\\]{2}/i.test(input)
    )
      throw new RivetError("Use a relative workspace path");
    const parts = input.replace(/\\/g, "/").split("/");
    if (
      parts.some(
        (p) =>
          blocked(p) ||
          p === ".." ||
          (/[:*?<>|]|[. ]$/.test(p) && p !== ".") ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
    )
      throw new RivetError("Protected or unsafe path");
    const target = resolve(this.root, ...parts);
    if (!this.contains(target)) throw new RivetError("Path leaves workspace");
    let current = this.root;
    for (const part of relative(this.root, target).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new RivetError("Symlinks and junctions are not followed");
        if (!this.contains(await realpath(current)))
          throw new RivetError("Resolved path leaves workspace");
        if (info.isFile() && info.nlink > 1)
          throw new RivetError("Hard-linked files are not supported");
      } catch (e) {
        if (
          allowMissing &&
          (e as NodeJS.ErrnoException).code === "ENOENT" &&
          current === target
        )
          return target;
        throw e;
      }
    }
    return target;
  }
  contains(target: string) {
    const p = relative(this.root, target);
    return (
      p === "" || (!p.startsWith(".." + sep) && p !== ".." && !isAbsolute(p))
    );
  }
  async read(path: string, max = 262144) {
    const target = await this.path(path);
    const info = await lstat(target);
    if (!info.isFile() || info.size > max)
      throw new RivetError(`Not a regular file or exceeds ${max} bytes`);
    const text = await readFile(target, "utf8");
    if (text.includes("\0") || Buffer.byteLength(text) > max)
      throw new RivetError("Binary or oversized file");
    return text;
  }
  async files(start = ".", limit = 2000) {
    const output: string[] = [];
    let visited = 0;
    const walk = async (dir: string, depth: number) => {
      if (depth > 30 || visited >= 10000 || output.length >= limit) return;
      const entries = await readdir(await this.path(dir), {
        withFileTypes: true,
      });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (++visited > 10000 || output.length >= limit) break;
        if (
          entry.isSymbolicLink() ||
          blocked(entry.name) ||
          ["node_modules", "dist", ".cache", "coverage"].includes(entry.name)
        )
          continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) await walk(p, depth + 1);
        else if (entry.isFile()) output.push(p.replace(/\\/g, "/"));
      }
    };
    await walk(start, 0);
    return {
      files: output,
      truncated: output.length >= limit || visited >= 10000,
    };
  }
  async instructions(path = ".") {
    const target = await this.path(path, true);
    const dirs = [this.root];
    const rel = relative(this.root, path === "." ? target : dirname(target));
    for (const p of rel.split(sep).filter(Boolean))
      dirs.push(join(dirs.at(-1)!, p));
    const instructions: string[] = [];
    for (const dir of dirs) {
      const p = relative(this.root, join(dir, "AGENTS.md"));
      try {
        instructions.push(
          `Scope ${relative(this.root, dir) || "."}:\n${await this.read(p, 16384)}`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    const result = instructions.join("\n\n");
    if (result.length > 32768)
      throw new RivetError("Scoped instructions exceed 32 KiB");
    return result;
  }
}
export type Decision = "once" | "session" | "deny";
export type Approve = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Decision>;
export class Policy {
  private grants = new Set<string>();
  constructor(
    public config: Config,
    private approve: Approve,
    private emit: Emit,
  ) {}
  async check(
    name: string,
    args: Record<string, unknown>,
    effect: "read" | "write" | "exec" | "mcp",
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const rule =
      this.config.mode === "custom"
        ? this.config.policy[name] || "ask"
        : effect === "read"
          ? "allow"
          : "ask";
    if (rule === "deny" || (this.config.mode === "plan" && effect !== "read"))
      throw new RivetError(`Policy denies ${name}`, 3);
    const scope = hash(JSON.stringify([name, args]));
    if (rule === "allow" || this.grants.has(scope)) return;
    this.emit({ type: "approval", tool: name, args });
    const decision = await this.approve(name, args, signal);
    signal.throwIfAborted();
    this.emit({ type: "approval", tool: name, args, decision });
    if (decision === "deny")
      throw new RivetError(`Approval denied for ${name}`, 3);
    if (decision === "session") this.grants.add(scope);
  }
}
export const objectArgs = z.record(z.string(), z.unknown());
