import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const lines = createInterface({ input: process.stdin });
let initialized = false;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode === "hang") return;
    if (mode === "utf8")
      return process.stdout.write(Buffer.from([0xc3, 0x28, 10]));
    if (mode === "malformed") return process.stdout.write("not-json\n");
    if (mode === "oversized")
      return process.stdout.write("x".repeat(1024 * 1024 + 1));
    return send(message.id, {
      protocolVersion:
        mode === "version" ? "unsupported" : message.params.protocolVersion,
      serverInfo: { name: "fixture", version: "1" },
      capabilities: { tools: {} },
    });
  }
  if (message.method === "notifications/initialized") {
    initialized = true;
    process.stderr.write("private server diagnostic\n");
  }
  if (message.method === "tools/list") {
    if (!initialized) return process.exit(9);
    return send(message.id, {
      tools: [
        {
          name: "echo.value",
          description: "Echo arguments",
          inputSchema: { type: "object", properties: {} },
        },
        { name: "fail", inputSchema: { type: "object" } },
        { name: "structured", inputSchema: { type: "object" } },
      ],
    });
  }
  if (message.method === "tools/call") {
    if (mode === "exit") return process.exit(7);
    if (message.params.name === "fail")
      return send(message.id, {
        isError: true,
        content: [{ type: "text", text: "tool rejected input" }],
      });
    if (message.params.name === "structured")
      return send(message.id, { content: [], structuredContent: { count: 7 } });
    return send(message.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name: message.params.name,
            args: message.params.arguments,
            cwd: process.cwd(),
            pid: process.pid,
            selected: process.env.RIVET_MCP_TEST_KEY,
            leaked: process.env.RIVET_PROVIDER_TEST_KEY,
          }),
        },
      ],
    });
  }
});
