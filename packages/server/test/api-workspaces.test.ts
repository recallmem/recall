import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../src/http/auth.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

type Server = ApiServer;

describe("workspaces (auth disabled)", () => {
  let s: Server;
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  it("get-or-create returns 201 then 200 and ignores the body for existing workspaces", async () => {
    const created = await s.request("POST", "/v3/workspaces", {
      id: "acme",
      metadata: { a: 1 },
      configuration: { summary: { enabled: false } },
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toMatchObject({
      id: "acme",
      metadata: { a: 1 },
      configuration: { summary: { enabled: false } },
    });
    expect(body.created_at).toMatch(/Z$/);

    const again = await s.request("POST", "/v3/workspaces", { id: "acme", metadata: { a: 2 } });
    expect(again.status).toBe(200);
    expect((await again.json()).metadata).toEqual({ a: 1 });
  });

  it("drops null configuration values on create", async () => {
    const res = await s.request("POST", "/v3/workspaces", {
      id: "nulls",
      configuration: { reasoning: { enabled: null, custom_instructions: "x" }, dream: null },
    });
    expect((await res.json()).configuration).toEqual({ reasoning: { custom_instructions: "x" } });
  });

  it("rejects bad ids with the FastAPI-style 422 array", async () => {
    for (const id of ["has space", "", "a".repeat(513), "scope.x"]) {
      const res = await s.request("POST", "/v3/workspaces", { id });
      expect(res.status, id).toBe(422);
      const body = await res.json();
      expect(Array.isArray(body.detail)).toBe(true);
      expect(body.detail[0].loc[0]).toBe("body");
    }
  });

  it("PUT upserts, replaces metadata, and merges configuration one level deep", async () => {
    const first = await s.request("PUT", "/v3/workspaces/put-ws", {
      metadata: { k: "v" },
      configuration: {
        summary: { enabled: true, messages_per_short_summary: 30 },
        dream: { enabled: false },
      },
    });
    expect(first.status).toBe(200);
    const second = await s.request("PUT", "/v3/workspaces/put-ws", {
      metadata: { other: 1 },
      configuration: { summary: { enabled: false }, custom_instructions: "be brief" },
    });
    const body = await second.json();
    expect(body.metadata).toEqual({ other: 1 });
    // the summary sub-object is replaced wholesale; untouched keys survive
    expect(body.configuration).toEqual({
      summary: { enabled: false },
      dream: { enabled: false },
      custom_instructions: "be brief",
    });
    const noop = await s.request("PUT", "/v3/workspaces/put-ws", {
      metadata: null,
      configuration: null,
    });
    expect((await noop.json()).metadata).toEqual({ other: 1 });
  });

  it("validates configuration", async () => {
    const res = await s.request("PUT", "/v3/workspaces/put-ws", {
      configuration: { summary: { messages_per_short_summary: 40, messages_per_long_summary: 30 } },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain(
      "messages_per_short_summary must be less than",
    );
    const low = await s.request("PUT", "/v3/workspaces/put-ws", {
      configuration: { summary: { messages_per_short_summary: 5 } },
    });
    expect(low.status).toBe(422);
    const long = await s.request("PUT", "/v3/workspaces/put-ws", {
      configuration: { custom_instructions: "word ".repeat(2500) },
    });
    expect(long.status).toBe(422);
    // unknown keys are preserved
    const extra = await s.request("PUT", "/v3/workspaces/put-ws", {
      configuration: { legacy: { x: 1 } },
    });
    expect((await extra.json()).configuration.legacy).toEqual({ x: 1 });
  });

  it("enforces metadata limits", async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i]));
    expect((await s.request("PUT", "/v3/workspaces/meta-ws", { metadata: tooMany })).status).toBe(
      422,
    );
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect((await s.request("PUT", "/v3/workspaces/meta-ws", { metadata: deep })).status).toBe(422);
    const ok = { a: { b: { c: { d: { e: 1 } } } }, list: [{ x: { y: 1 } }] };
    expect((await s.request("PUT", "/v3/workspaces/meta-ws", { metadata: ok })).status).toBe(200);
  });

  it("strips NUL characters from metadata", async () => {
    const res = await s.request("PUT", "/v3/workspaces/nul-ws", {
      metadata: { "k\u0000": "v\u0000alue" },
    });
    expect((await res.json()).metadata).toEqual({ k: "value" });
  });

  it("lists workspaces with offset and cursor envelopes", async () => {
    for (const id of ["l1", "l2", "l3"]) await s.request("POST", "/v3/workspaces", { id });
    const page = await (await s.request("POST", "/v3/workspaces/list?size=2")).json();
    expect(page).toMatchObject({ page: 1, size: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.pages).toBe(Math.ceil(page.total / 2));

    // cursor walk visits every workspace exactly once
    const seen: string[] = [];
    let cursor = "";
    for (let i = 0; i < 20; i++) {
      const res = await (
        await s.request("POST", `/v3/workspaces/list?size=2&cursor=${encodeURIComponent(cursor)}`)
      ).json();
      expect(res.total).toBeNull();
      seen.push(...res.items.map((w: { id: string }) => w.id));
      if (!res.next_page) break;
      cursor = res.next_page;
    }
    const all = await (await s.request("POST", "/v3/workspaces/list?size=100")).json();
    expect(seen).toEqual(all.items.map((w: { id: string }) => w.id));
    expect(new Set(seen).size).toBe(seen.length);

    const reversed = await (
      await s.request("POST", "/v3/workspaces/list?size=100&reverse=true")
    ).json();
    expect(reversed.items.map((w: { id: string }) => w.id)).toEqual([...seen].reverse());
  });

  it("filters the list", async () => {
    await s.request("POST", "/v3/workspaces", { id: "filt-a", metadata: { tier: "gold", n: 5 } });
    await s.request("POST", "/v3/workspaces", {
      id: "filt-b",
      metadata: { tier: "silver", n: 10 },
    });
    const list = async (filters: unknown) =>
      (
        (await (await s.request("POST", "/v3/workspaces/list", { filters })).json()).items as {
          id: string;
        }[]
      ).map((w) => w.id);
    expect(await list({ metadata: { tier: "gold" } })).toEqual(["filt-a"]);
    expect(await list({ metadata: { n: { gt: 7 } } })).toEqual(["filt-b"]);
    expect(await list({ id: { contains: "filt-" } })).toEqual(["filt-a", "filt-b"]);
    expect(
      await list({
        OR: [{ id: "filt-a" }, { id: "filt-b" }],
        NOT: [{ metadata: { tier: "silver" } }],
      }),
    ).toEqual(["filt-a"]);
    const bad = await s.request("POST", "/v3/workspaces/list", { filters: { nope: 1 } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).detail).toContain(
      "Column 'nope' is not allowed to be filtered on or does not exist on Workspace",
    );
  });

  it("rejects an invalid cursor", async () => {
    const res = await s.request("POST", "/v3/workspaces/list?cursor=garbage");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "Invalid cursor" });
    // a cursor minted for another query is rejected too
    const first = await (await s.request("POST", "/v3/workspaces/list?size=1&cursor=")).json();
    const other = await s.request(
      "POST",
      `/v3/workspaces/list?size=1&reverse=true&cursor=${first.next_page}`,
    );
    expect(other.status).toBe(400);
  });

  it("deletes asynchronously and refuses while sessions are active", async () => {
    expect((await s.request("DELETE", "/v3/workspaces/ghost")).status).toBe(404);
    await s.request("PUT", "/v3/workspaces/del-ws/sessions/s1", {});
    const blocked = await s.request("DELETE", "/v3/workspaces/del-ws");
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).detail).toBe(
      "Cannot delete workspace 'del-ws': active session(s) remain. Delete all sessions first.",
    );
    expect((await s.request("DELETE", "/v3/workspaces/del-ws/sessions/s1")).status).toBe(202);
    const ok = await s.request("DELETE", "/v3/workspaces/del-ws");
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ message: "Workspace deletion accepted" });
  });
});

describe("workspaces and keys (auth enabled)", () => {
  const secret = "test-secret";
  let s: Server;
  const bearer = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
  });
  afterAll(() => s.close());

  it("requires a token", async () => {
    const res = await s.request("POST", "/v3/workspaces", { id: "a" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "No access token provided" });
  });

  it("applies the self-authorizing rule on get-or-create", async () => {
    const own = await s.request("POST", "/v3/workspaces", { id: "mine" }, bearer({ w: "mine" }));
    expect(own.status).toBe(201);
    const other = await s.request(
      "POST",
      "/v3/workspaces",
      { id: "theirs" },
      bearer({ w: "mine" }),
    );
    expect(other.status).toBe(401);
    expect(await other.json()).toEqual({ detail: "Unauthorized access to resource" });
    expect(
      (await s.request("POST", "/v3/workspaces", { id: "anything" }, bearer({ ad: true }))).status,
    ).toBe(201);
    // a peer token for the workspace may still call it (reference behaviour)
    expect(
      (await s.request("POST", "/v3/workspaces", { id: "mine" }, bearer({ w: "mine", p: "alice" })))
        .status,
    ).toBe(200);
  });

  it("lists workspaces for admins only", async () => {
    const denied = await s.request("POST", "/v3/workspaces/list", {}, bearer({ w: "mine" }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ detail: "Resource requires admin privileges" });
    expect(
      (await s.request("POST", "/v3/workspaces/list", undefined, bearer({ ad: true }))).status,
    ).toBe(200);
  });

  it("scopes PUT and DELETE to the token's workspace, and denies peer tokens", async () => {
    expect((await s.request("PUT", "/v3/workspaces/mine", {}, bearer({ w: "mine" }))).status).toBe(
      200,
    );
    expect(
      (await s.request("PUT", "/v3/workspaces/theirs", {}, bearer({ w: "mine" }))).status,
    ).toBe(401);
    expect(
      (await s.request("PUT", "/v3/workspaces/mine", {}, bearer({ w: "mine", p: "alice" }))).status,
    ).toBe(401);
    expect(
      (await s.request("DELETE", "/v3/workspaces/mine", undefined, bearer({ w: "mine", s: "s1" })))
        .status,
    ).toBe(401);
  });

  it("mints keys (admin only) and the keys verify", async () => {
    const res = await s.request(
      "POST",
      "/v3/keys?workspace_id=mine&peer_id=alice&expires_at=2999-01-01T00:00:00Z",
      undefined,
      bearer({ ad: true }),
    );
    expect(res.status).toBe(200);
    const { key } = await res.json();
    const { verifyToken } = await import("../src/http/auth.js");
    expect(verifyToken(key, secret)).toMatchObject({
      w: "mine",
      p: "alice",
      exp: Math.floor(Date.parse("2999-01-01T00:00:00Z") / 1000),
    });
    // the minted key works
    expect(
      (
        await s.request(
          "PUT",
          "/v3/workspaces/mine/peers/alice",
          {},
          { authorization: `Bearer ${key}` },
        )
      ).status,
    ).toBe(200);

    const nonAdmin = await s.request(
      "POST",
      "/v3/keys?workspace_id=mine",
      undefined,
      bearer({ w: "mine" }),
    );
    expect(nonAdmin.status).toBe(401);
    const none = await s.request("POST", "/v3/keys", undefined, bearer({ ad: true }));
    expect(none.status).toBe(422);
    expect(await none.json()).toEqual({
      detail: "At least one of workspace_id, peer_id, or session_id must be provided",
    });
    const noWs = await s.request("POST", "/v3/keys?peer_id=alice", undefined, bearer({ ad: true }));
    expect(noWs.status).toBe(422);
    expect(await noWs.json()).toEqual({
      detail: "workspace_id is required when scoping a key to a peer or session",
    });
  });

  it("answers 405 for key minting when auth is off", async () => {
    const open = await createTestServer();
    try {
      const res = await open.request("POST", "/v3/keys?workspace_id=x");
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ detail: "Feature is disabled" });
    } finally {
      await open.close();
    }
  });
});
