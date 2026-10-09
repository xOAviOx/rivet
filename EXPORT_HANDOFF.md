# Session export integration

The parallel export feature is implemented in `src/export.ts`, with regression
tests in `test/export.test.mjs`. It does not edit the CLI or write export files.

```ts
import { exportSession } from "./export.js";

const secrets = sessionKey ? [sessionKey] : [];
const output = exportSession(store, sessionId, "json", secrets);
// Or: exportSession(store, sessionId, "markdown", secrets);
```

- The store needs the canonical `get`, `messages`, `events`, and `pending`
  methods. An existing open `Store` can be passed directly.
- JSON is the default. Its versioned envelope contains `schemaVersion: 1`,
  `session`, `messages`, `events`, and `pending`. Records retain their original
  order. Nothing is truncated.
- Markdown renders conversation text, tool calls/results, events, and pending
  actions. Untrusted content is indented as literal text, not interpreted as
  Markdown or HTML. Terminal controls are removed from displayed text.
- JSON escapes terminal controls and bidirectional overrides without discarding
  the original event content, so parsing recovers it.
- Known environment credentials and provider-shaped tokens use the shared
  redactor. Pass process-only `/key` credentials in the fourth argument. This is
  not general-purpose detection of every possible secret.
- Export never appends records, resolves actions, or replays commands. Pending
  actions remain pending and Markdown warns against automatic replay.
- Invalid formats and missing sessions throw `RivetError` with exit code 2.
- The CLI owns destination selection and file writing. Avoid overwriting an
  existing destination without explicit authorization.

## Validation

Nine regression tests cover ordering, session isolation, restart persistence,
secret redaction, record immutability, terminal controls, literal Markdown,
empty sessions, invalid input, and overlapping credentials.

The isolated strict typecheck, ESLint, and scoped Prettier checks pass.
Repository-wide typechecking encountered missing `killTree` and `spawnOptions`
exports referenced by the independently edited `src/diff.ts`; no changes were
made to that agent's files.
