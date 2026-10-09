export type Mode = "plan" | "edit";
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export interface ProviderResult {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
}
export interface Provider {
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    options: { signal?: AbortSignal; onText?: (text: string) => void },
  ): Promise<ProviderResult>;
}
export interface ApprovalRequest {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}
export type ApprovalDecision = "once" | "session" | "deny";
export interface ToolContext {
  workspace: string;
  mode: Mode;
  signal?: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}
export interface ToolRunner {
  definitions: ToolDefinition[];
  execute(call: ToolCall, context: ToolContext): Promise<string>;
}
export interface RivetEvent {
  type: string;
  sessionId: string;
  timestamp: string;
  [key: string]: unknown;
}
export interface Session {
  id: string;
  workspace: string;
  model: string;
  createdAt: string;
}
export interface SessionStore {
  createSession(workspace: string, model: string): Session;
  getSession(id: string): Session | undefined;
  listSessions(): Session[];
  appendMessage(sessionId: string, message: Message): void;
  getMessages(sessionId: string): Message[];
  appendEvent(event: RivetEvent): void;
  getEvents(sessionId: string): RivetEvent[];
  beginAction(sessionId: string, call: ToolCall): string;
  finishAction(actionId: string, result: string): void;
  getPendingActions(sessionId: string): Array<{ id: string; call: ToolCall }>;
  close(): void;
}
