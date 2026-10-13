import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleDeleteSession, handleDeleteWorkspace, type JobRow } from "../src/core/jobs.js";
import { rows } from "../src/db/client.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

async function jobFor(
  s: ApiServer,
  kind: string,
  match: { session?: string; workspace?: string },
): Promise<JobRow> {
  const [j] = await rows<{
    id: number | string;
    work_key: string;
    workspace_id: string | null;
    session_id: string | null;
    payload: Record<string, unknown>;
  }>(
    s.ctx.db,
    sql`SELECT id, work_key, workspace_id, session_id, payload FROM jobs
        WHERE kind = ${kind} AND (payload ->> 'session' = ${match.session ?? null} OR payload ->> 'workspace' = ${match.workspace ?? null})
        ORDER BY id DESC LIMIT 1`,
  );
  if (!j) throw new Error(`no ${kind} job`);
  return {
    id: Number(j.id),
    kind,
    workKey: j.work_key,
    workspaceId: j.workspace_id,
    sessionId: j.session_id,
    payload: j.payload,
    attempts: 0,
  };
}

const count = async (s: ApiServer, table: string, where = sql`TRUE`) =>
  Number(
    (
      await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${where}`,
      )
    )[0]!.n,
  );

describe("deletion jobs", () => {
  let s: ApiServer;
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  it("deleting a session removes its data and the conclusions filed under it, nothing else", async () => {
    const w = "dj";
    await s.request("POST", `/v3/workspaces/${w}/sessions`, {
      id: "keep",
      peers: { ann: {}, bob: {} },
    });
    await s.request("POST", `/v3/workspaces/${w}/sessions`, {
      id: "drop",
      peers: { ann: {}, bob: {} },
    });
    for (const session of ["keep", "drop"]) {
      await s.request("POST", `/v3/workspaces/${w}/sessions/${session}/messages`, {
        messages: Array.from({ length: 5 }, (_, i) => ({
          content: `${session} ${i}`,
          peer_id: i % 2 ? "ann" : "bob",
        })),
      });
    }
    await s.request("PUT", `/v3/workspaces/${w}/peers/ann/card`, { peer_card: ["a card"] });
    const created = await s.request("POST", `/v3/workspaces/${w}/conclusions`, {
      conclusions: [
        { content: "from drop", observer_id: "bob", observed_id: "ann", session_id: "drop" },
        { content: "from keep", observer_id: "bob", observed_id: "ann", session_id: "keep" },
        { content: "from nowhere", observer_id: "bob", observed_id: "ann" },
      ],
    });
    expect(created.status).toBe(201);
    const [{ version: before }] = (await rows<{ version: number | string }>(
      s.ctx.db,
      sql`SELECT version FROM collections WHERE card_updated_at IS NULL`,
    )) as [{ version: number | string }];

    expect((await s.request("DELETE", `/v3/workspaces/${w}/sessions/drop`)).status).toBe(202);
    const job = await jobFor(s, "delete_session", { session: "drop" });
    // pending background work for the session is dropped; unrelated work stays
    expect(await count(s, "jobs", sql`kind = 'reason' AND session_id = ${job.sessionId}`)).toBe(1);
    await handleDeleteSession(s.ctx, job);
    expect(await count(s, "jobs", sql`kind = 'reason' AND session_id = ${job.sessionId}`)).toBe(0);

    expect(await count(s, "sessions", sql`name = 'drop'`)).toBe(0);
    expect(await count(s, "messages", sql`content LIKE 'drop %'`)).toBe(0);
    expect(await count(s, "session_peers", sql`session_id = ${job.sessionId}`)).toBe(0);
    expect(await count(s, "messages", sql`content LIKE 'keep %'`)).toBe(5);
    const left = (
      await rows<{ content: string }>(
        s.ctx.db,
        sql`SELECT content FROM conclusions WHERE deleted_at IS NULL ORDER BY content`,
      )
    ).map((c) => c.content);
    expect(left).toEqual(["from keep", "from nowhere"]);
    // the peer card and the peers survive; the affected collection's version moved
    expect((await s.request("GET", `/v3/workspaces/${w}/peers/ann/card`)).status).toBe(200);
    expect(await count(s, "peers", sql`name IN ('ann', 'bob')`)).toBe(2);
    const [{ version: after }] = (await rows<{ version: number | string }>(
      s.ctx.db,
      sql`SELECT version FROM collections WHERE card_updated_at IS NULL`,
    )) as [{ version: number | string }];
    expect(Number(after)).toBeGreaterThan(Number(before));
    // running it again is a no-op
    await handleDeleteSession(s.ctx, job);
    expect(await count(s, "messages", sql`content LIKE 'keep %'`)).toBe(5);
  });

  it("deletes a large session in batches", async () => {
    const w = "big";
    await s.request("POST", `/v3/workspaces/${w}/sessions`, { id: "huge", peers: { ann: {} } });
    for (let i = 0; i < 25; i++) {
      await s.request("POST", `/v3/workspaces/${w}/sessions/huge/messages`, {
        messages: Array.from({ length: 100 }, (_, j) => ({
          content: `m${i}-${j}`,
          peer_id: "ann",
        })),
      });
    }
    expect(
      await count(s, "messages", sql`session_id IN (SELECT id FROM sessions WHERE name = 'huge')`),
    ).toBe(2500);
    await s.request("DELETE", `/v3/workspaces/${w}/sessions/huge`);
    await handleDeleteSession(s.ctx, await jobFor(s, "delete_session", { session: "huge" }));
    expect(await count(s, "messages", sql`content LIKE 'm%-%'`)).toBe(0);
    expect(await count(s, "sessions", sql`name = 'huge'`)).toBe(0);
  });

  it("deleting a workspace removes everything that belongs to it and nothing that does not", async () => {
    const mine = "gone-ws";
    const other = "stays-ws";
    for (const w of [mine, other]) {
      await s.request("POST", `/v3/workspaces/${w}/sessions`, {
        id: "s",
        peers: { ann: {} },
        scopes: ["team"],
      });
      await s.request("POST", `/v3/workspaces/${w}/sessions/s/messages`, {
        messages: [{ content: `msg in ${w}`, peer_id: "ann" }],
      });
      await s.request("POST", `/v3/workspaces/${w}/conclusions`, {
        conclusions: [{ content: `fact in ${w}`, observer_id: "ann", observed_id: "ann" }],
      });
      await s.request("PUT", `/v3/workspaces/${w}/peers/ann/card`, { peer_card: ["card"] });
    }
    const [wsRow] = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM workspaces WHERE name = ${mine}`,
    );
    await s.ctx.db.execute(
      sql`INSERT INTO llm_usage (workspace_id, task, provider, model) VALUES (${wsRow!.id}, 'reasoner', 'mock', 'm')`,
    );
    await s.request("DELETE", `/v3/workspaces/${mine}/sessions/s`);
    await s
      .request("POST", `/v3/workspaces/${mine}/webhooks`, { url: "https://example.com/x" })
      .catch(() => undefined);

    expect((await s.request("DELETE", `/v3/workspaces/${mine}`)).status).toBe(202);
    const job = await jobFor(s, "delete_workspace", { workspace: mine });
    expect(job.workspaceId).toBe(wsRow!.id);
    await handleDeleteWorkspace(s.ctx, job);

    for (const table of [
      "workspaces",
      "peers",
      "sessions",
      "session_peers",
      "messages",
      "conclusions",
      "collections",
      "llm_usage",
      "summary_blocks",
      "webhook_endpoints",
    ]) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      expect(await count(s, table, sql`${sql.raw(column)} = ${wsRow!.id}`), table).toBe(0);
    }
    expect(await count(s, "jobs", sql`workspace_id = ${wsRow!.id} AND id <> ${job.id}`)).toBe(0);
    expect((await s.request("POST", `/v3/workspaces/${mine}/sessions/list`)).status).toBe(200);
    expect(
      (await (await s.request("POST", `/v3/workspaces/${mine}/sessions/list`)).json()).total,
    ).toBe(0);

    // the other workspace is untouched
    expect(await count(s, "messages", sql`content = ${`msg in ${other}`}`)).toBe(1);
    expect(await count(s, "conclusions", sql`content = ${`fact in ${other}`}`)).toBe(1);
    expect(
      (await (await s.request("GET", `/v3/workspaces/${other}/peers/ann/card`)).json()).peer_card,
    ).toEqual(["card"]);
    // a second, duplicate deletion request finds nothing to do
    await handleDeleteWorkspace(s.ctx, job);
  });
});

describe("list endpoints do not issue per-row queries", () => {
  let s: ApiServer;
  beforeAll(async () => {
    s = await createTestServer();
    await s.request("POST", "/v3/workspaces/q/sessions", {
      id: "s",
      peers: { a: {}, b: {}, c: {} },
      scopes: ["sc"],
    });
    const names = ["a", "b", "c"];
    await s.request("POST", "/v3/workspaces/q/sessions/s/messages", {
      messages: Array.from({ length: 60 }, (_, i) => ({ content: `m${i}`, peer_id: names[i % 3] })),
    });
    for (let i = 0; i < 12; i++)
      await s.request("POST", "/v3/workspaces/q/sessions", { id: `x${i}`, peers: { a: {} } });
    await s.request("POST", "/v3/workspaces/q/conclusions", {
      conclusions: Array.from({ length: 12 }, (_, i) => ({
        content: `fact ${i}`,
        observer_id: "a",
        observed_id: "b",
        session_id: "s",
      })),
    });
    await s.request("POST", "/v3/workspaces/q/scopes/sc/sessions", {
      session_ids: ["x0", "x1", "x2"],
    });
  });
  afterAll(() => s.close());

  it("uses at most a data query and a count query per list request", async () => {
    const original = s.ctx.db.execute.bind(s.ctx.db);
    let statements = 0;
    (s.ctx.db as { execute: unknown }).execute = (...args: Parameters<typeof original>) => {
      statements++;
      return original(...args);
    };
    try {
      const routes: [string, string][] = [
        ["POST", "/v3/workspaces/q/peers/list?size=100"],
        ["POST", "/v3/workspaces/q/sessions/list?size=5"],
        ["POST", "/v3/workspaces/q/peers/a/sessions?size=5"],
        ["POST", "/v3/workspaces/q/sessions/s/messages/list?size=20"],
        ["POST", "/v3/workspaces/q/conclusions/list?size=5"],
        ["GET", "/v3/workspaces/q/sessions/s/peers?size=2"],
        ["POST", "/v3/workspaces/q/scopes/list?size=1"],
        ["POST", "/v3/workspaces/q/scopes/sc/sessions/list?size=2"],
        ["POST", "/v3/workspaces/list?size=1"],
        ["POST", "/v3/workspaces/q/sessions/s/messages/list?size=20&cursor="],
      ];
      for (const [method, path] of routes) {
        statements = 0;
        const res = await s.request(method, path);
        expect(res.status, path).toBe(200);
        const limit = path.includes("scopes/sc") ? 3 : 2; // scope routes first resolve the scope
        expect(statements, path).toBeGreaterThanOrEqual(1);
        expect(statements, path).toBeLessThanOrEqual(limit);
      }
    } finally {
      (s.ctx.db as { execute: unknown }).execute = original;
    }
  });
});
