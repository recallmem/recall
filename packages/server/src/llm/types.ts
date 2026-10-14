/** Provider-neutral message format. Providers translate to their native shapes. */
export type LlmMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /** Provider-native content, replayed verbatim on the same provider (keeps thinking blocks valid). */
      native?: { provider: string; content: unknown };
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input (object). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** How hard a reasoning model thinks; "none" turns reasoning off where the model allows it. */
export type Effort = "none" | "low" | "medium" | "high";

export interface LlmRequest {
  /** Logical task, used for model routing and cost attribution. */
  task: string;
  /** "provider/model". Resolved from the task when omitted. */
  model?: string;
  /**
   * Fixed instructions, byte-identical on every call of the task: no dates, ids,
   * names or settings (those go in `context`). With the tools and output schema
   * before it, this is the static prefix that providers cache; it gets a cache
   * breakpoint when it reaches the provider's minimum (src/llm/cache.ts).
   */
  system?: string;
  /** Per-call context (known facts, the memory pack, app instructions), sent after `system`. */
  context?: string;
  /**
   * Also cache `context` and the conversation so far: only worth it when they are
   * re-sent within minutes (tool loops), since a one-off context pays the
   * cache-write premium (1.25x) for nothing.
   */
  cacheContext?: boolean;
  messages: LlmMessage[];
  maxTokens?: number;
  /** Sampling temperature; the provider's default when omitted (OpenAI-compatible providers only). */
  temperature?: number;
  effort?: Effort;
  tools?: ToolDef[];
  /** JSON schema the response must match (structured output). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** For usage metering. */
  workspaceId?: string | null;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: Usage;
  provider: string;
  model: string;
  latencyMs: number;
  /**
   * Cost the provider reported for this call in USD (OpenRouter's `usage.cost`, plus the upstream
   * provider's charge on a BYOK call); preferred over list prices.
   */
  costUsd?: number;
  /**
   * A BYOK call that reported no upstream charge: OpenRouter's own charge for it. Its cost is the
   * list price of its tokens plus this (see `LlmClient.cost`).
   */
  byokFeeUsd?: number;
  /** Assistant turn to append when continuing a tool loop. */
  assistantMessage: Extract<LlmMessage, { role: "assistant" }>;
}

export type StreamEvent = { type: "text"; delta: string } | { type: "done"; result: LlmResult };

export interface LlmProvider {
  readonly name: string;
  complete(model: string, req: LlmRequest): Promise<LlmResult>;
  stream(model: string, req: LlmRequest): AsyncIterable<StreamEvent>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** Native dimensionality of the model before padding. */
  readonly nativeDimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<{ vectors: number[][]; tokens: number }>;
}

export interface UsageRecord {
  workspaceId: string | null;
  task: string;
  provider: string;
  model: string;
  usage: Usage;
  costUsd: number | null;
  /** The cost is the list price of the call's tokens, not one the provider reported. */
  costEstimated?: boolean;
  latencyMs: number;
  at: Date;
}

export interface UsageSink {
  record(entry: UsageRecord): void;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "refusal" | "invalid_output" | "config" | "provider",
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
