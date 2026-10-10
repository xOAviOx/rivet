# Rivet

**A local, permission-controlled coding agent for your terminal.**

Rivet inspects a project, carries out a coding task with a model provider you already pay for, asks before doing anything consequential, and saves the conversation so you can pick it up again after an interruption. It runs in your own terminal and your own repository, and it shows every action as it happens.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D%2022.19-339933?logo=node.js&logoColor=white)](#requirements)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

```
$ rivet
rivet  /home/dev/myapp / openai:gpt-4.1 / plan
> where does the retry logic for provider requests live?
  file_search src "retry"
  file_read src/providers.ts
Retries are handled in src/providers.ts. Only transient HTTP statuses are
retried, at most twice, and Retry-After is honored for up to five seconds.
Client errors fail immediately and error bodies are never surfaced.
>
```

## Highlights

- **Explicit approval.** Every file change, process, non-read-only Git command, and MCP call shows its exact arguments and destination, then waits for **once**, **session**, or **deny**. Escape and Ctrl+C cancel; they never approve.
- **Bring your own provider.** OpenAI, Anthropic, or any OpenAI-compatible endpoint that supports tool calling, including Google Gemini, local servers, and gateways. Keys live in your environment or OS credential store, never in the config file.
- **A hard workspace boundary.** Tools accept workspace-relative paths only. Absolute paths, `..`, symlinks, junctions, Git internals, `.env*`, and credential directories are refused at the tool boundary, not by the prompt.
- **Durable sessions.** Every message and event is appended to a local SQLite store. Interrupted or crashed sessions resume with an honest account of what did and did not run.
- **No shell, no surprises.** Processes run as an executable plus an argument vector with a filtered environment, a timeout, and an output cap. Timeouts and cancellation kill the whole process tree.
- **Bounded by design.** Steps, tool calls, tokens, cost, stream sizes, file sizes, and process output all have documented limits and specific failure messages.
- **A quiet terminal.** Plain monospace text in your own theme, one header line, one line per completed tool call. Details are a slash command away.
- **Small footprint.** Strict TypeScript over Node's built-in `readline`, `fetch`, and SQLite. One runtime dependency (Zod).

## Requirements

- Node.js 22.19 or newer. Node 24 LTS is recommended; on Node 22 the built-in SQLite driver prints one `ExperimentalWarning` at startup.
- pnpm 11 (`corepack enable` is enough).
- An API key for OpenAI, Anthropic, or an OpenAI-compatible endpoint that supports tool calling.
- Git on `PATH` for the Git tool and `/diff`.

## Installation

Rivet is not yet published to npm. Install it from source:

```sh
git clone https://github.com/xOAviOx/rivet.git
cd rivet
pnpm install --frozen-lockfile
pnpm build
pnpm pack                          # produces rivet-agent-<version>.tgz
npm install -g ./rivet-agent-*.tgz
```

To run from the repository without installing, use `pnpm start -- <args>` or `node dist/cli.js <args>`.

## Quick start

1. Put your key in the environment:

   ```sh
   export OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY, or any name you choose
   ```

2. Create the configuration:

   ```sh
   rivet setup
   ```

   The wizard asks for the provider, an explicit endpoint when the provider is `compatible`, the credential source, the environment variable that holds the key, and the model's id, context window, and output allowance. Each answer is validated as you type it. If a key is available, setup runs a one-shot tool-calling check against the model and saves nothing if the check fails. The result is written once to `~/.rivet/config.json` with private permissions; it never contains a key.

3. Start a session inside a project:

   ```sh
   cd ~/projects/myapp
   rivet
   ```

   The header shows the workspace, `provider:model`, and the mode. Type a task at the `>` prompt.

Set `RIVET_HOME` to use a different state directory. See [`example.config.json`](example.config.json) for a complete, valid configuration file.

### Using an OpenAI-compatible endpoint

Any endpoint that speaks the OpenAI Chat Completions protocol with streaming tool calls works through the `compatible` provider. For example, Google Gemini:

```json
{
  "provider": "compatible",
  "endpoint": "https://generativelanguage.googleapis.com/v1beta/openai",
  "keyEnv": "GEMINI_API_KEY",
  "model": {
    "id": "gemini-3.8-flash",
    "tools": true,
    "context": 1048576,
    "maxOutput": 8192
  }
}
```

Endpoints must use HTTPS, or HTTP on loopback for local servers. Redirects are refused so a key is never re-sent to another host.

## Usage

### Interactive sessions

Each completed tool call leaves one summary line in the scrollback. While a tool is running, its line is shown below the output and replaced when it finishes.

```
> add a --version flag to the CLI
  file_read src/cli.ts
approval required: file_patch
  destination: /home/dev/myapp/src/cli.ts
  path: "src/cli.ts"
  expectedHash: "9f2c7a1e4b8d3c6f0a5e2d7b9c4f1a8e3d6b0c5f7a2e9d4c1b8f3a6e0d5c2b7f"
  oldText: 3 lines
    | case "help":
    |   printHelp();
    |   return 0;
  newText: 6 lines
    | case "--version":
    |   console.log(`${name} ${version}`);
    |   return 0;
    | case "help":
    |   printHelp();
    |   return 0;
approve: once (o) · session rule (s) · deny (d) · Esc cancels
```

| Key                  | Effect                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| Enter                | Send the message.                                                                     |
| Alt+Enter or Ctrl+J  | Insert a newline. Bracketed paste stays in the editor until you submit.               |
| Ctrl+C while working | Cancel the current turn and keep the session. Running processes are killed as a tree. |
| Ctrl+C while idle    | Clear the draft; press again on an empty draft to exit.                               |
| Esc or Ctrl+C        | During an approval: cancel without approving.                                         |

### Session commands

| Command                   | Effect                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/help`                   | List commands.                                                                                                                      |
| `/key <secret>`           | Use a key for this process only. It is never saved and is redacted from exports.                                                    |
| `/model`                  | Show the current model.                                                                                                             |
| `/model <id>`             | Switch models after listing the endpoint's models, checking tool calling, and confirming the saved transcript fits the new context. |
| `/diff [--staged] [path]` | Show the workspace's unstaged (or staged) tracked changes, bounded and sanitized.                                                   |
| `/details [count]`        | Show the exact arguments and full result of the last tool call, or the last `count` calls. Control characters appear as `<U+XXXX>`. |
| `/settings`               | Show the effective configuration: destination, credential source and whether a key is present (never the key), mode, limits, MCP.   |
| `/sessions`               | List recent sessions.                                                                                                               |
| `/export [file]`          | Export this session as JSON without overwriting an existing file.                                                                   |
| `/exit`                   | Leave the session.                                                                                                                  |

### Non-interactive runs

```sh
rivet run "add a --version flag to the CLI"
rivet run --json "list the TypeScript files" > events.jsonl
```

`--json` prints one event per line: `session`, `text`, `status`, `approval`, `tool.start`, `tool.end`, `usage`, `error`, `done`. Slash-command output and notices go to stderr so stdout carries only events. Approvals need a terminal, so a non-interactive run in `edit` mode fails closed with exit code 3 at the first consequential action. Ctrl+C cancels a one-shot run with exit code 130.

### Other commands

| Command                                 | Effect                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `rivet setup`                           | Create `~/.rivet/config.json`. Refuses to replace an existing file.       |
| `rivet models`                          | List the models offered by the endpoint, marking the configured one.      |
| `rivet models check`                    | Run the tool-calling check against the configured model.                  |
| `rivet sessions`                        | List saved sessions.                                                      |
| `rivet resume <id>`                     | Continue a session in its workspace, reconciling uncertain actions first. |
| `rivet export <id> [file] [--markdown]` | Export a session's events as JSON or Markdown, with secrets redacted.     |
| `rivet help`, `rivet --version`         | Show help or the version.                                                 |

## Modes and approvals

Policy is enforced at the tool boundary, not in the prompt.

| Mode     | Read tools | Write, exec, and MCP tools                              |
| -------- | ---------- | ------------------------------------------------------- |
| `plan`   | allowed    | denied (exit code 3), no prompt                         |
| `edit`   | allowed    | ask on every call                                       |
| `custom` | per tool   | per tool: `allow`, `ask`, or `deny`; unlisted tools ask |

In `plan` mode (the default) Rivet reads and searches files, runs a fixed allowlist of read-only Git commands, and reports proposed changes as text. Switch to `edit` mode in the config when you want it to apply changes.

An approval prompt shows the tool name, the complete arguments (never truncated), and the destination or executable. For processes it states that execution is permission-controlled rather than sandboxed. The choices are:

- **once**: allow this exact call.
- **session**: allow this tool with these exact arguments for the rest of the process. Any change to the arguments asks again.
- **deny**: refuse. The model receives the refusal as a tool error.

## Tools

| Tool                  | Effect | Notes                                                                                                     |
| --------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `file_list`           | read   | Bounded recursive listing; skips symlinks, `.git`, `.rivet`, `node_modules`, `dist`.                      |
| `file_read`           | read   | UTF-8 files up to 1 MiB, returned with a SHA-256 for later patching.                                      |
| `file_search`         | read   | Literal text search with bounded traversal and output.                                                    |
| `file_patch`          | write  | Replaces one unique exact match after checking the SHA-256; atomic rename; one file per call.             |
| `command`             | exec   | Runs an executable directly with an argument vector: no shell, filtered environment, timeout, output cap. |
| `git`                 | exec   | A narrow read-only subset is allowed in `plan` mode; everything else requires approval.                   |
| `mcp_<server>_<tool>` | mcp    | Tools from trusted MCP servers; invocations pass through the same policy gate.                            |

All paths are workspace-relative. Absolute paths, drive letters, UNC paths, `..`, symlinks, junctions, hard links, Git internals, `.env*`, SSH and cloud credential directories, and reserved Windows device names are refused.

### Project instructions

Rivet reads `AGENTS.md` files from your repository. The root file is part of every system prompt. Nested files are discovered from the root down to the directory a tool is about to act in and are delivered to the model before that tool runs. Files are capped at 16 KiB each and must be UTF-8.

## Configuration

`~/.rivet/config.json` is validated with a strict schema. Unknown fields are rejected so a typo never silently disables a limit.

| Field                | Meaning                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `provider`           | `openai`, `anthropic`, or `compatible`.                                                                            |
| `endpoint`           | Required for `compatible`, forbidden otherwise. HTTPS, or HTTP on loopback only; no credentials, query, or hash.   |
| `model.id`           | Model identifier sent to the provider.                                                                             |
| `model.tools`        | Must be `true`; models without tool calling cannot be configured.                                                  |
| `model.context`      | Context window in tokens (at least 4096). Bounds compaction.                                                       |
| `model.maxOutput`    | Output allowance per step (default 4096, must be below `context`).                                                 |
| `model.inputPrice`   | Optional USD per million input tokens. Both prices are required for `limits.cost`.                                 |
| `model.outputPrice`  | Optional USD per million output tokens.                                                                            |
| `keyEnv`             | Environment variable holding the key. Defaults: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `RIVET_API_KEY`.            |
| `credential`         | `environment` (default) or `os` (Keychain, Secret Service, or Windows PasswordVault).                              |
| `mode`               | `plan` (default), `edit`, or `custom`.                                                                             |
| `policy`             | For `custom` mode: `{ "<tool>": "allow" \| "ask" \| "deny" }`. Unlisted tools ask.                                 |
| `limits.steps`       | Model steps per turn (default 30, max 1000).                                                                       |
| `limits.tools`       | Tool calls per turn (default 100, max 10000).                                                                      |
| `limits.tokens`      | Input plus output tokens per turn (default 100000).                                                                |
| `limits.cost`        | Optional USD per turn.                                                                                             |
| `limits.timeoutMs`   | Provider request deadline (default 120000, max 600000).                                                            |
| `limits.outputBytes` | Tool result bytes kept per result (default 32768, max 1 MiB).                                                      |
| `mcp`                | Up to 16 MCP servers. Each must be marked `"trusted": true` before Rivet connects. See [docs/MCP.md](docs/MCP.md). |

## Sessions and recovery

Every message and event is appended to `~/.rivet/sessions.sqlite`. One Rivet process owns the store at a time; a second process is told the store is open elsewhere. If Rivet crashes, the operating system releases the lock, so there is nothing to clean up.

Tool calls are recorded before they run and resolved after. A call that has no recorded result when you `rivet resume <id>` is an **uncertain action**: Rivet shows it and asks whether to record it as aborted. It is never replayed automatically, because the command may or may not have had side effects. Calls that never started, for example later calls in a batch interrupted by Ctrl+C, a limit, or a crash, are recorded as not executed without asking. A session with an unresolved uncertain action refuses new turns (exit code 2) until you resolve it in a terminal.

Compaction keeps the most recent complete turns that fit the model's context and tells the model how many earlier turns were omitted. A tool call is never separated from its result, and the complete transcript stays in the store and in exports.

## MCP servers

Rivet connects to up to 16 [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or Streamable HTTP. A server is refused until its config entry says `"trusted": true`. Discovered tools are namespaced `mcp_<server>_<tool>` so a server cannot shadow a built-in tool, and every invocation passes through the same policy gate and approval prompt as built-in tools. Connections last for one turn and close afterward. See [docs/MCP.md](docs/MCP.md) for configuration, limits, and unsupported protocol features.

## Exit codes

| Code  | Meaning                                      |
| ----- | -------------------------------------------- |
| `0`   | Completed.                                   |
| `1`   | Runtime error.                               |
| `2`   | Configuration or credential problem.         |
| `3`   | Policy denied or approval refused.           |
| `4`   | A step, tool, token, cost, or context limit. |
| `130` | Cancelled.                                   |

## Platform notes

- **Windows**: processes start without a shell and are killed with `taskkill /T`; junctions are treated as symlinks; reserved device names are refused. The OS credential store is Windows PasswordVault (resource `rivet`), and `rivet setup` can save the key there. Prefer Windows Terminal or PowerShell 7 for ANSI output. `NO_COLOR` disables the single cyan accent.
- **macOS**: `credential: "os"` reads a generic password with service `rivet` from Keychain. Rivet does not write it; add it with Keychain Access or `security add-generic-password` using the account shown by `/settings`.
- **Linux**: `credential: "os"` uses `secret-tool` (libsecret), and `rivet setup` can save the key there. Without it, use environment credentials.

## Security

The model's output is treated as untrusted input. In short:

- Path validation, policy, and resource bounds are enforced in the tool and transport layers, never by instructions to the model.
- Processes are permission-controlled, **not sandboxed**. An approved executable runs with your privileges.
- Keys never appear in the config file, logs, exports, child processes, or terminal output. Provider error bodies are discarded because they can echo headers.
- All text from models, tools, files, Git, and MCP servers is stripped of terminal control sequences before it is displayed.
- Nothing is retried or replayed automatically after an interruption.

The full threat model, boundaries, and limits are in [SECURITY.md](SECURITY.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint src
pnpm format:check   # prettier --check .
pnpm test           # builds, then node --test test/*.test.mjs
```

The test suite runs offline against local fake provider and MCP servers in temporary directories, and covers the agent loop, tools, policy, path guards, providers, storage, recovery, the terminal, the setup wizard, and the CLI end to end.

### Project layout

```
src/
  cli.ts           argument parsing, commands, interactive loop, event rendering
  agent.ts         the single-step loop: compaction, provider step, limits, tool execution
  providers.ts     streaming adapters for OpenAI Chat Completions and Anthropic Messages
  tools.ts         built-in tools and the policy check at the tool boundary
  security.ts      workspace path validation, policy, sanitizers
  process.ts       shell-less process execution with timeout and tree kill
  store.ts         SQLite sessions, messages, events, actions, and the writer lock
  context.ts       token estimate and turn-level compaction
  mcp.ts           MCP client for stdio and Streamable HTTP
  terminal.ts      raw-mode editor, streaming renderer, approval prompts
  setup.ts         the setup wizard
  config.ts        schema and loading of ~/.rivet/config.json
  credentials.ts   environment and OS credential store lookup
  instructions.ts  scoped AGENTS.md discovery
  models.ts        model listing, capability check, safe switching
  inspect.ts       /details and /settings views
  export.ts        JSON and Markdown export with redaction
  diff.ts          bounded, sanitized git diff for /diff
  types.ts         shared contracts and the typed event union
test/              offline tests, one file per module
docs/              architecture, feature matrix, and MCP reference
```

Further reading: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the design principles and data flow, [docs/FEATURES.md](docs/FEATURES.md) lists each capability with its test evidence and known gaps, and [docs/MCP.md](docs/MCP.md) covers MCP configuration and limits.

## License

[MIT](LICENSE) © xOAviOx
