import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { consoleOverview } from "../src/core/operator.js";
import { rows } from "../src/db/client.js";
import { LlmClient } from "../src/llm/client.js";
import { EmbeddingClient } from "../src/llm/embeddings.js";
import {
  OpenRouterCatalog,
  openRouterBody,
  parseOpenRouterModels,
  parseOpenRouterRouting,
} from "../src/llm/openrouter.js";
import type { UsageRecord } from "../src/llm/types.js";
import { createTestServer } from "./helpers.js";

/** Captures what the OpenAI SDK sends to OpenRouter and answers with one chat completion. */
function stubOpenRouter(content: string, usage: Record<string, unknown> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(
        JSON.stringify({
          id: "gen-1",
          object: "chat.completion",
          created: 0,
          model: "x",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, ...usage },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const HOSTED = {
  RECALL_HOSTED: "true",
  RECALL_AUTH_ENABLED: "true",
  RECALL_AUTH_SECRET: "test-secret-test-secret-test-secret",
  RECALL_ADMIN_TOKEN: "admin-token-admin-token-admin",
  RECALL_DATABASE_URL: "postgres://localhost/recall",
};
const ROUTING = JSON.stringify({
  default: { sort: "price", data_collection: "deny" },
  reasoner: {
    fallbacks: ["openai/gpt-oss-120b", "openrouter/qwen/qwen3.5-9b"],
    allow_fallbacks: true,
  },
  chat_low: { data_collection: "allow", sort: "latency" },
});
const req = (task = "reasoner") => ({
  task,
  system: "S",
  messages: [{ role: "user" as const, content: "hi" }],
  effort: "low" as const,
  maxTokens: 500,
});
const noCatalog = () =>
  new OpenRouterCatalog({ fetchImpl: vi.fn(async () => new Response("{}", { status: 500 })) });

describe("OpenRouter routing", () => {
  it("sends per-task fallbacks, provider preferences, usage accounting and reasoning effort", async () => {
    const calls = stubOpenRouter('{"ok":true}', { cost: 0.000321 });
    const config = loadConfig({
      OPENROUTER_API_KEY: "or-key",
      RECALL_MODEL_REASONER: "openrouter/google/gemma-4-26b-a4b-it:floor",
      RECALL_OPENROUTER_ROUTING: ROUTING,
    });
    const llm = new LlmClient(config, null, { openRouterCatalog: noCatalog() });
    await llm.structured(req(), z.object({ ok: z.boolean() }), "x");
    const body = calls[0]!.body;
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body.model).toBe("google/gemma-4-26b-a4b-it:floor"); // suffix passed through
    expect(body.models).toEqual([
      "google/gemma-4-26b-a4b-it:floor",
      "openai/gpt-oss-120b",
      "qwen/qwen3.5-9b",
    ]);
    expect(body.provider).toEqual({
      sort: "price",
      data_collection: "deny",
      allow_fallbacks: true,
    });
    expect(body.usage).toEqual({ include: true });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("merges the default route under each task's own", () => {
    const routing = parseOpenRouterRouting(ROUTING);
    const policy = { routing, hosted: false, allowFree: false };
    expect(openRouterBody("m", req("chat_low"), policy).provider).toEqual({
      sort: "latency",
      data_collection: "allow",
    });
    expect(openRouterBody("m", req("summary"), policy)).toMatchObject({
      provider: { sort: "price", data_collection: "deny" },
    });
    expect(openRouterBody("m", req("summary"), policy).models).toBeUndefined();
    expect(() => parseOpenRouterRouting('{"reasoner": {"sort": "cheapest"}}')).toThrow(/invalid/);
    expect(() => parseOpenRouterRouting('{"reasoner": {"fallback": []}}')).toThrow(/invalid/);
    expect(() => loadConfig({ RECALL_OPENROUTER_ROUTING: "not json" })).toThrow(/JSON object/);
  });
});

describe("hosted mode data policy", () => {
  it("always denies data collection, whatever the routing says", () => {
    const routing = parseOpenRouterRouting(ROUTING);
    const body = openRouterBody("m", req("chat_low"), { routing, hosted: true, allowFree: false });
    expect(body.provider).toMatchObject({ data_collection: "deny" });
    expect(
      openRouterBody("m", req("dream"), { routing: {}, hosted: true, allowFree: false }).provider,
    ).toEqual({
      data_collection: "deny",
    });
  });

  it("refuses :free models at startup and per request unless explicitly allowed", async () => {
    expect(() =>
      loadConfig({
        ...HOSTED,
        OPENROUTER_API_KEY: "k",
        RECALL_MODEL_REASONER: "openrouter/google/gemma-4-31b-it:free",
      }),
    ).toThrow(/refuses free OpenRouter models/);
    expect(() =>
      loadConfig({
        ...HOSTED,
        RECALL_OPENROUTER_ROUTING: JSON.stringify({
          reasoner: { fallbacks: ["google/gemma-4-31b-it:free"] },
        }),
      }),
    ).toThrow(/gemma-4-31b-it:free/);
    expect(
      loadConfig({
        ...HOSTED,
        RECALL_OPENROUTER_ALLOW_FREE: "true",
        RECALL_MODEL_REASONER: "openrouter/google/gemma-4-31b-it:free",
      }).openrouter.allowFree,
    ).toBe(true);
    // A model passed on the request (not in the config) is checked when the call is made.
    const calls = stubOpenRouter("{}");
    const llm = new LlmClient(loadConfig({ ...HOSTED, OPENROUTER_API_KEY: "k" }), null, {
      openRouterCatalog: noCatalog(),
    });
    await expect(
      llm.complete({ ...req(), model: "openrouter/google/gemma-4-31b-it:free" }),
    ).rejects.toMatchObject({
      kind: "config",
    });
    expect(calls).toHaveLength(0);
    // Self-hosted (not multi-tenant): free models are the operator's call.
    const dev = new LlmClient(loadConfig({ OPENROUTER_API_KEY: "k" }), null, {
      openRouterCatalog: noCatalog(),
    });
    await dev.complete({ ...req(), model: "openrouter/google/gemma-4-31b-it:free" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.provider).toBeUndefined();
  });
});

describe("metering", () => {
  it("records the cost OpenRouter reports, falling back to the price table", async () => {
    const records: UsageRecord[] = [];
    const sink = { record: (r: UsageRecord) => records.push(r) };
    const config = loadConfig({ OPENROUTER_API_KEY: "k" });
    let calls = stubOpenRouter('{"ok":true}', { cost: 0.0042 });
    const llm = new LlmClient(config, sink, { openRouterCatalog: noCatalog() });
    const r = await llm.structured(
      { ...req(), model: "openrouter/openai/gpt-oss-120b" },
      z.object({ ok: z.boolean() }),
      "x",
    );
    expect(records[0]!.costUsd).toBe(0.0042);
    expect(r.costUsd).toBe(0.0042);
    expect(r.result.costUsd).toBe(0.0042);

    calls = stubOpenRouter('{"ok":true}'); // no cost in the response
    const llm2 = new LlmClient(config, sink, { openRouterCatalog: noCatalog() });
    await llm2.complete({ ...req(), model: "openrouter/openai/gpt-oss-120b" });
    expect(records[1]!.costUsd).toBeCloseTo((1000 * 0.037 + 100 * 0.17) / 1e6, 12);
    expect(calls).toHaveLength(1);

    // Other providers' "cost" fields are not trusted.
    stubOpenRouter("{}", { cost: 99 });
    const together = new LlmClient(loadConfig({ TOGETHER_API_KEY: "t" }), sink);
    await together.complete({ ...req(), model: "together/Qwen/Qwen3.5-9B" });
    expect(records[2]!.costUsd).toBeCloseTo((1000 * 0.17 + 100 * 0.25) / 1e6, 12);
    // Reported costs are exact; list prices are marked as estimates.
    expect(records.map((r) => r.costEstimated)).toEqual([false, true, true]);
  });

  describe("calls on the operator's own provider key (BYOK)", () => {
    const model = "openrouter/openai/gpt-oss-120b"; // $0.037 in, $0.17 out in the price table
    const list = (1000 * 0.037 + 100 * 0.17) / 1e6;
    const meter = async (usage: Record<string, unknown>, ref = model) => {
      const records: UsageRecord[] = [];
      stubOpenRouter("{}", usage);
      const llm = new LlmClient(
        loadConfig({ OPENROUTER_API_KEY: "k" }),
        { record: (r: UsageRecord) => records.push(r) },
        { openRouterCatalog: noCatalog() },
      );
      const result = await llm.complete({ ...req(), model: ref });
      expect(records).toHaveLength(1);
      return { record: records[0]!, cost: llm.cost(ref, result) };
    };

    it("records OpenRouter's fee plus what the upstream provider charged the key", async () => {
      const { record } = await meter({
        cost: 0.00001,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0002 },
      });
      expect(record.costUsd).toBeCloseTo(0.00021, 12);
      expect(record.costEstimated).toBe(false);
      // Responses without `is_byok` still carry the upstream charge.
      const older = await meter({ cost: 0, cost_details: { upstream_inference_cost: 0.0003 } });
      expect(older.record.costUsd).toBeCloseTo(0.0003, 12);
      expect(older.record.costEstimated).toBe(false);
    });

    it("estimates the call at list price when the upstream charge is missing", async () => {
      for (const usage of [
        { cost: 0, is_byok: true },
        { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0 } },
        // No BYOK flag, but OpenRouter charged nothing for tokens of a paid model.
        { cost: 0, cost_details: { upstream_inference_cost: null } },
      ]) {
        const { record, cost } = await meter(usage);
        expect(record.costUsd, JSON.stringify(usage)).toBeCloseTo(list, 12);
        expect(record.costEstimated, JSON.stringify(usage)).toBe(true);
        expect(cost).toBeCloseTo(list, 12);
      }
      // OpenRouter's own BYOK fee is kept on top of the estimate.
      const fee = await meter({ cost: 0.000002, is_byok: true });
      expect(fee.record.costUsd).toBeCloseTo(list + 0.000002, 12);
      // A model with no known price stays unpriced rather than free.
      const unknown = await meter({ cost: 0, is_byok: true }, "openrouter/acme/unlisted-1b");
      expect(unknown.record.costUsd).toBeNull();
      expect(unknown.record.costEstimated).toBe(false);
    });

    it("prices cache reads and writes in the estimate, from the live catalog too", async () => {
      const catalog = new OpenRouterCatalog({
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "acme/cached-1",
                    pricing: {
                      prompt: "0.000001",
                      completion: "0.000002",
                      input_cache_read: "0.0000001",
                      input_cache_write: "0.0000015",
                    },
                  },
                ],
              }),
            ),
        ) as unknown as typeof fetch,
      });
      await catalog.refresh();
      const records: UsageRecord[] = [];
      stubOpenRouter("{}", {
        cost: 0,
        is_byok: true,
        prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 },
      });
      const llm = new LlmClient(
        loadConfig({ OPENROUTER_API_KEY: "k" }),
        { record: (r: UsageRecord) => records.push(r) },
        { openRouterCatalog: catalog },
      );
      await llm.complete({ ...req(), model: "openrouter/acme/cached-1" });
      expect(records[0]!.usage).toMatchObject({
        inputTokens: 400,
        cacheReadTokens: 400,
        cacheWriteTokens: 200,
        outputTokens: 100,
      });
      // 400 in at $1, 400 read at $0.10, 200 written at $1.50, 100 out at $2 (per 1M).
      expect(records[0]!.costUsd).toBeCloseTo((400 + 40 + 300 + 200) / 1e6, 12);
      expect(records[0]!.costEstimated).toBe(true);
    });

    it("stores the estimate flag with the usage row", async () => {
      const s = await createTestServer();
      try {
        const base = {
          workspaceId: null,
          task: "chat_low",
          provider: "openrouter",
          model: "openai/gpt-oss-120b",
          usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          latencyMs: 1,
          at: new Date(),
        };
        s.ctx.usage.record({ ...base, costUsd: 0.002, costEstimated: true });
        s.ctx.usage.record({ ...base, costUsd: 0.001, costEstimated: false });
        await s.ctx.usage.flush();
        const stored = await rows<{ cost_usd: number; cost_estimated: boolean | null }>(
          s.ctx.db,
          sql`SELECT cost_usd, cost_estimated FROM llm_usage ORDER BY id`,
        );
        expect(stored.map((r) => [Number(r.cost_usd), r.cost_estimated])).toEqual([
          [0.002, true],
          [0.001, false],
        ]);
        // The operator console shows how much of the provider cost is estimated.
        const overview = await consoleOverview(s.ctx.db, { welcomeCapMicros: 0 });
        expect(overview.windows.map((w) => [w.costAllMicros, w.costEstimatedMicros])).toEqual([
          [3000, 2000],
          [3000, 2000],
        ]);
      } finally {
        await s.close();
      }
    });

    it("leaves calls OpenRouter paid for alone, free models included", async () => {
      const paid = await meter({
        cost: 0.0042,
        is_byok: false,
        cost_details: { upstream_inference_cost: null },
      });
      expect(paid.record.costUsd).toBe(0.0042);
      expect(paid.record.costEstimated).toBe(false);
      const zero = await meter({ cost: 0, is_byok: false });
      expect(zero.record.costUsd).toBe(0);
      const free = await meter({ cost: 0 }, "openrouter/acme/tiny-7b:free");
      expect(free.record.costUsd).toBe(0);
      expect(free.record.costEstimated).toBe(false);
    });
  });
});

describe("live prices", () => {
  const MODELS = {
    data: [
      {
        id: "acme/tiny-7b",
        pricing: {
          prompt: "0.00000002",
          completion: "0.00000009",
          input_cache_read: "0.00000001",
          input_cache_write: "0.00000003",
        },
      },
      { id: "acme/tiny-7b:free", pricing: { prompt: "0", completion: "0" } },
      { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
      { id: "openai/gpt-oss-120b", pricing: { prompt: "0.000009", completion: "0.000009" } },
    ],
  };

  it("parses per-token string prices into USD per 1M tokens", () => {
    const prices = parseOpenRouterModels(MODELS);
    expect(prices.get("acme/tiny-7b")).toEqual({
      input: 0.02,
      output: 0.09,
      cacheRead: 0.01,
      cacheWrite: 0.03,
    });
    expect(prices.get("acme/tiny-7b:free")).toEqual({ input: 0, output: 0 });
    expect(prices.has("openrouter/auto")).toBe(false);
    expect(parseOpenRouterModels({ nope: 1 }).size).toBe(0);
  });

  it("caches the catalog, survives failures and prices routing suffixes as the base model", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(MODELS), { status: 200 }));
    const catalog = new OpenRouterCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(catalog.price("acme/tiny-7b")).toBeUndefined();
    const [a, b] = await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(a).toBe(3);
    expect(b).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // concurrent refreshes share one request
    expect(catalog.price("openrouter/acme/tiny-7b:floor")).toMatchObject({ input: 0.02 });
    const errors: unknown[] = [];
    const broken = new OpenRouterCatalog({
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      onError: (e) => errors.push(e),
    });
    await expect(broken.refresh()).resolves.toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("prices models missing from the table; the table wins; startup never fetches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(MODELS), { status: 200 }));
    const catalog = new OpenRouterCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const config = loadConfig({
      OPENROUTER_API_KEY: "k",
      RECALL_MODEL_REASONER: "openrouter/acme/tiny-7b",
    });
    const llm = new LlmClient(config, null, { openRouterCatalog: catalog });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    const u = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    // A miss returns null at once and starts a background refresh.
    expect(llm.prices.cost("openrouter/acme/tiny-7b", u)).toBeNull();
    await vi.waitFor(() => expect(catalog.size).toBe(3));
    expect(llm.prices.cost("openrouter/acme/tiny-7b", u)).toBeCloseTo(0.11);
    // The static table (here gpt-oss-120b at $0.037/$0.17) overrides the live price.
    expect(llm.prices.cost("openrouter/openai/gpt-oss-120b", u)).toBeCloseTo(0.207);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Without an OpenRouter key nothing is fetched, and RECALL_OPENROUTER_LIVE_PRICES=false turns it off.
    const quiet = new OpenRouterCatalog({ fetchImpl: fetchImpl as unknown as typeof fetch });
    new LlmClient(loadConfig({}), null, { openRouterCatalog: quiet }).prices.cost(
      "openrouter/acme/tiny-7b",
      u,
    );
    const off = new LlmClient(
      loadConfig({ OPENROUTER_API_KEY: "k", RECALL_OPENROUTER_LIVE_PRICES: "false" }),
      null,
      {
        openRouterCatalog: catalog,
      },
    );
    expect(off.prices.cost("openrouter/acme/tiny-7b", u)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("OpenRouter embeddings", () => {
  const stubEmbeddings = () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0.01) }],
            model: "openai/text-embedding-3-small",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    return calls;
  };
  const env = {
    OPENROUTER_API_KEY: "k",
    RECALL_EMBEDDING_MODEL: "openrouter/openai/text-embedding-3-small",
  };

  it("deny data collection on the hosted service, as chat calls do", async () => {
    const calls = stubEmbeddings();
    await new EmbeddingClient(loadConfig({ ...HOSTED, ...env })).embed(["hello"]);
    expect(calls.at(-1)).toMatchObject({ provider: { data_collection: "deny" } });
  });

  it("leave provider preferences alone when self-hosted", async () => {
    const calls = stubEmbeddings();
    await new EmbeddingClient(loadConfig({ ...env, RECALL_DATA_DIR: "memory" })).embed(["hello"]);
    expect(calls.at(-1)).not.toHaveProperty("provider");
  });
});
