# Progress

## Resumed integration — 2026-10-11

- Reviewed the repository against the handoffs. The historical workstream entries below describe earlier snapshots; use this section for the latest integration state.
- Fixed all seven tool-boundary findings below: file tools use `Workspace.path`, protected files and hard links are skipped during discovery, Windows short-name aliases are refused, commands/Git use `childEnvironment`, custom read policies are enforced, built-in tool errors count toward the loop breaker, plain-text MCP results remain valid, and tool results are redacted before events, transcript, action storage, or subsequent provider requests. The CLI supplies the active provider credential for redaction, including OS/session keys. Invalid file creations fail before approval.
- Fixed invalid endpoint validation throwing a TypeError. Enabled all six former TODO tests and added `test/agent.test.mjs` for plain-text MCP results, the eight-error breaker, and result redaction through SQLite and the provider boundary.
- Validation: build, lint, typecheck, touched-file Prettier checks, and `git diff --check` pass. Full suite: 164 tests pass, zero failures, skips, or TODOs on Windows/Node 22.19.0; the Windows 8.3 regression ran successfully. Changes are committed locally in this branch.
- Remaining integration work: `src/mcp.ts` and MCP tests are absent from the current source tree (old compiled MCP files in `dist` are stale); implement/connect the transports. Wire cancellation and terminal approvals into one-shot `run`. Complete CLI/restart/sample-workflow integration tests. Make builds remove stale generated modules before packaging. Scoped instruction loading exists, but `buildSystem` currently loads only root scope; integrate deeper scopes when tools target nested paths. Refresh the feature matrix and acceptance checklist with execution evidence.
- No live provider calls or cross-platform verification performed during this continuation.

Phase 1 complete: empty workspace inspected; skills read; dependency network blocked; cache available. Plan and design recorded.

Committed so far: types/config/security/process/context/credentials, OpenAI and Anthropic streaming providers (`provider.ts` and `providers.ts` are duplicates; one must be chosen), SQLite stores (`store.ts` and `storage.ts` are duplicates; one must be chosen), file/search/patch/command/Git tools in `tools.ts` (built on `contracts.ts`).

## Parallel work split (two agents, two terminals)

Shared contract: everything new builds on `src/types.ts` (`AgentEvent`, `Emit`, `Message`, `ToolCall`, `ToolDefinition`, `Provider`, `RivetError`), `src/config.ts` (`Config`, `McpConfig`), `src/security.ts` (`Workspace`, `Policy`, `clean`, `redact`) and `src/process.ts`. Treat `contracts.ts` as legacy; the agent-loop owner decides whether to port `tools.ts`/`storage.ts` to `types.ts` or keep an adapter.

Only edit files in your own column. Additive changes to shared files (new exports only) are allowed; note them here.

| Agent A (core, sequential)                                             | Agent B (independent modules)                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/agent.ts`: single-step loop, limits, loop detection, cancellation | `src/mcp.ts`: stdio + Streamable HTTP client, trust, bounded discovery       |
| `src/cli.ts`: run/help/JSON events/exit codes, setup, `/key`, models   | `src/terminal.ts`: header, batched streaming, approval prompt, multiline     |
| sessions/resume/export commands, uncertain-action reconciliation       | `test/mcp.test.mjs`, `test/terminal.test.mjs`                                |
| choose and delete duplicate provider/store modules; port `tools.ts`    | failure-path tests: security, context, config, process, providers (fake SSE) |
| sample workflow + Git integration test                                 | README, SECURITY.md, ARCHITECTURE.md, example.config.json                    |

Integration points Agent A can rely on from Agent B:

- `mcp.ts`: `connectMcp(config: McpConfig, signal, emit): Promise<McpServer>`; `McpServer.tools: ToolDefinition[]` (names prefixed `mcp_<server>_`), `McpServer.call(name, args, signal): Promise<string>`, `McpServer.close()`. Untrusted servers are refused at connect time; `Policy.check(..., "mcp", ...)` is the invocation gate.
- `terminal.ts`: `createTerminal(options)` returning `{ render(event: AgentEvent), prompt(): Promise<string | null>, approve(name, args, signal): Promise<Decision>, close() }`.

## Agent B log

- MCP is yielded to the WORKSTREAMS.md MCP agent (claimed first; `mcp-transport.ts`, `test/mcp.test.mjs`, fixtures in progress). Agent B's complete standalone draft is parked at `.cache/mcp-draft-agent-b.ts` (gitignored, not built) if useful. Terminal is yielded to the terminal agent below. Agent B's `src/mcp.ts` and `src/process.ts` edits are removed; the tree contains no Agent B source changes.
- Agent B now owns only: failure-path tests for shared modules (`test/security.test.mjs`, `test/context.test.mjs`, `test/config.test.mjs`, `test/process.test.mjs`, `test/credentials.test.mjs`, `test/providers.test.mjs` with a local fake SSE server), documentation (`README.md`, `SECURITY.md`, `ARCHITECTURE.md`, `FEATURES.md`, `example.config.json`), and a packaging check (`pnpm pack` dry run). No edits to any `src/` file.
- Tests target only exported APIs: `Workspace`, `Policy`, `clean`, `redact`, `hash`; `compact`, `estimate`; `configSchema`, `loadConfig`, `saveConfig`, `destination`, `keyName`; `runProcess`, `childEnvironment`; `credential` (environment path only); `createProvider(config, key).step(...)` and `probe`.
- **Complete.** Added `test/security.test.mjs` (15), `test/context.test.mjs` (7), `test/config.test.mjs` (13 + 1 todo), `test/process.test.mjs` (9), `test/credentials.test.mjs` (4), `test/providers.test.mjs` (13, local fake SSE server covering OpenAI-compatible, official OpenAI header/body shape, Anthropic, retries, redirects, malformed streams, bounds, cancellation, timeout, probe). Added `README.md`, `SECURITY.md`, `example.config.json` (valid against `configSchema`), `docs/ARCHITECTURE.md`, `docs/FEATURES.md` (feature matrix, gaps, roadmap, platform evidence). All Prettier-formatted. `pnpm pack --dry-run` succeeds. Full run at this time: typecheck 0, lint 0, 139 tests, 133 pass, 0 fail, 6 todo.
- **Findings for owners (no `src/` edits made by Agent B):**
  - `config.ts` (Agent A): the endpoint `.refine()` calls `new URL(value)` and Zod 4 runs it even after `.url()` fails, so `configSchema.safeParse({ endpoint: "not a url" })` throws `TypeError: Invalid URL` instead of returning an issue. Fix: guard with `URL.canParse(value)` or `try/catch` inside the refine. Tracked as a `todo` test in `test/config.test.mjs`.
  - `providers.ts` (Agent A): `parse()` throws `invalid("expected an object")` inside its own `try`, so the `catch` rewrites it to "malformed JSON". Cosmetic; move the shape check outside the `try`.
  - `package.json` (shared): `tsc` never removes stale output, so `dist/` still holds `provider.js`, `storage.js`, `contracts.js` from deleted sources and `pnpm pack` ships them. Suggest `"build": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && tsc"` or a `clean` step in `prepack`.
  - `cli.ts` (Agent A): `HELP` and `COMMANDS` omit `/diff`, which `command()` implements. `README.md` documents `/diff [--staged] [path]`; adjust whichever is wrong.
  - `README.md`/`docs/FEATURES.md` describe the CLI as of `cli.ts` at 04:42. CLI owner: update the command tables if flags or names change.

## Parallel export module

- Separate feature claimed: `src/export.ts` and `test/export.test.mjs` only. No edits to Agent A/B implementation files or tests.
- Integration API for Agent A: `exportSession(store, id, format = "json", secrets = []): string`, where `format` is `"json"` or `"markdown"` and `store` provides `get`, `messages`, `events`, `pending` (canonical `Store` shape). Pass process-only provider keys in `secrets`.
- JSON preserves the complete stored message/event ordering and pending-action arguments while redacting secrets. Markdown uses terminal-safe, literal content. Original stored records are never mutated. Export is read-only; the CLI owns destination choice and writing.
- Complete: `src/export.ts`, `test/export.test.mjs`, and `EXPORT_HANDOFF.md`. Nine export tests pass; isolated strict TypeScript, ESLint, scoped Prettier, and `git diff --check` pass. No shared source files edited.
- Core integration remains with the CLI owner. `EXPORT_HANDOFF.md` includes a call example and the versioned JSON envelope. Repository-wide typechecking found missing `killTree` / `spawnOptions` imports in the independently edited `src/diff.ts`; diff/shared-module owners should reconcile those APIs.

## Parallel diff module

- Session `f9a61f3e-e547-4075-801f-2bfb2fdd4368` claims only `src/diff.ts`, `test/diff.test.mjs`, and `DIFF_HANDOFF.md`.
- CLI integration: `workspaceDiff(workspace, signal, options?)` returns `{ text, truncated, staged }`. Supports unstaged/staged, bounded context/output, safe relative path filtering, terminal sanitization, and cancellation. See `DIFF_HANDOFF.md` for the exact contract.
- This agent will not edit CLI, tools, terminal, MCP, export, or shared source modules.
- Complete: all 21 diff tests pass on Windows; isolated strict compilation, repository-wide `tsc --noEmit`, scoped ESLint/Prettier, and whitespace checks pass. The earlier missing `killTree` / `spawnOptions` imports are resolved without shared-file changes.
- The CLI owner has wired `workspaceDiff` into `/diff`. `DIFF_HANDOFF.md` records final integration notes (preserve path spaces, pass an active cancellation signal, avoid a duplicate truncation notice).

## Parallel terminal module

- Takes `src/terminal.ts` and `test/terminal.test.mjs` from Agent B's column (Agent B is on MCP). Agent B: skip the terminal item. No edits to CLI, agent loop, tools, MCP, export, diff, or shared modules.
- **Complete.** Module committed in `01a5ad6`; CLI wiring committed after it (see below).
- Final contract: `createTerminal(options)` returns `{ interactive, header(info), render(event), print(text), prompt(), approve(name, args, signal), secret(label), confirm(question, signal?), close() }`. Options: `input`, `output`, `interactive`, `color`, `columns`, `workspace`, `destination(name, args)`, `onInterrupt`, `conceal(text)`, `flushMs`. Also exports `width`, `truncate`, `summarize`.
  - `prompt()` resolves `null` on idle Ctrl+C (empty draft) / Ctrl+D / end of input. Messages typed during work queue (max 10) and are sent by the next `prompt()`; Ctrl+C during work returns them to the draft unsent.
  - `approve()` shows exact, untruncated arguments (controls and bidi shown as `<U+…>`) and the destination (`host process in … (not sandboxed)` for `command`/`git`). Keys o / s / d; Enter has no default; Esc, Ctrl+C, and abort deny ("cancelled").
  - `secret()` reads without echo; `confirm()` answers yes only for `y`. `conceal` rewrites a submitted message for echo and history (the CLI masks `/key <secret>`).
  - Non-TTY input uses line mode: no escape sequences, prompts and approvals read whole lines.
- **CLI wiring (`src/cli.ts`, interactive session only; claimed here at 05:05 while `cli.ts` was idle):** `repl` uses `createTerminal` for the header, prompt, rendering, approvals, and command output. Ctrl+C aborts the active turn or slash command through `onInterrupt`. Other changes:
  - A failed slash command or turn prints `error: …` and keeps the session. Before this, an unknown command ended the process.
  - `/key` with no argument reads the key hidden. `/key <secret>` is echoed as `/key [hidden]`.
  - The `Policy` lives for the whole session, so "session rule" approvals now outlive one turn (it was rebuilt every turn).
  - `/diff` keeps spaces in paths, uses the active cancellation signal, and drops the duplicate truncation notice (per `DIFF_HANDOFF.md`). `/help` and `rivet help` now list `/diff`.
  - `reconcile` uses `terminal.confirm`. `--json` sessions use line mode and print no header, so stdout carries only JSONL.
  - Unchanged: `run`, `setup`, and the other subcommands still use the readline `ask`/`renderer` path.
- Evidence: 22 terminal tests (fake TTY plus a small VT emulator). Real ConPTY runs (tuistory, Windows 11) against a local fake OpenAI-compatible SSE server covered: multiline Alt+Enter, streaming, file_patch approval (Enter ignored, `o` approved, file written), type-ahead plus Ctrl+C interrupt (queued text restored to the draft), `/key` hidden and inline (no `sk-` text in scrollback), unknown command keeps the session, `resume` reconciliation (Enter = no, `y` records an abort and the next turn works), and idle Ctrl+C exit. Piped and `--json` sessions checked without a PTY. Full suite: typecheck 0, lint 0, 161 tests, 155 pass, 0 fail, 6 todo.
- Findings for owners:
  - `diff.ts`: `/diff` outside a Git repository throws `Cannot read Git diff:` followed by Git's entire `--no-index` usage text (about 150 lines). Suggest checking `git rev-parse --is-inside-work-tree` first and throwing a short "not a Git repository" error.
  - `cli.ts` `run` mode: Ctrl+C kills the process instead of cancelling (its `AbortController` is never aborted), and approvals there still use the readline prompt without a destination line. Wiring `createTerminal` into `run` (TTY, non-JSON) would fix both.

## Parallel model selection module

- Session `87ccfbb8-ec08-476b-9ff2-a1b86a648869` claims only `src/models.ts` and `test/models.test.mjs`. No edits to CLI, agent loop, providers, config, tools, terminal, MCP, export, or diff files.
- Done: `src/models.ts` + `test/models.test.mjs` (12 tests pass; module typechecks, lints, and is formatted). No hardcoded model catalog or prices: context/output limits come only from the endpoint listing or explicit user values, and prices are always explicit.
- Integration API for the CLI owner (`/model`, `rivet models`, setup):
  - `listModels(config, key, signal): Promise<{ models: { id, context?, maxOutput? }[], truncated }>` GETs `modelsUrl(config)` (OpenAI/Anthropic official URLs, or `<endpoint>/models`). Redirects rejected, 30 s cap, 4 MiB/1000-model bounds, control-character IDs skipped, remote error bodies never surfaced. Cancel gives exit 130.
  - `resolveModel(id, { listing?, context?, maxOutput?, inputPrice?, outputPrice? }): ModelSpec` refuses IDs missing from a complete listing, explicit limits above reported ones, and unknown context windows (exit 2). Default `maxOutput` is `min(reported ?? 4096, context / 4)`.
  - `planModelChange(config, next, history, system): { config, omitted }` is pure. It refuses unfinished tool calls, cost limits without prices, and windows that cannot hold the system prompt or current turn (exit 2/4). `omitted` = earlier turns the new window drops from context (same budget formula as `agent.ts`). Inputs are never mutated.
  - `changeModel(config, next, { key, history, system, signal, connect? })` runs `planModelChange`, then `probe()` through `createProvider` for a new model ID. It returns `{ config, omitted, usage }` (`usage` is null when the ID is unchanged). The caller persists `config` only on success.
  - `modelLines(listing, currentId?)`: plain-text picker rows; says "context not reported" rather than guessing.
- Not committed yet: `models.ts` imports `probe` from `providers.ts`, which only exists in Agent A's uncommitted `providers.ts` change. Commit `src/models.ts` and `test/models.test.mjs` together with or after that change so HEAD keeps building.
- Coordination note: sessions `8c4d1b95` and `a917f9ce` are both executing the Agent A column, and sessions `4b466f50` and `915b5c14` are both building MCP (`src/mcp.ts` / `src/mcp-transport.ts`). Those pairs should reconcile before editing the same files.

## Parallel tool-boundary tests

- Withdrawn: the earlier claim on failure-path tests / example config / SECURITY.md in this section. Agent B re-claimed and is writing those; Agent B keeps them.
- This session now claims only `test/tools.test.mjs` (and `test/fixtures/tools-*` if needed). Covers `createToolRunner()` through its exported API: path guards at the tool boundary, plan/edit policy enforcement, once/session/deny approvals, bounded read/search/list output, patch hash and uniqueness checks, atomic replacement, command limits and cancellation, and Git tool behavior in a temporary repository.
- Test file only. No edits to any `src/` file. Defects found in `tools.ts` are reported here for Agent A instead of fixed.
- Done: `test/tools.test.mjs`, 21 tests (16 pass, 5 `todo`, 0 fail; suite exits 0). Prettier-clean. Covers malformed-call rejection before approval, absolute/drive/UNC/`..`/`.git`/`.rivet`/ADS/trailing-dot/reserved-name paths across every path-taking tool, junctions, plan-mode denial without prompts, once/session/deny with exact-argument prompts and approval events, custom allow/deny, patch hash/uniqueness/`$&` literal/CRLF/size/no temp files, create-without-overwrite and no implicit directories, read bounds/binary/invalid UTF-8/truncation, list/search bounds and skips, no-shell argv, exit codes, output truncation, process-tree kill on timeout and cancellation (grandchild verified dead), pre-aborted signals, read-only Git in plan mode with `diff.external` and `core.fsmonitor` neutralized (control runs prove the hooks would fire), and Git commit approval.
- Defects for Agent A (the `todo` tests flip to normal tests once fixed):
  1. **Security, Windows 8.3 aliases:** with 8.3 names enabled (confirmed on this machine's C: volume), `GIT~1/config` reads `.git/config`, and `GIT~1/hooks/...` reaches Git hooks. This affects both `tools.ts` `safeRelative` and shared `security.ts` `Workspace.path`/`read` (verified: `Workspace.read("GIT~1/config")` returns the file), so `diff.ts`/`instructions.ts` inherit it. Suggested fix: after resolving, compare each component of `realpath(target)` (long names) against the protected-name check, or reject any component matching `/~\d+$/`.
  2. **Security:** `tools.ts` keeps its own path guard instead of `Workspace.path`, so `.env*`, `.ssh`, `.aws`, `.codex`, `.agents` are readable, listable, and searchable in plan mode without approval, and hard-linked files (possibly outside the workspace) are readable. Routing tool paths through `Workspace.path` fixes both.
  3. **Security:** `tools.ts` `runProcess` spawns with the full `process.env`, so approved commands and Git receive provider keys (test proves `*_API_KEY` reaches the child). Use `childEnvironment({ GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" })` from `process.ts`.
  4. **Policy:** `file_list`/`file_read`/`file_search` and allowlisted read-only Git never call `Policy.check`, so custom-mode `deny`/`ask` rules for them are bypassed. Call `check(context, call, "read")` for those paths.
  5. **agent.ts line ~200:** `JSON.parse(result).error === true` never matches. Tools return `{ error: "<message>" }`, so `tool.end.error` is always false and the eight-consecutive-error breaker never trips. Use `typeof parsed.error === "string"`. The same `JSON.parse` also throws on non-JSON MCP text results, which replaces a successful MCP result with a parse error.
  6. **agent.ts:** tool results go to the store, events, and the provider without `redact()`, so secrets printed by commands or read from files persist in SQLite. Redact before `store.finish`/`append`.
  7. Minor UX: `file_patch` creation prompts for approval before checking that the parent directory exists or the file is absent, so the user can approve a call that then fails.

## Agent A log

- Chose `providers.ts` and `store.ts`; deleted `provider.ts`, `storage.ts`, and `contracts.ts`. `probe` moved into `providers.ts`. `tools.ts` ported to `types.ts`; approvals now go through `security.ts` `Policy` only (plan/custom mode and once/session/deny enforced at one boundary). `test/store.test.mjs` replaces `test/storage.test.mjs`.
- `src/agent.ts`: single-step loop with step/tool/token/cost limits, three-identical-call loop detection, an eight-consecutive-tool-error circuit breaker, cancellation, events persisted through the store, and an `McpTools` bridge ready for `connectMcp`.
- `src/cli.ts`: run/help/JSON events/exit codes (0/1/2/3/4/130), setup, `/key`, `/model` (endpoint listing plus capability-checked switch via `models.ts`), `/diff`, `/sessions`, `/export` via `export.ts` (json/markdown, secret redaction, never overwrites), `sessions`, `resume` with uncertain-action reconciliation, `models [check]`.
- Integrated the feature modules: `instructions.ts` (loop system prompt), `models.ts`, `export.ts`, `diff.ts`. All four typecheck and their tests pass; models.ts is committed together with providers.ts so HEAD keeps building.
- Open in this column: wire `connectMcp` when MCP lands; swap prompt/rendering to `createTerminal` when `terminal.ts` lands (prompt is single-line readline until then); sample workflow + Git integration test.
- Config owner note: the endpoint refine in `config.ts` throws a TypeError on unparsable URLs instead of adding a zod issue; Agent B's TODO test covers it.
- Coordination: two sessions were reported on the Agent A column. This column is complete and committed; reconcile here before further edits to `agent.ts`/`cli.ts`.
