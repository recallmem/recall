import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { clusterBySimilarity, packClusters } from "../src/consolidate/cluster.js";
import { rows } from "../src/db/client.js";
import { enqueue } from "../src/queue/enqueue.js";
import {
  drainQueue,
  isUniqueViolation,
  recoverStaleJobs,
  startWorker,
  Worker,
} from "../src/queue/worker.js";
import { applyCardEdits } from "../src/reasoner/cards.js";
import { createTestServer } from "./helpers.js";
import { addMessages, seed } from "./reasoner-fixtures.js";

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

const jobs = async (ctx: Server["ctx"]) =>
  rows<{
    id: number;
    kind: string;
    status: string;
    attempts: number;
    last_error: string | null;
    work_key: string;
  }>(ctx.db, sql`SELECT id, kind, status, attempts, last_error, work_key FROM jobs ORDER BY id`);

describe("worker", () => {
  it("runFor waits for jobs that fall due soon and leaves later ones pending", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    const job = (workKey: string, inMs: number) =>
      enqueue(ctx.db, {
        kind: "embed",
        workKey,
        workspaceId: s.workspaceId,
        sessionId: s.sessionId,
        runAfter: new Date(Date.now() + inMs),
      });
    await job("now", 0);
    await job("soon", 400);
    await job("later", 60_000);
    const processed = await new Worker(ctx).runFor(10_000, 2_000);
    expect(processed).toBe(2);
    const byKey = Object.fromEntries((await jobs(ctx)).map((j) => [j.work_key, j.status]));
    expect(byKey).toEqual({ now: "done", soon: "done", later: "pending" });
  });

  it("runFor stops claiming at its deadline", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await enqueue(ctx.db, {
      kind: "embed",
      workKey: "late",
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
      runAfter: new Date(Date.now() + 1_500),
    });
    const started = Date.now();
    expect(await new Worker(ctx).runFor(300, 5_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect((await jobs(ctx)).map((j) => j.status)).toEqual(["pending"]);
  });

  it("runs at most one job per work key, enforced by the database", async () => {
    const ctx = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await enqueue(ctx.db, {
      kind: "embed",
      workKey: "same",
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
    });
    await enqueue(ctx.db, {
      kind: "embed",
      workKey: "same",
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
    });
    await enqueue(ctx.db, {
      kind: "embed",
      workKey: "other",
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
    });
    const w = new Worker(ctx);
    const a = await w.claim();
    const b = await w.claim();
    const c = await w.claim();
    expect([a?.workKey, b?.workKey, c]).toEqual(["same", "other", null]);
    // A second running row for the same key is rejected outright.
    const err = await ctx.db
      .execute(
        sql`UPDATE jobs SET status = 'running' WHERE work_key = 'same' AND status = 'pending'`,
      )
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("retries failures with backoff, then marks the job failed and keeps the error", async () => {
    const ctx = await start({
      RECALL_QUEUE_MAX_ATTEMPTS: "3",
      RECALL_WORKER_RETRY_BASE_MS: "1",
    });
    const s = await seed(ctx, { peers: ["alice"] });
    ctx.llm.mock.respondWith(() => {
      throw new Error("provider is down");
    });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Lisbon and I love surfing." }]);
    for (let i = 0; i < 20; i++) {
      await drainQueue(ctx);
      const [j] = (await jobs(ctx)).filter((x) => x.kind === "reason");
      if (j!.status === "failed") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    const [j] = (await jobs(ctx)).filter((x) => x.kind === "reason");
    expect(j).toMatchObject({ status: "failed", attempts: 3 });
    expect(j!.last_error).toContain("provider is down");
    // The messages are still unreasoned, so the next insert retries them.
    const [m] = await rows<{ n: number }>(
      ctx.db,
      sql`SELECT count(*)::int AS n FROM messages WHERE reasoned_at IS NULL`,
    );
    expect(m!.n).toBe(1);
  });

  it("fails terminal errors immediately", async () => {
    const ctx = await start({ RECALL_WEBHOOK_SECRET: "secret" });
    await enqueue(ctx.db, { kind: "webhook", workKey: "webhook:x", payload: {} });
    await enqueue(ctx.db, { kind: "nonsense" as "embed", workKey: "n" });
    await drainQueue(ctx);
    const js = await jobs(ctx);
    expect(js.map((j) => [j.status, j.attempts])).toEqual([
      ["failed", 1],
      ["failed", 1],
    ]);
    expect(js[1]!.last_error).toContain('unknown job kind "nonsense"');
  });

  it("recovers jobs whose lease expired", async () => {
    const ctx = await start({ RECALL_QUEUE_MAX_ATTEMPTS: "2" });
    await ctx.db.execute(
      sql`INSERT INTO jobs (kind, work_key, status, attempts, locked_by, locked_until) VALUES
            ('embed', 'a', 'running', 1, 'dead', now() - interval '1 minute'),
            ('embed', 'b', 'running', 2, 'dead', now() - interval '1 minute'),
            ('reason', 'c', 'running', 1, 'dead', now() - interval '1 minute'),
            ('reason', 'c', 'pending', 0, NULL, NULL),
            ('embed', 'd', 'running', 1, 'alive', now() + interval '1 minute')`,
    );
    expect(await recoverStaleJobs(ctx, 2)).toBe(3);
    const js = await jobs(ctx);
    expect(js.map((j) => `${j.work_key}:${j.status}:${j.attempts}`)).toEqual([
      "a:pending:1",
      "b:failed:2",
      "c:pending:1",
      "d:running:1",
    ]);
    expect(js[0]!.last_error).toContain("lease expired");
  });

  it("wakes immediately on enqueue instead of waiting for the poll interval", async () => {
    const ctx = await start({ RECALL_WORKER_POLL_MS: "60000" });
    const s = await seed(ctx, { peers: ["alice"] });
    const stop = await startWorker(ctx);
    try {
      await new Promise((r) => setTimeout(r, 50));
      const t0 = Date.now();
      await addMessages(ctx, s, [{ peer: "alice", content: "I live in Madrid." }]);
      for (;;) {
        const [m] = await rows<{ done: boolean }>(
          ctx.db,
          sql`SELECT reasoned_at IS NOT NULL AS done FROM messages`,
        );
        if (m!.done) break;
        if (Date.now() - t0 > 5000) throw new Error("worker did not wake");
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await stop();
    }
  });

  it("folds a rescheduled job into a newer pending job with the same key", async () => {
    const ctx = await start({
      RECALL_REASONER_MAX_DELAY_MS: "600000",
      RECALL_REASONER_BATCH_TOKENS: "10000",
    });
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Porto." }]);
    const w = new Worker(ctx);
    const claimed = await w.claim();
    expect(claimed?.kind).toBe("reason");
    // New messages arrive while the job runs: a second pending job appears.
    await addMessages(ctx, s, [{ peer: "alice", content: "I love port wine." }]);
    await (w as unknown as { execute(j: unknown): Promise<void> }).execute(claimed);
    const js = (await jobs(ctx)).filter((j) => j.kind === "reason");
    expect(js).toHaveLength(1);
    expect(js[0]).toMatchObject({ status: "pending", attempts: 0 });
    const [j] = await rows<{ early: boolean }>(
      ctx.db,
      sql`SELECT created_at <= (SELECT min(created_at) FROM messages) + interval '1 second' AS early FROM jobs WHERE kind = 'reason'`,
    );
    expect(j!.early).toBe(true);
  });
});

describe("cards", () => {
  it("validate prefixes, replace entries by label, and cap at 40", () => {
    const { card, changed } = applyCardEdits(
      ["ATTRIBUTE: Location: Amsterdam", "IDENTITY: Name: Alice"],
      [
        "attribute: Location: Berlin",
        "no prefix here",
        "INSTRUCTION: Reply in Dutch",
        `ATTRIBUTE: ${"x".repeat(250)}`,
      ],
      ["IDENTITY: name: alice"],
    );
    expect(changed).toBe(true);
    expect(card).toEqual(["ATTRIBUTE: Location: Berlin", "INSTRUCTION: Reply in Dutch"]);
    const many = applyCardEdits(
      ["IDENTITY: Name: A"],
      Array.from({ length: 45 }, (_, i) => `ATTRIBUTE: fact ${i}`),
      [],
    ).card;
    expect(many).toHaveLength(40);
    expect(many[0]).toBe("IDENTITY: Name: A");
    expect(many.at(-1)).toBe("ATTRIBUTE: fact 44");
  });
});

describe("dream clustering", () => {
  it("is deterministic, respects the size cap, and packs under budgets", () => {
    const v = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    const vectors = [v(0), v(2), v(90), v(88), v(-15), v(180)];
    const clusters = clusterBySimilarity(vectors, { threshold: 0.9, maxSize: 2 });
    expect(clusters).toEqual([[0, 1], [2, 3], [4], [5]]);
    expect(clusterBySimilarity(vectors, { threshold: 0.9, maxSize: 3 })).toEqual([
      [0, 1, 4],
      [2, 3],
      [5],
    ]);
    const groups = packClusters(clusters, () => 10, {
      maxTokensPerCall: 30,
      maxCalls: 2,
      maxTotalTokens: 50,
    });
    expect(groups).toEqual([[[0, 1], [4]], [[2, 3]]]);
    expect(
      packClusters(clusters, () => 10, { maxTokensPerCall: 20, maxCalls: 1, maxTotalTokens: 100 }),
    ).toEqual([[[0, 1]]]);
  });
});
