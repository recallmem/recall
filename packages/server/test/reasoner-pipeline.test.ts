import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { drainQueue } from "../src/queue/worker.js";
import { offlineExtraction } from "../src/reasoner/offline.js";
import { createTestServer } from "./helpers.js";
import { addMessages, conclusions, seed, usageByTask } from "./reasoner-fixtures.js";

type Server = Awaited<ReturnType<typeof createTestServer>>;
let server: Server | null = null;
const start = async (env: Record<string, string> = {}) => {
  server = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0", ...env });
  return server.ctx;
};
afterEach(async () => {
  server?.ctx.llm.mock.respondWith(null);
  await server?.close();
  server = null;
});

const current = (cs: Awaited<ReturnType<typeof conclusions>>) =>
  cs.filter((c) => !c.valid_to && !c.deleted_at);

describe("reason job", () => {
  it("extracts facts for every speaker in one call and files them for every observer", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice", "bob"], observeOthers: ["bob"] });
    await addMessages(ctx, s, [
      { peer: "alice", content: "I live in Amsterdam. I work as a nurse at the OLVG hospital." },
      { peer: "bob", content: "Nice. I love climbing on weekends." },
    ]);
    await drainQueue(ctx);

    const usage = await usageByTask(ctx, s.workspaceId);
    expect(usage.reasoner?.calls).toBe(1);
    const cs = await conclusions(ctx, s.workspaceId);
    const pairs = cs.map((c) => `${c.observer}>${c.observed}: ${c.content}`).sort();
    expect(pairs).toEqual([
      "alice>alice: alice lives in Amsterdam",
      "alice>alice: alice works as a nurse at the OLVG hospital",
      "bob>alice: alice lives in Amsterdam",
      "bob>alice: alice works as a nurse at the OLVG hospital",
      "bob>bob: bob loves climbing on weekends",
    ]);
    // Provenance is per fact, not per batch.
    const [m1] = await rows<{ id: string }>(
      ctx.db,
      sql`SELECT id FROM messages WHERE seq_in_session = 1`,
    );
    expect(cs.find((c) => c.observed === "alice")!.message_ids).toEqual([m1!.id]);

    const msgs = await rows<{ embedded: boolean; reasoned: boolean }>(
      ctx.db,
      sql`SELECT embedding IS NOT NULL AS embedded, reasoned_at IS NOT NULL AS reasoned FROM messages`,
    );
    expect(msgs.every((m) => m.embedded && m.reasoned)).toBe(true);
    const cols = await rows<{ version: number; new_since_dream: number; peer_card: string[] }>(
      ctx.db,
      sql`SELECT c.version, c.new_since_dream, c.peer_card FROM collections c
          JOIN peers o ON o.id = c.observer_id JOIN peers d ON d.id = c.observed_id
          WHERE o.name = 'alice' AND d.name = 'alice'`,
    );
    expect(cols[0]!.version).toBeGreaterThan(0);
    expect(cols[0]!.new_since_dream).toBe(2);
    expect(cols[0]!.peer_card).toEqual([
      "ATTRIBUTE: Location: Amsterdam",
      "ATTRIBUTE: Occupation: nurse at the OLVG hospital",
    ]);
  });

  it("supersedes a changed fact at ingest and keeps the history", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice", "bob"], observeOthers: ["bob"] });
    await addMessages(ctx, s, [
      {
        peer: "alice",
        content: "I live in Amsterdam.",
        createdAt: new Date("2026-09-01T10:00:00Z"),
      },
    ]);
    await drainQueue(ctx);
    await addMessages(ctx, s, [
      {
        peer: "alice",
        content: "Big news: I moved to Berlin last week.",
        createdAt: new Date("2026-10-01T10:00:00Z"),
      },
    ]);
    await drainQueue(ctx);

    const cs = await conclusions(ctx, s.workspaceId);
    for (const observer of ["alice", "bob"]) {
      const mine = cs.filter((c) => c.observer === observer && c.observed === "alice");
      const old = mine.find((c) => c.content.includes("Amsterdam"))!;
      const now = mine.find((c) => c.content.includes("Berlin"))!;
      expect(old.valid_to).not.toBeNull();
      expect(old.superseded_by).toBe(now.id);
      expect(now.valid_to).toBeNull();
      expect(current(mine).map((c) => c.content)).toEqual(["alice lives in Berlin last week"]);
    }
    const [card] = await rows<{ peer_card: string[] }>(
      ctx.db,
      sql`SELECT peer_card FROM collections c JOIN peers o ON o.id = c.observer_id
          WHERE o.name = 'alice' AND c.observer_id = c.observed_id`,
    );
    expect(card!.peer_card).toEqual(["ATTRIBUTE: Location: Berlin last week"]);
  });

  it("chains two updates of the same fact within one batch so the later one wins", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [
      { peer: "alice", content: "I live in Lyon.", createdAt: new Date("2026-08-01T10:00:00Z") },
    ]);
    await drainQueue(ctx);
    await addMessages(ctx, s, [
      { peer: "alice", content: "I moved to Nantes.", createdAt: new Date("2026-09-01T10:00:00Z") },
      {
        peer: "alice",
        content: "Then I moved to Lille.",
        createdAt: new Date("2026-10-01T10:00:00Z"),
      },
    ]);
    await drainQueue(ctx);
    const cs = await conclusions(ctx, s.workspaceId);
    const [lyon, nantes, lille] = ["Lyon", "Nantes", "Lille"].map(
      (city) => cs.find((c) => c.content.includes(city))!,
    );
    expect(current(cs).map((c) => c.content)).toEqual(["alice lives in Lille"]);
    expect(lyon!.superseded_by).toBe(nantes!.id);
    expect(nantes!.superseded_by).toBe(lille!.id);
  });

  it("reinforces a repeated fact instead of duplicating it", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I love sushi." }]);
    await drainQueue(ctx);
    await addMessages(ctx, s, [{ peer: "alice", content: "Honestly, I love sushi!" }]);
    await drainQueue(ctx);
    const cs = await conclusions(ctx, s.workspaceId);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.times_derived).toBe(2);
    expect(cs[0]!.message_ids).toHaveLength(2);
  });

  it("guards against near-duplicate adds even when the model says add", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I love sushi." }]);
    await drainQueue(ctx);
    ctx.llm.mock.respondWith((req) => {
      const out = offlineExtraction(req);
      for (const f of out.facts) Object.assign(f, { action: "add", target: null });
      return { json: out };
    });
    await addMessages(ctx, s, [{ peer: "alice", content: "I love sushi." }]);
    await drainQueue(ctx);
    const cs = await conclusions(ctx, s.workspaceId);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.times_derived).toBe(2);
  });

  it("skips the LLM for trivial batches but still embeds and marks them", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice", "bot"] });
    await addMessages(ctx, s, [
      { peer: "alice", content: "ok thanks!" },
      { peer: "bot", content: "You're welcome." },
      { peer: "alice", content: "👍" },
    ]);
    await drainQueue(ctx);
    expect((await usageByTask(ctx, s.workspaceId)).reasoner).toBeUndefined();
    const msgs = await rows<{ embedded: boolean; reasoned: boolean }>(
      ctx.db,
      sql`SELECT embedding IS NOT NULL AS embedded, reasoned_at IS NOT NULL AS reasoned FROM messages`,
    );
    expect(msgs.every((m) => m.embedded && m.reasoned)).toBe(true);
  });

  it("embeds messages with reasoning off but derives nothing from them", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Paris.", reasoning: false }]);
    await drainQueue(ctx);
    expect(await conclusions(ctx, s.workspaceId)).toHaveLength(0);
    expect((await usageByTask(ctx, s.workspaceId)).reasoner).toBeUndefined();
    const [m] = await rows<{ embedded: boolean; reasoned: boolean }>(
      ctx.db,
      sql`SELECT embedding IS NOT NULL AS embedded, reasoned_at IS NOT NULL AS reasoned FROM messages`,
    );
    expect(m).toEqual({ embedded: true, reasoned: true });
  });

  it("waits for a token batch, embedding immediately, and processes once the batch is full", async () => {
    const ctx = await start({
      RECALL_REASONER_MAX_DELAY_MS: "600000",
      RECALL_REASONER_BATCH_TOKENS: "20",
    });
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Rome." }]);
    await drainQueue(ctx);
    expect(await conclusions(ctx, s.workspaceId)).toHaveLength(0);
    const [job] = await rows<{ status: string; future: boolean; attempts: number }>(
      ctx.db,
      sql`SELECT status, run_after > now() AS future, attempts FROM jobs WHERE kind = 'reason'`,
    );
    expect(job).toEqual({ status: "pending", future: true, attempts: 0 });
    const [m] = await rows<{ embedded: boolean }>(
      ctx.db,
      sql`SELECT embedding IS NOT NULL AS embedded FROM messages`,
    );
    expect(m!.embedded).toBe(true);

    await addMessages(ctx, s, [
      {
        peer: "alice",
        content:
          "I work as a baker in a small shop near the Pantheon, and I love the early mornings there.",
      },
    ]);
    await drainQueue(ctx);
    expect((await usageByTask(ctx, s.workspaceId)).reasoner?.calls).toBe(1);
    expect((await conclusions(ctx, s.workspaceId)).length).toBeGreaterThanOrEqual(2);
  });

  it("retries an unusable answer as two smaller windows instead of dropping facts", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    ctx.llm.mock.respondWith((req) => {
      const lines = req.messages[0]!.content.split("\n").length - 1;
      return lines > 2 ? { text: "not json at all" } : { json: offlineExtraction(req) };
    });
    await addMessages(
      ctx,
      s,
      ["I live in Oslo.", "I love skiing.", "I have two cats.", "I work as a pilot."].map(
        (content) => ({ peer: "alice", content }),
      ),
    );
    await drainQueue(ctx);
    const cs = await conclusions(ctx, s.workspaceId);
    expect(cs.map((c) => c.content).sort()).toEqual([
      "alice has two cats",
      "alice lives in Oslo",
      "alice loves skiing",
      "alice works as a pilot",
    ]);
    const [job] = await rows<{ status: string }>(
      ctx.db,
      sql`SELECT status FROM jobs WHERE kind = 'reason'`,
    );
    expect(job!.status).toBe("done");
  });
});

describe("summaries", () => {
  it("fold the short summary into the extraction call and build the long one from synopses", async () => {
    const ctx = await start();
    const s = await seed(ctx, {
      peers: ["alice", "bot"],
      sessionConfig: { summary: { messages_per_short_summary: 10, messages_per_long_summary: 20 } },
    });
    for (let i = 0; i < 4; i++) {
      await addMessages(
        ctx,
        s,
        Array.from({ length: 5 }, (_, j) => ({
          peer: j % 2 ? "bot" : "alice",
          content:
            j % 2
              ? `Here is some advice about topic ${i}-${j}, take it slowly.`
              : `I enjoy hobby number ${i * 5 + j} a lot.`,
        })),
      );
      await drainQueue(ctx);
    }
    const usage = await usageByTask(ctx, s.workspaceId);
    expect(usage.summary).toBeUndefined();
    const sums = await rows<{ kind: string; end_seq: number | string; content: string }>(
      ctx.db,
      sql`SELECT kind, end_seq, content FROM summary_blocks WHERE session_id = ${s.sessionId} ORDER BY kind, end_seq`,
    );
    const short = sums.filter((x) => x.kind === "short");
    const long = sums.filter((x) => x.kind === "long");
    expect(short).toHaveLength(1);
    expect(Number(short[0]!.end_seq)).toBe(20);
    expect(long).toHaveLength(1);
    expect(Number(long[0]!.end_seq)).toBe(20);
    expect(long[0]!.content).toContain("[messages 1-5]");
    expect(sums.filter((x) => x.kind === "block")).toHaveLength(4);
  });

  it("run as their own job when reasoning is off", async () => {
    const ctx = await start();
    const s = await seed(ctx, {
      peers: ["alice", "bot"],
      wsConfig: { reasoning: { enabled: false } },
      sessionConfig: { summary: { messages_per_short_summary: 10, messages_per_long_summary: 20 } },
    });
    await addMessages(
      ctx,
      s,
      Array.from({ length: 12 }, (_, j) => ({
        peer: j % 2 ? "bot" : "alice",
        content: `Message number ${j} about gardening.`,
      })),
    );
    await drainQueue(ctx);
    const usage = await usageByTask(ctx, s.workspaceId);
    expect(usage.reasoner).toBeUndefined();
    expect(usage.summary?.calls).toBe(1);
    const [short] = await rows<{ end_seq: number | string }>(
      ctx.db,
      sql`SELECT end_seq FROM summary_blocks WHERE session_id = ${s.sessionId} AND kind = 'short'`,
    );
    expect(Number(short!.end_seq)).toBe(10);
  });
});
