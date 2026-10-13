import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleScopeBackfill, handleScopeRemoval, type JobRow } from "../src/core/jobs.js";
import { resolveScopeSessions } from "../src/core/scopes.js";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

type Server = ApiServer;
const json = async (res: ApiResponse) => res.json();

async function jobs(s: Server, kind: string, session?: string): Promise<JobRow[]> {
  const found = await rows<{
    id: number | string;
    kind: string;
    work_key: string;
    workspace_id: string | null;
    session_id: string | null;
    payload: Record<string, unknown>;
  }>(
    s.ctx.db,
    sql`SELECT j.id, j.kind, j.work_key, j.workspace_id, j.session_id, j.payload FROM jobs j
        WHERE j.kind = ${kind} AND (${session ?? null}::text IS NULL OR j.payload ->> 'session' = ${session ?? null})
        ORDER BY j.id`,
  );
  return found.map((j) => ({
    id: Number(j.id),
    kind: j.kind,
    workKey: j.work_key,
    workspaceId: j.workspace_id,
    sessionId: j.session_id,
    payload: j.payload,
    attempts: 0,
  }));
}

describe("scopes", () => {
  let s: Server;
  const ws = "sc";
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  it("get-or-creates scopes: 201, 200, metadata replaced, 409 on a name collision", async () => {
    const created = await s.request("POST", `/v3/workspaces/${ws}/scopes`, {
      id: "alpha",
      metadata: { a: 1 },
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body).toMatchObject({ id: "alpha", metadata: { a: 1 } });
    expect(body.created_at).toMatch(/Z$/);
    const again = await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "alpha" });
    expect(again.status).toBe(200);
    expect((await json(again)).metadata).toEqual({ a: 1 });
    const replaced = await json(
      await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "alpha", metadata: { b: 2 } }),
    );
    expect(replaced.metadata).toEqual({ b: 2 });

    // a scope peer is hidden facade state: flagged, with observe_me=false
    const [row] = await rows<{
      is_scope: boolean;
      configuration: unknown;
      internal: { kind: string };
    }>(
      s.ctx.db,
      sql`SELECT is_scope, configuration, internal FROM peers WHERE name = 'scope.alpha'`,
    );
    expect(row).toMatchObject({
      is_scope: true,
      configuration: { observe_me: false },
      internal: { kind: "scope" },
    });

    // a regular peer that merely carries the reserved prefix is a legacy collision
    const [wsRow] = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM workspaces WHERE name = ${ws}`,
    );
    await s.ctx.db.execute(
      sql`INSERT INTO peers (id, workspace_id, name) VALUES ('legacyLegacyLegacy001', ${wsRow!.id}, 'scope.legacy')`,
    );
    const clash = await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "legacy" });
    expect(clash.status).toBe(409);
    expect((await json(clash)).detail).toMatch(
      /^A peer named 'scope\.legacy' already exists in workspace sc but is not a scope\./,
    );

    for (const id of ["bad id", "scope.x", "", "a".repeat(507)]) {
      expect((await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id })).status, id).toBe(422);
    }
    expect(
      (await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "a".repeat(506) })).status,
    ).toBe(201);
  });

  it("lists and gets scopes", async () => {
    await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "beta" });
    const list = await json(await s.request("POST", `/v3/workspaces/${ws}/scopes/list`));
    expect(list.items.map((x: { id: string }) => x.id).slice(0, 2)).toEqual(
      ["alpha", "a".repeat(506)].slice(0, 1).concat([list.items[1].id]),
    );
    expect(list.items.map((x: { id: string }) => x.id)).toContain("beta");
    expect(list.items.map((x: { id: string }) => x.id)).not.toContain("legacy");
    const reversed = await json(
      await s.request("POST", `/v3/workspaces/${ws}/scopes/list?reverse=true`),
    );
    expect(reversed.items[0].id).toBe("beta");
    expect(await json(await s.request("GET", `/v3/workspaces/${ws}/scopes/beta`))).toMatchObject({
      id: "beta",
      metadata: {},
    });
    const missing = await s.request("GET", `/v3/workspaces/${ws}/scopes/ghost`);
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ detail: "Scope ghost not found in workspace sc" });
    expect((await s.request("GET", `/v3/workspaces/${ws}/scopes/scope.legacy`)).status).toBe(404);
    expect((await s.request("GET", `/v3/workspaces/${ws}/scopes/ghost/status`)).status).toBe(404);
    expect(
      (await s.request("POST", `/v3/workspaces/${ws}/scopes/ghost/sessions/list`)).status,
    ).toBe(404);
  });

  it("adds sessions, lists them, queues a backfill only when a session has messages", async () => {
    await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "team" });
    await s.request("POST", `/v3/workspaces/${ws}/sessions`, { id: "empty" });
    await s.request("POST", `/v3/workspaces/${ws}/sessions`, { id: "full", peers: { ann: {} } });
    await s.request("POST", `/v3/workspaces/${ws}/sessions/full/messages`, {
      messages: [{ content: "hi", peer_id: "ann" }],
    });

    const missing = await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions`, {
      session_ids: ["empty", "nope", "nada"],
    });
    expect(missing.status).toBe(404);
    expect((await json(missing)).detail).toBe(
      "Session(s) ['nope', 'nada'] not found in workspace sc",
    );
    expect(
      (await json(await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions/list`))).items,
    ).toEqual([]);

    const ok = await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions`, {
      session_ids: ["empty", "full"],
    });
    expect(ok.status).toBe(204);
    const members = await json(
      await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions/list`),
    );
    expect(members.items.map((x: { id: string }) => x.id)).toEqual(["empty", "full"]);
    expect(
      (
        await json(
          await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions/list?reverse=true`),
        )
      ).items.map((x: { id: string }) => x.id),
    ).toEqual(["full", "empty"]);

    const backfills = await jobs(s, "scope_backfill");
    expect(backfills.map((j) => j.payload.session)).toEqual(["full"]);
    expect(
      await json(await s.request("GET", `/v3/workspaces/${ws}/scopes/team/status`)),
    ).toMatchObject({
      backfill_status: { full: { state: "pending" } },
    });
    expect(
      (await json(await s.request("GET", `/v3/workspaces/${ws}/scopes/alpha/status`)))
        .backfill_status,
    ).toEqual({});

    // scope memberships are hidden from the session peer routes and don't count as observers
    const peers = await json(await s.request("GET", `/v3/workspaces/${ws}/sessions/full/peers`));
    expect(peers.items.map((p: { id: string }) => p.id)).toEqual(["ann"]);
    const [cfg] = await rows<{ configuration: unknown }>(
      s.ctx.db,
      sql`SELECT sp.configuration FROM session_peers sp JOIN peers p ON p.id = sp.peer_id WHERE p.name = 'scope.team' LIMIT 1`,
    );
    expect(cfg!.configuration).toEqual({ observe_me: false, observe_others: true });

    // re-adding a member is harmless but queues another backfill (reference behaviour)
    await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions`, { session_ids: ["full"] });
    expect(await jobs(s, "scope_backfill")).toHaveLength(2);
    expect(
      (await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions`, { session_ids: [] }))
        .status,
    ).toBe(422);
    expect((await s.request("POST", `/v3/workspaces/${ws}/scopes/team/sessions`, {})).status).toBe(
      422,
    );
  });

  it("creates a session with scopes and backfills when it already has messages", async () => {
    await s.request("POST", `/v3/workspaces/${ws}/sessions`, { id: "pre", peers: { ann: {} } });
    await s.request("POST", `/v3/workspaces/${ws}/sessions/pre/messages`, {
      messages: [{ content: "before", peer_id: "ann" }],
    });
    const res = await s.request("POST", `/v3/workspaces/${ws}/sessions`, {
      id: "pre",
      scopes: ["team", "newscope"],
    });
    expect(res.status).toBe(200);
    expect((await json(await s.request("GET", `/v3/workspaces/${ws}/scopes/newscope`))).id).toBe(
      "newscope",
    );
    const backfills = (await jobs(s, "scope_backfill", "pre")).map((j) => j.payload.scope).sort();
    expect(backfills).toEqual(["newscope", "team"]);
    // a brand-new session has nothing to backfill
    await s.request("POST", `/v3/workspaces/${ws}/sessions`, { id: "fresh", scopes: ["team"] });
    expect(await jobs(s, "scope_backfill", "fresh")).toHaveLength(0);
    const conflict = await s.request("POST", `/v3/workspaces/${ws}/sessions`, {
      id: "x",
      scopes: ["legacy"],
    });
    expect(conflict.status).toBe(409);
    expect(
      (await s.request("POST", `/v3/workspaces/${ws}/sessions`, { id: "y", scopes: ["scope.bad"] }))
        .status,
    ).toBe(422);
  });

  it("stops a removed session from contributing", async () => {
    await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "gate" });
    await s.request("POST", `/v3/workspaces/${ws}/sessions`, {
      id: "g1",
      peers: { zoe: {} },
      scopes: ["gate"],
    });
    await s.request("POST", `/v3/workspaces/${ws}/sessions`, {
      id: "g2",
      peers: { zoe: {} },
      scopes: ["gate"],
    });
    const observersOf = async (session: string) =>
      (
        await rows<{ observers: string[] }>(
          s.ctx.db,
          sql`SELECT m.internal -> 'observers' AS observers FROM messages m JOIN sessions x ON x.id = m.session_id WHERE x.name = ${session} ORDER BY m.seq DESC LIMIT 1`,
        )
      )[0]!.observers.length;
    await s.request("POST", `/v3/workspaces/${ws}/sessions/g1/messages`, {
      messages: [{ content: "one", peer_id: "zoe" }],
    });
    expect(await observersOf("g1")).toBe(2); // zoe and the scope

    const removed = await s.request("DELETE", `/v3/workspaces/${ws}/scopes/gate/sessions/g1`);
    expect(removed.status).toBe(204);
    expect(
      (
        await json(await s.request("POST", `/v3/workspaces/${ws}/scopes/gate/sessions/list`))
      ).items.map((x: { id: string }) => x.id),
    ).toEqual(["g2"]);
    // new messages in the removed session are no longer observed by the scope
    await s.request("POST", `/v3/workspaces/${ws}/sessions/g1/messages`, {
      messages: [{ content: "two", peer_id: "zoe" }],
    });
    expect(await observersOf("g1")).toBe(1);
    await s.request("POST", `/v3/workspaces/${ws}/sessions/g2/messages`, {
      messages: [{ content: "three", peer_id: "zoe" }],
    });
    expect(await observersOf("g2")).toBe(2);

    expect(await jobs(s, "scope_removal", "g1")).toHaveLength(1);
    expect(
      (await json(await s.request("GET", `/v3/workspaces/${ws}/scopes/gate/status`)))
        .backfill_status,
    ).not.toHaveProperty("g1");
    // removing a non-member still succeeds and always queues the reconciliation
    expect((await s.request("DELETE", `/v3/workspaces/${ws}/scopes/gate/sessions/g1`)).status).toBe(
      204,
    );
    expect(await jobs(s, "scope_removal", "g1")).toHaveLength(2);
    expect(
      (await s.request("DELETE", `/v3/workspaces/${ws}/scopes/gate/sessions/nope`)).status,
    ).toBe(404);
    expect(
      (await s.request("DELETE", `/v3/workspaces/${ws}/scopes/ghost/sessions/g1`)).status,
    ).toBe(404);

    const resolved = await resolveScopeSessions(s.ctx.db, { account: "default", name: ws }, [
      "gate",
      "missing",
    ]);
    expect(resolved.sessions.map((x) => x.name)).toEqual(["g2"]);
    expect(resolved.missing).toEqual(["missing"]);
  });

  describe("background jobs", () => {
    async function seed() {
      const w = "job";
      await s.request("POST", `/v3/workspaces/${w}/scopes`, { id: "club" });
      await s.request("POST", `/v3/workspaces/${w}/sessions`, {
        id: "S1",
        peers: { amy: {}, ben: { observe_others: true } },
      });
      await s.request("POST", `/v3/workspaces/${w}/sessions`, { id: "S2", peers: { amy: {} } });
      const ids = Object.fromEntries(
        (
          await rows<{ id: string; name: string }>(
            s.ctx.db,
            sql`SELECT id, name FROM peers WHERE name IN ('amy', 'ben', 'scope.club')`,
          )
        ).map((r) => [r.name, r.id]),
      );
      const sessionIds = Object.fromEntries(
        (
          await rows<{ id: string; name: string }>(
            s.ctx.db,
            sql`SELECT id, name FROM sessions WHERE name IN ('S1', 'S2')`,
          )
        ).map((r) => [r.name, r.id]),
      );
      return { w, ids, sessionIds };
    }

    const makeCollection = async (
      workspaceId: string,
      observer: string,
      observed: string,
      card: string[] = [],
    ) => {
      const id = `col${Math.random().toString(36).slice(2, 12).padEnd(18, "x")}`;
      await s.ctx.db.execute(
        sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id, peer_card, card_updated_at)
            VALUES (${id}, ${workspaceId}, ${observer}, ${observed}, ${JSON.stringify(card)}::jsonb, ${card.length ? new Date() : null})
            ON CONFLICT (observer_id, observed_id) DO UPDATE SET peer_card = EXCLUDED.peer_card RETURNING id`,
      );
      return (
        await rows<{ id: string }>(
          s.ctx.db,
          sql`SELECT id FROM collections WHERE observer_id = ${observer} AND observed_id = ${observed}`,
        )
      )[0]!.id;
    };
    const addConclusion = async (
      workspaceId: string,
      collectionId: string,
      observer: string,
      observed: string,
      session: string | null,
      content: string,
      extra: {
        id?: string;
        level?: string;
        sources?: string[];
        validTo?: Date;
        supersededBy?: string;
        messageIds?: string[];
      } = {},
    ) => {
      const id = extra.id ?? `c${Math.random().toString(36).slice(2, 12).padEnd(20, "x")}`;
      await s.ctx.db.execute(
        sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content, level,
                                     source_ids, message_ids, valid_to, superseded_by, embedding)
            VALUES (${id}, ${workspaceId}, ${collectionId}, ${observer}, ${observed}, ${session}, ${content}, ${extra.level ?? "explicit"},
                    ${`{${(extra.sources ?? []).join(",")}}`}::text[], ${`{${(extra.messageIds ?? []).join(",")}}`}::text[],
                    ${extra.validTo ?? null}, ${extra.supersededBy ?? null}, NULL)`,
      );
      return id;
    };

    it("backfills a session's explicit conclusions into the scope, idempotently", async () => {
      const { w, ids, sessionIds } = await seed();
      const [wsRow] = await rows<{ id: string }>(
        s.ctx.db,
        sql`SELECT id FROM workspaces WHERE name = ${w}`,
      );
      const wsId = wsRow!.id;
      // the same fact is filed under two observers' collections, as the reasoner does
      const self = await makeCollection(wsId, ids.amy!, ids.amy!);
      const ben = await makeCollection(wsId, ids.ben!, ids.amy!);
      await addConclusion(wsId, self, ids.amy!, ids.amy!, sessionIds.S1!, "Amy likes jazz");
      await addConclusion(wsId, ben, ids.ben!, ids.amy!, sessionIds.S1!, "Amy likes jazz");
      const old = await addConclusion(
        wsId,
        self,
        ids.amy!,
        ids.amy!,
        sessionIds.S1!,
        "Amy lived in Rome",
        { validTo: new Date(), supersededBy: "pending" },
      );
      const newer = await addConclusion(
        wsId,
        self,
        ids.amy!,
        ids.amy!,
        sessionIds.S1!,
        "Amy lives in Oslo",
      );
      await s.ctx.db.execute(
        sql`UPDATE conclusions SET superseded_by = ${newer} WHERE id = ${old}`,
      );
      await addConclusion(
        wsId,
        self,
        ids.amy!,
        ids.amy!,
        sessionIds.S2!,
        "Amy is a runner (other session)",
      );
      await addConclusion(wsId, self, ids.amy!, ids.amy!, sessionIds.S1!, "Derived thing", {
        level: "deductive",
      });
      const gone = await addConclusion(
        wsId,
        self,
        ids.amy!,
        ids.amy!,
        sessionIds.S1!,
        "Deleted fact",
      );
      await s.ctx.db.execute(sql`UPDATE conclusions SET deleted_at = now() WHERE id = ${gone}`);

      await s.request("POST", `/v3/workspaces/${w}/sessions/S1/messages`, {
        messages: [{ content: "x", peer_id: "amy" }],
      });
      await s.request("POST", `/v3/workspaces/${w}/scopes/club/sessions`, { session_ids: ["S1"] });
      const [job] = await jobs(s, "scope_backfill", "S1");
      await handleScopeBackfill(s.ctx, job!);

      const copies = await rows<{
        content: string;
        observer_id: string;
        observed_id: string;
        session_id: string;
        valid_to: Date | null;
        superseded_by: string | null;
        internal: { scope_copy_of: string };
        id: string;
      }>(
        s.ctx.db,
        sql`SELECT content, observer_id, observed_id, session_id, valid_to, superseded_by, internal, id FROM conclusions WHERE observer_id = ${ids["scope.club"]!} ORDER BY content`,
      );
      expect(copies.map((c) => c.content)).toEqual([
        "Amy likes jazz",
        "Amy lived in Rome",
        "Amy lives in Oslo",
      ]);
      for (const c of copies) {
        expect(c.observed_id).toBe(ids.amy);
        expect(c.session_id).toBe(sessionIds.S1);
      }
      const rome = copies.find((c) => c.content === "Amy lived in Rome")!;
      const oslo = copies.find((c) => c.content === "Amy lives in Oslo")!;
      expect(rome.valid_to).not.toBeNull();
      expect(rome.superseded_by).toBe(oslo.id);
      expect(oslo.internal.scope_copy_of).toBe(newer);

      expect(
        await json(await s.request("GET", `/v3/workspaces/${w}/scopes/club/status`)),
      ).toMatchObject({
        backfill_status: { S1: { state: "completed", docs_copied: 3 } },
      });
      // the scope now answers conclusion queries about amy from its own collection
      const listed = await json(
        await s.request("POST", `/v3/workspaces/${w}/conclusions/list`, {
          filters: { observer_id: "scope.club" },
        }),
      );
      expect(listed.items).toHaveLength(3);

      // running it again copies nothing
      await handleScopeBackfill(s.ctx, job!);
      expect(
        await json(await s.request("GET", `/v3/workspaces/${w}/scopes/club/status`)),
      ).toMatchObject({
        backfill_status: { S1: { state: "completed", docs_copied: 0 } },
      });
      const [{ n }] = (await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT count(*)::int AS n FROM conclusions WHERE observer_id = ${ids["scope.club"]!}`,
      )) as [{ n: number }];
      expect(n).toBe(3);
    });

    it("skips the backfill when the session has left the scope, and records failures", async () => {
      const { w, ids } = await seed();
      await s.request("POST", `/v3/workspaces/${w}/sessions/S2/messages`, {
        messages: [{ content: "x", peer_id: "amy" }],
      });
      await s.request("POST", `/v3/workspaces/${w}/scopes/club/sessions`, { session_ids: ["S2"] });
      const [job] = (await jobs(s, "scope_backfill", "S2")).slice(-1);
      await s.request("DELETE", `/v3/workspaces/${w}/scopes/club/sessions/S2`);
      await handleScopeBackfill(s.ctx, job!);
      expect(
        (
          await rows<{ n: number }>(
            s.ctx.db,
            sql`SELECT count(*)::int AS n FROM conclusions WHERE observer_id = ${ids["scope.club"]!} AND session_id = ${job!.sessionId}`,
          )
        )[0]!.n,
      ).toBe(0);
      await expect(handleScopeBackfill(s.ctx, { ...job!, payload: {} })).rejects.toThrow(/missing/);
    });

    it("backfills no second copy of a fact the scope already holds, and links history to it", async () => {
      const w = "dup";
      await s.request("POST", `/v3/workspaces/${w}/scopes`, { id: "crew" });
      for (const id of ["SA", "SB"])
        await s.request("POST", `/v3/workspaces/${w}/sessions`, { id, peers: { amy: {} } });
      await s.request("POST", `/v3/workspaces/${w}/scopes/crew/sessions`, { session_ids: ["SA"] });
      const byName = async (table: "peers" | "sessions") =>
        Object.fromEntries(
          (
            await rows<{ id: string; name: string }>(
              s.ctx.db,
              sql`SELECT t.id, t.name FROM ${sql.raw(table)} t JOIN workspaces w ON w.id = t.workspace_id
                  WHERE w.name = ${w}`,
            )
          ).map((r) => [r.name, r.id]),
        );
      const peers = await byName("peers");
      const sessions = await byName("sessions");
      const amy = peers.amy!;
      const scope = peers["scope.crew"]!;
      const [{ id: wsId }] = (await rows<{ id: string }>(
        s.ctx.db,
        sql`SELECT id FROM workspaces WHERE name = ${w}`,
      )) as [{ id: string }];
      // What the scope already learned from SA (as the reasoner files it).
      const scoped = await makeCollection(wsId, scope, amy);
      const oslo = await addConclusion(
        wsId,
        scoped,
        scope,
        amy,
        sessions.SA!,
        "Amy lives in Oslo",
        {
          messageIds: ["mA1"],
        },
      );
      // SB says the same in other words, an older state it replaced, and something new.
      const own = await makeCollection(wsId, amy, amy);
      const sbOslo = await addConclusion(wsId, own, amy, amy, sessions.SB!, "amy lives in  Oslo", {
        messageIds: ["mB1"],
      });
      await addConclusion(wsId, own, amy, amy, sessions.SB!, "Amy lived in Rome", {
        validTo: new Date(),
        supersededBy: sbOslo,
        messageIds: ["mB0"],
      });
      await addConclusion(wsId, own, amy, amy, sessions.SB!, "Amy has a dog", {
        messageIds: ["mB2"],
      });

      await s.request("POST", `/v3/workspaces/${w}/sessions/SB/messages`, {
        messages: [{ content: "x", peer_id: "amy" }],
      });
      await s.request("POST", `/v3/workspaces/${w}/scopes/crew/sessions`, { session_ids: ["SB"] });
      const [job] = (await jobs(s, "scope_backfill", "SB")).slice(-1);
      const inScope = () =>
        rows<{
          id: string;
          content: string;
          valid_to: Date | null;
          superseded_by: string | null;
          times_derived: number;
          message_ids: string[];
        }>(
          s.ctx.db,
          sql`SELECT id, content, valid_to, superseded_by, times_derived, message_ids FROM conclusions
              WHERE collection_id = ${scoped} AND deleted_at IS NULL ORDER BY content`,
        );
      const status = async () =>
        (await json(await s.request("GET", `/v3/workspaces/${w}/scopes/crew/status`)))
          .backfill_status.SB;

      for (const run of [1, 2]) {
        await handleScopeBackfill(s.ctx, job!);
        const facts = await inScope();
        expect(facts.map((f) => f.content)).toEqual([
          "Amy has a dog",
          "Amy lived in Rome",
          "Amy lives in Oslo",
        ]);
        const kept = facts.find((f) => f.content === "Amy lives in Oslo")!;
        expect(kept.id).toBe(oslo);
        // Learned again from SB: reinforced once, with SB's message, however often this runs.
        expect(kept.times_derived).toBe(2);
        expect([...kept.message_ids].sort()).toEqual(["mA1", "mB1"]);
        const rome = facts.find((f) => f.content === "Amy lived in Rome")!;
        expect(rome.valid_to).not.toBeNull();
        expect(rome.superseded_by).toBe(oslo);
        expect(await status()).toMatchObject({
          state: "completed",
          docs_copied: run === 1 ? 2 : 0,
        });
      }
    });

    it("removal soft-deletes the session's scope conclusions, their dependents, and clears cards", async () => {
      const { w, ids, sessionIds } = await seed();
      const [wsRow] = await rows<{ id: string }>(
        s.ctx.db,
        sql`SELECT id FROM workspaces WHERE name = ${w}`,
      );
      const wsId = wsRow!.id;
      const scope = ids["scope.club"]!;
      await s.request("POST", `/v3/workspaces/${w}/scopes/club/sessions`, {
        session_ids: ["S1", "S2"],
      });
      const col = await makeCollection(wsId, scope, ids.amy!, ["Card from both sessions"]);
      const keep = await addConclusion(
        wsId,
        col,
        scope,
        ids.amy!,
        sessionIds.S2!,
        "Kept (session two)",
      );
      const drop = await addConclusion(
        wsId,
        col,
        scope,
        ids.amy!,
        sessionIds.S1!,
        "Dropped (session one)",
      );
      const derived = await addConclusion(
        wsId,
        col,
        scope,
        ids.amy!,
        null,
        "Derived from dropped",
        { level: "deductive", sources: [drop, keep] },
      );
      const nested = await addConclusion(wsId, col, scope, ids.amy!, null, "Derived from derived", {
        level: "inductive",
        sources: [derived],
      });
      const unrelated = await addConclusion(wsId, col, scope, ids.amy!, null, "Derived from kept", {
        level: "deductive",
        sources: [keep],
      });
      // another observer's copy of the same session is not the scope's to remove
      const other = await makeCollection(wsId, ids.amy!, ids.amy!);
      const own = await addConclusion(
        wsId,
        other,
        ids.amy!,
        ids.amy!,
        sessionIds.S1!,
        "Amy's own belief",
      );
      const versionBefore = Number(
        (
          await rows<{ version: number | string }>(
            s.ctx.db,
            sql`SELECT version FROM collections WHERE id = ${col}`,
          )
        )[0]!.version,
      );

      await s.request("DELETE", `/v3/workspaces/${w}/scopes/club/sessions/S1`);
      const [job] = (await jobs(s, "scope_removal", "S1")).slice(-1);
      await handleScopeRemoval(s.ctx, job!);

      const state = Object.fromEntries(
        (
          await rows<{ id: string; deleted_at: Date | null }>(
            s.ctx.db,
            sql`SELECT id, deleted_at FROM conclusions`,
          )
        ).map((r) => [r.id, r.deleted_at !== null]),
      );
      expect(state[drop]).toBe(true);
      expect(state[derived]).toBe(true);
      expect(state[nested]).toBe(true);
      expect(state[keep]).toBe(false);
      expect(state[unrelated]).toBe(false);
      expect(state[own]).toBe(false);
      const [card] = await rows<{ peer_card: string[]; version: number | string }>(
        s.ctx.db,
        sql`SELECT peer_card, version FROM collections WHERE id = ${col}`,
      );
      expect(card!.peer_card).toEqual([]);
      expect(Number(card!.version)).toBeGreaterThan(versionBefore);
      // a card rebuild is queued
      const dreams = await rows<{ payload: { type: string; rebuild: boolean } }>(
        s.ctx.db,
        sql`SELECT payload FROM jobs WHERE kind = 'dream'`,
      );
      expect(
        dreams.some((d) => d.payload.type === "card_refresh" && d.payload.rebuild === true),
      ).toBe(true);

      // if the session rejoined in the meantime, nothing more is removed
      await s.request("POST", `/v3/workspaces/${w}/scopes/club/sessions`, { session_ids: ["S1"] });
      const again = await addConclusion(
        wsId,
        col,
        scope,
        ids.amy!,
        sessionIds.S1!,
        "Re-added fact",
      );
      await handleScopeRemoval(s.ctx, job!);
      expect(
        (
          await rows<{ deleted_at: Date | null }>(
            s.ctx.db,
            sql`SELECT deleted_at FROM conclusions WHERE id = ${again}`,
          )
        )[0]!.deleted_at,
      ).toBeNull();
    });
  });
});

describe("scopes (auth enabled)", () => {
  const secret = "s3cret";
  let s: Server;
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
    await s.request("POST", "/v3/workspaces/w/scopes", { id: "team" }, as({ ad: true }));
  });
  afterAll(() => s.close());

  it("requires a workspace or admin token on every scope route", async () => {
    const routes: [string, string, unknown?][] = [
      ["POST", "/v3/workspaces/w/scopes", { id: "x" }],
      ["POST", "/v3/workspaces/w/scopes/list"],
      ["GET", "/v3/workspaces/w/scopes/team"],
      ["GET", "/v3/workspaces/w/scopes/team/status"],
      ["POST", "/v3/workspaces/w/scopes/team/sessions/list"],
      ["POST", "/v3/workspaces/w/scopes/team/sessions", { session_ids: ["a"] }],
      ["DELETE", "/v3/workspaces/w/scopes/team/sessions/a"],
    ];
    for (const [method, path, body] of routes) {
      for (const claims of [{ w: "w", p: "alice" }, { w: "w", s: "a" }, { w: "other" }]) {
        expect(
          (await s.request(method, path, body, as(claims))).status,
          `${method} ${path} ${JSON.stringify(claims)}`,
        ).toBe(401);
      }
    }
    expect(
      (await s.request("GET", "/v3/workspaces/w/scopes/team", undefined, as({ w: "w" }))).status,
    ).toBe(200);
    expect(
      (await s.request("GET", "/v3/workspaces/w/scopes/team", undefined, as({ ad: true }))).status,
    ).toBe(200);
  });
});
