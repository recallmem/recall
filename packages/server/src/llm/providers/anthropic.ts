import Anthropic from "@anthropic-ai/sdk";
import { anthropicCacheMinimum, cachePlan } from "../cache.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  StreamEvent,
  ToolCall,
} from "../types.js";
import { LlmError } from "../types.js";

/** Room added to `max_tokens` when a call may think: the thinking counts as output. */
const THINKING_ROOM_TOKENS = 8192;

/** Models that accept `output_config.effort` and adaptive thinking. Haiku 4.5 and Sonnet 4.5 reject it. */
function supportsEffort(model: string): boolean {
  return /claude-(opus|sonnet|haiku|fable|mythos)-5|claude-opus-4-[5-9]|claude-sonnet-4-6/.test(
    model,
  );
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.native?.provider === "anthropic") {
        out.push({ role: "assistant", content: m.native.content as Anthropic.ContentBlockParam[] });
        continue;
      }
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : m.content });
    } else {
      // All tool results for one assistant turn go back in a single user message.
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** Puts a cache breakpoint on the last block of the last message (a user turn or tool results). */
function markLastMessage(messages: Anthropic.MessageParam[]): void {
  const last = messages.at(-1);
  if (last?.role !== "user") return;
  if (typeof last.content === "string") {
    if (last.content)
      last.content = [{ type: "text", text: last.content, cache_control: EPHEMERAL }];
    return;
  }
  const blocks = [...last.content];
  const end = blocks.at(-1);
  if (end && (end.type === "text" || end.type === "tool_result")) {
    blocks[blocks.length - 1] = { ...end, cache_control: EPHEMERAL };
    last.content = blocks;
  }
}

/**
 * The Messages API body for a request. Cache breakpoints (docs/ARCHITECTURE.md,
 * "Prompt layout and caching"): after the system prompt, which with the tools
 * before it is the static prefix shared by every call of a task, when that
 * prefix reaches the model's minimum; and for tool loops (`cacheContext`) also
 * after the context and at the end of the conversation, so each round reads
 * the previous one. Exported so tests can inspect the exact wire layout.
 */
export function anthropicParams(
  model: string,
  req: LlmRequest,
): Anthropic.MessageCreateParamsNonStreaming {
  const plan = cachePlan(req, anthropicCacheMinimum(model));
  const system: Anthropic.TextBlockParam[] = [];
  if (req.system) {
    system.push({
      type: "text",
      text: req.system,
      ...(plan.system ? { cache_control: EPHEMERAL } : {}),
    });
  }
  if (req.context) {
    system.push({
      type: "text",
      text: req.context,
      ...(plan.context ? { cache_control: EPHEMERAL } : {}),
    });
  }
  const messages = toAnthropicMessages(req.messages);
  if (plan.messages) markLastMessage(messages);
  const outputConfig: Anthropic.OutputConfig = {};
  // Claude has no "none" effort: without a thinking budget it does not think anyway.
  if (req.effort && req.effort !== "none" && supportsEffort(model))
    outputConfig.effort = req.effort;
  if (req.jsonSchema) outputConfig.format = { type: "json_schema", schema: req.jsonSchema.schema };
  const thinking = !!req.thinking && supportsEffort(model);

  return {
    model,
    max_tokens: (req.maxTokens ?? 8192) + (thinking ? THINKING_ROOM_TOKENS : 0),
    ...(thinking ? { thinking: { type: "adaptive" as const } } : {}),
    messages,
    ...(system.length ? { system } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
          tool_choice: { type: "auto" as const },
        }
      : {}),
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      maxRetries: 3,
      timeout: 120_000,
    });
  }

  private toResult(model: string, message: Anthropic.Message, startedAt: number): LlmResult {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }
    const stop = message.stop_reason;
    if (stop === "refusal") {
      throw new LlmError(`${model} declined the request`, "refusal");
    }
    return {
      text,
      toolCalls,
      stopReason:
        stop === "end_turn" || stop === "stop_sequence"
          ? "end"
          : stop === "tool_use"
            ? "tool_use"
            : stop === "max_tokens"
              ? "max_tokens"
              : "other",
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      provider: this.name,
      model,
      latencyMs: Date.now() - startedAt,
      assistantMessage: {
        role: "assistant",
        content: text,
        toolCalls,
        native: { provider: this.name, content: message.content },
      },
    };
  }

  async complete(model: string, req: LlmRequest): Promise<LlmResult> {
    const startedAt = Date.now();
    try {
      const message = await this.client.messages.create(anthropicParams(model, req), {
        signal: req.signal,
      });
      return this.toResult(model, message, startedAt);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError(`anthropic/${model}: ${(err as Error).message}`, "provider", err);
    }
  }

  async *stream(model: string, req: LlmRequest): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    const stream = this.client.messages.stream(anthropicParams(model, req), { signal: req.signal });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    yield { type: "done", result: this.toResult(model, final, startedAt) };
  }
}
