import { z } from "zod";
import type { Config, LlmTask } from "../config.js";
import { type OpenRouterCatalog, openRouterBody, openRouterCatalog } from "./openrouter.js";
import { PriceBook } from "./pricing.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { MockProvider } from "./providers/mock.js";
import { OPENAI_COMPATIBLE_BASE_URLS, OpenAiCompatibleProvider } from "./providers/openai.js";
import type {
  Effort,
  LlmProvider,
  LlmRequest,
  LlmResult,
  StreamEvent,
  Usage,
  UsageSink,
} from "./types.js";
import { LlmError } from "./types.js";

/**
 * Converts a Zod schema to the strict JSON Schema dialect that structured
 * output modes accept: every object closed, every property required (model
 * optional fields as `.nullable()`, not `.optional()`).
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (
        k === "$schema" ||
        k === "minLength" ||
        k === "maxLength" ||
        k === "format" ||
        k === "pattern"
      )
        continue;
      obj[k] = visit(v);
    }
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      obj.additionalProperties = false;
      obj.required = Object.keys(obj.properties);
    }
    return obj;
  };
  return visit(raw) as Record<string, unknown>;
}

/** The JSON in a model's reply (bare, fenced, or embedded in prose). Used by `structured`. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error("no JSON found in model output");
  }
}

type Pool = "eval" | null;

/**
 * Which provider keys a workspace's calls use: "eval" sends OpenRouter calls of benchmark
 * accounts to OPENROUTER_API_KEY_EVAL, so a benchmark can never spend the production budget.
 */
export type KeyPool = (workspaceId: string) => Promise<Pool>;

/** A task's model on one account, and optionally its reasoning effort there. */
export interface AccountModel {
  model: string;
  effort?: Effort;
}

/** Models an account uses for some tasks instead of the configured ones (operator-set, see key-pool.ts). */
export type AccountModels = (
  workspaceId: string,
) => Promise<Partial<Record<LlmTask, AccountModel>> | null>;

export class LlmClient {
  private readonly providers = new Map<string, LlmProvider>();
  readonly prices: PriceBook;
  readonly mock: MockProvider;

  readonly openRouterCatalog: OpenRouterCatalog;
  private readonly keyPool: KeyPool | null;
  private readonly accountModels: AccountModels | null;

  constructor(
    private readonly config: Config,
    private readonly usage: UsageSink | null = null,
    opts: {
      openRouterCatalog?: OpenRouterCatalog;
      keyPool?: KeyPool;
      accountModels?: AccountModels;
    } = {},
  ) {
    this.openRouterCatalog = opts.openRouterCatalog ?? openRouterCatalog;
    this.keyPool = opts.keyPool ?? null;
    this.accountModels = opts.accountModels ?? null;
    this.prices = new PriceBook(config.pricingOverrides, (ref) => this.livePrice(ref));
    this.mock = new MockProvider();
    this.providers.set("mock", this.mock);
  }

  /**
   * Live OpenRouter list price for an "openrouter/..." model missing from the
   * table. Never blocks: a miss with a stale catalog starts a background
   * refresh (only when OpenRouter is actually configured).
   */
  private livePrice(ref: string) {
    if (!ref.startsWith("openrouter/") || this.config.openrouter?.livePrices === false)
      return undefined;
    const price = this.openRouterCatalog.price(ref);
    if (this.config.env.OPENROUTER_API_KEY) this.openRouterCatalog.refreshIfStale();
    return price;
  }

  /** Fetches live OpenRouter prices now (for cost estimates); resolves to the number of models priced. */
  refreshOpenRouterPrices(): Promise<number> {
    return this.openRouterCatalog.refresh();
  }

  /**
   * Cost of a call: what the provider reported (OpenRouter), else the list price of its tokens
   * (plus OpenRouter's fee on a BYOK call whose upstream charge was not reported).
   */
  cost(ref: string, result: Pick<LlmResult, "usage" | "costUsd" | "byokFeeUsd">): number | null {
    if (result.costUsd !== undefined) return result.costUsd;
    const list = this.prices.cost(ref, result.usage);
    return list === null ? null : list + (result.byokFeeUsd ?? 0);
  }

  /** Lazily builds the provider for a "provider/model" reference (per key pool for OpenRouter). */
  private provider(name: string, pool: Pool = null): LlmProvider {
    const eval_ =
      pool === "eval" && name === "openrouter" && !!this.config.env.OPENROUTER_API_KEY_EVAL;
    const cacheKey = eval_ ? `${name}#eval` : name;
    const existing = this.providers.get(cacheKey);
    if (existing) return existing;
    const env = this.config.env;
    let provider: LlmProvider;
    if (name === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) throw new LlmError("ANTHROPIC_API_KEY is not set", "config");
      provider = new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        baseURL: env.ANTHROPIC_BASE_URL,
      });
    } else {
      const keys: Record<string, string | undefined> = {
        openai: env.OPENAI_API_KEY,
        gemini: env.GEMINI_API_KEY,
        openrouter: eval_ ? env.OPENROUTER_API_KEY_EVAL : env.OPENROUTER_API_KEY,
        groq: env.GROQ_API_KEY,
        xai: env.XAI_API_KEY,
        deepseek: env.DEEPSEEK_API_KEY,
        together: env.TOGETHER_API_KEY,
        "together-dedicated": env.TOGETHER_API_KEY,
        fireworks: env.FIREWORKS_API_KEY,
        compat: env.RECALL_COMPAT_API_KEY ?? "not-needed",
      };
      const baseURL =
        name === "compat"
          ? env.RECALL_COMPAT_BASE_URL
          : name === "openai"
            ? (env.OPENAI_BASE_URL ?? OPENAI_COMPATIBLE_BASE_URLS.openai)
            : OPENAI_COMPATIBLE_BASE_URLS[name];
      const apiKey = keys[name];
      if (!baseURL) throw new LlmError(`unknown LLM provider "${name}"`, "config");
      if (!apiKey) throw new LlmError(`no API key configured for provider "${name}"`, "config");
      const openrouter = this.config.openrouter;
      provider = new OpenAiCompatibleProvider(name, {
        apiKey,
        baseURL,
        ...(name === "openrouter"
          ? {
              extraBody: (model: string, req: LlmRequest) =>
                openRouterBody(model, req, {
                  routing: openrouter?.routing ?? {},
                  hosted: this.config.tenancy?.hosted ?? false,
                  allowFree: openrouter?.allowFree ?? false,
                }),
            }
          : {}),
      });
    }
    this.providers.set(cacheKey, provider);
    return provider;
  }

  resolve(
    req: Pick<LlmRequest, "task" | "model">,
    pool: Pool = null,
  ): {
    provider: LlmProvider;
    model: string;
    ref: string;
  } {
    const ref = req.model ?? this.config.models[req.task as LlmTask];
    if (!ref) throw new LlmError(`no model configured for task "${req.task}"`, "config");
    const slash = ref.indexOf("/");
    if (slash < 0) throw new LlmError(`model "${ref}" must be "provider/model"`, "config");
    return { provider: this.provider(ref.slice(0, slash), pool), model: ref.slice(slash + 1), ref };
  }

  /**
   * The model a call runs on: the request's own, else the account's choice for the task (with its
   * effort, when it sets one), else the configured one. A failed account lookup changes nothing.
   */
  private async withModel<R extends Pick<LlmRequest, "task" | "model" | "workspaceId" | "effort">>(
    req: R,
  ): Promise<R> {
    if (req.model || !this.accountModels || !req.workspaceId) return req;
    const models = await this.accountModels(req.workspaceId).catch(() => null);
    const pick = models?.[req.task as LlmTask];
    if (!pick) return req;
    return { ...req, model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) };
  }

  /** The key pool of the workspace a call is for; a failed lookup falls back to the default keys. */
  private async pool(req: LlmRequest): Promise<Pool> {
    if (!this.keyPool || !req.workspaceId) return null;
    return this.keyPool(req.workspaceId).catch(() => null);
  }

  private meter(req: LlmRequest, ref: string, result: LlmResult): void {
    const costUsd = this.cost(ref, result);
    this.usage?.record({
      workspaceId: req.workspaceId ?? null,
      task: req.task,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      costUsd,
      costEstimated: costUsd !== null && result.costUsd === undefined,
      latencyMs: result.latencyMs,
      at: new Date(),
    });
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const req = await this.withModel(request);
    const { provider, model, ref } = this.resolve(req, await this.pool(req));
    const result = await provider.complete(model, req);
    this.meter(req, ref, result);
    return result;
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamEvent> {
    const req = await this.withModel(request);
    const { provider, model, ref } = this.resolve(req, await this.pool(req));
    for await (const event of provider.stream(model, req)) {
      if (event.type === "done") this.meter(req, ref, event.result);
      yield event;
    }
  }

  /**
   * Structured output: asks for JSON matching `schema`, validates it, and
   * makes one repair attempt with the validation errors before giving up.
   */
  async structured<T extends z.ZodType>(
    request: Omit<LlmRequest, "jsonSchema">,
    schema: T,
    schemaName: string,
  ): Promise<{ data: z.infer<T>; result: LlmResult; usage: Usage; costUsd: number | null }> {
    // Resolved once, so every attempt and the cost below use the same model.
    const req = await this.withModel(request);
    const jsonSchema = { name: schemaName, schema: strictJsonSchema(schema) };
    const ref = req.model ?? this.config.models[req.task as LlmTask] ?? "";
    let messages = req.messages;
    let lastError = "";
    const total: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let costUsd: number | null = 0;
    let maxTokens = req.maxTokens;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.complete({
        ...req,
        messages,
        jsonSchema,
        ...(maxTokens ? { maxTokens } : {}),
      });
      for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += result.usage[k];
      const cost = this.cost(ref, result);
      costUsd = costUsd === null || cost === null ? null : costUsd + cost;
      if (result.stopReason === "max_tokens" && attempt === 0) {
        // Cut off, not malformed: a model that reasons spends part of max_tokens thinking. A repair
        // turn would be cut off the same way, so ask again with room for the reasoning.
        maxTokens = (maxTokens ?? 8192) * 2 + 2048;
        lastError = "output cut off at max_tokens";
        continue;
      }
      try {
        const parsed = schema.safeParse(extractJson(result.text));
        if (parsed.success) return { data: parsed.data, result, usage: total, costUsd };
        lastError = z.prettifyError(parsed.error);
      } catch (err) {
        lastError = (err as Error).message;
      }
      messages = [
        ...messages,
        { role: "assistant", content: result.text },
        {
          role: "user",
          content: `That output was invalid:\n${lastError}\nReturn only corrected JSON.`,
        },
      ];
    }
    throw new LlmError(
      `structured output for ${schemaName} failed validation: ${lastError}`,
      "invalid_output",
    );
  }
}
