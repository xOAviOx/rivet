import { z } from "zod";
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { RivetError } from "./types.js";

const positive = z.number().int().positive();
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    );
  }, "Use HTTPS, or HTTP on loopback; credentials, query strings and fragments are forbidden");
export const modelSchema = z
  .object({
    id: z.string().min(1).max(200),
    tools: z.literal(true),
    context: positive.min(4096),
    maxOutput: positive.default(4096),
    inputPrice: z.number().nonnegative().optional(),
    outputPrice: z.number().nonnegative().optional(),
  })
  .strict();
export const mcpSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,24}$/),
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: endpoint.optional(),
    keyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
    trusted: z.boolean().default(false),
  })
  .strict()
  .refine(
    (s) =>
      s.transport === "http" ? !!s.url && !s.command : !!s.command && !s.url,
    "Specify command for stdio or url for HTTP",
  );
export const configSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "compatible"]),
    model: modelSchema,
    endpoint: endpoint.optional(),
    keyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .optional(),
    credential: z.enum(["environment", "os"]).default("environment"),
    mode: z.enum(["plan", "edit", "custom"]).default("plan"),
    policy: z.record(z.string(), z.enum(["allow", "ask", "deny"])).default({}),
    limits: z
      .object({
        steps: positive.max(1000).default(30),
        tools: positive.max(10000).default(100),
        tokens: positive.default(100000),
        cost: z.number().positive().optional(),
        timeoutMs: positive.max(600000).default(120000),
        outputBytes: positive.max(1048576).default(32768),
      })
      .strict()
      .default({
        steps: 30,
        tools: 100,
        tokens: 100000,
        timeoutMs: 120000,
        outputBytes: 32768,
      }),
    mcp: z.array(mcpSchema).max(16).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.provider === "compatible" && !c.endpoint)
      ctx.addIssue({
        code: "custom",
        message: "Compatible providers require an explicit endpoint",
      });
    if (c.provider !== "compatible" && c.endpoint)
      ctx.addIssue({
        code: "custom",
        message: "Use compatible for a custom endpoint",
      });
    if (c.model.maxOutput >= c.model.context)
      ctx.addIssue({
        code: "custom",
        message: "maxOutput must be smaller than context",
      });
    if (
      c.limits.cost &&
      (c.model.inputPrice === undefined || c.model.outputPrice === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Cost limits require both per-million-token prices",
      });
    if (new Set(c.mcp.map((s) => s.name)).size !== c.mcp.length)
      ctx.addIssue({ code: "custom", message: "MCP names must be unique" });
  });
export type Config = z.infer<typeof configSchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export const configDir = () =>
  process.env.RIVET_HOME || join(homedir(), ".rivet");
export const destination = (c: Config) =>
  c.provider === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : c.provider === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : `${c.endpoint!.replace(/\/$/, "")}/chat/completions`;
export const keyName = (c: Config) =>
  c.keyEnv ||
  (c.provider === "openai"
    ? "OPENAI_API_KEY"
    : c.provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : "RIVET_API_KEY");
export async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink())
    throw new RivetError("State directory must not be a symlink", 2);
}
export async function loadConfig(
  file = join(configDir(), "config.json"),
): Promise<Config> {
  try {
    return configSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (e) {
    throw new RivetError(
      `Cannot load ${file}. Run rivet setup. ${e instanceof Error ? e.message : ""}`,
      2,
    );
  }
}
export async function saveConfig(config: Config) {
  await privateDir(configDir());
  await writeFile(
    join(configDir(), "config.json"),
    JSON.stringify(configSchema.parse(config), null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
