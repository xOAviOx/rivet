# Rivet

Rivet is a local, permission-controlled terminal coding agent. It inspects a project, performs a coding task with a model provider you already pay for, asks before anything consequential, and saves the conversation so you can resume it after an interruption.

It is built for a developer who works in their own terminal and repository: every action is shown as it happens, approval scope is explicit, your uncommitted work is never discarded, and recovery after a crash is understandable.

## Requirements

- Node.js 22.19 or newer. Node 24 LTS is recommended; on Node 22 the bundled SQLite driver prints one `ExperimentalWarning` at startup.
- pnpm 11 (`corepack enable` is enough).
- An API key for OpenAI, Anthropic, or an OpenAI-compatible endpoint that supports tool calling.
- Git on `PATH` for the Git tool and `/diff`.

## Install

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack              # produces rivet-agent-<version>.tgz
npm install -g ./rivet-agent-*.tgz
```

During development run `pnpm start -- <args>` or `node dist/cli.js <args>` instead of installing.

## Setup

```sh
export OPENAI_API_KEY=...     # or ANTHROPIC_API_KEY, or your own name
rivet setup
```

`rivet setup` asks for the provider, an explicit endpoint when the provider is `compatible`, the credential source, and the model's id, context window, and output allowance. If a key is available it runs a one-shot tool-calling check against the model before saving. The result is written once to `~/.rivet/config.json` with private permissions; it never contains a key. Set `RIVET_HOME` to use a different state directory.

See [`example.config.json`](example.config.json) for a complete, valid file. Fields:

| Field                | Meaning                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `provider`           | `openai`, `anthropic`, or `compatible`.                                                                            |
| `endpoint`           | Required for `compatible`, forbidden otherwise. HTTPS, or HTTP on loopback only; no credentials, query, hash.      |
| `model.id`           | Model identifier sent to the provider.                                                                             |
| `model.tools`        | Must be `true`; models without tool calling cannot be configured.                                                  |
| `model.context`      | Context window in tokens (at least 4096). Bounds compaction.                                                       |
| `model.maxOutput`    | Output allowance per step (default 4096, must be below `context`).                                                 |
| `model.inputPrice`   | Optional USD per million input tokens. Both prices are required for `limits.cost`.                                 |
| `model.outputPrice`  | Optional USD per million output tokens.                                                                            |
| `keyEnv`             | Environment variable holding the key. Defaults: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `RIVET_API_KEY`.            |
| `credential`         | `environment` (default) or `os` (Keychain, Secret Service, or Windows PasswordVault).                              |
| `mode`               | `plan` (default), `edit`, or `custom`. See Modes.                                                                  |
| `policy`             | For `custom` mode: `{ "<tool>": "allow" \| "ask" \| "deny" }`. Unlisted tools ask.                                 |
| `limits.steps`       | Model steps per turn (default 30, max 1000).                                                                       |
| `limits.tools`       | Tool calls per turn (default 100, max 10000).                                                                      |
| `limits.tokens`      | Input plus output tokens per turn (default 100000).                                                                |
| `limits.cost`        | Optional USD per turn.                                                                                             |
| `limits.timeoutMs`   | Provider request deadline (default 120000, max 600000).                                                            |
| `limits.outputBytes` | Tool result bytes kept per result (default 32768, max 1 MiB).                                                      |
| `mcp`                | Up to 16 MCP servers. Each must be marked `"trusted": true` before Rivet connects. See [docs/MCP.md](docs/MCP.md). |

Unknown fields are rejected so typos never silently disable a limit.

## Use

Run `rivet` inside a project directory. The header shows the workspace name, `provider:model`, and the mode. Type a task at the `rivet>` prompt.

```
myproject · openai:gpt-4.1 · plan
rivet> explain how sessions are stored and where the writer lock lives
```

In `plan` mode Rivet reads and searches files and runs read-only Git commands, and reports proposed changes as text. Switch to `edit` mode in the config when you want it to apply changes; every patch, command, and non-read-only Git invocation then requires approval.

Session commands:

| Command                   | Effect                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/help`                   | List commands.                                                                                                                      |
| `/key <secret>`           | Use a key for this process only. It is never saved and is redacted from exports.                                                    |
| `/model`                  | Show the current model.                                                                                                             |
| `/model <id>`             | Switch models after listing the endpoint's models, checking tool calling, and confirming the saved transcript fits the new context. |
| `/diff [--staged] [path]` | Show the workspace's unstaged (or staged) tracked changes, bounded and sanitized.                                                   |
| `/sessions`               | List recent sessions.                                                                                                               |
| `/export [file]`          | Export this session as JSON without overwriting an existing file.                                                                   |
| `/exit`                   | Leave. Ctrl+C at an idle prompt also exits.                                                                                         |

While Rivet is working, Ctrl+C cancels the current turn and keeps the session. Running processes are killed as a tree, and the interrupted tool call is recorded as uncertain (see Recovery).

Non-interactive use:

```sh
rivet run "add a --version flag to the CLI"
rivet run --json "list the TypeScript files" > events.jsonl
```

`--json` prints one event per line: `session`, `text`, `status`, `approval`, `tool.start`, `tool.end`, `usage`, `error`, `done`. Approvals cannot be granted without a terminal, so non-interactive runs in `edit` mode fail with exit code 3 at the first consequential action.

Other commands: `rivet models` (list models offered by the endpoint, marking the configured one), `rivet models check` (run the tool-calling check), `rivet sessions`, `rivet resume <id>`, `rivet export <id> [file] [--markdown]`, `rivet help`, `rivet --version`.

## Approvals

An approval shows the tool name, the exact arguments the tool will receive, and, for processes, the fact that execution is permission-controlled rather than sandboxed. The choices are:

- **once**: allow this exact call.
- **session**: allow this tool with these exact arguments for the rest of the process. Any change to the arguments asks again.
- **deny**: refuse. The model receives the refusal as a tool error.

Escape and Ctrl+C cancel; they never approve. Arguments are never truncated in an approval, only in one-line summaries.

## Tools

| Tool                  | Effect | Notes                                                                                                  |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `file_list`           | read   | Bounded recursive listing; skips symlinks, `.git`, `.rivet`, `node_modules`, `dist`.                   |
| `file_read`           | read   | UTF-8 files up to 1 MiB with a SHA-256 for later patching.                                             |
| `file_search`         | read   | Literal text search with bounded traversal and output.                                                 |
| `file_patch`          | write  | Replaces one unique exact match after checking the SHA-256; atomic rename; one file per call.          |
| `command`             | exec   | Runs an executable directly with argument vector, no shell, filtered environment, timeout, output cap. |
| `git`                 | exec   | A narrow read-only subset is allowed in `plan` mode; everything else requires approval.                |
| `mcp_<server>_<tool>` | mcp    | Tools from trusted MCP servers; invocation passes through the same policy gate.                        |

All paths are workspace-relative. Absolute paths, drive letters, UNC paths, `..`, symlinks, junctions, hard links, Git internals, `.env*`, SSH and cloud credential directories, and reserved Windows device names are refused.

## Sessions and recovery

Every message and event is appended to `~/.rivet/sessions.sqlite`. One Rivet process owns the store at a time; a second process is told the store is open elsewhere. If Rivet crashes, the operating system releases the lock.

Tool calls are recorded before they run and resolved after. A call that has no recorded result when you `rivet resume <id>` is an **uncertain action**: Rivet shows it and asks whether to record it as aborted. It is never replayed automatically, because the command may or may not have had side effects.

Compaction keeps the most recent complete turns that fit the model's context and tells the model how many earlier turns were omitted. Tool calls and their results are never separated, and the complete transcript stays in the store and in exports.

## Exit codes

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | Completed.                                   |
| 1    | Runtime error.                               |
| 2    | Configuration or credential problem.         |
| 3    | Policy denied or approval refused.           |
| 4    | A step, tool, token, cost, or context limit. |
| 130  | Cancelled.                                   |

## Platform notes

- Windows: processes are started without a shell and killed with `taskkill /T`; junctions are treated as symlinks; reserved device names are refused. The OS credential store is Windows PasswordVault. Prefer Windows Terminal or PowerShell 7 for ANSI output; `NO_COLOR` disables the single cyan accent.
- macOS: `credential: "os"` reads a generic password with service `rivet` from Keychain. Add it with Keychain Access or `security add-generic-password`.
- Linux: `credential: "os"` uses `secret-tool` (libsecret). Without it, use environment credentials.

## Development

```sh
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint src
pnpm format:check   # prettier
pnpm test           # builds, then node --test test/*.test.mjs
```

Tests run offline against local fake servers and temporary directories. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/FEATURES.md](docs/FEATURES.md), and [SECURITY.md](SECURITY.md).
