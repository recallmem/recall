import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  anthropicCacheMinimum,
  cacheKey,
  cachePlan,
  openAiExplicitCaching,
} from "../src/llm/cache.js";
import { LlmClient } from "../src/llm/client.js";
import { OpenRouterCatalog } from "../src/llm/openrouter.js";
import { PriceBook } from "../src/llm/pricing.js";
import type { LlmRequest, UsageRecord } from "../src/llm/types.js";
import { EXTRACTION_SYSTEM } from "../src/reasoner/prompt.js";

/**
 * Provider-level prompt caching with mocked HTTP (no network): which request
 * fields and breakpoints each provider gets, the fallback for endpoints that
 * reject them, and how cache reads and writes are metered and priced.
 */

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** Stubs fetch with a queue of [status, json] replies (the last one repeats). */
function stubHttp(...replies: [number, unknown][]): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      const [status, json] = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const completion = (usage: Record<string, unknown>, content = '{"ok":true}') => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "x",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { completion_tokens: 200, ...usage },
});

const anthropicMessage = (usage: Record<string, unknown>) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "x",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 50, output_tokens: 20, ...usage },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A reasoner-shaped request: the real fixed instructions, then per-call context and transcript. */
const reasonerRequest = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  task: "reasoner",
  workspaceId: "ws_1",
  system: EXTRACTION_SYSTEM,
  context: "KNOWN FACTS\nmaya:\n(none)",
  messages: [
    { role: "user", content: "TRANSCRIPT\n[m1] maya 2026-10-01T09:00Z: I live in Leeds." },
  ],
  maxTokens: 500,
  effort: "low",
  ...over,
});

/** A tool-loop round: question, one tool call and its result, with `cacheContext`. */
const loopRequest = (task = "chat_high"): LlmRequest => ({
  task,
  workspaceId: "ws_9",
  system: EXTRACTION_SYSTEM,
  context: "About: maya.\n## Facts\n[F1] 2026-01-02 maya lives in Leeds",
  cacheContext: true,
  tools: [{ name: "search_memory", description: "Search facts.", inputSchema: { type: "object" } }],
  messages: [
    { role: "user", content: "Today is 2026-10-09.\n\nQuestion: where does maya live?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "search_memory", input: { query: "home" } }],
    },
    { role: "tool", toolCallId: "call_1", name: "search_memory", content: "[F2] maya moved" },
  ],
});

const usageSink = () => {
  const records: UsageRecord[] = [];
  return { records, sink: { record: (r: UsageRecord) => records.push(r) } };
};

type Msg = { role: string; content: unknown };
const messagesOf = (c: Captured) => c.body.messages as Msg[];

describe("cache rules", () => {
  it("knows each Claude model's minimum cacheable prefix", () => {
    expect(anthropicCacheMinimum("claude-haiku-5-5")).toBe(512);
    expect(anthropicCacheMinimum("claude-sonnet-5-5")).toBe(512);
    expect(anthropicCacheMinimum("claude-opus-5-5")).toBe(512);
    expect(anthropicCacheMinimum("claude-opus-5")).toBe(512);
    expect(anthropicCacheMinimum("claude-sonnet-5")).toBe(1024);
    expect(anthropicCacheMinimum("claude-sonnet-4-6")).toBe(1024);
    expect(anthropicCacheMinimum("claude-opus-4-8")).toBe(1024);
    expect(anthropicCacheMinimum("claude-opus-4-20250514")).toBe(1024);
    expect(anthropicCacheMinimum("claude-opus-4-7")).toBe(2048);
    expect(anthropicCacheMinimum("claude-3-5-haiku-20241022")).toBe(2048);
    expect(anthropicCacheMinimum("claude-haiku-4-5")).toBe(4096);
    expect(anthropicCacheMinimum("anthropic/claude-haiku-4.5")).toBe(4096);
    expect(anthropicCacheMinimum("claude-opus-4-5")).toBe(4096);
  });

  it("uses explicit OpenAI caching from GPT-5.6 on", () => {
    for (const m of ["gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-luna", "openai/gpt-6-luna:floor"])
      expect(openAiExplicitCaching(m), m).toBe(true);
    for (const m of ["gpt-5.5", "gpt-5.4-mini", "gpt-5", "gpt-4.1-mini", "gpt-oss-120b", "o3"])
      expect(openAiExplicitCaching(m), m).toBe(false);
  });

  it("keys the cache per task, and per workspace once tenant content is cached", () => {
    expect(cacheKey({ task: "reasoner", workspaceId: "ws_1" })).toBe("recall:reasoner");
    expect(cacheKey({ task: "chat_max", workspaceId: "ws_1", cacheContext: true })).toBe(
      "recall:chat_max:ws_1",
    );
  });

  it("places breakpoints only where the prefix reaches the minimum", () => {
    expect(cachePlan(reasonerRequest(), 1024)).toEqual({
      system: true,
      context: false,
      messages: false,
    });
    expect(cachePlan(reasonerRequest({ system: "Short instructions." }), 1024).system).toBe(false);
    expect(cachePlan(reasonerRequest(), 4096).system).toBe(false);
    expect(cachePlan(loopRequest(), 1024)).toEqual({ system: true, context: true, messages: true });
  });
});

describe("OpenAI prompt caching", () => {
  const luna = () =>
    loadConfig({ OPENAI_API_KEY: "sk-test", RECALL_MODEL_REASONER: "openai/gpt-6-luna" });

  it("marks the end of the static prefix and writes nothing else (GPT-5.6+)", async () => {
    const calls = stubHttp([
      200,
      completion({
        prompt_tokens: 1600,
        prompt_tokens_details: { cached_tokens: 1456, cache_write_tokens: 0 },
      }),
    ]);
    const { records, sink } = usageSink();
    await new LlmClient(luna(), sink).complete(reasonerRequest());
    const body = calls[0]!.body;
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.prompt_cache_key).toBe("recall:reasoner");
    expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(messagesOf(calls[0]!)).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: EXTRACTION_SYSTEM, prompt_cache_breakpoint: { mode: "explicit" } },
        ],
      },
      { role: "system", content: "KNOWN FACTS\nmaya:\n(none)" },
      { role: "user", content: reasonerRequest().messages[0]!.content },
    ]);
    expect(records[0]!.usage).toEqual({
      inputTokens: 144,
      outputTokens: 200,
      cacheReadTokens: 1456,
      cacheWriteTokens: 0,
    });
    // gpt-6-luna: $0.10 input, $0.01 cached, $0.50 output per 1M.
    expect(records[0]!.costUsd).toBeCloseTo((144 * 0.1 + 1456 * 0.01 + 200 * 0.5) / 1e6, 12);
  });

  it("meters cache writes at 1.25x input", async () => {
    stubHttp([
      200,
      completion({
        prompt_tokens: 1600,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1456 },
      }),
    ]);
    const { records, sink } = usageSink();
    await new LlmClient(luna(), sink).complete(reasonerRequest());
    expect(records[0]!.usage).toMatchObject({ inputTokens: 144, cacheWriteTokens: 1456 });
    expect(records[0]!.costUsd).toBeCloseTo((144 * 0.1 + 1456 * 0.125 + 200 * 0.5) / 1e6, 12);
  });

  it("sends no breakpoint when the prefix is too short, so nothing is written at all", async () => {
    const calls = stubHttp([200, completion({ prompt_tokens: 300 })]);
    await new LlmClient(luna()).complete(reasonerRequest({ task: "summary", system: "Short." }));
    expect(calls[0]!.body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(calls[0]!.body.prompt_cache_key).toBe("recall:summary");
    expect(messagesOf(calls[0]!)[0]).toEqual({ role: "system", content: "Short." });
  });

  it("marks the instructions, the context and every finished round in a tool loop", async () => {
    const calls = stubHttp([200, completion({ prompt_tokens: 2000 })]);
    const config = loadConfig({
      OPENAI_API_KEY: "sk-test",
      RECALL_MODEL_CHAT_HIGH: "openai/gpt-6-luna",
    });
    await new LlmClient(config).complete(loopRequest());
    const body = calls[0]!.body;
    expect(body.prompt_cache_key).toBe("recall:chat_high:ws_9");
    const marked = messagesOf(calls[0]!).map(
      (m) => Array.isArray(m.content) && "prompt_cache_breakpoint" in m.content[0],
    );
    // system, context, question, (assistant tool call), tool result
    expect(marked).toEqual([true, true, true, false, true]);
    expect(body.reasoning_effort).toBe("none");
  });

  it("only sends prompt_cache_key to models before GPT-5.6, which bill no cache writes", async () => {
    const calls = stubHttp([
      200,
      completion({
        prompt_tokens: 1600,
        prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 500 },
      }),
    ]);
    const { records, sink } = usageSink();
    const config = loadConfig({
      OPENAI_API_KEY: "sk-test",
      RECALL_MODEL_REASONER: "openai/gpt-4.1-mini",
    });
    await new LlmClient(config, sink).complete(reasonerRequest());
    expect(calls[0]!.body.prompt_cache_key).toBe("recall:reasoner");
    expect(calls[0]!.body.prompt_cache_options).toBeUndefined();
    expect(messagesOf(calls[0]!)[0]!.content).toBe(EXTRACTION_SYSTEM);
    expect(records[0]!.usage).toMatchObject({
      inputTokens: 576,
      cacheReadTokens: 1024,
      cacheWriteTokens: 0,
    });
  });

  it("retries without the cache fields when an endpoint rejects them, then stops sending them", async () => {
    const calls = stubHttp(
      [
        400,
        {
          error: {
            message: "Unrecognized request argument supplied: prompt_cache_options",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
      ],
      [200, completion({ prompt_tokens: 1600 })],
    );
    const llm = new LlmClient(luna());
    const r = await llm.complete(reasonerRequest());
    expect(r.text).toBe('{"ok":true}');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.prompt_cache_options).toEqual({ mode: "explicit" });
    for (const c of calls.slice(1)) {
      expect(c.body.prompt_cache_key).toBeUndefined();
      expect(c.body.prompt_cache_options).toBeUndefined();
      expect(messagesOf(c)[0]!.content).toBe(EXTRACTION_SYSTEM);
    }
    await llm.complete(reasonerRequest());
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.prompt_cache_key).toBeUndefined();
  });

  it("does not retry other bad requests", async () => {
    const calls = stubHttp([
      400,
      { error: { message: "max_tokens is too large", type: "invalid_request_error" } },
    ]);
    await expect(new LlmClient(luna()).complete(reasonerRequest())).rejects.toMatchObject({
      kind: "provider",
    });
    expect(calls).toHaveLength(1);
  });

  it("sends no cache fields to the other OpenAI-compatible providers", async () => {
    const env = {
      GROQ_API_KEY: "k",
      XAI_API_KEY: "k",
      DEEPSEEK_API_KEY: "k",
      TOGETHER_API_KEY: "k",
      FIREWORKS_API_KEY: "k",
      GEMINI_API_KEY: "k",
      RECALL_COMPAT_BASE_URL: "https://llm.example.test/v1",
    };
    const models = [
      "groq/llama-3.3-70b",
      "xai/grok-4-fast",
      "deepseek/deepseek-chat",
      "together/Qwen/Qwen3.5-9B",
      "fireworks/accounts/fireworks/models/qwen3p5-9b",
      "gemini/gemini-2.5-flash-lite",
      "compat/local-model",
    ];
    const calls = stubHttp([200, completion({ prompt_tokens: 1600 })]);
    const llm = new LlmClient(loadConfig(env));
    for (const model of models) await llm.complete(reasonerRequest({ model }));
    expect(calls).toHaveLength(models.length);
    expect(calls[1]!.url).toBe("https://api.x.ai/v1/chat/completions");
    for (const c of calls) {
      for (const field of ["prompt_cache_key", "prompt_cache_options", "session_id"])
        expect(c.body[field], `${c.url} ${field}`).toBeUndefined();
      for (const m of messagesOf(c)) expect(typeof m.content, c.url).toBe("string");
    }
  });

  it("meters DeepSeek's own cache-hit field", async () => {
    stubHttp([
      200,
      completion({
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
      }),
    ]);
    const { records, sink } = usageSink();
    await new LlmClient(loadConfig({ DEEPSEEK_API_KEY: "k" }), sink).complete(
      reasonerRequest({ model: "deepseek/deepseek-chat" }),
    );
    expect(records[0]!.usage).toMatchObject({ inputTokens: 200, cacheReadTokens: 800 });
  });
});

describe("OpenRouter prompt caching", () => {
  const noCatalog = () =>
    new OpenRouterCatalog({ fetchImpl: vi.fn(async () => new Response("{}", { status: 500 })) });
  const client = (sink?: { record: (r: UsageRecord) => void }) =>
    new LlmClient(loadConfig({ OPENROUTER_API_KEY: "or-key" }), sink ?? null, {
      openRouterCatalog: noCatalog(),
    });

  it("passes Anthropic-style breakpoints through for Claude models", async () => {
    const calls = stubHttp([200, completion({ prompt_tokens: 1600 })]);
    const llm = client();
    await llm.complete(reasonerRequest({ model: "openrouter/anthropic/claude-sonnet-5.5" }));
    await llm.complete({ ...loopRequest(), model: "openrouter/anthropic/claude-sonnet-5.5" });
    const [single, loop] = calls;
    expect(single!.body.session_id).toBe("recall:reasoner");
    expect(single!.body.prompt_cache_options).toBeUndefined();
    expect(messagesOf(single!)[0]!.content).toEqual([
      { type: "text", text: EXTRACTION_SYSTEM, cache_control: { type: "ephemeral" } },
    ]);
    expect(messagesOf(single!)[1]!.content).toBe("KNOWN FACTS\nmaya:\n(none)");
    // Tool loop: system, context and only the last message (Anthropic allows four breakpoints).
    const marked = messagesOf(loop!).map((m) => Array.isArray(m.content));
    expect(marked).toEqual([true, true, false, false, true]);
    expect(loop!.body.session_id).toBe("recall:chat_high:ws_9");
  });

  it("uses OpenAI's explicit mode for GPT-5.6+ and no markers for Gemini", async () => {
    const calls = stubHttp([200, completion({ prompt_tokens: 1600 })]);
    const llm = client();
    await llm.complete(reasonerRequest({ model: "openrouter/openai/gpt-6-luna" }));
    await llm.complete(reasonerRequest({ model: "openrouter/google/gemini-2.5-flash" }));
    const [gpt, gemini] = calls;
    expect(gpt!.body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(messagesOf(gpt!)[0]!.content).toEqual([
      { type: "text", text: EXTRACTION_SYSTEM, prompt_cache_breakpoint: { mode: "explicit" } },
    ]);
    // Gemini caches implicitly; explicit markers would add cache storage costs.
    expect(gemini!.body.session_id).toBe("recall:reasoner");
    expect(gemini!.body.prompt_cache_options).toBeUndefined();
    expect(messagesOf(gemini!)[0]!.content).toBe(EXTRACTION_SYSTEM);
  });

  it("meters reported cache reads and writes and keeps OpenRouter's cost", async () => {
    stubHttp([
      200,
      completion({
        prompt_tokens: 1600,
        cost: 0.00042,
        prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 },
      }),
    ]);
    const { records, sink } = usageSink();
    await client(sink).complete(
      reasonerRequest({ model: "openrouter/anthropic/claude-sonnet-5.5" }),
    );
    expect(records[0]!.usage).toMatchObject({
      inputTokens: 600,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    });
    expect(records[0]!.costUsd).toBe(0.00042);
  });
});

describe("Anthropic prompt caching", () => {
  const anthropic = (model = "anthropic/claude-haiku-5-5") =>
    loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test", RECALL_MODEL_REASONER: model });

  it("caches the static prefix when it reaches the model's minimum", async () => {
    const calls = stubHttp([200, anthropicMessage({ cache_read_input_tokens: 1300 })]);
    const { records, sink } = usageSink();
    await new LlmClient(anthropic(), sink).complete(reasonerRequest());
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.body.system).toEqual([
      { type: "text", text: EXTRACTION_SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text: "KNOWN FACTS\nmaya:\n(none)" },
    ]);
    expect(messagesOf(calls[0]!)[0]!.content).toBe(reasonerRequest().messages[0]!.content);
    expect(records[0]!.usage).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 1300,
      cacheWriteTokens: 0,
    });
    // Haiku 5.5: $0.10 input, $0.01 cache read, $0.50 output per 1M.
    expect(records[0]!.costUsd).toBeCloseTo((50 * 0.1 + 1300 * 0.01 + 20 * 0.5) / 1e6, 12);
  });

  it("meters cache writes at 1.25x input", async () => {
    stubHttp([200, anthropicMessage({ cache_creation_input_tokens: 1300 })]);
    const { records, sink } = usageSink();
    await new LlmClient(anthropic(), sink).complete(reasonerRequest());
    expect(records[0]!.usage.cacheWriteTokens).toBe(1300);
    expect(records[0]!.costUsd).toBeCloseTo((50 * 0.1 + 1300 * 0.125 + 20 * 0.5) / 1e6, 12);
  });

  it("places no breakpoint below the minimum (Haiku 4.5 needs 4,096 tokens)", async () => {
    const calls = stubHttp([200, anthropicMessage({})]);
    await new LlmClient(anthropic("anthropic/claude-haiku-4-5")).complete(reasonerRequest());
    expect(JSON.stringify(calls[0]!.body)).not.toContain("cache_control");
  });

  it("caches system, context and the latest round in a tool loop", async () => {
    const calls = stubHttp([200, anthropicMessage({})]);
    const config = loadConfig({
      ANTHROPIC_API_KEY: "sk-ant-test",
      RECALL_MODEL_CHAT_HIGH: "anthropic/claude-sonnet-5-5",
    });
    await new LlmClient(config).complete(loopRequest());
    const body = calls[0]!.body;
    const system = body.system as { cache_control?: unknown }[];
    expect(system.map((b) => !!b.cache_control)).toEqual([true, true]);
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[0]!.content).toBe(loopRequest().messages[0]!.content);
    expect(messages.at(-1)!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "[F2] maya moved",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3);
  });

  it("prices Sonnet 5.5 and Opus 5.5 cache reads at 0.05x input", () => {
    const p = new PriceBook();
    // 50k tokens: under Haiku 5.5's 100k long-context threshold.
    const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 50_000, cacheWriteTokens: 0 };
    expect(p.cost("anthropic/claude-sonnet-5-5", u)).toBeCloseTo((50_000 * 0.1) / 1e6, 12);
    expect(p.cost("anthropic/claude-opus-5-5", u)).toBeCloseTo((50_000 * 0.2) / 1e6, 12);
    expect(p.cost("anthropic/claude-haiku-5-5", u)).toBeCloseTo((50_000 * 0.01) / 1e6, 12);
  });
});
