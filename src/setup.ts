import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  configDir,
  configSchema,
  destination,
  keyName,
  saveConfig,
  type Config,
} from "./config.js";
import { credential, storeCredential } from "./credentials.js";
import { createProvider, probe } from "./providers.js";
import { RivetError, errorText } from "./types.js";

export interface SetupIO {
  /** One visible answer; null when the user cancels or input ends. */
  ask(question: string): Promise<string | null>;
  /** One hidden answer; null when skipped or cancelled. */
  secret(label: string): Promise<string | null>;
  print(text: string): void;
}

export interface SetupOptions {
  signal: AbortSignal;
  /** Defaults read the configured source, store in the OS store, and run the provider probe. */
  readKey?: (config: Config) => Promise<string | undefined>;
  storeKey?: (config: Config, key: string) => Promise<void>;
  check?: (config: Config, key: string, signal: AbortSignal) => Promise<void>;
}

type Parsed<T> = { value: T } | { problem: string };

const cancelled = () =>
  new RivetError("Setup cancelled; nothing was saved", 130);

async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const integer = (text: string) => {
  const digits = text.replace(/[,_]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : NaN;
};

function choice<T extends string>(
  options: readonly T[],
  fallback?: T,
): (text: string) => Parsed<T> {
  return (text) => {
    const value = (text.toLowerCase() || fallback) as T | undefined;
    return value && options.includes(value)
      ? { value }
      : { problem: `Choose one of: ${options.join(", ")}` };
  };
}

function endpointValue(text: string): Parsed<string> {
  if (!text) return { problem: "Enter the endpoint URL" };
  const result = configSchema.shape.endpoint.unwrap().safeParse(text);
  return result.success
    ? { value: result.data }
    : { problem: result.error.issues[0]?.message ?? "Invalid URL" };
}

function modelId(text: string): Parsed<string> {
  // eslint-disable-next-line no-control-regex -- Model ids are sent verbatim to the provider.
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f\s]/.test(text))
    return {
      problem: "Enter the model id: 1 to 200 characters without spaces",
    };
  return { value: text };
}

/**
 * Interactive configuration. Every answer is validated when it is entered, the file is
 * written once at the end, and an existing configuration is never replaced.
 */
export async function runSetup(
  io: SetupIO,
  options: SetupOptions,
): Promise<Config> {
  const { signal } = options;
  const file = join(configDir(), "config.json");
  if (await exists(file))
    throw new RivetError(
      `${file} already exists; edit it, or move it aside and run rivet setup again`,
      2,
    );
  const ask = async <T>(
    question: string,
    parse: (text: string) => Parsed<T>,
  ): Promise<T> => {
    for (;;) {
      const text = await io.ask(question);
      if (text === null || signal.aborted) throw cancelled();
      const parsed = parse(text.trim());
      if ("value" in parsed) return parsed.value;
      io.print(`  ${parsed.problem}`);
    }
  };

  io.print(
    "Rivet setup. Keys stay in your environment or OS credential store; the config file never contains one. Esc or Ctrl+C cancels.",
  );
  const provider = await ask(
    "Provider (openai, anthropic, compatible):",
    choice(["openai", "anthropic", "compatible"] as const),
  );
  const endpoint =
    provider === "compatible"
      ? await ask(
          "Endpoint base URL, for example http://127.0.0.1:8080/v1:",
          endpointValue,
        )
      : undefined;
  const source = await ask(
    "Credential source (environment, os) [environment]:",
    choice(["environment", "os"] as const, "environment"),
  );
  const defaultName = keyName({ provider });
  const keyEnv =
    source === "environment"
      ? await ask(
          `Environment variable holding the key [${defaultName}]:`,
          (text): Parsed<string> =>
            /^[A-Z_][A-Z0-9_]*$/.test(text || defaultName)
              ? { value: text || defaultName }
              : {
                  problem:
                    "Use upper-case letters, digits, and underscores, not starting with a digit",
                },
        )
      : defaultName;
  const id = await ask("Model id:", modelId);
  const context = await ask(
    "Context window in tokens (at least 4096):",
    (text): Parsed<number> => {
      const value = integer(text);
      return Number.isSafeInteger(value) && value >= 4096
        ? { value }
        : { problem: "Enter a whole number of at least 4096" };
    },
  );
  const fallback = Math.min(4096, Math.floor(context / 4));
  const maxOutput = await ask(
    `Max output tokens per step [${fallback}]:`,
    (text): Parsed<number> => {
      const value = text ? integer(text) : fallback;
      return Number.isSafeInteger(value) && value >= 1 && value < context
        ? { value }
        : {
            problem: `Enter a whole number from 1 to ${context - 1} (below the context window)`,
          };
    },
  );

  let config: Config;
  try {
    config = configSchema.parse({
      provider,
      ...(endpoint ? { endpoint } : {}),
      ...(keyEnv !== defaultName ? { keyEnv } : {}),
      credential: source,
      model: { id, tools: true, context, maxOutput },
    });
  } catch (error) {
    throw new RivetError(`Invalid settings: ${errorText(error)}`, 2);
  }

  const readKey =
    options.readKey ?? ((c: Config) => credential(c).catch(() => undefined));
  const storeKey = options.storeKey ?? storeCredential;
  const check =
    options.check ??
    (async (c: Config, key: string, s: AbortSignal) => {
      await probe(createProvider(c, key), s);
    });

  let key = await readKey(config);
  let typed = false;
  if (!key && config.credential === "os") {
    const value = await io.secret(
      `Key for ${destination(config)} (hidden; Enter skips)`,
    );
    if (signal.aborted) throw cancelled();
    if (value) {
      key = value;
      typed = true;
    }
  }
  if (key) {
    io.print(
      `Checking tool calling with ${config.model.id} at ${destination(config)}...`,
    );
    try {
      await check(config, key, signal);
    } catch (error) {
      if (signal.aborted) throw cancelled();
      throw new RivetError(
        `Nothing was saved: ${errorText(error)}`,
        error instanceof RivetError ? error.exitCode : 1,
      );
    }
    io.print("The model passed the tool-calling check.");
    if (typed) {
      try {
        await storeKey(config, key);
        io.print("Saved the key in the OS credential store.");
      } catch (error) {
        io.print(
          `The key was not saved in the OS credential store: ${errorText(error)}`,
        );
      }
    }
  } else
    io.print(
      config.credential === "environment"
        ? `${keyName(config)} is not set, so the tool-calling check was skipped. Set it, then run rivet models check.`
        : "No key is in the OS credential store yet, so the tool-calling check was skipped. Add one, then run rivet models check.",
    );

  if (signal.aborted) throw cancelled();
  try {
    await saveConfig(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new RivetError(`${file} was created during setup; not replaced`, 2);
    throw error;
  }
  io.print(
    `Saved ${file}. Mode is plan, which only reads; set "mode": "edit" there to allow approved changes. Run rivet inside a project directory.`,
  );
  return config;
}
