# Parallel diff feature

Owner: terminal session `f9a61f3e-e547-4075-801f-2bfb2fdd4368`.

Claimed files: `src/diff.ts`, `test/diff.test.mjs`, and this handoff only.
Other agents retain ownership of the CLI, tools, terminal, MCP, export, and
existing shared modules.

## Integration contract

`workspaceDiff(workspace: Workspace, signal: AbortSignal, options?: DiffOptions)`
returns `Promise<DiffResult>`. Import it from `./diff.js` for the `/diff` command.

- Options: `staged?: boolean`, `path?: string`, `context?: number`,
  `maxBytes?: number`, `timeoutMs?: number`.
- Result: `{ text: string, truncated: boolean, staged: boolean }`.
- Defaults: unstaged tracked-file changes, three context lines, 32 KiB output,
  30-second timeout. An empty `text` means no changes.
- Reads only. No external diff helpers, textconv, pagers, submodule traversal,
  clean/process filters, fsmonitor hooks, or automatic `safe.directory` bypass.
  Never stages or changes files.
- Paths are workspace-relative and pass through `Workspace.path`. The command
  also works from a repository subdirectory without exposing sibling diffs.
- `text` uses the shared environment-secret/token redactor and terminal
  sanitizer. Binary changes normally produce Git's binary-file notice, not
  binary payloads. Untracked files are not included. Protected paths, symlinks,
  and hard links are excluded from broad previews and rejected as explicit
  path selections. Empty `text` means no previewable tracked-file changes.
- Output truncation is explicit. Cancellation throws and does not retry.

## Integration status

Implementation complete. The CLI owner has imported `workspaceDiff` and wired
the `/diff` case. The backend does not depend on the temporary `killTree` or
`spawnOptions` exports that another agent withdrew.

The CLI owner still handles presentation and command parsing. Preserve spaces
in path arguments, and pass the active cancellation signal instead of an
unconnected `new AbortController().signal`. The result already contains its
truncation notice, so no second notice is needed.

## Validation

On Windows 11 with Node 22.19.0 and Git 2.43.0:

- `node --test test/diff.test.mjs`: all 21 tests pass.
- Strict isolated TypeScript compilation and repository `tsc --noEmit`: pass.
- `eslint src/diff.ts`: pass.
- Scoped Prettier checks and `git diff --check`: pass.
- Tests cover staged/unstaged changes, no-op/untracked behavior, context,
  deletions, binary notices, literal paths, subdirectory containment, protected
  paths, hard links/junctions, terminal controls, redaction/UTF-8 byte bounds,
  disabled Git helpers, inherited Git overrides, cancellation, deadlines,
  and non-repository errors.

The repository-wide test suite and interactive CLI checks remain with their
owners. No existing implementation files were edited for this feature.
