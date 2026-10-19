import type { Usage } from "./types.js";

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
  /** Defaults to 10% of input. */
  cacheRead?: number;
  /** Defaults to 125% of input (Anthropic 5-minute writes; OpenAI GPT-5.6 and later). */
  cacheWrite?: number;
  /** Optional higher rate card above a prompt-length threshold. */
  longContext?: { aboveInputTokens: number; input: number; output: number };
}

/**
 * List prices, used for cost metering only. They drift; override any of them
 * with RECALL_PRICING_JSON rather than editing this table in production.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "anthropic/claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    longContext: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
  },
  // Cache reads on Sonnet 5.5 and Opus 5.5 bill at 0.05x input (platform.claude.com, Oct 2026).
  "anthropic/claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "anthropic/claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15 },
  "anthropic/claude-opus-4-8": { input: 5, output: 25 },
  "openai/gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  // OpenAI list prices (developers.openai.com/api/docs/pricing, Oct 2026); >272K-token prompts bill higher.
  "openai/gpt-6-sol": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    longContext: { aboveInputTokens: 272_000, input: 4, output: 15 },
  },
  "openai/gpt-6.1-sol": {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    longContext: { aboveInputTokens: 272_000, input: 4, output: 15 },
  },
  "openai/gpt-5.5": {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    longContext: { aboveInputTokens: 272_000, input: 10, output: 45 },
  },
  "openai/gpt-5.4": {
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    longContext: { aboveInputTokens: 272_000, input: 5, output: 22.5 },
  },
  "openai/gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "openai/gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  "openai/gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "openai/gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "openai/text-embedding-3-small": { input: 0.02, output: 0 },
  "openrouter/openai/text-embedding-3-small": { input: 0.02, output: 0 },
  "neon/qwen3-embedding-0-6b": { input: 0.02, output: 0 },
  "openai/text-embedding-3-large": { input: 0.13, output: 0 },
  // Together AI serverless (together.ai/pricing, Oct 2026). Open weights: DeepSeek V4 (MIT), Qwen3.5 (Apache-2.0).
  // Fine-tuned LoRA models run on dedicated endpoints billed per GPU-hour, so they have no
  // per-token price here; set one with RECALL_PRICING_JSON to meter them.
  "together/deepseek-ai/DeepSeek-V4-Pro-0813": { input: 1.32, output: 3.96, cacheRead: 0.13 },
  "together/deepseek-ai/DeepSeek-V4-Flash-0731": { input: 0.14, output: 0.28, cacheRead: 0.03 },
  "together/Qwen/Qwen3.5-9B": { input: 0.17, output: 0.25 },
  "together/openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  // Fireworks serverless (fireworks.ai/pricing, Oct 2026): unlisted models are priced by size,
  // 4B-16B parameters at $0.20 per 1M tokens in and out.
  "fireworks/accounts/fireworks/models/qwen3p5-9b": { input: 0.2, output: 0.2 },
  "fireworks/accounts/fireworks/models/gpt-oss-120b": {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.015,
  },
  // OpenRouter (openrouter.ai/api/v1/models, Oct 9 2026): cheap open-weight models with structured
  // outputs, for offline estimates. Models not listed here are priced from the live catalog, and
  // calls are metered at the cost OpenRouter reports. Credit purchases add a 5.5% fee (not included).
  "openrouter/openai/gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "openrouter/openai/gpt-oss-120b": { input: 0.037, output: 0.17 },
  "openrouter/openai/gpt-oss-20b": { input: 0.018, output: 0.09, cacheRead: 0.009 },
  "openrouter/qwen/qwen3.5-9b": { input: 0.1, output: 0.15 },
  "openrouter/qwen/qwen3-30b-a3b-instruct-2507": { input: 0.1, output: 0.3 },
  "openrouter/google/gemma-4-26b-a4b-it": { input: 0.09, output: 0.3, cacheRead: 0.05 },
  "openrouter/mistralai/mistral-small-3.2-24b-instruct": { input: 0.094, output: 0.25 },
  "openrouter/nvidia/nemotron-3-nano-30b-a3b": { input: 0.06, output: 0.24 },
  "openrouter/z-ai/glm-4.7-flash": { input: 0.0605, output: 0.4 },
  "openrouter/meta-llama/llama-3.1-8b-instruct": { input: 0.05, output: 0.08, cacheRead: 0.025 },
  "gemini/gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  "gemini/gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini/gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini/gemini-embedding-001": { input: 0.15, output: 0 },
};

export class PriceBook {
  private readonly prices: Record<string, Price>;

  /**
   * `fallback` prices models missing from the table (e.g. live OpenRouter list
   * prices); the table and RECALL_PRICING_JSON always win.
   */
  constructor(
    overrides: Record<string, unknown> = {},
    private readonly fallback?: (modelRef: string) => Price | undefined,
  ) {
    this.prices = { ...DEFAULT_PRICES, ...(overrides as Record<string, Price>) };
  }

  /** The list price used for a model, if any. */
  price(modelRef: string): Price | undefined {
    return this.prices[modelRef] ?? this.fallback?.(modelRef);
  }

  /** Cost in USD, or null when the model has no known price (local, mock, unknown). */
  cost(modelRef: string, usage: Usage): number | null {
    if (modelRef.startsWith("mock/") || modelRef.startsWith("local/")) return 0;
    const price = this.price(modelRef);
    if (!price) return null;
    const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const long = price.longContext && promptTokens > price.longContext.aboveInputTokens;
    const input = long ? price.longContext!.input : price.input;
    const output = long ? price.longContext!.output : price.output;
    const cacheRead = price.cacheRead ?? input * 0.1;
    const cacheWrite = price.cacheWrite ?? input * 1.25;
    return (
      (usage.inputTokens * input +
        usage.outputTokens * output +
        usage.cacheReadTokens * cacheRead +
        usage.cacheWriteTokens * cacheWrite) /
      1_000_000
    );
  }
}
