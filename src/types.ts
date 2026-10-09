export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; calls?: ToolCall[] }
  | { role: "tool"; content: string; callId: string; error?: boolean };
export type Usage = { input: number; output: number; estimated?: boolean };
export type AgentEvent =
  | { type: "session"; id: string; model: string; destination: string }
  | { type: "text"; text: string }
  | { type: "status"; message: string }
  | {
      type: "approval";
      tool: string;
      args: Record<string, unknown>;
      decision?: string;
    }
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool.end"; id: string; result: string; error: boolean }
  | { type: "usage"; usage: Usage; total: number; cost: number | null }
  | { type: "error"; message: string }
  | { type: "done"; reason: "complete" | "cancelled" | "limit" | "error" };
export type Emit = (event: AgentEvent) => void;
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export interface Provider {
  step(
    system: string,
    messages: Message[],
    tools: ToolDefinition[],
    maxOutput: number,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<{
    message: Extract<Message, { role: "assistant" }>;
    usage: Usage;
  }>;
}
export class RivetError extends Error {
  constructor(
    message: string,
    public exitCode = 1,
  ) {
    super(message);
    this.name = "RivetError";
  }
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
