import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Workspace } from "./security.js";
import { RivetError } from "./types.js";

export type InstructionSource = {
  path: string;
  scope: string;
  text: string;
};
export type ScopedInstructions = {
  target: string;
  sources: InstructionSource[];
  text: string;
};
export type InstructionOptions = {
  signal?: AbortSignal;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
};

function limit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RivetError(`Invalid instruction ${label} limit`, 2);
  return value;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function render(sources: InstructionSource[]): string {
  if (!sources.length) return "";
  return (
    "Workspace instructions, ordered from root to closest scope. " +
    "More specific instructions take precedence within their scope only.\n\n" +
    sources
      .map(
        (source) => `Scope ${source.scope} (${source.path}):\n${source.text}`,
      )
      .join("\n\n")
  );
}

async function readInstructions(
  workspace: Workspace,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  // Only an absent AGENTS.md is optional. Unsafe paths and read errors fail closed.
  const filename = await workspace.path(path, true);
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new RivetError(
        `Instruction file ${path} must be a regular, unlinked file`,
      );
    if (info.size > maxBytes)
      throw new RivetError(
        `Instruction file ${path} exceeds ${maxBytes} bytes`,
        4,
      );
    // Revalidate after opening so a replaced path is not treated as the checked file.
    await workspace.path(path);
    const current = await lstat(filename);
    if (current.dev !== info.dev || current.ino !== info.ino)
      throw new RivetError(`Instruction file ${path} changed while loading`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      signal?.throwIfAborted();
      const chunk = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        null,
      );
      if (chunk.bytesRead === 0) break;
      bytes += chunk.bytesRead;
    }
    signal?.throwIfAborted();
    if (bytes > maxBytes)
      throw new RivetError(
        `Instruction file ${path} exceeds ${maxBytes} bytes`,
        4,
      );
    const contents = buffer.subarray(0, bytes);
    if (!isUtf8(contents) || contents.includes(0))
      throw new RivetError(`Instruction file ${path} must contain UTF-8 text`);
    return contents.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Load only ancestor scopes for one workspace-relative directory or file. */
export async function loadInstructions(
  workspace: Workspace,
  target = ".",
  options: InstructionOptions = {},
): Promise<ScopedInstructions> {
  options.signal?.throwIfAborted();
  if (
    typeof target !== "string" ||
    target.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(target)
  )
    throw new RivetError(
      "Instruction target must be a bounded, safe relative path",
    );
  const maxFileBytes = limit(options.maxFileBytes ?? 16384, 65536, "file byte");
  const maxTotalBytes = limit(
    options.maxTotalBytes ?? 32768,
    262144,
    "total byte",
  );
  const maxDepth = limit(options.maxDepth ?? 30, 64, "scope depth");
  const absolute = await workspace.path(target, true);
  options.signal?.throwIfAborted();
  let directory = dirname(absolute);
  try {
    const info = await lstat(absolute);
    if (info.isDirectory()) directory = absolute;
    else if (!info.isFile())
      throw new RivetError(
        "Instruction target must be a regular file or directory",
      );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const parts = relative(workspace.root, directory).split(sep).filter(Boolean);
  if (parts.length > maxDepth)
    throw new RivetError("Instruction scopes exceed the depth limit", 4);
  const sources: InstructionSource[] = [];
  const dirs = [workspace.root];
  for (const part of parts) dirs.push(join(dirs.at(-1)!, part));
  let text = "";
  for (const dir of dirs) {
    options.signal?.throwIfAborted();
    const path = portable(relative(workspace.root, join(dir, "AGENTS.md")));
    const contents = await readInstructions(
      workspace,
      path,
      maxFileBytes,
      options.signal,
    );
    if (contents === undefined) continue;
    sources.push({
      path,
      scope: portable(relative(workspace.root, dir)) || ".",
      text: contents,
    });
    text = render(sources);
    if (Buffer.byteLength(text) > maxTotalBytes)
      throw new RivetError(
        `Scoped instructions exceed ${maxTotalBytes} bytes including scope labels`,
        4,
      );
  }
  options.signal?.throwIfAborted();
  return {
    target: portable(relative(workspace.root, absolute)) || ".",
    sources,
    text,
  };
}
