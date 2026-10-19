import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { LlmClient } from "../src/llm/client.js";
import { PriceBook } from "../src/llm/pricing.js";
import { anthropicParams } from "../src/llm/providers/anthropic.js";
import {
  chatParams,
  OPENAI_COMPATIBLE_BASE_URLS,
  toOpenAiMessages,
} from "../src/llm/providers/openai.js";
import type { UsageRecord } from "../src/llm/types.js";

/** Captures what the OpenAI SDK sends; answers with one canned chat completion. No network. */
function stubChatCompletions(content: string) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "x",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  // The SDK picks up the global fetch when a provider is first built.
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = {
  task: "reasoner",
  system: "SYSTEM PROMPT",
  context: "KNOWN FACTS\nalice:\n(none)",
  messages: [{ role: "user" as const, content: "TRANSCRIPT\n[m1] alice 2026-01-01T10:00Z: hi" }],
  maxTokens: 300,
  effort: "low" as const,
};
const Out = z.object({ facts: z.array(z.string()) });

describe("open-weight providers", () => {
  it("has base URLs for Together (serverless and dedicated) and Fireworks", () => {
    expect(OPENAI_COMPATIBLE_BASE_URLS.together).toBe("https://api.together.ai/v1");
    expect(OPENAI_COMPATIBLE_BASE_URLS["together-dedicated"]).toBe(
      "https://api-inference.together.ai/v1",
    );
    expect(OPENAI_COMPATIBLE_BASE_URLS.fireworks).toBe("https://api.fireworks.ai/inference/v1");
  });

  it("routes a Together model for the reasoner task with one system message", async () => {
    const calls = stubChatCompletions('{"facts":["alice says hi"]}');
    const records: UsageRecord[] = [];
    const config = loadConfig({
      TOGETHER_API_KEY: "tg-test-key",
      RECALL_MODEL_REASONER: "together/Qwen/Qwen3.5-9B",
    });
    const llm = new LlmClient(config, { record: (r) => records.push(r) });
    const { data } = await llm.structured(request, Out, "facts");

    expect(data.facts).toEqual(["alice says hi"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://api.together.ai/v1/chat/completions");
    expect(call!.headers.get("authorization")).toBe("Bearer tg-test-key");
    expect(call!.body.model).toBe("Qwen/Qwen3.5-9B");
    expect(call!.body.max_tokens).toBe(300);
    expect(call!.body.max_completion_tokens).toBeUndefined();
    expect(call!.body.reasoning_effort).toBeUndefined();
    expect(call!.body.messages).toEqual([
      { role: "system", content: "SYSTEM PROMPT\n\nKNOWN FACTS\nalice:\n(none)" },
      { role: "user", content: request.messages[0]!.content },
    ]);
    expect((call!.body.response_format as { type: string }).type).toBe("json_schema");
    // Metered at the Together list price: 1000 x $0.17 + 200 x $0.25 per 1M.
    expect(records[0]!.costUsd).toBeCloseTo((1000 * 0.17 + 200 * 0.25) / 1e6, 10);
  });

  it("serves a fine-tuned model from a Together dedicated endpoint", async () => {
    const calls = stubChatCompletions('{"facts":[]}');
    const config = loadConfig({
      TOGETHER_API_KEY: "tg-test-key",
      RECALL_MODEL_REASONER: "together-dedicated/acme/recall-reasoner-v1",
    });
    const llm = new LlmClient(config);
    await llm.structured(request, Out, "facts");
    expect(calls[0]!.url).toBe("https://api-inference.together.ai/v1/chat/completions");
    expect(calls[0]!.body.model).toBe("acme/recall-reasoner-v1");
    expect(
      llm.prices.cost("together-dedicated/acme/recall-reasoner-v1", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it("routes a Fireworks model by its full resource name", async () => {
    const calls = stubChatCompletions('{"facts":[]}');
    const config = loadConfig({
      FIREWORKS_API_KEY: "fw-test-key",
      RECALL_MODEL_REASONER: "fireworks/accounts/acme/models/recall-reasoner-v1",
    });
    const llm = new LlmClient(config);
    await llm.structured(request, Out, "facts");
    expect(calls[0]!.url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer fw-test-key");
    expect(calls[0]!.body.model).toBe("accounts/acme/models/recall-reasoner-v1");
    expect((calls[0]!.body.messages as unknown[]).length).toBe(2);
  });

  it("fails with a configuration error when the key is missing", async () => {
    const llm = new LlmClient(loadConfig({ RECALL_MODEL_REASONER: "together/Qwen/Qwen3.5-9B" }));
    await expect(llm.complete(request)).rejects.toMatchObject({ kind: "config" });
  });

  it("keeps separate system and context messages for OpenAI", () => {
    expect(toOpenAiMessages(request).map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(toOpenAiMessages(request, "together").map((m) => m.role)).toEqual(["system", "user"]);
    expect(toOpenAiMessages({ ...request, context: undefined }, "fireworks")[0]).toEqual({
      role: "system",
      content: "SYSTEM PROMPT",
    });
  });
});

describe("pricing entries", () => {
  it("prices the OpenAI reference models and the open-weight teacher", () => {
    const p = new PriceBook();
    // 100k in + 100k out, under the 272K-token long-context threshold.
    const u = {
      inputTokens: 100_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(p.cost("openai/gpt-6-sol", u)).toBeCloseTo(1.2);
    expect(p.cost("openai/gpt-5.5", u)).toBeCloseTo(3.5);
    expect(p.cost("openai/gpt-6-sol", { ...u, inputTokens: 300_000 })).toBeCloseTo(2.7);
    expect(p.cost("together/deepseek-ai/DeepSeek-V4-Pro-0813", u)).toBeCloseTo(0.528);
    expect(p.cost("together/deepseek-ai/DeepSeek-V4-Flash-0731", u)).toBeCloseTo(0.042);
    expect(p.cost("fireworks/accounts/fireworks/models/qwen3p5-9b", u)).toBeCloseTo(0.04);
  });
});

describe("benchmark key pool", () => {
  const evalRequest = (workspaceId: string) => ({ ...request, workspaceId });
  const auth = (calls: { headers: Headers }[], i: number) => calls[i]!.headers.get("authorization");

  it("sends OpenRouter calls of eval workspaces with the eval key, everything else with the main key", async () => {
    const calls = stubChatCompletions('{"facts":[]}');
    const config = loadConfig({
      OPENROUTER_API_KEY: "or-main",
      OPENROUTER_API_KEY_EVAL: "or-eval",
      RECALL_MODEL_REASONER: "openrouter/openai/gpt-6-luna",
    });
    const llm = new LlmClient(config, null, {
      keyPool: async (ws) => {
        if (ws === "broken") throw new Error("db down");
        return ws === "bench" ? "eval" : null;
      },
    });
    await llm.complete(evalRequest("bench"));
    await llm.complete(evalRequest("customer"));
    await llm.complete(evalRequest("broken"));
    await llm.complete(request);
    expect([0, 1, 2, 3].map((i) => auth(calls, i))).toEqual([
      "Bearer or-eval",
      "Bearer or-main",
      "Bearer or-main",
      "Bearer or-main",
    ]);
  });

  it("keeps the main key when no eval key is configured", async () => {
    const calls = stubChatCompletions('{"facts":[]}');
    const config = loadConfig({
      OPENROUTER_API_KEY: "or-main",
      RECALL_MODEL_REASONER: "openrouter/openai/gpt-6-luna",
    });
    const llm = new LlmClient(config, null, { keyPool: async () => "eval" });
    await llm.complete(evalRequest("bench"));
    expect(auth(calls, 0)).toBe("Bearer or-main");
  });
});

describe("account models", () => {
  const DS = "openrouter/deepseek/deepseek-v4-flash";
  const config = () =>
    loadConfig({
      OPENROUTER_API_KEY: "or-main",
      RECALL_MODEL_REASONER: "openrouter/openai/gpt-6-luna",
      RECALL_PRICING_JSON: JSON.stringify({ [DS]: { input: 1, output: 1 } }),
    });
  const accountModels = async (ws: string) => {
    if (ws === "broken") throw new Error("db down");
    if (ws === "no-think") return { reasoner: { model: DS, effort: "none" as const } };
    return ws === "bench" ? { reasoner: { model: DS } } : null;
  };

  it("runs a task on the account's model; otherwise, or when the lookup fails, on the configured one", async () => {
    const calls = stubChatCompletions('{"facts":[]}');
    const llm = new LlmClient(config(), null, { accountModels });
    await llm.complete({ ...request, workspaceId: "bench" });
    await llm.complete({ ...request, workspaceId: "customer" });
    await llm.complete({ ...request, workspaceId: "broken" });
    await llm.complete({ ...request, workspaceId: "bench", model: "openrouter/openai/gpt-6-luna" });
    await llm.complete({ ...request, task: "summary", workspaceId: "bench" });
    expect(calls.map((c) => c.body.model)).toEqual([
      "deepseek/deepseek-v4-flash",
      "openai/gpt-6-luna",
      "openai/gpt-6-luna",
      "openai/gpt-6-luna",
      expect.not.stringContaining("deepseek"),
    ]);
  });

  it("sets the account's effort for the task: none turns DeepSeek's reasoning off on OpenRouter", async () => {
    const calls = stubChatCompletions('{"facts":[]}');
    const llm = new LlmClient(config(), null, { accountModels });
    await llm.complete({ ...request, workspaceId: "no-think" });
    await llm.complete({ ...request, workspaceId: "bench" });
    expect(calls.map((c) => [c.body.model, c.body.reasoning])).toEqual([
      ["deepseek/deepseek-v4-flash", { effort: "none" }],
      ["deepseek/deepseek-v4-flash", { effort: "low" }],
    ]);
  });

  it("prices structured output at the account's model", async () => {
    stubChatCompletions('{"facts":["a"]}');
    const llm = new LlmClient(config(), null, { accountModels });
    const bench = await llm.structured({ ...request, workspaceId: "bench" }, Out, "facts");
    const customer = await llm.structured({ ...request, workspaceId: "customer" }, Out, "facts");
    // 1,000 tokens in and 200 out: $1/M both ways for the account's model, gpt-6-luna's list price otherwise.
    expect(bench.costUsd).toBeCloseTo(0.0012);
    expect(customer.costUsd).toBeCloseTo(0.0002);
  });
});

describe("temperature", () => {
  it("goes on the wire only when a caller sets it", () => {
    const body = (req: typeof request & { temperature?: number }) =>
      chatParams("openrouter", "openai/gpt-4o-2024-08-06", req) as unknown as Record<
        string,
        unknown
      >;
    expect(body({ ...request, temperature: 0 }).temperature).toBe(0);
    expect("temperature" in body(request)).toBe(false);
  });
});

describe("effort none", () => {
  const none = { ...request, effort: "none" as const };
  it("is sent to OpenAI models that take it and left out where it would be rejected", () => {
    const effort = (model: string) =>
      (chatParams("openai", model, none) as unknown as Record<string, unknown>).reasoning_effort;
    expect(effort("gpt-6-luna")).toBe("none");
    expect(effort("gpt-5")).toBeUndefined();
    const claude = anthropicParams("claude-fable-5-1", none) as unknown as {
      output_config?: { effort?: string };
    };
    expect(claude.output_config?.effort).toBeUndefined();
  });
});

describe("thinking", () => {
  type Body = { max_tokens: number; thinking?: { type: string } };
  const body = (model: string, thinking?: boolean) =>
    anthropicParams(model, { ...request, maxTokens: 1000, thinking }) as unknown as Body;

  it("lets Claude think adaptively, with room for it, only when asked", () => {
    expect(body("claude-fable-5-1", true)).toMatchObject({
      max_tokens: 1000 + 8192,
      thinking: { type: "adaptive" },
    });
    const plain = body("claude-fable-5-1");
    expect(plain.max_tokens).toBe(1000);
    expect(plain.thinking).toBeUndefined();
    // A model that rejects adaptive thinking is called as before.
    expect(body("claude-sonnet-4-5", true).thinking).toBeUndefined();
  });
});
