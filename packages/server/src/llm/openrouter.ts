import { z } from "zod";
import type { Price } from "./pricing.js";
import { LlmError, type LlmRequest } from "./types.js";

/**
 * OpenRouter as a first-class route for cheap, swappable models
 * ("openrouter/<vendor>/<model>"): per-task fallbacks and provider
 * preferences, data-policy rules for hosted mode, and live list prices.
 * Request fields as documented at openrouter.ai/docs (Oct 2026).
 */

/** Routing for one task; every field is optional and maps onto OpenRouter's request body. */
export const OpenRouterRoute = z
  .object({
    /** Models tried after the configured one (OpenRouter's top-level `models` array). */
    fallbacks: z.array(z.string().min(1)).optional(),
    /** Provider ordering: "price" picks the cheapest endpoint (the ":floor" suffix does the same). */
    sort: z.enum(["price", "throughput", "latency"]).optional(),
    allow_fallbacks: z.boolean().optional(),
    /** "deny": only providers that do not store or train on prompts. Forced in hosted mode. */
    data_collection: z.enum(["allow", "deny"]).optional(),
    /** Only zero-data-retention endpoints. */
    zdr: z.boolean().optional(),
    order: z.array(z.string()).optional(),
    only: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    require_parameters: z.boolean().optional(),
    /** USD per 1M tokens. */
    max_price: z
      .object({ prompt: z.number().optional(), completion: z.number().optional() })
      .optional(),
  })
  .strict();
export type OpenRouterRoute = z.infer<typeof OpenRouterRoute>;

/** `RECALL_OPENROUTER_ROUTING`: {"default": {...}, "reasoner": {...}, "chat_low": {...}}. */
export type OpenRouterRouting = Record<string, OpenRouterRoute>;

export function parseOpenRouterRouting(raw: string | undefined): OpenRouterRouting {
  if (!raw?.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("RECALL_OPENROUTER_ROUTING must be a JSON object");
  }
  const r = z.record(z.string(), OpenRouterRoute).safeParse(json);
  if (!r.success) {
    throw new Error(`RECALL_OPENROUTER_ROUTING is invalid: ${z.prettifyError(r.error)}`);
  }
  return r.data;
}

/** The task's routing on top of the "default" entry. */
export function routeFor(routing: OpenRouterRouting, task: string): OpenRouterRoute {
  return { ...(routing.default ?? {}), ...(routing[task] ?? {}) };
}

/** "openrouter/x/y" or "x/y" -> "x/y". */
export const openRouterId = (ref: string): string =>
  ref.startsWith("openrouter/") ? ref.slice("openrouter/".length) : ref;

/** Free variants may be served by providers that log prompts or train on them. */
export const isFreeModel = (id: string): boolean => /:free$/.test(id.trim());

export interface OpenRouterPolicy {
  routing: OpenRouterRouting;
  /** Hosted (multi-tenant) mode: customer data must never reach a provider that collects it. */
  hosted: boolean;
  /** Explicit override that allows ":free" models in hosted mode. */
  allowFree: boolean;
}

/** Models a configuration would send to OpenRouter that are free variants. */
export function freeModelsIn(models: string[], routing: OpenRouterRouting): string[] {
  const refs = [
    ...models.filter((m) => m.startsWith("openrouter/")).map(openRouterId),
    ...Object.values(routing)
      .flatMap((r) => r.fallbacks ?? [])
      .map(openRouterId),
  ];
  return [...new Set(refs.filter(isFreeModel))];
}

/**
 * Extra request-body fields for an OpenRouter chat completion: fallbacks,
 * provider preferences, usage accounting and reasoning effort. Throws a
 * configuration error for ":free" models in hosted mode unless allowed.
 */
export function openRouterBody(
  model: string,
  req: LlmRequest,
  policy: OpenRouterPolicy,
): Record<string, unknown> {
  const route = routeFor(policy.routing, req.task);
  const fallbacks = (route.fallbacks ?? []).map(openRouterId).filter((m) => m !== model);
  if (policy.hosted && !policy.allowFree) {
    const free = [model, ...fallbacks].filter(isFreeModel);
    if (free.length) {
      throw new LlmError(
        `${free.join(", ")}: free OpenRouter models may log or train on prompts and are refused in hosted mode (set RECALL_OPENROUTER_ALLOW_FREE=true to override)`,
        "config",
      );
    }
  }
  const provider: Record<string, unknown> = {};
  for (const k of [
    "sort",
    "allow_fallbacks",
    "data_collection",
    "zdr",
    "order",
    "only",
    "ignore",
    "require_parameters",
    "max_price",
  ] as const) {
    if (route[k] !== undefined) provider[k] = route[k];
  }
  if (policy.hosted) provider.data_collection = "deny";
  const involvesTools =
    !!req.tools?.length ||
    req.messages.some((m) => m.role === "tool" || (m.role === "assistant" && m.toolCalls?.length));
  return {
    ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
    ...(Object.keys(provider).length ? { provider } : {}),
    // Cost is reported in every response now; the flag is kept for older deployments.
    usage: { include: true },
    // Reasoning models otherwise think at their default effort, which can exhaust a small max_tokens.
    ...(req.effort && !involvesTools ? { reasoning: { effort: req.effort } } : {}),
  };
}

/** What OpenRouter's `usage` says about a call's cost (USD). */
export interface OpenRouterCost {
  /**
   * The call's whole cost, when the response says it: what OpenRouter charged, plus on a BYOK call
   * (the operator's own provider key) what the upstream provider charged that key.
   */
  costUsd?: number;
  /**
   * A BYOK call whose upstream charge is missing: what OpenRouter charged (its BYOK fee, often 0).
   * The call's tokens are priced at list price on top of it.
   */
  byokFeeUsd?: number;
}

/**
 * The cost of one OpenRouter call from its `usage` object. OpenRouter's `cost` is what it charged
 * the account; on a BYOK call that is at most a fee, and the inference itself is billed to the
 * operator's provider key and reported as `cost_details.upstream_inference_cost` (0 or null on
 * other calls). A BYOK call is recognised by `is_byok`, or, in responses without that field, by a
 * cost of 0 for tokens of a model that is not free. Without the upstream charge such a call is
 * left to the list price (`byokFeeUsd`), so it is never recorded as free.
 */
export function openRouterCost(
  usage: unknown,
  call: { tokens: number; free: boolean },
): OpenRouterCost {
  const u = (usage ?? {}) as {
    cost?: unknown;
    is_byok?: unknown;
    cost_details?: { upstream_inference_cost?: unknown } | null;
  };
  const usd = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const cost = usd(u.cost);
  const upstream = usd(u.cost_details?.upstream_inference_cost);
  const own = cost === undefined ? {} : { costUsd: cost };
  if (u.is_byok === false) return own;
  if (upstream) return { costUsd: (cost ?? 0) + upstream };
  const byok = u.is_byok === true || (cost === 0 && call.tokens > 0 && !call.free);
  return byok ? { byokFeeUsd: cost ?? 0 } : own;
}

/** OpenRouter's /models entry, the fields used here. Prices are USD per token, as strings. */
interface ModelsEntry {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

/** Prices (USD per 1M tokens) keyed by OpenRouter model id. */
export function parseOpenRouterModels(json: unknown): Map<string, Price> {
  const out = new Map<string, Price>();
  const data = (json as { data?: ModelsEntry[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  const perM = (v: string | undefined) => {
    const n = v === undefined || v === "" ? Number.NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
  };
  for (const m of data) {
    if (typeof m?.id !== "string") continue;
    const input = perM(m.pricing?.prompt);
    const output = perM(m.pricing?.completion);
    if (input === null || output === null) continue; // e.g. "-1" for router models
    const cacheRead = perM(m.pricing?.input_cache_read);
    const cacheWrite = perM(m.pricing?.input_cache_write);
    out.set(m.id, {
      input,
      output,
      ...(cacheRead !== null ? { cacheRead } : {}),
      ...(cacheWrite !== null ? { cacheWrite } : {}),
    });
  }
  return out;
}

/**
 * Live OpenRouter list prices from the public /models endpoint (no key),
 * cached in-process. Lookups are synchronous and never wait for the network;
 * a miss can trigger a background refresh. Nothing at startup depends on it.
 */
export class OpenRouterCatalog {
  private prices = new Map<string, Price>();
  private fetchedAt = 0;
  private lastAttempt = 0;
  private inflight: Promise<number> | null = null;

  constructor(
    private readonly opts: {
      url?: string;
      ttlMs?: number;
      timeoutMs?: number;
      /** Minimum time between attempts after a failure. */
      retryMs?: number;
      fetchImpl?: typeof fetch;
      onError?: (err: unknown) => void;
    } = {},
  ) {}

  get size(): number {
    return this.prices.size;
  }

  get stale(): boolean {
    return Date.now() - this.fetchedAt > (this.opts.ttlMs ?? 6 * 3_600_000);
  }

  /** Price of "x/y", "x/y:floor" or "x/y:nitro" (routing suffixes price as the base model). */
  price(id: string): Price | undefined {
    const plain = openRouterId(id);
    return this.prices.get(plain) ?? this.prices.get(plain.replace(/:(floor|nitro)$/, ""));
  }

  /** Fetches the catalog; resolves to the number of priced models (0 on failure). Never throws. */
  refresh(): Promise<number> {
    if (this.inflight) return this.inflight;
    this.lastAttempt = Date.now();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    this.inflight = (async () => {
      try {
        const res = await fetchImpl(this.opts.url ?? "https://openrouter.ai/api/v1/models", {
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
        const prices = parseOpenRouterModels(await res.json());
        if (!prices.size) throw new Error("OpenRouter /models had no priced models");
        this.prices = prices;
        this.fetchedAt = Date.now();
        return prices.size;
      } catch (err) {
        this.opts.onError?.(err);
        return 0;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Starts a background refresh when stale (and not retried too recently). */
  refreshIfStale(): void {
    if (!this.stale || this.inflight) return;
    if (Date.now() - this.lastAttempt < (this.opts.retryMs ?? 600_000)) return;
    void this.refresh();
  }
}

/** Process-wide catalog shared by every LlmClient. */
export const openRouterCatalog = new OpenRouterCatalog();
