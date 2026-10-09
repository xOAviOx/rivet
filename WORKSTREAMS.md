# Parallel work

Session `915b5c14-2c53-4574-9013-b1312b74103a` owns **only**
`src/instructions.ts`, `test/instructions.test.mjs`, and this handoff.

Feature: safe, bounded, scoped `AGENTS.md` loading for existing directories,
existing files, and files that will be created. Root instructions come first;
deeper instructions apply only within their directory. No recursive workspace
scan and no sibling-scope leakage.

Other agents retain the core loop/CLI, MCP, terminal, models, export, diff,
shared modules, and their tests/documentation as recorded in `PROGRESS.md`.

## MCP overlap resolved

The initial MCP claim here was superseded by the earlier claim from session
`4b466f50-f80c-4ba8-abc8-3b490d668d89` in `PROGRESS.md`.
Its `src/mcp.ts` is preserved. This session removed only its own, unused
`src/mcp-transport.ts`, `test/mcp.test.mjs`, and fixture before changing scope.
The MCP owner can create its planned tests in the now-free path.

## Integration handoff

`loadInstructions(workspace, target = ".", options?)` returns
`Promise<{ target: string, sources: InstructionSource[], text: string }>`.
It imports the canonical `Workspace` / `RivetError` interfaces, not the removed
`contracts.ts`. Options include an abort signal and bounded file/total bytes
and scope depth. The CLI/loop owner handles wiring this into provider context.

```ts
import { loadInstructions } from "./instructions.js";
const scoped = await loadInstructions(workspace, targetPath, { signal });
// Include scoped.text in context without treating sibling rules as global rules.
```

- Unlike the legacy `Workspace.instructions`, directory targets include their
  own `AGENTS.md`. A missing final target is treated as a new file; its parent
  must already exist.
- Defaults: 16 KiB per file, 32 KiB rendered context including scope labels,
  30 nested directories. Configurable ceilings: 64 KiB / 256 KiB / 64.
- `sources` preserves exact UTF-8 content and records workspace-relative file
  paths and scopes. No persistent cache, recursive discovery, or file writes.
- Unsafe/protected paths, symlinks/junctions, hard links, non-regular files,
  binary/invalid UTF-8, cancellation, and budget overflow fail closed.
- Missing `AGENTS.md` files are optional; other filesystem errors are not ignored.

Status: implementation complete, ready for the CLI/loop owner's integration.
No new dependencies required.

## Validation

- Focused strict TypeScript compilation: passed.
- `node --test test/instructions.test.mjs`: all 12 tests passed, no skips.
- ESLint for `src/instructions.ts`: passed.
- Prettier for this handoff and both implementation/test files: passed.
- Repository-wide `pnpm typecheck`: currently blocked by concurrent `src/cli.ts`
  work (missing `Config` export, incomplete functions/context, and unused
  declarations). Those files were not changed by this session.
- The full test suite was not run because its build is blocked by the CLI work.
