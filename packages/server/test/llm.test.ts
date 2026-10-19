import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { LlmClient, strictJsonSchema } from "../src/llm/client.js";
import { EmbeddingClient } from "../src/llm/embeddings.js";
import { PriceBook } from "../src/llm/pricing.js";
import type { UsageRecord } from "../src/llm/types.js";

const config = loadConfig({});

describe("config", () => {
  it("picks the cheapest configured model per task", () => {
    const c = loadConfig({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
    expect(c.models.reasoner).toBe("gemini/gemini-2.5-flash-lite");
    expect(c.models.chat_high).toBe("openai/gpt-6-luna");
  });
  it("runs everything through OpenRouter with only an OpenRouter key", () => {
    for (const env of [
      { OPENROUTER_API_KEY: "or" },
      { RECALL_DEFAULT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or" },
    ]) {
      const c = loadConfig(env);
      for (const model of Object.values(c.models))
        expect(model).toBe("openrouter/openai/gpt-6-luna");
      // No answer fallback unless the operator names one.
      expect(c.openrouter?.routing.chat_low).toBeUndefined();
      expect(c.embedding.model).toBe("openrouter/openai/text-embedding-3-small");
      const embeddings = new EmbeddingClient(c);
      expect(embeddings.provider.name).toBe("openrouter");
      expect(embeddings.provider.nativeDimensions).toBe(1536);
    }
    // A direct provider key still wins over the same model through OpenRouter.
    const both = loadConfig({ OPENAI_API_KEY: "o", OPENROUTER_API_KEY: "or" });
    expect(both.models.reasoner).toBe("openai/gpt-6-luna");
    expect(both.embedding.model).toBe("openai/text-embedding-3-small");
  });

  it("takes per-task models and an answer fallback from the environment", () => {
    const answer = "openrouter/vendor-a/answer-model";
    const c = loadConfig({
      OPENROUTER_API_KEY: "or",
      RECALL_MODEL_CHAT_LOW: answer,
      RECALL_MODEL_CHAT_HIGH: answer,
      RECALL_ANSWER_FALLBACK: "openai/gpt-6-luna",
    });
    expect(c.models.chat_low).toBe(answer);
    expect(c.models.reasoner).toBe("openrouter/openai/gpt-6-luna");
    expect(c.openrouter?.routing.chat_low?.fallbacks).toEqual(["openai/gpt-6-luna"]);
    expect(c.openrouter?.routing.chat_high?.fallbacks).toEqual(["openai/gpt-6-luna"]);
    // A task already on the fallback model gets no fallback to itself; memory tasks get none.
    expect(c.openrouter?.routing.chat_medium).toBeUndefined();
    expect(c.openrouter?.routing.reasoner).toBeUndefined();
  });

  it("keeps the operator's own routing for answers", () => {
    const c = loadConfig({
      OPENROUTER_API_KEY: "or",
      RECALL_MODEL_CHAT_LOW: "openrouter/vendor-a/answer-model",
      RECALL_MODEL_CHAT_HIGH: "openrouter/vendor-a/answer-model",
      RECALL_ANSWER_FALLBACK: "openai/gpt-6-luna",
      RECALL_OPENROUTER_ROUTING: JSON.stringify({ chat_low: { fallbacks: ["x/y"] } }),
    });
    expect(c.openrouter?.routing.chat_low?.fallbacks).toEqual(["x/y"]);
    expect(c.openrouter?.routing.chat_high?.fallbacks).toEqual(["openai/gpt-6-luna"]);
  });

  it("runs offline with no keys", () => {
    expect(config.models.reasoner).toBe("mock/default");
    expect(config.database.kind).toBe("pglite");
  });
});

describe("LlmClient", () => {
  it("validates structured output and repairs once", async () => {
    const records: UsageRecord[] = [];
    const llm = new LlmClient(config, { record: (r) => records.push(r) });
    let calls = 0;
    llm.mock.respondWith(() => (++calls === 1 ? { text: "not json" } : { json: { facts: ["a"] } }));
    const { data } = await llm.structured(
      { task: "reasoner", messages: [{ role: "user", content: "hi" }] },
      z.object({ facts: z.array(z.string()) }),
      "facts",
    );
    expect(data.facts).toEqual(["a"]);
    expect(calls).toBe(2);
    expect(records).toHaveLength(2);
    expect(records[0]!.costUsd).toBe(0);
  });

  it("asks again with more room when structured output is cut off at max_tokens", async () => {
    const llm = new LlmClient(config);
    const budgets: (number | undefined)[] = [];
    llm.mock.respondWith((req) => {
      budgets.push(req.maxTokens);
      // A reasoning model that spent the budget thinking: the JSON stops halfway.
      return budgets.length === 1
        ? { text: '{"facts": ["a", "b', stopReason: "max_tokens" }
        : { json: { facts: ["a", "b"] } };
    });
    const { data } = await llm.structured(
      { task: "reasoner", maxTokens: 1060, messages: [{ role: "user", content: "hi" }] },
      z.object({ facts: z.array(z.string()) }),
      "facts",
    );
    expect(data.facts).toEqual(["a", "b"]);
    // The retry is the same request with room for reasoning, not a repair turn.
    expect(budgets).toEqual([1060, 1060 * 2 + 2048]);
  });

  it("produces strict JSON schema", () => {
    const s = strictJsonSchema(z.object({ a: z.string(), b: z.number().nullable() }));
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["a", "b"]);
  });

  it("drops defaults and length limits, never a field named like them", () => {
    const s = strictJsonSchema(
      z.object({ list: z.array(z.string()).default([]), default: z.string().min(2) }),
    );
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(s.required).toEqual(["list", "default"]);
    expect(props.list).not.toHaveProperty("default");
    expect(props.default).toEqual({ type: "string" });
  });
});

describe("pricing", () => {
  it("meters cache reads and the long-context rate card", () => {
    const p = new PriceBook();
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(p.cost("anthropic/claude-haiku-5-5", { ...u, inputTokens: 50_000 })).toBeCloseTo(0.005);
    expect(p.cost("anthropic/claude-haiku-5-5", u)).toBeCloseTo(0.5);
    expect(p.cost("unknown/model", u)).toBeNull();
  });
});

describe("embeddings", () => {
  it("pads hash embeddings to the column size and ranks lexical overlap", async () => {
    const emb = new EmbeddingClient(config);
    const [a, b, c] = await emb.embed([
      "alice loves hiking",
      "hiking is what alice loves",
      "quarterly tax filing",
    ]);
    expect(a!.length).toBe(1536);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
  });
});
