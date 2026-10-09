# Security

Rivet runs a model-driven agent on a developer's machine with the developer's own provider account. The model's output is untrusted input. This document states what Rivet protects, how, and what it does not protect.

## Threat model

Protected against:

- The model (or a prompt-injected file, tool result, or MCP server) reading or writing outside the workspace, or reaching Git internals, state, or credential files inside it.
- Consequential actions (file changes, process execution, non-read-only Git, MCP invocations) happening without the user seeing the exact arguments and approving.
- Credentials leaking into configuration files, logs, exports, error messages, child processes, or terminal output.
- Unbounded resource use: runaway loops, oversized responses, endless processes, unlimited spend.
- Terminal injection through control sequences in model text, tool output, file names, or MCP responses.
- Silent replay of interrupted actions after a crash.

Not protected against (by design, documented limits):

- A process the user approves. `command` and non-read-only `git` are permission-controlled, **not sandboxed**. An approved executable runs with the user's privileges and can access the host. Rivet filters the child environment to a small allowlist but cannot constrain what an approved binary does.
- A compromised or malicious provider endpoint the user configured, or a MCP server the user marked trusted. Trust decisions are the user's; Rivet bounds what such a party can send but not what it does with the data sent to it.
- Reading secrets that live in ordinary files inside the workspace that are not on the protected list.

## Workspace boundary

All tool paths are relative to the workspace root, which is the real path of the directory Rivet was started in.

- Refused outright: NUL bytes, absolute paths, drive letters, UNC paths, `..` segments.
- Protected names anywhere in a path: `.git`, `.rivet`, `.ssh`, `.aws`, `.codex`, `.agents`, `.env` and `.env.*`.
- Windows short-name spellings such as `GIT~1` and `SECRET~1.TXT` are refused on every platform, including ordinary filenames matching that pattern. Canonical path components are also checked for protected names.
- Windows: reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with or without extension), characters `: * ? < > |`, and trailing dots or spaces are refused on every platform so a repository stays portable.
- Every component of a path is `lstat`ed. Symbolic links and junctions are not followed. Files with more than one hard link are refused. The resolved real path must stay under the root.
- Missing paths are accepted only for the final component and only when the tool creates files.
- Directory listing skips symlinks, protected names, and `node_modules`, `dist`, `.cache`, `coverage`, with caps on depth (30), visited entries (10000), and returned entries.
- Reads are limited to regular UTF-8 files up to 1 MiB (16 KiB for `AGENTS.md`); files containing NUL are treated as binary and refused.

Patches replace exactly one occurrence of the supplied text and require the SHA-256 of the file content the model last read. The result is written to a temporary file in the same directory, synced, and atomically renamed over the original; new files are created without overwriting. One file per call, so there is no false claim of multi-file atomicity.

## Approval policy

Policy is enforced at the tool boundary, not in the prompt.

| Mode     | read tools | write / exec / MCP                                    |
| -------- | ---------- | ----------------------------------------------------- |
| `plan`   | allowed    | denied (exit code 3), no prompt                       |
| `edit`   | allowed    | ask every call                                        |
| `custom` | per tool   | per tool: `allow`, `ask`, or `deny`; unlisted = `ask` |

An approval prompt shows the tool name, the complete arguments (never truncated), and the destination or executable. The user chooses **once**, **session**, or **deny**. A session grant is keyed on the SHA-256 of the tool name and the canonical arguments, so any change to arguments asks again. Escape and Ctrl+C cancel without approving; a cancelled prompt records no grant even if an answer arrived late. Approvals are impossible without a terminal, so `rivet run` in `edit` mode fails closed.

Read-only Git is a fixed allowlist of subcommands with flag checks (for example `diff` always receives `--no-ext-diff --no-textconv`), and every Git invocation gets `--no-pager --no-optional-locks -c core.fsmonitor=false`.

## Process execution

- No shell. Commands are an executable plus an argument vector; `a && b` is a literal argument.
- Child environment contains only `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `LANG`, `LC_ALL`, plus explicitly configured MCP key variables for MCP servers. Provider keys are never passed.
- Timeouts and output caps kill the entire process tree (`taskkill /T /F` on Windows, process-group `SIGKILL` elsewhere) and report that side effects may have occurred.
- Cancellation kills the tree and returns exit code 130. Nothing is retried automatically.

## Credentials

- Keys come from an environment variable, the OS credential store (macOS Keychain, libsecret, Windows PasswordVault), or `/key` for the lifetime of one process. The configuration file holds only the variable name and is written with mode `0600` inside a `0700` directory that must not be a symlink.
- Keys are validated for shape (no line breaks) before use and are never printed. Provider error bodies and fetch error messages are discarded because they can echo headers.
- Exports redact every environment value whose name contains `KEY`, `TOKEN`, `SECRET`, or `PASSWORD`, the process-only `/key` value, and anything shaped like `sk-...` or `Bearer ...`.
- Tool results are redacted before storage, output events, and subsequent provider requests using the environment/key-pattern redactor and the active provider credential. This does not detect arbitrary secrets in ordinary project files.
- OS credential helpers receive no model-controlled arguments; the account name is the SHA-256 of the destination URL. When `rivet setup` stores a key, it is read with hidden input, passed to the helper on stdin (never on the command line), and stored only after the model passes the tool-calling check.
- `/settings` and `/details` never print a key: `/settings` shows only the credential source and whether a key is present, and `/details` masks the process-only `/key` value and environment secrets again at display time.

## Network

- Official providers use fixed destinations (`api.openai.com`, `api.anthropic.com`). `compatible` requires an explicit endpoint that is HTTPS, or HTTP on loopback only, with no embedded credentials, query string, or fragment.
- Redirects are rejected (`redirect: "error"`), so a key is never re-sent to another host.
- Responses must be `text/event-stream`; streams are bounded (16 MiB total, 1 MiB per event, 1 MiB of text, 64 KiB per tool call's arguments, at most 64 tool calls per step). Malformed JSON, unexpected shapes, unknown tool names, duplicate call ids, and premature stream ends fail the step with a specific reason.
- Only HTTP 408, 429, 500, 502, 503, 504, and 529 are retried, at most twice, honoring `Retry-After` up to five seconds. Client errors fail immediately. Every request has a deadline (`limits.timeoutMs`).
- Model listing and switching reject redirects, bound the response, and refuse models that do not pass a live tool-calling check.

## MCP

- Servers are refused until the configuration marks them `trusted: true`. The default is untrusted.
- Stdio servers start without a shell, with the filtered environment plus the configured key variable only. HTTP servers must be HTTPS or loopback; the key is sent as a bearer token and redirects are rejected.
- Discovery is bounded (pages, tool count, description length, schema size). Tool names are namespaced `mcp_<server>_<tool>` so a server cannot shadow a built-in tool. Server-initiated requests (sampling, roots, elicitation) are refused.
- Every invocation passes the same policy gate as built-in tools (effect `mcp`). Results are sanitized and size-capped before reaching the model or the terminal.

## Terminal output

All text from the model, tools, files, Git, and MCP is passed through a sanitizer that removes OSC and CSI escape sequences, C0 and C1 control characters other than tab and newline, and Unicode bidirectional override characters before it reaches the terminal. JSON event output escapes them instead, preserving the original bytes for inspection.

## Storage

- `~/.rivet/sessions.sqlite` is created with mode `0600`; the state directory with `0700`. Both are refused if they are symlinks or hard links.
- A separate writer-lock database is held in an exclusive transaction for the life of the process. A second Rivet process fails with a clear message; an operating-system crash releases the lock without manual cleanup.
- Databases with a newer schema version are refused rather than migrated downward.
- Tool calls are recorded before execution and resolved after. Unresolved calls are shown as uncertain actions on resume and are recorded as aborted only when the user says so. They are never re-executed. Calls that never began are recorded as not executed. A session with an unresolved call refuses new turns until it is reconciled.

## Limits

Per turn: `limits.steps` model steps, `limits.tools` tool calls, `limits.tokens` total tokens, optional `limits.cost` in USD, three identical consecutive tool calls (loop detection), and eight consecutive tool errors. Reaching any limit ends the turn with exit code 4 and a recorded `error` event. Context compaction never splits a tool call from its result and refuses to drop the current turn.

## Reporting

Report vulnerabilities privately to the maintainers with reproduction steps. Do not include real credentials in reports; rotate any key that may have been exposed.
