# Architecture

Rivet is one package of cohesive ES modules under `src/`, compiled with strict TypeScript to `dist/`. There is no framework: the terminal is Node's `readline`, providers are explicit HTTP adapters over `fetch`, and storage is Node's built-in SQLite. The only runtime dependency is Zod for configuration validation.

## Principles

1. **Own the loop.** The provider adapter returns one assistant step (text plus tool calls). It cannot execute tools. The agent loop decides what runs, records it, and feeds results back.
2. **Enforce at the boundary.** Policy, path validation, and resource bounds live in the tool and transport layers, not in prompts. The model is untrusted input.
3. **Record before acting.** A tool call is written to SQLite before it runs and resolved after. Anything unresolved is an uncertain action for the user, never an automatic replay.
4. **Bound everything.** Every stream, file, process, list, and loop has a documented cap and a specific failure message.
5. **Keep the original.** Compaction shapes what the model sees; the store and exports keep the full transcript and event log.

## Module map

| Module            | Responsibility                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | Shared contracts: `Message`, `ToolCall`, `ToolDefinition`, `Usage`, the `AgentEvent` union, the `Provider.step` interface, and `RivetError` with an exit code.    |
| `config.ts`       | Zod schema for `~/.rivet/config.json`, provider destinations, key names, private state directory handling, load/save (save never overwrites).                     |
| `credentials.ts`  | Resolves a key from the process-only session value, the environment, or an OS store via `security`, `secret-tool`, or PowerShell PasswordVault.                   |
| `security.ts`     | `Workspace` (path validation, bounded read/list, scoped `AGENTS.md`), `Policy` (plan/edit/custom, once/session/deny), `clean` and `redact` sanitizers, `hash`.    |
| `instructions.ts` | Scoped `AGENTS.md` discovery from the root to the target directory, with per-file and total byte bounds and UTF-8 checks.                                         |
| `process.ts`      | `runProcess`: shell-less spawn with filtered environment, timeout, output cap, cancellation, and process-tree kill.                                               |
| `tools.ts`        | Built-in tool definitions and runner: `file_list`, `file_read`, `file_search`, `file_patch`, `command`, `git`. Validates arguments and asks `Policy`.             |
| `providers.ts`    | Streaming adapters for OpenAI Chat Completions (also used for `compatible`) and Anthropic Messages; bounded SSE parsing, bounded retries, capability `probe`.     |
| `models.ts`       | Endpoint model listing, capability-checked selection, and safe switching that refuses when the saved transcript cannot fit the new context.                       |
| `context.ts`      | Byte-based token estimate and turn-level compaction that keeps complete turns from the most recent backwards.                                                     |
| `store.ts`        | SQLite sessions, messages, events, and actions with WAL, a separate exclusive writer lock, schema versioning, and private file modes.                             |
| `export.ts`       | Read-only JSON or Markdown export of a session with secret redaction.                                                                                             |
| `diff.ts`         | Bounded, sanitized `git diff` for `/diff` without external diff helpers.                                                                                          |
| `mcp.ts`          | MCP client: stdio and Streamable HTTP transports, explicit trust, bounded discovery, namespaced tools, approval-gated invocation.                                 |
| `agent.ts`        | The single-step loop: system prompt, compaction, provider step, limits, loop detection, tool execution with action recording, typed events, crash reconciliation. |
| `terminal.ts`     | Raw-mode editor and line-mode fallback: header, batched streaming, running/completed tool lines, approval prompt, `ask`, hidden `secret`, `confirm`.              |
| `inspect.ts`      | Plain-text views for `/details` (paired calls and complete results, controls made visible, secrets masked) and `/settings` (effective configuration, no keys).    |
| `setup.ts`        | The setup wizard as a function over an `ask`/`secret`/`print` interface: per-answer validation, optional OS key storage, capability check, single write.          |
| `cli.ts`          | Argument parsing, commands, interactive session loop, rendering of events to the terminal or JSONL, prompts for uncertain actions.                                |

## Data flow for one turn

The CLI connects configured MCP servers before entering the loop and closes them in a `finally` block. Connection notices are persisted. Tool calls use the same policy boundary and action records as built-in tools; server failures and remote tool errors return to the model without automatic replay. See [MCP](MCP.md) for protocol limits.

```
user input
  └─ cli.runTurn ─ credential → createProvider → Policy
       └─ agent.runAgent
            ├─ unfinished tool calls in history → error, exit 2 (reconcile first)
            ├─ store.append(user message)
            ├─ loop
            │    ├─ buildSystem: mode prompt + root AGENTS.md
            │    ├─ compact(history, context - maxOutput - system)
            │    ├─ provider.step → emits text deltas, returns {message, usage}
            │    ├─ usage → token/cost limits
            │    ├─ no tool calls → done(complete)
            │    └─ for each call
            │         ├─ loop detection (3 identical consecutive calls)
            │         ├─ store.begin(call)             ← recorded before running
            │         ├─ new/changed nested AGENTS.md → deferred result, nothing runs
            │         ├─ tools.execute → Policy.check → run
            │         └─ store.complete(result + tool message, one transaction)
            └─ on any stop: calls in the batch that never began get a "not executed" result
```

Providers reject a transcript in which a tool call has no result. Rivet therefore keeps every stored batch paired. A call that never began is recorded as not executed when the turn stops, and an action's result and its transcript message are written in one transaction. Only a crash during a running call can leave a call open. `reconcileSession` (called by `rivet resume`) then records calls that never began and results already stored, and asks the user about the started call. Until that call is resolved, new turns are refused rather than sent with an unpaired call.

Every `AgentEvent` goes to the renderer and to the store. Event types: `session`, `text`, `status`, `approval` (with and without decision), `tool.start`, `tool.end`, `usage`, `error`, `done` with reason `complete | cancelled | limit | error`.

## Provider adapters

Both adapters produce the same `Message` shape. OpenAI-style transcripts carry `tool_calls` and `tool` messages; Anthropic transcripts merge consecutive same-role messages and use `tool_use` and `tool_result` blocks with `is_error`. Tool results in the outgoing transcript are truncated to `limits.outputBytes`.

The SSE reader validates `content-type`, decodes UTF-8 strictly, and caps total bytes, event bytes, text bytes, and tool-call argument bytes. A step is complete only when the stream signals completion and the finish reason is a normal stop or tool call; `length` and unknown reasons are errors so a truncated tool call is never executed.

Retries cover only transient HTTP statuses, at most twice, with `Retry-After` honored up to five seconds. Error bodies are never surfaced.

## Storage schema (version 1)

```
sessions(id TEXT PK, workspace, model, createdAt)
messages(seq INTEGER PK AUTOINCREMENT, session → sessions, body JSON)
events  (seq INTEGER PK AUTOINCREMENT, session → sessions, body JSON)
actions (id TEXT PK, session → sessions, call JSON, result TEXT NULL, createdAt)
```

`PRAGMA user_version` records the schema version; a newer version is refused. The writer lock is a second database file held in `BEGIN EXCLUSIVE` for the process lifetime, so crash recovery is automatic and a second process is rejected immediately.

## Context compaction

`estimate` counts UTF-8 bytes (one byte per token is deliberately conservative; no tokenizer is assumed). `compact` groups messages into turns starting at each user message, keeps turns from the newest backwards while they fit, and prepends a short notice stating how many earlier turns were omitted. It refuses budgets under 1 KiB and refuses to drop the current turn, both with exit code 4.

## Terminal

The CLI inherits the user's theme and uses plain monospace text. The only color is a cyan prompt when stdout is a TTY and `NO_COLOR` is unset. Text deltas are batched and flushed before any non-text line so lines stay whole. Everything shown is passed through `clean`. Completed tool lines are one-line summaries truncated to the terminal width; approval arguments and `/details` output are shown in full, with control and bidirectional characters rendered as `<U+XXXX>`. When stdin is not a terminal, the same module reads whole lines, so piped sessions, `rivet setup`, approvals, and reconciliation share one code path. In `--json` sessions, command output and notices go to stderr.

## Decisions and deviations

- External SDKs (AI SDK, MCP SDK, Ink) were unavailable offline; explicit protocol adapters are used and tested against local fake servers. Transport and UI sit behind small interfaces (`Provider`, `McpTools`, the renderer) so they can be replaced.
- Node's built-in `node:sqlite` avoids native dependency installation. It is stable on Node 24 and experimental (one warning) on Node 22.
- Patches are exact-text replacement with a content hash rather than unified diffs: unambiguous, verifiable by the user, and safe under concurrent edits.
- Local commands are permission-controlled, not sandboxed, and this is stated in the tool description and in every approval.
