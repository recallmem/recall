import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../src/http/auth.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

type Server = ApiServer;
const json = async (res: ApiResponse) => res.json();

describe("peers", () => {
  let s: Server;
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  it("get-or-create returns 201 then 200, auto-creating the workspace", async () => {
    const created = await s.request("POST", "/v3/workspaces/w1/peers", {
      id: "alice",
      metadata: { role: "admin" },
      configuration: { observe_me: false },
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      id: "alice",
      workspace_id: "w1",
      metadata: { role: "admin" },
      configuration: { observe_me: false },
    });
    const workspace = await s.request("POST", "/v3/workspaces", { id: "w1" });
    expect(workspace.status).toBe(200);

    // an existing peer's provided fields are replaced wholesale (no merge)
    const again = await json(
      await s.request("POST", "/v3/workspaces/w1/peers", { id: "alice", metadata: { other: 1 } }),
    );
    expect(again.metadata).toEqual({ other: 1 });
    expect(again.configuration).toEqual({ observe_me: false });
  });

  it("validates ids and rejects the reserved scope prefix", async () => {
    for (const id of ["bad id", "scope.x", ""]) {
      const res = await s.request("POST", "/v3/workspaces/w1/peers", { id });
      expect(res.status, id).toBe(422);
    }
  });

  it("PUT creates the peer and replaces configuration instead of merging", async () => {
    const res = await s.request("PUT", "/v3/workspaces/w1/peers/bob", {
      configuration: { a: 1, b: 2 },
    });
    expect(res.status).toBe(200);
    const next = await json(
      await s.request("PUT", "/v3/workspaces/w1/peers/bob", {
        configuration: { c: 3 },
        metadata: { m: 1 },
      }),
    );
    expect(next.configuration).toEqual({ c: 3 });
    expect(next.metadata).toEqual({ m: 1 });
    expect((await s.request("PUT", "/v3/workspaces/w1/peers/bad.name", {})).status).toBe(422);
  });

  it("lists peers, excluding scopes unless asked", async () => {
    await s.request("POST", "/v3/workspaces/w1/scopes", { id: "team" });
    const names = async (body?: unknown, query = "") =>
      (await json(await s.request("POST", `/v3/workspaces/w1/peers/list${query}`, body))).items.map(
        (p: { id: string }) => p.id,
      );
    expect(await names()).toEqual(["alice", "bob"]);
    expect(await names({ kind: "scope" })).toEqual(["scope.team"]);
    expect(await names({ kind: "all" })).toEqual(["alice", "bob", "scope.team"]);
    expect(await names(undefined, "?reverse=true")).toEqual(["bob", "alice"]);
    expect(await names({ filters: { metadata: { role: "admin" } } })).toEqual([]);
    expect(await names({ filters: { id: { in: ["bob"] } } })).toEqual(["bob"]);
    const unknown = await s.request("POST", "/v3/workspaces/w1/peers/list", {
      filters: { session_id: "x" },
    });
    expect(unknown.status).toBe(422);
    expect((await json(unknown)).detail).toBe("Column 'session_id' does not exist on Peer");
    // unknown workspace: empty page, not an error
    expect((await json(await s.request("POST", "/v3/workspaces/nope/peers/list"))).total).toBe(0);
  });

  it("refuses to update a scope through the peer route", async () => {
    const res = await s.request("PUT", "/v3/workspaces/w1/peers/scope.team", {
      metadata: { a: 1 },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).detail).toBe(
      "Peer 'scope.team' is a scope. Use the scopes routes to manage scopes.",
    );
  });

  it("lists the sessions of a peer including departed and inactive ones", async () => {
    await s.request("POST", "/v3/workspaces/w1/sessions", { id: "s-active", peers: { alice: {} } });
    await s.request("POST", "/v3/workspaces/w1/sessions", {
      id: "s-left",
      peers: { alice: {}, bob: {} },
    });
    await s.request("POST", "/v3/workspaces/w1/sessions", {
      id: "s-deleted",
      peers: { alice: {} },
    });
    await s.request("DELETE", "/v3/workspaces/w1/sessions/s-left/peers", ["alice"]);
    await s.request("DELETE", "/v3/workspaces/w1/sessions/s-deleted");
    const page = await json(await s.request("POST", "/v3/workspaces/w1/peers/alice/sessions"));
    expect(page.items.map((x: { id: string }) => x.id)).toEqual([
      "s-active",
      "s-left",
      "s-deleted",
    ]);
    expect(page.items[2].is_active).toBe(false);
    const filtered = await json(
      await s.request("POST", "/v3/workspaces/w1/peers/alice/sessions", {
        filters: { is_active: true },
      }),
    );
    expect(filtered.items.map((x: { id: string }) => x.id)).toEqual(["s-active", "s-left"]);
    expect(
      (await json(await s.request("POST", "/v3/workspaces/w1/peers/nobody/sessions"))).items,
    ).toEqual([]);
  });

  it("reads and writes peer cards", async () => {
    expect((await s.request("GET", "/v3/workspaces/w1/peers/ghost/card")).status).toBe(404);
    expect(await json(await s.request("GET", "/v3/workspaces/w1/peers/alice/card"))).toEqual({
      peer_card: null,
    });

    const set = await s.request("PUT", "/v3/workspaces/w1/peers/alice/card", {
      peer_card: ["Likes tea", "Lives in Utrecht"],
    });
    expect(await json(set)).toEqual({ peer_card: ["Likes tea", "Lives in Utrecht"] });
    expect(await json(await s.request("GET", "/v3/workspaces/w1/peers/alice/card"))).toEqual({
      peer_card: ["Likes tea", "Lives in Utrecht"],
    });

    // a card about another peer is stored separately and creates the observer
    await s.request("PUT", "/v3/workspaces/w1/peers/carol/card?target=alice", {
      peer_card: ["Alice is a tea drinker"],
    });
    expect(
      await json(await s.request("GET", "/v3/workspaces/w1/peers/carol/card?target=alice")),
    ).toEqual({
      peer_card: ["Alice is a tea drinker"],
    });
    expect(await json(await s.request("GET", "/v3/workspaces/w1/peers/carol/card"))).toEqual({
      peer_card: null,
    });

    // replaced wholesale, empty list allowed
    await s.request("PUT", "/v3/workspaces/w1/peers/alice/card", { peer_card: [] });
    expect(await json(await s.request("GET", "/v3/workspaces/w1/peers/alice/card"))).toEqual({
      peer_card: [],
    });

    const scopeTarget = await s.request(
      "PUT",
      "/v3/workspaces/w1/peers/alice/card?target=scope.team",
      { peer_card: ["x"] },
    );
    expect(scopeTarget.status).toBe(422);
    expect(
      (await s.request("PUT", "/v3/workspaces/w1/peers/alice/card", { peer_card: "nope" })).status,
    ).toBe(422);
  });

  it("bumps the collection version on every card write", async () => {
    const { rows } = (await s.ctx.db.execute(
      (
        await import("drizzle-orm")
      )
        .sql`SELECT version FROM collections c JOIN peers p ON p.id = c.observer_id WHERE p.name = 'alice' AND c.observed_id = p.id`,
    )) as unknown as { rows: { version: number | string }[] };
    expect(Number(rows[0]!.version)).toBeGreaterThanOrEqual(2);
  });
});

describe("peers (auth enabled)", () => {
  const secret = "s3cret";
  let s: Server;
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
  });
  afterAll(() => s.close());

  it("lets a workspace token create any peer but a peer token only itself", async () => {
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers", { id: "alice" }, as({ w: "w" }))).status,
    ).toBe(201);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/peers",
          { id: "alice" },
          as({ w: "w", p: "alice" }),
        )
      ).status,
    ).toBe(200);
    const other = await s.request(
      "POST",
      "/v3/workspaces/w/peers",
      { id: "bob" },
      as({ w: "w", p: "alice" }),
    );
    expect(other.status).toBe(401);
    expect(await json(other)).toEqual({ detail: "Unauthorized access to resource" });
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers", { id: "bob" }, as({ w: "w", s: "sess" })))
        .status,
    ).toBe(401);
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers", { id: "bob" }, as({ w: "other" }))).status,
    ).toBe(401);
    // a token without a workspace claim cannot create peers anywhere (the reference lets it)
    expect((await s.request("POST", "/v3/workspaces/w/peers", { id: "bob" }, as({}))).status).toBe(
      401,
    );
  });

  it("limits peer tokens to their own peer routes", async () => {
    await s.request("POST", "/v3/workspaces/w/peers", { id: "bob" }, as({ ad: true }));
    const alice = as({ w: "w", p: "alice" });
    expect(
      (await s.request("PUT", "/v3/workspaces/w/peers/alice", { metadata: { a: 1 } }, alice))
        .status,
    ).toBe(200);
    expect((await s.request("PUT", "/v3/workspaces/w/peers/bob", {}, alice)).status).toBe(401);
    expect(
      (await s.request("GET", "/v3/workspaces/w/peers/alice/card", undefined, alice)).status,
    ).toBe(200);
    expect(
      (await s.request("GET", "/v3/workspaces/w/peers/bob/card", undefined, alice)).status,
    ).toBe(401);
    expect((await s.request("POST", "/v3/workspaces/w/peers/list", undefined, alice)).status).toBe(
      401,
    );
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers/alice/sessions", undefined, alice)).status,
    ).toBe(200);
  });
});
