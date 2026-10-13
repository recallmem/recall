import { createHash } from "node:crypto";
import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base";
import OpenAI from "openai";
import type { Config } from "../config.js";
import { PriceBook } from "./pricing.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "./providers/openai.js";
import type { EmbeddingProvider, UsageSink } from "./types.js";
import { LlmError } from "./types.js";

/** Native output sizes; anything smaller than the column is zero-padded (cosine is unchanged). */
const NATIVE_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "gemini-embedding-001": 3072,
  "Xenova/multilingual-e5-small": 384,
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/bge-small-en-v1.5": 384,
};

const MAX_BATCH = 64;

/**
 * Input cap for embeddings, in cl100k tokens: the tokenizer OpenAI's embedding models count with
 * (their limit is 8,192). It has to be that tokenizer, not o200k: indented code takes far more
 * cl100k tokens (6,000 o200k tokens of Python were 9,224 cl100k), and one over-long input fails
 * the whole batch. Other providers' models truncate long input themselves.
 */
export const EMBED_INPUT_MAX_TOKENS = 8000;

/**
 * Text sent to the embedding model, cut to the input cap. Counted in tokens, not characters:
 * code, numbers or repeated symbols can pass 8k tokens in far fewer than 20k characters. Short
 * texts (at most four tokens per character) skip the count.
 */
export function embeddingInput(text: string): string {
  if (text.length <= EMBED_INPUT_MAX_TOKENS / 4) return text;
  const tokens = encode(text);
  return tokens.length > EMBED_INPUT_MAX_TOKENS
    ? decode(tokens.slice(0, EMBED_INPUT_MAX_TOKENS))
    : text;
}

/**
 * An embedding provider whose key is missing. The server still starts (the site,
 * sign-in and the dashboard keep working); every embedding call fails with the reason.
 */
class UnconfiguredEmbeddings implements EmbeddingProvider {
  constructor(
    readonly name: string,
    readonly model: string,
    readonly nativeDimensions: number,
    private readonly reason: string,
  ) {}

  async embed(): Promise<never> {
    throw new LlmError(this.reason, "config");
  }
}

class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  private readonly client: OpenAI;
  constructor(
    readonly name: string,
    readonly model: string,
    readonly nativeDimensions: number,
    opts: { apiKey: string; baseURL: string },
    private readonly requestDims: number | null,
    /** Extra request fields, e.g. OpenRouter provider preferences. */
    private readonly extra: Record<string, unknown> = {},
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 3 });
  }
  async embed(texts: string[], signal?: AbortSignal) {
    const res = await this.client.embeddings.create(
      {
        model: this.model,
        input: texts,
        ...(this.requestDims ? { dimensions: this.requestDims } : {}),
        ...this.extra,
      },
      { signal },
    );
    const vectors = res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { vectors, tokens: res.usage?.prompt_tokens ?? 0 };
  }
}

/** Local ONNX embeddings through @huggingface/transformers (optional dependency). $0 per token. */
class LocalEmbeddings implements EmbeddingProvider {
  readonly name = "local";
  private extractor: Promise<(t: string[], o: object) => Promise<{ tolist(): number[][] }>> | null =
    null;
  constructor(
    readonly model: string,
    readonly nativeDimensions: number,
  ) {}
  async embed(texts: string[]) {
    this.extractor ??= (async () => {
      const mod = (await import("@huggingface/transformers" as string).catch(() => {
        throw new LlmError(
          "local embeddings need the optional package @huggingface/transformers (pnpm add @huggingface/transformers)",
          "config",
        );
      })) as { pipeline: (task: string, model: string) => Promise<never> };
      return mod.pipeline("feature-extraction", this.model);
    })();
    const extract = await this.extractor;
    const out = await extract(texts, { pooling: "mean", normalize: true });
    return { vectors: out.tolist(), tokens: 0 };
  }
}

/**
 * Hashed bag-of-words embedding. Deterministic, dependency-free, and good
 * enough for lexical similarity in tests and the keyless offline mode.
 */
export class HashEmbeddings implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "hash";
  constructor(readonly nativeDimensions: number) {}
  async embed(texts: string[]) {
    const vectors = texts.map((text) => {
      const v = new Array<number>(this.nativeDimensions).fill(0);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        const h = createHash("md5").update(word).digest();
        v[h.readUInt32LE(0) % this.nativeDimensions]! += h[4]! & 1 ? 1 : -1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, tokens: 0 };
  }
}

export class EmbeddingClient {
  readonly provider: EmbeddingProvider;
  readonly ref: string;
  readonly dimensions: number;
  private readonly prices: PriceBook;
  private readonly cache = new Map<string, number[]>();

  constructor(
    config: Config,
    private readonly usage: UsageSink | null = null,
  ) {
    this.ref = config.embedding.model;
    this.dimensions = config.embedding.dimensions;
    this.prices = new PriceBook(config.pricingOverrides);
    const slash = this.ref.indexOf("/");
    const providerName = this.ref.slice(0, slash);
    const model = this.ref.slice(slash + 1);
    const env = config.env;
    if (providerName === "mock") {
      this.provider = new HashEmbeddings(Math.min(this.dimensions, 512));
    } else if (providerName === "local") {
      this.provider = new LocalEmbeddings(model, NATIVE_DIMS[model] ?? 384);
    } else {
      const apiKey =
        providerName === "openai"
          ? env.OPENAI_API_KEY
          : providerName === "gemini"
            ? env.GEMINI_API_KEY
            : providerName === "openrouter"
              ? env.OPENROUTER_API_KEY
              : providerName === "compat"
                ? (env.RECALL_COMPAT_API_KEY ?? "not-needed")
                : undefined;
      const baseURL =
        providerName === "compat"
          ? env.RECALL_COMPAT_BASE_URL
          : providerName === "openai"
            ? (env.OPENAI_BASE_URL ?? OPENAI_COMPATIBLE_BASE_URLS.openai)
            : OPENAI_COMPATIBLE_BASE_URLS[providerName];
      // OpenRouter names models "<vendor>/<model>".
      const native = NATIVE_DIMS[model] ?? NATIVE_DIMS[model.split("/").pop()!] ?? this.dimensions;
      // Matryoshka models can be truncated server-side to fit the column.
      const requestDims = native > this.dimensions ? this.dimensions : null;
      this.provider =
        apiKey && baseURL
          ? new OpenAiCompatibleEmbeddings(
              providerName,
              model,
              requestDims ?? native,
              { apiKey, baseURL },
              requestDims,
              // Hosted: only providers that neither store nor train on the text, as for chat calls.
              providerName === "openrouter" && env.RECALL_HOSTED
                ? { provider: { data_collection: "deny" } }
                : {},
            )
          : new UnconfiguredEmbeddings(
              providerName,
              model,
              requestDims ?? native,
              `embedding provider "${providerName}" is not configured (missing API key)`,
            );
    }
    if (this.provider.nativeDimensions > this.dimensions) {
      throw new LlmError(
        `${this.ref} produces ${this.provider.nativeDimensions}-d vectors; RECALL_EMBEDDING_DIMENSIONS is ${this.dimensions}`,
        "config",
      );
    }
  }

  private pad(v: number[]): number[] {
    if (v.length === this.dimensions) return v;
    return v.concat(new Array<number>(this.dimensions - v.length).fill(0));
  }

  async embed(
    inputs: string[],
    workspaceId: string | null = null,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    // Every caller's text is capped here: messages, extracted facts (a model can copy a whole
    // document into one), consolidated conclusions and queries alike.
    const texts = inputs.map(embeddingInput);
    const keys = texts.map((t) => createHash("sha1").update(t).digest("base64"));
    const missing = [...new Set(texts.filter((_, i) => !this.cache.has(keys[i]!)))];
    for (let i = 0; i < missing.length; i += MAX_BATCH) {
      const batch = missing.slice(i, i + MAX_BATCH);
      const startedAt = Date.now();
      const { vectors, tokens } = await this.provider.embed(batch, signal);
      batch.forEach((t, j) => {
        this.cache.set(createHash("sha1").update(t).digest("base64"), this.pad(vectors[j]!));
      });
      const usage = {
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const costUsd = this.prices.cost(this.ref, usage);
      this.usage?.record({
        workspaceId,
        task: "embedding",
        provider: this.provider.name,
        model: this.provider.model,
        usage,
        costUsd,
        costEstimated: costUsd !== null,
        latencyMs: Date.now() - startedAt,
        at: new Date(),
      });
    }
    const out = keys.map((k) => this.cache.get(k)!);
    if (this.cache.size > 5000) {
      for (const k of [...this.cache.keys()].slice(0, this.cache.size - 5000)) this.cache.delete(k);
    }
    return out;
  }
}
