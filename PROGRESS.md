# Progress

Phase 1 complete: empty workspace inspected; skills read; dependency network blocked; cache available. Plan and design recorded.

Committed so far: types/config/security/process/context/credentials, OpenAI and Anthropic streaming providers (`provider.ts` and `providers.ts` are duplicates; one must be chosen), SQLite stores (`store.ts` and `storage.ts` are duplicates; one must be chosen), file/search/patch/command/Git tools in `tools.ts` (built on `contracts.ts`).

## Parallel work split (two agents, two terminals)

Shared contract: everything new builds on `src/types.ts` (`AgentEvent`, `Emit`, `Message`, `ToolCall`, `ToolDefinition`, `Provider`, `RivetError`), `src/config.ts` (`Config`, `McpConfig`), `src/security.ts` (`Workspace`, `Policy`, `clean`, `redact`) and `src/process.ts`. Treat `contracts.ts` as legacy; the agent-loop owner decides whether to port `tools.ts`/`storage.ts` to `types.ts` or keep an adapter.

Only edit files in your own column. Additive changes to shared files (new exports only) are allowed; note them here.

| Agent A (core, sequential)                                             | Agent B (independent modules)                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/agent.ts`: single-step loop, limits, loop detection, cancellation | `src/mcp.ts`: stdio + Streamable HTTP client, trust, bounded discovery      |
| `src/cli.ts`: run/help/JSON events/exit codes, setup, `/key`, models   | `src/terminal.ts`: header, batched streaming, approval prompt, multiline    |
| sessions/resume/export commands, uncertain-action reconciliation       | `test/mcp.test.mjs`, `test/terminal.test.mjs`                               |
| choose and delete duplicate provider/store modules; port `tools.ts`    | failure-path tests: security, context, config, process, providers (fake SSE) |
| sample workflow + Git integration test                                 | README, SECURITY.md, ARCHITECTURE.md, example.config.json                   |

Integration points Agent A can rely on from Agent B:

- `mcp.ts`: `connectMcp(config: McpConfig, signal, emit): Promise<McpServer>`; `McpServer.tools: ToolDefinition[]` (names prefixed `mcp_<server>_`), `McpServer.call(name, args, signal): Promise<string>`, `McpServer.close()`. Untrusted servers are refused at connect time; `Policy.check(..., "mcp", ...)` is the invocation gate.
- `terminal.ts`: `createTerminal(options)` returning `{ render(event: AgentEvent), prompt(): Promise<string | null>, approve(name, args, signal): Promise<Decision>, close() }`.

## Agent B log

- MCP is yielded to the WORKSTREAMS.md MCP agent (claimed first; `mcp-transport.ts`, `test/mcp.test.mjs`, fixtures in progress). Agent B's complete standalone draft is parked at `.cache/mcp-draft-agent-b.ts` (gitignored, not built) if useful. Terminal is yielded to the terminal agent below. Agent B's `src/mcp.ts` and `src/process.ts` edits are removed; the tree contains no Agent B source changes.
- Agent B now owns only: failure-path tests for shared modules (`test/security.test.mjs`, `test/context.test.mjs`, `test/config.test.mjs`, `test/process.test.mjs`, `test/credentials.test.mjs`, `test/providers.test.mjs` with a local fake SSE server), documentation (`README.md`, `SECURITY.md`, `ARCHITECTURE.md`, `FEATURES.md`, `example.config.json`), and a packaging check (`pnpm pack` dry run). No edits to any `src/` file.
- Tests target only exported APIs: `Workspace`, `Policy`, `clean`, `redact`, `hash`; `compact`, `estimate`; `configSchema`, `loadConfig`, `saveConfig`, `destination`, `keyName`; `runProcess`, `childEnvironment`; `credential` (environment path only); `createProvider(config, key).step(...)` and `probe`.

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
- Contract (as listed above, plus two additions): `createTerminal(options)` returns `{ header(info), render(event: AgentEvent), prompt(): Promise<string | null>, approve(name, args, signal): Promise<Decision>, secret(label): Promise<string | null>, close() }`. `secret` reads a key without echo for `/key`. `prompt()` resolves `null` on idle Ctrl+C / Ctrl+D (exit). Options accept `input`/`output` streams, `color`, `columns` for tests.

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

## Agent A log

- Chose `providers.ts` and `store.ts`; deleted `provider.ts`, `storage.ts`, and `contracts.ts`. `probe` moved into `providers.ts`. `tools.ts` ported to `types.ts`; approvals now go through `security.ts` `Policy` only (plan/custom mode and once/session/deny enforced at one boundary). `test/store.test.mjs` replaces `test/storage.test.mjs`.
- `src/agent.ts`: single-step loop with step/tool/token/cost limits, three-identical-call loop detection, an eight-consecutive-tool-error circuit breaker, cancellation, events persisted through the store, and an `McpTools` bridge ready for `connectMcp`.
- `src/cli.ts`: run/help/JSON events/exit codes (0/1/2/3/4/130), setup, `/key`, `/model` (endpoint listing plus capability-checked switch via `models.ts`), `/diff`, `/sessions`, `/export` via `export.ts` (json/markdown, secret redaction, never overwrites), `sessions`, `resume` with uncertain-action reconciliation, `models [check]`.
- Integrated the feature modules: `instructions.ts` (loop system prompt), `models.ts`, `export.ts`, `diff.ts`. All four typecheck and their tests pass; models.ts is committed together with providers.ts so HEAD keeps building.
- Open in this column: wire `connectMcp` when MCP lands; swap prompt/rendering to `createTerminal` when `terminal.ts` lands (prompt is single-line readline until then); sample workflow + Git integration test.
- Config owner note: the endpoint refine in `config.ts` throws a TypeError on unparsable URLs instead of adding a zod issue; Agent B's TODO test covers it.
- Coordination: two sessions were reported on the Agent A column. This column is complete and committed; reconcile here before further edits to `agent.ts`/`cli.ts`.
