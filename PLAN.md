# Rivet implementation and acceptance

Build a usable local terminal agent in five increments. Keep this checklist authoritative; unchecked first-release work is not roadmap work.

1. [x] Inspect repository, instructions, runtime, dependency availability; record architecture.
2. [x] CLI + agent loop + OpenAI + file/search/patch/command/Git tools + approvals + SQLite.
3. [x] Anthropic + explicit compatible endpoints + setup + model selection + budgets + sessions.
4. [x] Scoped AGENTS.md + bounded compaction + trusted stdio/HTTP MCP.
5. [x] Terminal polish + recovery + failure tests + packaging + documentation + sample workflow.

## Acceptance

- [x] Interactive and noninteractive run, help, JSON events, defined exit codes.
- [x] Provider setup with environment/session/OS credentials, explicit destinations, no plaintext keys. (Wizard covered by `test/setup.test.mjs`; the OS store is exercised through an injected store in tests plus one manual Windows PasswordVault round trip. macOS Keychain and Linux `secret-tool` remain unexecuted.)
- [x] Capability-checked model selection and safe model changes.
- [x] Validated, bounded file discovery/search/read/patch/exec/Git tools.
- [x] Workspace/symlink/Windows path protection; Git internals protected.
- [x] Plan/edit/custom policy enforced at tool boundary; once/session/deny choices.
- [x] Streaming, cancellation, timeouts, bounded retries, loop detection, step/tool/token/cost limits.
- [x] Typed lifecycle, output, tool, approval, usage, error events.
- [x] Scoped instructions and bounded context with intact call/result pairs and original transcript.
- [x] SQLite migrations, writer exclusion, sessions/resume/export, uncertain-action reconciliation (schema v1; newer versions refused).
- [x] MCP stdio and Streamable HTTP, explicit local trust, bounded discovery, invocation approvals (local fixtures; see docs/MCP.md for limits).
- [x] Responsive multiline terminal input, narrow/wide/no-color, details/diff/settings/sessions commands. (`test/terminal.test.mjs`, `test/inspect.test.mjs`, `test/cli.test.mjs`.)
- [x] Failure-path tests and deterministic Git repository integration including restart/resume.
- [x] Format, lint, types, tests, package, actual terminal and sample workflow checks (offline fake provider; Windows only).
- [x] README, example config, architecture, security, feature matrix, roadmap, platform evidence.

## Constraints and decisions

- Empty D:\\rivet, no existing user files or repository instructions found.
- Network package installation is denied (npm registry EACCES); approval policy disallows escalation. No live API credentials supplied. Node 22.19.0 and pnpm 11.6.0 installed.
- Use one package with cohesive modules, strict TypeScript, pnpm lock, cached Zod/tooling. Node's maintained SQLite binding avoids native dependency installation. Node 24 LTS is recommended; installed Node 22 is tested with SQLite's experimental warning.
- Use native terminal/readline and explicit provider HTTP adapters because Ink/AI SDK/MCP SDK are unavailable offline. Keep transport/UI behind boundaries. This is a stack deviation, not a claim those packages were integrated.
- Direct provider clients use official endpoints and fetch with redirect rejection. Own the single-step loop; transport cannot execute tools.
- Patches use exact unique text replacement plus a required content hash, with atomic file replacement; one file per call avoids falsely atomic multi-file changes.
- Local commands are permission controlled, not sandboxed. No automatic command retries. Interrupted/uncertain actions require reconciliation and never replay automatically.
- Product choices follow the user's detailed brief; no additional brand interview needed. Neutral terminal palette, one cyan accent, stable input, plain status verbs, no animation.
