import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { reembedStale, resetReembedIdle } from "../src/core/reembed.js";
import { rows } from "../src/db/client.js";
import { EmbeddingClient } from "../src/llm/embeddings.js";
import { drainQueue } from "../src/queue/worker.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * After the embedding model changes, stored vectors are made again with the new one in the
 * background: vectors of two models cannot be compared.
 */

let s: ApiServer | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  await s?.close();
  s = null;
});

describe("Neon AI Gateway embeddings", () => {
  it("call the branch's gateway for floats and pad to the column", async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? "{}")),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: Array(1024).fill(0.03) }],
            model: "qwen3-embedding-0-6b-112025",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const client = new EmbeddingClient(
      loadConfig({
        RECALL_DATA_DIR: "memory",
        RECALL_EMBEDDING_MODEL: "neon/qwen3-embedding-0-6b",
        NEON_AI_GATEWAY_BASE_URL: "https://br-x-api.ai.example.neon.tech/",
        NEON_AI_GATEWAY_TOKEN: "nt_test",
      }),
    );
    const [v] = await client.embed(["hello"]);
    expect(calls[0]).toMatchObject({
      url: "https://br-x-api.ai.example.neon.tech/v1/embeddings",
      body: { model: "qwen3-embedding-0-6b", encoding_format: "float" },
      auth: "Bearer nt_test",
    });
    expect(calls[0]!.body).not.toHaveProperty("dimensions");
    expect(v).toHaveLength(1536);
    expect(v!.slice(1020, 1028)).toEqual([0.03, 0.03, 0.03, 0.03, 0, 0, 0, 0]);
  });
});

describe("re-embedding sweep", () => {
  it("re-embeds what another model embedded, then rests", async () => {
    s = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
    const srv = s;
    const { ctx } = srv;
    await srv.request("POST", "/v3/workspaces", { id: "re" });
    await srv.request("POST", "/v3/workspaces/re/peers", { id: "alice" });
    const r = await srv.request("POST", "/v3/workspaces/re/sessions/s1/messages", {
      messages: [
        { peer_id: "alice", content: "I live in Leiden. I work as a nurse." },
        { peer_id: "alice", content: "I play the cello on Sundays." },
      ],
    });
    expect(r.status).toBe(201);
    await drainQueue(ctx);

    const models = async (table: "messages" | "conclusions") =>
      (
        await rows<{ m: string | null; n: number }>(
          ctx.db,
          sql`SELECT embedding_model AS m, count(*)::int AS n FROM ${sql.raw(table)}
              WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY 1`,
        )
      ).map((x) => [x.m, x.n]);
    const [facts] = await rows<{ n: number }>(
      ctx.db,
      sql`SELECT count(*)::int AS n FROM conclusions WHERE embedding IS NOT NULL`,
    );
    expect(facts!.n).toBeGreaterThan(1);

    // An earlier model made every vector; one fact has since been deleted.
    await ctx.db.execute(sql`UPDATE messages SET embedding_model = 'old/model'`);
    await ctx.db.execute(sql`UPDATE conclusions SET embedding_model = 'old/model'`);
    await ctx.db.execute(
      sql`UPDATE conclusions SET deleted_at = now()
          WHERE id = (SELECT id FROM conclusions ORDER BY id LIMIT 1)`,
    );

    resetReembedIdle();
    expect(await reembedStale(ctx)).toBe(2 + facts!.n - 1);
    const ref = ctx.embeddings.ref;
    expect(await models("messages")).toEqual([[ref, 2]]);
    // The deleted fact keeps its old vector: nothing searches it.
    expect(await models("conclusions")).toEqual(
      [
        [ref, facts!.n - 1],
        ["old/model", 1],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );

    // Nothing left: the sweep rests instead of scanning every minute.
    expect(await reembedStale(ctx)).toBe(0);
    await ctx.db.execute(sql`UPDATE messages SET embedding_model = 'old/model'`);
    expect(await reembedStale(ctx)).toBe(0);
    resetReembedIdle();
    expect(await reembedStale(ctx)).toBe(2);
  });
});
