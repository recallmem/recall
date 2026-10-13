import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { newId } from "../src/lib/ids.js";
import { drainQueue, startWorker } from "../src/queue/worker.js";
import {
  canonicalJson,
  emitWebhookEvent,
  isPrivateAddress,
  signBody,
} from "../src/webhooks/index.js";
import { createTestServer } from "./helpers.js";
import { addMessages, conclusions, seed, usageByTask } from "./reasoner-fixtures.js";

type Server = Awaited<ReturnType<typeof createTestServer>>;
let server: Server | null = null;
let http: HttpServer | null = null;
const start = async (env: Record<string, string> = {}) => {
  server = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0", ...env });
  return server;
};
afterEach(async () => {
  await server?.close();
  server = null;
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = null;
});

describe("GET /queue/status", () => {
  it("counts work units per session (keyed by name) and honours filters", async () => {
    const { ctx, request } = await start({ RECALL_REASONER_MAX_DELAY_MS: "600000" });
    const s = await seed(ctx, { peers: ["alice", "bob"], session: "chat-1" });
    await addMessages(ctx, s, [
      { peer: "alice", content: "I live in Utrecht." },
      { peer: "bob", content: "I live in Delft." },
      { peer: "alice", content: "I love cycling." },
    ]);
    const base = `/v3/workspaces/${s.workspaceName}/queue/status`;
    let body = (await (await request("GET", base)).json()) as Record<string, unknown>;
    expect(body).toEqual({
      total_work_units: 1,
      completed_work_units: 0,
      in_progress_work_units: 0,
      pending_work_units: 1,
      sessions: {
        "chat-1": {
          session_id: "chat-1",
          total_work_units: 1,
          completed_work_units: 0,
          in_progress_work_units: 0,
          pending_work_units: 1,
        },
      },
    });
    body = (await (await request("GET", `${base}?sender_id=bob`)).json()) as Record<
      string,
      unknown
    >;
    expect(body.pending_work_units).toBe(1);
    body = (await (await request("GET", `${base}?sender_id=nobody&observer_id=`)).json()) as Record<
      string,
      unknown
    >;
    expect(body.total_work_units).toBe(0);
    body = (await (await request("GET", `${base}?session_id=chat-1`)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ pending_work_units: 1, sessions: null });
    body = (await (await request("GET", `${base}?session_id=missing`)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ total_work_units: 0, sessions: null });
    expect((await request("GET", "/v3/workspaces/nope/queue/status")).status).toBe(404);
  });

  it("with wait_ms flushes waiting batches and returns once the queue is idle", async () => {
    const { ctx, request } = await start({ RECALL_REASONER_MAX_DELAY_MS: "600000" });
    const s = await seed(ctx, { peers: ["alice"] });
    const stop = await startWorker(ctx);
    try {
      await addMessages(ctx, s, [
        { peer: "alice", content: "I live in Ghent. I work as a teacher." },
      ]);
      const res = await request(
        "GET",
        `/v3/workspaces/${s.workspaceName}/queue/status?wait_ms=10000`,
      );
      const body = (await res.json()) as {
        pending_work_units: number;
        in_progress_work_units: number;
        completed_work_units: number;
        idle?: boolean;
      };
      expect(body.pending_work_units + body.in_progress_work_units).toBe(0);
      expect(body.completed_work_units).toBeGreaterThanOrEqual(1);
      expect(body.idle).toBe(true);
      // Without wait_ms the response keeps the reference shape (no `idle`).
      const plain = (await (
        await request("GET", `/v3/workspaces/${s.workspaceName}/queue/status`)
      ).json()) as Record<string, unknown>;
      expect("idle" in plain).toBe(false);
      expect((await conclusions(ctx, s.workspaceId)).length).toBe(2);
    } finally {
      await stop();
    }
  });
});

describe("failed background work", () => {
  it("is reported with wait_ms and can be queued again, a bounded number of times", async () => {
    const { ctx, request } = await start({ RECALL_REASONER_MAX_DELAY_MS: "600000" });
    const s = await seed(ctx, { peers: ["alice"], session: "chat-1" });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Ghent." }]);
    // The provider was down: the reason unit failed for good.
    const fail = () =>
      ctx.db.execute(
        sql`UPDATE jobs SET status = 'failed', finished_at = now(), last_error = 'HTTP 403'
            WHERE workspace_id = ${s.workspaceId} AND kind = 'reason'`,
      );
    await fail();
    const base = `/v3/workspaces/${s.workspaceName}/queue`;
    const status = async (query = "?wait_ms=1") =>
      (await (await request("GET", `${base}/status${query}`)).json()) as Record<string, unknown>;
    expect(await status()).toMatchObject({
      idle: true,
      failed_work_units: 1,
      pending_work_units: 0,
    });
    expect(await status("?wait_ms=1&session_id=chat-1")).toMatchObject({ failed_work_units: 1 });
    // The reference shape stays as it was without wait_ms.
    expect("failed_work_units" in (await status(""))).toBe(false);

    const retry = async () =>
      ((await (await request("POST", `${base}/retry`, {})).json()) as { retried: number }).retried;
    expect(await retry()).toBe(1);
    expect(await status("")).toMatchObject({ pending_work_units: 1 });
    // Already queued: nothing to do.
    expect(await retry()).toBe(0);

    // A unit that keeps failing is retried three times by hand, then left alone.
    for (let i = 0; i < 2; i++) {
      await fail();
      expect(await retry()).toBe(1);
    }
    await fail();
    expect(await retry()).toBe(0);
    expect(await status()).toMatchObject({ failed_work_units: 1 });
  });

  it("no longer counts once a later attempt at the same work succeeded", async () => {
    const { ctx, request } = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Ghent." }]);
    await ctx.db.execute(
      sql`UPDATE jobs SET status = 'failed', finished_at = now() WHERE workspace_id = ${s.workspaceId} AND kind = 'reason'`,
    );
    expect(
      (
        (await (
          await request("POST", `/v3/workspaces/${s.workspaceName}/queue/retry`, {})
        ).json()) as {
          retried: number;
        }
      ).retried,
    ).toBe(1);
    await drainQueue(ctx);
    const body = (await (
      await request("GET", `/v3/workspaces/${s.workspaceName}/queue/status?wait_ms=5000`)
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ idle: true, failed_work_units: 0 });
    expect((await conclusions(ctx, s.workspaceId)).length).toBeGreaterThan(0);
  });
});

describe("dreams", () => {
  it("schedule_dream is idempotent while queued and refuses when dreams are off", async () => {
    let { ctx, request } = await start({ RECALL_DREAMS_ENABLED: "false" });
    let s = await seed(ctx, { peers: ["alice"] });
    let res = await request("POST", `/v3/workspaces/${s.workspaceName}/schedule_dream`, {
      observer: "alice",
      dream_type: "omni",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: "Dreams are not enabled in the system configuration",
    });
    await server!.close();
    ({ ctx, request } = await start());
    s = await seed(ctx, { peers: ["alice"] });
    for (let i = 0; i < 2; i++) {
      res = await request("POST", `/v3/workspaces/${s.workspaceName}/schedule_dream`, {
        observer: "alice",
        observed: "alice",
        dream_type: "omni",
      });
      expect(res.status).toBe(204);
    }
    const js = await rows<{ kind: string; status: string }>(
      ctx.db,
      sql`SELECT kind, status FROM jobs WHERE kind = 'dream'`,
    );
    expect(js).toEqual([{ kind: "dream", status: "pending" }]);
    res = await request("POST", `/v3/workspaces/${s.workspaceName}/schedule_dream`, {
      observer: "alice",
    });
    expect(res.status).toBe(422);
  });

  it("merge duplicates, add inductive patterns with sources, and mark contradictions in one call", async () => {
    const { ctx, request } = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [
      { peer: "alice", content: "I love sushi. I love hiking in the Alps." },
      { peer: "alice", content: "I enjoy reading crime novels." },
    ]);
    await drainQueue(ctx);
    await addMessages(ctx, s, [{ peer: "alice", content: "Honestly, I don't like sushi." }]);
    await drainQueue(ctx);
    // A duplicate learned elsewhere (e.g. another session) that ingest could not see.
    await ctx.db.execute(
      sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, content, level, embedding, internal)
          SELECT ${newId()}, workspace_id, collection_id, observer_id, observed_id, content, level, embedding, '{}'::jsonb
          FROM conclusions WHERE content = 'alice enjoys reading crime novels'`,
    );
    const res = await request("POST", `/v3/workspaces/${s.workspaceName}/schedule_dream`, {
      observer: "alice",
      dream_type: "omni",
    });
    expect(res.status).toBe(204);
    await drainQueue(ctx);

    expect((await usageByTask(ctx, s.workspaceId)).dream?.calls).toBe(1);
    const cs = await conclusions(ctx, s.workspaceId);
    const live = cs.filter((c) => !c.deleted_at && !c.valid_to);
    const reading = cs.filter((c) => c.content === "alice enjoys reading crime novels");
    expect(reading).toHaveLength(2);
    const survivor = reading.find((c) => !c.deleted_at)!;
    expect(survivor.times_derived).toBe(2);
    expect(reading.find((c) => c.deleted_at)!.superseded_by).toBe(survivor.id);
    const inductive = live.find((c) => c.level === "inductive")!;
    expect(inductive.content).toContain("several stated enjoyments");
    expect(inductive.source_ids.length).toBeGreaterThanOrEqual(3);
    const contradiction = live.find((c) => c.level === "contradiction")!;
    expect(contradiction.source_ids).toHaveLength(2);
    const [col] = await rows<{ new_since_dream: number; dreamt: boolean }>(
      ctx.db,
      sql`SELECT new_since_dream, last_dream_at IS NOT NULL AS dreamt FROM collections`,
    );
    expect(col).toEqual({ new_since_dream: 0, dreamt: true });
  });

  it("are scheduled automatically once enough new conclusions pile up", async () => {
    const { ctx } = await start({
      RECALL_DREAM_MIN_NEW_CONCLUSIONS: "3",
      RECALL_DREAM_IDLE_MS: "0",
    });
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [
      { peer: "alice", content: "I love tea. I love chess. I enjoy jazz." },
    ]);
    await drainQueue(ctx);
    expect((await usageByTask(ctx, s.workspaceId)).dream?.calls).toBe(1);
    const live = (await conclusions(ctx, s.workspaceId)).filter((c) => c.level === "inductive");
    expect(live).toHaveLength(1);
  });

  it("card_refresh rebuilds the peer card from current conclusions", async () => {
    const { ctx, request } = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Bern." }]);
    await drainQueue(ctx);
    await ctx.db.execute(
      sql`UPDATE collections SET peer_card = '["ATTRIBUTE: Location: Mars"]'::jsonb`,
    );
    await request("POST", `/v3/workspaces/${s.workspaceName}/schedule_dream`, {
      observer: "alice",
      dream_type: "card_refresh",
      rebuild: true,
    });
    await drainQueue(ctx);
    const [col] = await rows<{ peer_card: string[] }>(
      ctx.db,
      sql`SELECT peer_card FROM collections`,
    );
    expect(col!.peer_card).toEqual(["ATTRIBUTE: Location: Bern"]);
  });
});

describe("GET /usage and /deriver/metrics", () => {
  it("report tokens and cost by task and model, and the backlog", async () => {
    const { ctx, request } = await start();
    const s = await seed(ctx, { peers: ["alice"] });
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Zurich." }]);
    await drainQueue(ctx);
    const usage = (await (
      await request("GET", `/v3/workspaces/${s.workspaceName}/usage`)
    ).json()) as {
      total: { calls: number; input_tokens: number; cost_usd: number };
      by_task: Record<string, { calls: number }>;
      items: { task: string; provider: string; model: string }[];
    };
    expect(usage.by_task.reasoner!.calls).toBe(1);
    expect(usage.by_task.embedding!.calls).toBeGreaterThanOrEqual(1);
    expect(usage.total.input_tokens).toBeGreaterThan(0);
    expect(usage.total.cost_usd).toBe(0);
    expect(usage.items.find((i) => i.task === "reasoner")).toMatchObject({
      provider: "mock",
      model: "default",
    });

    const metrics = (await (await request("GET", "/deriver/metrics")).json()) as Record<
      string,
      unknown
    >;
    expect(metrics).toMatchObject({
      pending_items: 0,
      claimed_work_units: 0,
      embeddings_pending: 0,
      failed_jobs: 0,
    });
    expect(Object.keys(metrics)).toEqual(
      expect.arrayContaining([
        "outstanding_work_seconds",
        "eligible_work_units",
        "dreams_due",
        "measured_at",
      ]),
    );
  });
});

describe("webhooks", () => {
  it("serialise compactly with sorted keys and ASCII escapes, signed with HMAC-SHA256", () => {
    const body = canonicalJson({
      type: "test.event",
      timestamp: "2025-01-01T12:00:00Z",
      data: { workspace_id: "wé", a: null },
    });
    expect(body).toBe(
      '{"data":{"a":null,"workspace_id":"w\\u00e9"},"timestamp":"2025-01-01T12:00:00Z","type":"test.event"}',
    );
    // RFC-style known vector for HMAC-SHA256.
    expect(signBody("The quick brown fox jumps over the lazy dog", "key")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("refuse private and loopback addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isPrivateAddress(a)).toBe(false);
  });

  async function receiver(statuses: number[]) {
    const received: { body: string; signature: string | undefined }[] = [];
    http = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ body, signature: req.headers["x-recall-signature"] as string | undefined });
        // The v3 API's header name carries the same signature.
        expect(req.headers["x-honcho-signature"]).toBe(req.headers["x-recall-signature"]);
        res.statusCode = statuses.shift() ?? 200;
        res.end();
      });
    });
    await new Promise<void>((r) => http!.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/hook`, received };
  }

  it("deliver queue.empty after a session drains, retrying failed deliveries", async () => {
    const { ctx } = await start({
      RECALL_WEBHOOK_SECRET: "s3cret",
      RECALL_WEBHOOK_ALLOW_PRIVATE: "true",
      RECALL_WORKER_RETRY_BASE_MS: "1",
    });
    const { url, received } = await receiver([500]);
    const s = await seed(ctx, { peers: ["alice"], session: "chat-9" });
    await ctx.db.execute(
      sql`INSERT INTO webhook_endpoints (id, workspace_id, url) VALUES (${newId()}, ${s.workspaceId}, ${url})`,
    );
    await addMessages(ctx, s, [{ peer: "alice", content: "I live in Bruges." }]);
    for (let i = 0; i < 20 && received.length < 2; i++) {
      await drainQueue(ctx);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(received).toHaveLength(2);
    const event = JSON.parse(received[1]!.body);
    expect(event).toMatchObject({
      type: "queue.empty",
      data: {
        workspace_id: s.workspaceName,
        queue_type: "representation",
        session_id: "chat-9",
        observer: "alice",
        observed: "alice",
      },
    });
    expect(received[1]!.body).toMatch(
      /^\{"data":\{"observed":"alice","observer":"alice","queue_type"/,
    );
    expect(received[1]!.signature).toBe(signBody(received[1]!.body, "s3cret"));
    const hooks = await rows<{ status: string; attempts: number }>(
      ctx.db,
      sql`SELECT status, attempts FROM jobs WHERE kind = 'webhook'`,
    );
    expect(hooks).toEqual([{ status: "done", attempts: 2 }]);
  });

  it("refuse delivery to private hosts unless allowed, and send nothing without a secret", async () => {
    let { ctx } = await start({ RECALL_WEBHOOK_SECRET: "s3cret" });
    const { url, received } = await receiver([]);
    let s = await seed(ctx, { peers: ["alice"] });
    await ctx.db.execute(
      sql`INSERT INTO webhook_endpoints (id, workspace_id, url) VALUES (${newId()}, ${s.workspaceId}, ${url})`,
    );
    expect(
      await emitWebhookEvent(ctx, {
        workspaceId: s.workspaceId,
        type: "test.event",
        data: { workspace_id: s.workspaceName },
      }),
    ).toBe(1);
    await drainQueue(ctx);
    const [job] = await rows<{ status: string; last_error: string }>(
      ctx.db,
      sql`SELECT status, last_error FROM jobs WHERE kind = 'webhook'`,
    );
    expect(job!.status).toBe("failed");
    expect(job!.last_error).toContain("non-public address 127.0.0.1");
    expect(received).toHaveLength(0);
    await server!.close();

    ({ ctx } = await start());
    s = await seed(ctx, { peers: ["alice"] });
    await ctx.db.execute(
      sql`INSERT INTO webhook_endpoints (id, workspace_id, url) VALUES (${newId()}, ${s.workspaceId}, ${url})`,
    );
    expect(
      await emitWebhookEvent(ctx, { workspaceId: s.workspaceId, type: "test.event", data: {} }),
    ).toBe(0);
  });
});
