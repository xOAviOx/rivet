# Rivet terminal design

A developer uses Rivet alongside an editor in a terminal with a personally chosen light or dark theme. Inherit that theme instead of choosing a background.

- Native monospace, plain text hierarchy, cyan only for interactive prompts when color is supported.
- One compact workspace / provider:model / mode header.
- Append conversation and completed tool lines to terminal scrollback. Keep readline input separate and redraw it after streamed output.
- Batch streaming writes; strip untrusted controls. Details are explicit slash commands, not boxes.
- Approval displays exact arguments and destination, then once / session rule / deny. Escape or Ctrl+C cancels, never approves.
- Enter submits, Alt+Enter inserts a newline; bracketed paste stays in the editor until submission. Ctrl+C interrupts active work and keeps the session; idle Ctrl+C exits.
- Narrow displays wrap naturally; truncate only summaries, never approval arguments. Original events remain available through export.
