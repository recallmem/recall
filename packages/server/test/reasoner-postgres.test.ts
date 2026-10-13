import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { enqueue } from "../src/queue/enqueue.js";
import { Worker } from "../src/queue/worker.js";
import { createTestServer } from "./api-helpers.js";
import { addMessages, conclusions, seed } from "./reasoner-fixtures.js";

/**
 * The pipeline against a real Postgres server, with several workers competing
 * for the same queue. Runs only when RECALL_TEST_DATABASE_URL points at a
 * disposable database (its public schema is dropped).
 */
const url = process.env.RECALL_TEST_DATABASE_URL;

describe.skipIf(!url)("pipeline on postgres", () => {
  it("competing workers keep one job per key and process everything", async () => {
    // A private schema (see api-helpers): dropping `public` would break test files running
    // concurrently, since it drops the vector extension their tables depend on.
    const { ctx, request, close } = await createTestServer({
      RECALL_DATABASE_URL: url!,
      RECALL_REASONER_MAX_DELAY_MS: "600000",
      RECALL_REASONER_BATCH_TOKENS: "60",
      RECALL_WORKER_POLL_MS: "50",
    });
    const workers = [new Worker(ctx), new Worker(ctx), new Worker(ctx)];
    try {
      // Many jobs on few keys, claimed by three workers at once.
      for (let i = 0; i < 40; i++)
        await enqueue(ctx.db, {
          kind: "embed",
          workKey: `k${i % 4}`,
          payload: { session_id: "none" },
        });
      await Promise.all(workers.map((w) => w.runUntilIdle()));
      const [counts] = await rows<{ done: number; other: number }>(
        ctx.db,
        sql`SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status <> 'done')::int AS other FROM jobs`,
      );
      expect(counts).toEqual({ done: 40, other: 0 });

      for (const w of workers) w.start();
      const sessions = await Promise.all(
        ["s1", "s2"].map((name) =>
          seed(ctx, {
            workspace: "pgws",
            session: name,
            peers: ["alice", "bob"],
            observeOthers: ["bob"],
          }),
        ),
      );
      await Promise.all(
        sessions.map(async (s) => {
          for (let i = 0; i < 12; i++) {
            await addMessages(ctx, s, [
              {
                peer: "alice",
                content:
                  i === 0
                    ? "I live in Leiden."
                    : i === 9
                      ? "I moved to Haarlem."
                      : `I enjoy hobby ${i} on weekends.`,
              },
              { peer: "bob", content: `That sounds great, tell me more about number ${i}.` },
            ]);
          }
        }),
      );
      const res = await request("GET", "/v3/workspaces/pgws/queue/status?wait_ms=30000");
      const status = (await res.json()) as {
        pending_work_units: number;
        in_progress_work_units: number;
      };
      expect(status.pending_work_units + status.in_progress_work_units).toBe(0);

      const [m] = await rows<{ left: number; unembedded: number }>(
        ctx.db,
        sql`SELECT count(*) FILTER (WHERE reasoned_at IS NULL)::int AS left,
                   count(*) FILTER (WHERE embedding IS NULL)::int AS unembedded FROM messages`,
      );
      expect(m).toEqual({ left: 0, unembedded: 0 });
      const failed = await rows<{ last_error: string }>(
        ctx.db,
        sql`SELECT last_error FROM jobs WHERE status = 'failed'`,
      );
      expect(failed).toEqual([]);
      const cs = await conclusions(ctx, sessions[0]!.workspaceId);
      for (const observer of ["alice", "bob"]) {
        const live = cs.filter(
          (c) => c.observer === observer && c.observed === "alice" && !c.valid_to && !c.deleted_at,
        );
        expect(live.filter((c) => c.content.includes("lives in")).map((c) => c.content)).toEqual([
          "alice lives in Haarlem",
        ]);
      }
      const usage = (await (await request("GET", "/v3/workspaces/pgws/usage")).json()) as {
        by_task: Record<string, { calls: number }>;
      };
      expect(usage.by_task.reasoner!.calls).toBeGreaterThan(0);
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
      await close();
    }
  });
});
