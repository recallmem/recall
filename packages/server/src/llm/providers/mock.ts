import type { LlmProvider, LlmRequest, LlmResult, StreamEvent, ToolCall } from "../types.js";

export interface MockReply {
  text?: string;
  json?: unknown;
  toolCalls?: ToolCall[];
  /** Defaults to "tool_use" with tool calls, else "end" (tests can simulate a cut-off reply). */
  stopReason?: LlmResult["stopReason"];
}

export type MockResponder = (req: LlmRequest, model: string) => MockReply | Promise<MockReply>;

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Deterministic offline provider. Used by tests, and as the fallback when no
 * provider key is configured so the server still runs end to end. Modules can
 * register a per-task responder that gives a plausible offline answer.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock";
  private static readonly taskResponders = new Map<string, MockResponder>();
  private override: MockResponder | null = null;
  readonly calls: { model: string; req: LlmRequest }[] = [];

  static register(task: string, responder: MockResponder): void {
    MockProvider.taskResponders.set(task, responder);
  }

  /** Replace every reply (tests). Pass null to restore task responders. */
  respondWith(responder: MockResponder | null): void {
    this.override = responder;
  }

  private async reply(model: string, req: LlmRequest): Promise<MockReply> {
    this.calls.push({ model, req });
    const responder = this.override ?? MockProvider.taskResponders.get(req.task);
    if (responder) return responder(req, model);
    if (req.jsonSchema) return { json: {} };
    const last = req.messages.at(-1);
    return { text: `[mock] ${last && "content" in last ? last.content.slice(0, 200) : ""}` };
  }

  async complete(model: string, req: LlmRequest): Promise<LlmResult> {
    const startedAt = Date.now();
    const r = await this.reply(model, req);
    const text = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
    const toolCalls = r.toolCalls ?? [];
    const prompt = [req.system, req.context, ...req.messages.map((m) => m.content)].join("\n");
    return {
      text,
      toolCalls,
      stopReason: r.stopReason ?? (toolCalls.length ? "tool_use" : "end"),
      usage: {
        inputTokens: approxTokens(prompt),
        outputTokens: approxTokens(text),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      provider: this.name,
      model,
      latencyMs: Date.now() - startedAt,
      assistantMessage: { role: "assistant", content: text, toolCalls },
    };
  }

  async *stream(model: string, req: LlmRequest): AsyncIterable<StreamEvent> {
    const result = await this.complete(model, req);
    for (const word of result.text.split(/(?<=\s)/)) yield { type: "text", delta: word };
    yield { type: "done", result };
  }
}
