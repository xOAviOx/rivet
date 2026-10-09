# Feature matrix

Status values: **done** (implemented, covered by offline tests), **partial** (implemented, tests pending or integration pending), **planned** (not in the first release). Evidence names the test file that exercises the behavior; run `pnpm test` to reproduce.

## Runtime and CLI

| Capability                                                              | Status | Evidence                                                                                   |
| ----------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Interactive session with header, prompt, slash commands                 | done   | `test/terminal.test.mjs`; ConPTY checks on Windows 11                                      |
| `rivet run "prompt"` non-interactive                                    | done   | `test/cli.test.mjs`                                                                        |
| `rivet run --json` JSONL events                                         | done   | `test/cli.test.mjs`; stdout carries only event lines, notices go to stderr                 |
| Defined exit codes 0/1/2/3/4/130                                        | done   | `cli`, `agent`, `config`, `security`, `process`, `providers`, `context` tests assert codes |
| `rivet setup` wizard with per-answer validation and capability check    | done   | `test/setup.test.mjs` (scripted answers and real CLI runs against a fake endpoint)         |
| `/details [count]` full arguments and results of recent tool calls      | done   | `test/inspect.test.mjs`, `test/cli.test.mjs`; ConPTY check on Windows 11                   |
| `/settings` effective configuration without secrets                     | done   | `test/inspect.test.mjs`, `test/cli.test.mjs`; ConPTY check on Windows 11                   |
| `rivet models`, `rivet models check`, `/model <id>`                     | done   | `test/models.test.mjs`                                                                     |
| `rivet sessions`, `rivet resume <id>`                                   | done   | `test/store.test.mjs`, `test/cli.test.mjs` (resume in a new process)                       |
| Sample Git workflow: search, scoped read, patch, commit, resume, export | done   | `test/cli.test.mjs` against a temporary Git repository                                     |
| Package ships only current build output                                 | done   | `test/build.test.mjs`, `pnpm pack --dry-run`                                               |
| `rivet export`, `/export` JSON and Markdown                             | done   | `test/export.test.mjs`                                                                     |
| `/diff [--staged] [path]`                                               | done   | `test/diff.test.mjs`                                                                       |
| `/key` process-only credential                                          | done   | `test/credentials.test.mjs`                                                                |

## Providers

| Capability                                                | Status | Evidence                                          |
| --------------------------------------------------------- | ------ | ------------------------------------------------- |
| OpenAI Chat Completions streaming with tool calls         | done   | `test/providers.test.mjs`                         |
| Anthropic Messages streaming with tool_use blocks         | done   | `test/providers.test.mjs`                         |
| OpenAI-compatible explicit endpoints (HTTPS or loopback)  | done   | `test/config.test.mjs`, `test/providers.test.mjs` |
| Bounded retries on transient status, none on client error | done   | `test/providers.test.mjs`                         |
| Redirects rejected                                        | done   | `test/providers.test.mjs`                         |
| Stream bounds and malformed-response rejection            | done   | `test/providers.test.mjs`                         |
| Cancellation (130) and request timeout                    | done   | `test/providers.test.mjs`                         |
| Tool-calling capability probe                             | done   | `test/providers.test.mjs`                         |
| Usage accounting with estimated fallback, cost limits     | done   | `test/providers.test.mjs`, `src/agent.ts`         |

## Credentials and configuration

| Capability                                                | Status  | Evidence                                                                                                                                                                                              |
| --------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict schema, unknown keys rejected, documented ceilings | done    | `test/config.test.mjs`                                                                                                                                                                                |
| Environment credential with per-provider defaults         | done    | `test/credentials.test.mjs`                                                                                                                                                                           |
| OS credential store (Keychain, libsecret, PasswordVault)  | partial | `test/credentials.test.mjs` covers the fail-closed path; `test/setup.test.mjs` covers storing through an injected store; one manual PasswordVault round trip on Windows 11 (entry removed afterwards) |
| Private config directory, no overwrite, symlink refusal   | done    | `test/config.test.mjs`                                                                                                                                                                                |
| No plaintext keys in config or exports                    | done    | `test/export.test.mjs`, `test/security.test.mjs` (`redact`)                                                                                                                                           |

## Tools and safety

| Capability                                               | Status | Evidence                                                               |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| Workspace boundary: absolute, UNC, drive, `..`, NUL      | done   | `test/security.test.mjs`                                               |
| Protected names (`.git`, `.rivet`, `.env*`, `.ssh`, ...) | done   | `test/security.test.mjs`                                               |
| Symlink, junction, hard-link refusal                     | done   | `test/security.test.mjs`                                               |
| Windows reserved names and unsafe characters             | done   | `test/security.test.mjs`                                               |
| Bounded read, list, search                               | done   | `test/security.test.mjs`                                               |
| Hash-guarded atomic single-file patch                    | done   | `test/tools.test.mjs`                                                  |
| Shell-less process execution, filtered environment       | done   | `test/process.test.mjs`                                                |
| Timeout and output cap kill the process tree             | done   | `test/process.test.mjs`                                                |
| Read-only Git allowlist in plan mode                     | done   | `test/tools.test.mjs`                                                  |
| Plan / edit / custom policy at the tool boundary         | done   | `test/security.test.mjs`                                               |
| once / session / deny, cancel never approves             | done   | `test/security.test.mjs`                                               |
| Terminal sanitization of untrusted text                  | done   | `test/security.test.mjs`, `test/diff.test.mjs`, `test/export.test.mjs` |

## Agent loop and context

| Capability                                                    | Status | Evidence                                                                               |
| ------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| Single-step loop; transport never executes tools              | done   | `src/agent.ts`, `src/providers.ts`                                                     |
| Step, tool, token, cost limits (exit 4)                       | done   | `test/agent.test.mjs`                                                                  |
| Loop detection, consecutive tool-error cutoff                 | done   | `test/agent.test.mjs`                                                                  |
| Scoped `AGENTS.md` instructions                               | done   | `test/instructions.test.mjs`, `test/security.test.mjs`                                 |
| Nested `AGENTS.md` delivered before a tool acts in that scope | done   | `test/agent.test.mjs`, `test/cli.test.mjs`                                             |
| Bounded compaction keeping call/result pairs                  | done   | `test/context.test.mjs`                                                                |
| Interrupted batches stay paired (unstarted calls recorded)    | done   | `test/agent.test.mjs`, `test/cli.test.mjs` with a provider that rejects unpaired calls |
| Typed lifecycle, output, tool, approval, usage, error events  | done   | `src/types.ts`, `test/agent.test.mjs`, `test/cli.test.mjs`                             |

## Storage and recovery

| Capability                                              | Status | Evidence                                                                            |
| ------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| SQLite with schema version, WAL, private modes          | done   | `test/store.test.mjs`                                                               |
| Exclusive writer lock released on crash                 | done   | `test/store.test.mjs`                                                               |
| Actions recorded before execution, pending after crash  | done   | `test/store.test.mjs`, `test/cli.test.mjs` (process killed mid-command)             |
| Action result and transcript message written atomically | done   | `test/store.test.mjs`                                                               |
| Uncertain-action reconciliation, never replayed         | done   | `test/agent.test.mjs`, `test/cli.test.mjs`; terminal confirmation checked in ConPTY |

## MCP

| Capability                                          | Status | Evidence                                                                       |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Config: stdio or HTTP, untrusted by default, 16 max | done   | `test/config.test.mjs`                                                         |
| stdio and Streamable HTTP transports                | done   | `test/mcp.test.mjs`; local JSON/SSE fixtures, live interoperability unverified |
| Bounded discovery, namespaced tools                 | done   | `test/mcp.test.mjs`; page/tool/schema limits and name collisions               |
| Approval-gated invocation (`Policy` effect `mcp`)   | done   | `test/cli.test.mjs`; real CLI, provider fixture, and MCP fixture               |

## Known gaps in the first release

- Processes are permission-controlled, not sandboxed.
- Compaction is turn-based omission, not summarization.
- Model switching requires the endpoint to list the model; providers that do not expose a listing need the id in config.
- OS credential storage on macOS is read-only from Rivet; add the item with Keychain Access. On Windows and Linux, `rivet setup` stores the key, and the store itself is not exercised by the automated tests.
- One configuration file per user; no per-project overrides except `AGENTS.md` instructions.

## Roadmap (not first-release work)

- Optional sandboxed execution backends per platform.
- Summarizing compaction with user-visible summaries.
- Per-project configuration overlays.
- Additional provider protocols (OpenAI Responses API, Gemini).
- Session search and tagging.

## Platform evidence

| Platform                                | Node    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11 (10.0.26200), PowerShell 5.1 | 22.19.0 | Build, lint, typecheck, format, and the offline test suite pass (221 tests). `node:sqlite` prints one `ExperimentalWarning`. Junction, hard-link, and 8.3-alias refusal verified; `taskkill /T` tree kill verified by the process tests. ConPTY sessions (tuistory) checked multiline input, streaming, approvals, interrupts, hidden `/key`, crash reconciliation, the setup wizard (re-asked answers, Esc cancel, probe), and `/details` showing escape sequences as text. |
| macOS                                   | -       | Not executed in this environment. Keychain path is implemented per Apple's `security` CLI contract.                                                                                                                                                                                                                                                                                                                                                                          |
| Linux                                   | -       | Not executed in this environment. Process-group kill and `secret-tool` paths are implemented; tests are platform-neutral.                                                                                                                                                                                                                                                                                                                                                    |
