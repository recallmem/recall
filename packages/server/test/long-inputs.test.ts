import { encode as cl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { countTokens } from "../src/lib/tokens.js";
import { EmbeddingClient } from "../src/llm/embeddings.js";
import { EMBED_MAX_TOKENS, embeddingText } from "../src/reasoner/embed.js";
import { LEVELS } from "../src/recall/prompts.js";
import { createTestServer } from "./api-helpers.js";
import { chatUsage, parseSse, seedWorld } from "./recall-helpers.js";

describe("message embeddings", () => {
  it("cut a message to the embedding limit by tokens, even when it is short in characters", () => {
    // Under 20k characters but far over 8k tokens: dense numbers and symbols.
    const dense = Array.from({ length: 4000 }, (_, i) => ((i * 7919) % 10007).toString(36)).join(
      "~",
    );
    expect(dense.length).toBeLessThan(20_000);
    expect(countTokens(dense)).toBeGreaterThan(8192);
    const sent = embeddingText(dense);
    expect(cl100k(sent).length).toBeLessThanOrEqual(EMBED_MAX_TOKENS);
    expect(dense.startsWith(sent.slice(0, 1000))).toBe(true);

    // Indented code: cheap in o200k, dear in cl100k, the embedding model's tokenizer. A cap
    // counted in o200k let 9,224 cl100k tokens through on such a message (BEAM 500K).
    const code =
      `def login():\n        if not username or not password:\n            return jsonify({'error': 'missing'}), 400\n`.repeat(
        400,
      );
    expect(cl100k(code).length).toBeGreaterThan(8192);
    expect(cl100k(embeddingText(code)).length).toBeLessThanOrEqual(8192);

    const prose = "A normal message about a weekend trip to the coast. ".repeat(100);
    expect(embeddingText(prose)).toBe(prose);
  });
});

describe("every embedding input", () => {
  it("is cut to the limit by the embedding client, so one long extracted fact cannot fail the batch", async () => {
    const config = loadConfig({});
    const embeddings = new EmbeddingClient(config);
    const sent: string[] = [];
    const embed = embeddings.provider.embed.bind(embeddings.provider);
    embeddings.provider.embed = async (texts, signal) => {
      sent.push(...texts);
      return embed(texts, signal);
    };
    // A "fact" in which the model copied a whole document: far over the model's 8,192 tokens.
    const copied = "Line of the pasted config file: key_7 = value_7; ".repeat(2000);
    expect(countTokens(copied)).toBeGreaterThan(8192);
    const vectors = await embeddings.embed(["Alice moved to Utrecht.", copied]);
    expect(vectors).toHaveLength(2);
    expect(sent[0]).toBe("Alice moved to Utrecht.");
    expect(cl100k(sent[1]!).length).toBeLessThanOrEqual(EMBED_MAX_TOKENS);
  });
});

describe("chat answers cut off before any text", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    await seedWorld(server.ctx);
    // A model that thinks past the allowance on the first try and answers with more room.
    server.ctx.llm.mock.respondWith((req) =>
      (req.maxTokens ?? 0) <= LEVELS.low.maxOut
        ? { text: "", stopReason: "max_tokens" }
        : { text: "Alice lives in Utrecht." },
    );
  });
  afterAll(() => server.close());

  it("asks once more with twice the output allowance instead of returning nothing", async () => {
    const since = (await chatUsage(server.ctx)).at(-1)?.id ?? 0;
    const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
      query: "Where does Alice live now?",
      reasoning_level: "low",
    });
    const json = (await res.json()) as { content: string };
    expect(json.content).toBe("Alice lives in Utrecht.");
    expect(await chatUsage(server.ctx, since)).toHaveLength(2);
    const asked = server.ctx.llm.mock.calls.slice(-2).map((c) => c.req.maxTokens);
    expect(asked).toEqual([LEVELS.low.maxOut, LEVELS.low.maxOut * 2]);
  });

  it("does the same for a stream, which then carries the retried answer", async () => {
    const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
      query: "Where does Alice live these days?",
      reasoning_level: "low",
      stream: true,
    });
    const text = parseSse(await res.text())
      .map((e) => e.delta?.content ?? "")
      .join("");
    expect(text).toBe("Alice lives in Utrecht.");
  });
});
