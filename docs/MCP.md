# MCP tools

Rivet connects to MCP servers listed in the user configuration. Servers must have
`"trusted": true` before any connection is attempted. Review the executable,
arguments, endpoint, and credential destination before granting trust. An
untrusted or failing configured server stops the turn; remove unused examples
from the `mcp` array.

## Configuration

These are entries inside the configuration's `mcp` array:

```json
[
  {
    "name": "docs",
    "transport": "stdio",
    "command": "node",
    "args": ["./tools/docs-mcp-server.mjs"],
    "trusted": true
  },
  {
    "name": "tracker",
    "transport": "http",
    "url": "https://mcp.example.com/mcp",
    "keyEnv": "TRACKER_MCP_TOKEN",
    "trusted": true
  }
]
```

Replace these example destinations with servers you control or trust. The stdio
command runs directly, without a shell, in the workspace directory. On Windows,
use an executable such as `node.exe` with the server entry file as an argument;
shell scripts and `.cmd` launchers are not interpreted automatically.

`keyEnv` is optional. For HTTP, its value becomes a Bearer authorization header.
For stdio, only that named credential is added to the filtered child environment.
Missing configured credentials fail before connection. HTTP endpoints require
HTTPS, except loopback HTTP for local servers. Redirects are refused.

## Trust and approval

Trust permits startup and tool discovery, including starting a local process
with your privileges. Stdio servers are not sandboxed and may have side effects
during startup. Invocation is a separate policy decision: plan mode denies MCP
calls, edit mode asks, and custom mode uses the exposed tool name, such as
`mcp_tracker_create_issue`, in `policy`. A server's read-only annotations never
bypass this gate. Approval prompts identify the actual server destination.

Names are prefixed `mcp_<server>_`, normalized to letters, digits, underscores,
and hyphens, and limited to 64 characters for provider compatibility. Collisions
within a server are skipped with a notice. Collisions between servers fail the
connection set so an approved name cannot silently target another server.

## Supported behavior and limits

The client implements newline-delimited stdio and Streamable HTTP POST responses
in either JSON or SSE form, with initialization, negotiated protocol/session
headers, and HTTP DELETE cleanup. Supported protocol revisions are `2025-06-18`
and `2025-03-26`. See the official
[transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [lifecycle specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).

Connections last for one agent turn. They close on completion, cancellation, or
failure; the next turn establishes fresh sessions. Discovery is limited to eight
pages and 64 tools per server, with 16 KiB input schemas, 1024-character descriptions, and
64 KiB call arguments. Messages/HTTP responses are capped at 1 MiB; stdio output
is capped at 16 MiB per connection. At most 32 server requests are answered per
connection. `limits.timeoutMs` bounds each request, and `limits.outputBytes`
bounds the returned tool text. Known credentials are redacted before truncation.

Text content and fallback structured content are supported. Other content types
produce omission notices. Tool failures reach the model as errors. The client
answers pings and rejects server-initiated sampling, roots, and elicitation
requests; other notifications are ignored.

Calls are never retried or replayed automatically, including after timeouts or
HTTP session expiry. Cancellation is best effort: a remote operation may already
have happened. Verify remote state before asking for another attempt.

Not implemented: legacy HTTP+SSE transport, OAuth discovery/login, unsolicited
GET streams, stream resumption, dynamic tool-list refresh, or non-text artifacts.
Validation uses local fixture servers; interoperability with live third-party
servers has not been verified.
