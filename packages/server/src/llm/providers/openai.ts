import OpenAI from "openai";
import {
  anthropicCacheMinimum,
  type CachePlan,
  cacheKey,
  cachePlan,
  NO_CACHE,
  OPENAI_CACHE_MINIMUM,
  openAiExplicitCaching,
} from "../cache.js";
import { isFreeModel, type OpenRouterCost, openRouterCost } from "../openrouter.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  StreamEvent,
  ToolCall,
  Usage,
} from "../types.js";
import { LlmError } from "../types.js";

/** Known OpenAI-compatible endpoints. `compat` is any user-supplied base URL. */
export const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  /** xAI's Grok models, e.g. "xai/grok-4-fast". */
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  /** Together AI serverless models, e.g. "together/deepseek-ai/DeepSeek-V4-Pro-0813". */
  together: "https://api.together.ai/v1",
  /**
   * Together dedicated endpoints, where fine-tuned (LoRA) models are served:
   * "together-dedicated/<project-slug>/<endpoint-name>". Same TOGETHER_API_KEY.
   */
  "together-dedicated": "https://api-inference.together.ai/v1",
  /** Fireworks AI, e.g. "fireworks/accounts/<account>/models/<model>". */
  fireworks: "https://api.fireworks.ai/inference/v1",
};

/** Providers that only accept `json_object`, not `json_schema`. */
const JSON_OBJECT_ONLY = new Set(["deepseek"]);

/** Providers whose `usage.cost` (USD) is trusted as the cost of a call (see `openRouterCost`). */
const REPORTS_COST = new Set(["openrouter"]);

/**
 * Providers serving open-weight models whose chat templates accept a single,
 * leading system message (Qwen3.5's raises "System message must be at the
 * beginning" on a second one): system and context are sent as one message.
 */
export const SINGLE_SYSTEM_MESSAGE = new Set(["together", "together-dedicated", "fireworks"]);

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type TextPart = OpenAI.Chat.Completions.ChatCompletionContentPartText;

function isReasoningModel(provider: string, model: string): boolean {
  return provider === "openai" && /^(gpt-[5-9]|o\d)/.test(model);
}

/**
 * Prompt caching on an OpenAI-compatible wire: where the breakpoints go, how
 * they are marked, and the request fields that go with them.
 */
export interface WireCache {
  /**
   * Breakpoint markers: OpenAI's `prompt_cache_breakpoint` (GPT-5.6 and later)
   * or Anthropic-style `cache_control` (Claude through OpenRouter). Null: none.
   */
  markers: "openai" | "anthropic" | null;
  plan: CachePlan;
  /** Top-level request fields (`prompt_cache_key`, `prompt_cache_options`, `session_id`). */
  fields: Record<string, unknown>;
}

/**
 * Cache settings for `provider`, or null where nothing is sent: Gemini,
 * DeepSeek, Groq, Together and Fireworks cache prefixes automatically, and a
 * `compat` server may reject fields it does not know. Requests are already
 * laid out static-first, which is all automatic prefix caching needs.
 */
export function wireCache(provider: string, model: string, req: LlmRequest): WireCache | null {
  const explicit = openAiExplicitCaching(model);
  // Explicit mode writes only the marked breakpoints: the static prefix is written once and
  // read by later calls, and the per-call tail is not written at 1.25x on every call.
  const options = explicit ? { prompt_cache_options: { mode: "explicit" } } : {};
  if (provider === "openai") {
    return {
      markers: explicit ? "openai" : null,
      plan: explicit ? cachePlan(req, OPENAI_CACHE_MINIMUM) : NO_CACHE,
      fields: { prompt_cache_key: cacheKey(req), ...options },
    };
  }
  if (provider === "openrouter") {
    // `session_id` is OpenRouter's sticky-routing key: calls of a task stay on the provider
    // that holds their cache. Without it the key is derived from the first user message,
    // which differs on every call.
    const session = { session_id: cacheKey(req) };
    if (model.startsWith("anthropic/")) {
      return {
        markers: "anthropic",
        plan: cachePlan(req, anthropicCacheMinimum(model)),
        fields: session,
      };
    }
    if (explicit) {
      return {
        markers: "openai",
        plan: cachePlan(req, OPENAI_CACHE_MINIMUM),
        fields: { ...session, ...options },
      };
    }
    // Gemini 2.5+ caches implicitly at no write cost (explicit markers would add cache
    // storage); other providers cache automatically or not at all.
    return { markers: null, plan: NO_CACHE, fields: session };
  }
  return null;
}

const MARKERS = {
  openai: { prompt_cache_breakpoint: { mode: "explicit" } },
  anthropic: { cache_control: { type: "ephemeral" } },
} as const;

/**
 * Message indexes that end a cacheable stretch of the conversation. OpenAI only
 * looks up breakpoints present in the incoming request, so every user turn and
 * every group of tool results stays marked (each tool round then reads the
 * previous one). Anthropic looks back up to 20 blocks from a breakpoint on its
 * own and allows four in all, so only the last message is marked there.
 */
function messageBreakpoints(messages: LlmMessage[], markers: "openai" | "anthropic"): Set<number> {
  const ends = new Set<number>();
  const last = messages.length - 1;
  if (markers === "anthropic") {
    if (last >= 0 && messages[last]!.role !== "assistant") ends.add(last);
    return ends;
  }
  messages.forEach((m, i) => {
    if (m.role === "user" || (m.role === "tool" && messages[i + 1]?.role !== "tool")) ends.add(i);
  });
  return ends;
}

/**
 * The chat messages sent to `provider` for a request. Exported so fine-tuning
 * data is built from exactly what the server sends at inference time (without
 * `cache`, every content is a plain string).
 */
export function toOpenAiMessages(
  req: LlmRequest,
  provider = "openai",
  cache?: Pick<WireCache, "markers" | "plan"> | null,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const marker = cache?.markers ? MARKERS[cache.markers] : null;
  const plan = marker ? cache!.plan : NO_CACHE;
  const text = (content: string, mark: boolean): string | TextPart[] =>
    mark && marker ? [{ type: "text", text: content, ...marker } as TextPart] : content;
  if (SINGLE_SYSTEM_MESSAGE.has(provider)) {
    const system = [req.system, req.context].filter(Boolean).join("\n\n");
    if (system) out.push({ role: "system", content: system });
  } else {
    if (req.system) out.push({ role: "system", content: text(req.system, plan.system) });
    if (req.context) out.push({ role: "system", content: text(req.context, plan.context) });
  }
  const ends =
    plan.messages && cache?.markers
      ? messageBreakpoints(req.messages, cache.markers)
      : new Set<number>();
  for (const [i, m] of req.messages.entries()) {
    if (m.role === "user") out.push({ role: "user", content: text(m.content, ends.has(i)) });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: text(m.content, ends.has(i)) });
    }
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The chat-completions body for a request, without provider-specific extras
 * (OpenRouter routing). Exported so tests can inspect the exact wire layout.
 */
export function chatParams(
  provider: string,
  model: string,
  req: LlmRequest,
  cache: WireCache | null = null,
): ChatParams {
  const reasoning = isReasoningModel(provider, model);
  const maxTokens = req.maxTokens ?? 8192;
  const params: ChatParams = {
    model,
    messages: toOpenAiMessages(req, provider, cache),
    ...(provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
  // low/medium/high are accepted by every OpenAI reasoning model; "minimal" is
  // gpt-5 only and "none" is gpt-5.1+ only, so neither is used.
  // gpt-5.1+ on /v1/chat/completions rejects function tools combined with
  // reasoning_effort, including a final call whose history holds tool calls,
  // so any request involving tools runs at the model's default effort.
  const involvesTools =
    !!req.tools?.length ||
    req.messages.some((m) => m.role === "tool" || (m.role === "assistant" && m.toolCalls?.length));
  if (reasoning && involvesTools) {
    // gpt-5.1+ and gpt-6 need an explicit "none" next to tools (their default
    // effort is rejected too); the original gpt-5 family takes no setting.
    if (!/^gpt-5(-|$)/.test(model)) {
      (params as unknown as Record<string, unknown>).reasoning_effort = "none";
    }
  } else if (reasoning && req.effort && !(req.effort === "none" && /^gpt-5(-|$)/.test(model))) {
    (params as unknown as Record<string, unknown>).reasoning_effort = req.effort;
  }
  if (req.jsonSchema) {
    params.response_format = JSON_OBJECT_ONLY.has(provider)
      ? { type: "json_object" }
      : {
          type: "json_schema",
          json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
        };
  }
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (cache) Object.assign(params, cache.fields);
  return params;
}

/** A 400 that names a prompt-cache field: the endpoint does not accept it. */
function rejectsCacheFields(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== 400 && status !== 422) return false;
  return /prompt_cache|cache_control|session_id/i.test(String((err as Error).message ?? ""));
}

const clampTokens = (n: unknown, max: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(0, n), Math.max(0, max)) : 0;

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly extraBody: ((model: string, req: LlmRequest) => Record<string, unknown>) | null;
  /** Models whose endpoint refused the prompt-cache fields; they are sent without them from then on. */
  private readonly cacheRefused = new Set<string>();

  constructor(
    readonly name: string,
    opts: {
      apiKey: string;
      baseURL: string;
      /** Provider-specific request fields (e.g. OpenRouter routing); may throw LlmError. */
      extraBody?: (model: string, req: LlmRequest) => Record<string, unknown>;
    },
  ) {
    this.extraBody = opts.extraBody ?? null;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxRetries: 3,
      timeout: 120_000,
    });
  }

  private params(model: string, req: LlmRequest, cache: WireCache | null): ChatParams {
    const params = chatParams(this.name, model, req, cache);
    if (this.extraBody) Object.assign(params, this.extraBody(model, req));
    return params;
  }

  /**
   * Sends a request with its prompt-cache fields. An OpenAI-compatible endpoint
   * that rejects them (an older proxy or gateway behind OPENAI_BASE_URL) gets the
   * request again without them, and never sees them again for that model.
   */
  private async send<T>(
    model: string,
    req: LlmRequest,
    call: (params: ChatParams) => Promise<T>,
  ): Promise<T> {
    const cache = this.cacheRefused.has(model) ? null : wireCache(this.name, model, req);
    try {
      return await call(this.params(model, req, cache));
    } catch (err) {
      if (!cache || !rejectsCacheFields(err)) throw err;
      this.cacheRefused.add(model);
      return call(this.params(model, req, null));
    }
  }

  /**
   * Token usage with cache reads and writes split out. `prompt_tokens` includes
   * both; DeepSeek reports its hits as `prompt_cache_hit_tokens`. Only GPT-5.6+
   * bills cache writes on OpenAI, so earlier models count written tokens as
   * ordinary input.
   */
  private usage(model: string, usage: OpenAI.CompletionUsage | undefined | null): Usage {
    const prompt = usage?.prompt_tokens ?? 0;
    const details = usage?.prompt_tokens_details as
      | { cached_tokens?: number | null; cache_write_tokens?: number | null }
      | undefined;
    const hits =
      details?.cached_tokens ??
      (usage as { prompt_cache_hit_tokens?: number } | null | undefined)?.prompt_cache_hit_tokens;
    const cached = clampTokens(hits, prompt);
    const writesBilled = this.name !== "openai" || openAiExplicitCaching(model);
    const written = writesBilled ? clampTokens(details?.cache_write_tokens, prompt - cached) : 0;
    return {
      inputTokens: Math.max(0, prompt - cached - written),
      outputTokens: usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: written,
    };
  }

  private result(
    model: string,
    text: string,
    toolCalls: ToolCall[],
    finish: string | null | undefined,
    usage: OpenAI.CompletionUsage | undefined | null,
    startedAt: number,
  ): LlmResult {
    if (finish === "content_filter") throw new LlmError(`${model} declined the request`, "refusal");
    const tokens = (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
    const cost: OpenRouterCost = REPORTS_COST.has(this.name)
      ? openRouterCost(usage, { tokens, free: isFreeModel(model) })
      : {};
    return {
      text,
      toolCalls,
      stopReason:
        finish === "stop"
          ? "end"
          : finish === "tool_calls"
            ? "tool_use"
            : finish === "length"
              ? "max_tokens"
              : "other",
      usage: this.usage(model, usage),
      provider: this.name,
      model,
      latencyMs: Date.now() - startedAt,
      ...cost,
      assistantMessage: { role: "assistant", content: text, toolCalls },
    };
  }

  async complete(model: string, req: LlmRequest): Promise<LlmResult> {
    const startedAt = Date.now();
    try {
      const res = await this.send(
        model,
        req,
        (params) =>
          this.client.chat.completions.create(
            { ...params, stream: false },
            { signal: req.signal },
          ) as Promise<OpenAI.Chat.Completions.ChatCompletion>,
      );
      const choice = res.choices[0];
      const msg = choice?.message;
      if (msg?.refusal) throw new LlmError(`${model} declined: ${msg.refusal}`, "refusal");
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
        .filter((c) => c.type === "function")
        .map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }));
      return this.result(
        model,
        msg?.content ?? "",
        toolCalls,
        choice?.finish_reason,
        res.usage,
        startedAt,
      );
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError(`${this.name}/${model}: ${(err as Error).message}`, "provider", err);
    }
  }

  async *stream(model: string, req: LlmRequest): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    const stream = await this.send(model, req, (params) =>
      this.client.chat.completions.create(
        { ...params, stream: true, stream_options: { include_usage: true } },
        { signal: req.signal },
      ),
    );
    let text = "";
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: "text", delta: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    const toolCalls = [...calls.values()].map((c) => ({
      id: c.id,
      name: c.name,
      input: parseArgs(c.args),
    }));
    yield { type: "done", result: this.result(model, text, toolCalls, finish, usage, startedAt) };
  }
}
