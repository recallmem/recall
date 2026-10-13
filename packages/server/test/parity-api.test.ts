import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../src/http/auth.js";
import { LlmError } from "../src/llm/types.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";
import { seedWorld } from "./recall-helpers.js";

/**
 * Honcho behaviours closed by the parity audit (docs/PARITY.md): the `peer_perspective`
 * message-search filter, the `include_summary` alias on session context, the reference's
 * 503 detail text, and the side-effect-free GET routes Recall adds.
 */

const W = "/v3/workspaces/acme";

describe("parity: peer_perspective on message search", () => {
  let s: ApiServer;
  const contents = (items: { content: string }[]) => items.map((m) => m.content).sort();

  beforeAll(async () => {
    s = await createTestServer();
    const post = async (path: string, body: unknown, method = "POST") => {
      const res = await s.request(method, `${W}${path}`, body);
      expect(res.status, path).toBeLessThan(300);
    };
    // bob is there from the start and leaves; carol arrives late; dave is elsewhere.
    await post("/sessions", { id: "s1", peers: { alice: {}, bob: {} } });
    await post("/sessions/s1/messages", {
      messages: [
        { peer_id: "alice", content: "early note about gardening" },
        { peer_id: "bob", content: "bob replies about gardening" },
      ],
    });
    await post("/sessions/s1/peers", ["bob"], "DELETE");
    await post("/sessions/s1/peers", { carol: {} });
    await post("/sessions/s1/messages", {
      messages: [{ peer_id: "alice", content: "late note about gardening" }],
    });
    await post("/sessions/s2/messages", {
      messages: [{ peer_id: "dave", content: "dave talks about gardening elsewhere" }],
    });
  });
  afterAll(() => s.close());

  const search = async (path: string, filters: unknown) => {
    const res = await s.request("POST", `${W}${path}`, { query: "gardening", limit: 20, filters });
    return { status: res.status, body: await res.json() };
  };

  it("limits a workspace search to what the peer saw while it was a member", async () => {
    const all = await search("/search", null);
    expect(all.body).toHaveLength(4);

    const bob = await search("/search", { peer_perspective: "bob" });
    expect(bob.status).toBe(200);
    expect(contents(bob.body)).toEqual([
      "bob replies about gardening",
      "early note about gardening",
    ]);

    const carol = await search("/search", { peer_perspective: "carol" });
    expect(contents(carol.body)).toEqual(["late note about gardening"]);

    const alice = await search("/search", { peer_perspective: "alice" });
    expect(contents(alice.body)).toEqual([
      "bob replies about gardening",
      "early note about gardening",
      "late note about gardening",
    ]);
  });

  it("always counts a peer's own messages and combines with other filters", async () => {
    const dave = await search("/search", { peer_perspective: "dave" });
    expect(contents(dave.body)).toEqual(["dave talks about gardening elsewhere"]);

    const narrowed = await search("/search", { peer_perspective: "alice", peer_id: "bob" });
    expect(contents(narrowed.body)).toEqual(["bob replies about gardening"]);
  });

  it("works on the peer and session search routes too", async () => {
    const peer = await search("/peers/alice/search", { peer_perspective: "carol" });
    expect(contents(peer.body)).toEqual(["late note about gardening"]);
    const session = await search("/sessions/s1/search", { peer_perspective: "bob" });
    expect(contents(session.body)).toEqual([
      "bob replies about gardening",
      "early note about gardening",
    ]);
  });

  it("returns nothing for an unknown peer and rejects a value that is not a peer id", async () => {
    expect((await search("/search", { peer_perspective: "nobody" })).body).toEqual([]);
    for (const bad of [42, "", "*", null, ["bob"]]) {
      const res = await search("/search", { peer_perspective: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.body.detail).toContain("peer_perspective");
    }
  });
});

describe("parity: session context include_summary and the 503 text", () => {
  let s: ApiServer;
  beforeAll(async () => {
    s = await createTestServer();
    await seedWorld(s.ctx);
  });
  afterAll(() => s.close());

  const summaryOf = async (qs: string) => {
    const res = await s.request("GET", `${W}/sessions/s1/context${qs}`);
    return (await res.json()).summary;
  };

  it("accepts include_summary as Honcho's alias of summary; summary wins when both are sent", async () => {
    expect(await summaryOf("")).not.toBeNull();
    expect(await summaryOf("?include_summary=false")).toBeNull();
    expect(await summaryOf("?include_summary=true")).not.toBeNull();
    expect(await summaryOf("?include_summary=false&summary=true")).not.toBeNull();
  });

  it("reports a provider outage with the reference's detail text", async () => {
    s.ctx.llm.mock.respondWith(() => {
      throw new LlmError("down", "provider");
    });
    try {
      const res = await s.request("POST", `${W}/peers/alice/chat`, { query: "Where to?" });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        detail: "Upstream language model provider is unavailable",
      });
    } finally {
      s.ctx.llm.mock.respondWith(null);
    }
  });
});

describe("parity extension: side-effect-free GET for a workspace, peer or session", () => {
  let s: ApiServer;
  const secret = "parity-secret";
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  const admin = as({ ad: true });

  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
    const res = await s.request(
      "POST",
      `${W}/sessions`,
      { id: "s1", metadata: { topic: "x" }, peers: { alice: {}, bob: {} } },
      admin,
    );
    expect(res.status).toBe(201);
    await s.request("POST", `${W}/scopes`, { id: "work" }, admin);
    await s.request("PUT", `${W}/peers/alice`, { metadata: { tier: "gold" } }, admin);
  });
  afterAll(() => s.close());

  it("returns the same shapes as get-or-create", async () => {
    const ws = await s.request("GET", W, undefined, admin);
    expect(ws.status).toBe(200);
    expect(await ws.json()).toMatchObject({ id: "acme", metadata: {}, configuration: {} });

    const peer = await s.request("GET", `${W}/peers/alice`, undefined, admin);
    expect(await peer.json()).toMatchObject({
      id: "alice",
      workspace_id: "acme",
      metadata: { tier: "gold" },
    });

    const session = await s.request("GET", `${W}/sessions/s1`, undefined, admin);
    expect(await session.json()).toMatchObject({
      id: "s1",
      is_active: true,
      workspace_id: "acme",
      metadata: { topic: "x" },
    });
  });

  it("answers 404 for what does not exist, and creates nothing", async () => {
    expect((await s.request("GET", "/v3/workspaces/ghost", undefined, admin)).status).toBe(404);
    expect((await s.request("GET", `${W}/peers/ghost`, undefined, admin)).status).toBe(404);
    expect((await s.request("GET", `${W}/sessions/ghost`, undefined, admin)).status).toBe(404);
    const list = await s.request("POST", "/v3/workspaces/list", {}, admin);
    expect((await list.json()).items.map((w: { id: string }) => w.id)).toEqual(["acme"]);
    const peers = await s.request("POST", `${W}/peers/list`, {}, admin);
    expect((await peers.json()).items.map((p: { id: string }) => p.id).sort()).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("hides scopes and sessions being deleted", async () => {
    const scope = await s.request("GET", `${W}/peers/scope.work`, undefined, admin);
    expect(scope.status).toBe(422);
    await s.request("POST", `${W}/sessions`, { id: "gone" }, admin);
    expect((await s.request("DELETE", `${W}/sessions/gone`, undefined, admin)).status).toBe(202);
    expect((await s.request("GET", `${W}/sessions/gone`, undefined, admin)).status).toBe(404);
  });

  it("applies Honcho's token rules: workspace, own peer, own session, or member peer", async () => {
    const ws = as({ w: "acme" });
    const alice = as({ w: "acme", p: "alice" });
    const carol = as({ w: "acme", p: "carol" });
    const s1 = as({ w: "acme", s: "s1" });
    const other = as({ w: "other" });
    const get = async (path: string, headers: Record<string, string>) =>
      (await s.request("GET", path, undefined, headers)).status;

    expect(await get(W, ws)).toBe(200);
    expect(await get(W, alice)).toBe(401);
    expect(await get(W, other)).toBe(401);

    expect(await get(`${W}/peers/alice`, ws)).toBe(200);
    expect(await get(`${W}/peers/alice`, alice)).toBe(200);
    expect(await get(`${W}/peers/bob`, alice)).toBe(401);
    expect(await get(`${W}/peers/alice`, s1)).toBe(401);

    expect(await get(`${W}/sessions/s1`, ws)).toBe(200);
    expect(await get(`${W}/sessions/s1`, s1)).toBe(200);
    expect(await get(`${W}/sessions/s1`, alice)).toBe(200);
    expect(await get(`${W}/sessions/s1`, carol)).toBe(401);
  });
});

describe("parity: CORS origins are deployment configuration", () => {
  const preflight = (s: ApiServer, origin: string) =>
    s.app.fetch(
      new Request("http://recall.test/v3/workspaces", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      }),
    );

  it("allows any origin with credentials by default", async () => {
    const s = await createTestServer();
    try {
      const res = await preflight(s, "https://anywhere.example");
      expect(res.headers.get("access-control-allow-origin")).toBe("https://anywhere.example");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await s.close();
    }
  });

  it("answers only the listed origins when RECALL_CORS_ORIGINS is set", async () => {
    const s = await createTestServer({
      RECALL_CORS_ORIGINS: "https://app.example.com/, http://localhost:3000",
    });
    try {
      const ok = await preflight(s, "https://app.example.com");
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
      expect(
        (await preflight(s, "http://localhost:3000")).headers.get("access-control-allow-origin"),
      ).toBe("http://localhost:3000");
      const denied = await preflight(s, "https://evil.example");
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await s.close();
    }
  });
});

describe("parity extension: DELETE a peer (forget a person)", () => {
  let s: ApiServer;
  const secret = "forget-secret";
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  const admin = as({ ad: true });
  const req = async (method: string, path: string, body?: unknown, headers = admin) => {
    const res = await s.request(method, path, body, headers);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
    await req("POST", `${W}/sessions`, {
      id: "s1",
      peers: { alice: {}, bob: { observe_others: true } },
    });
    await req("POST", `${W}/sessions/s1/messages`, {
      messages: [
        { peer_id: "alice", content: "my passport number is X123 and I live in Utrecht" },
        { peer_id: "bob", content: "noted, alice" },
      ],
    });
    await req("POST", `${W}/sessions/s2/messages`, {
      messages: [{ peer_id: "bob", content: "bob alone in s2" }],
    });
    await req("POST", `${W}/scopes`, { id: "work" });
    await req("POST", `${W}/scopes/work/sessions`, { session_ids: ["s1"] });
    await req("POST", `${W}/conclusions`, {
      conclusions: [
        { content: "alice lives in Utrecht", observer_id: "alice", observed_id: "alice" },
        { content: "alice has passport X123", observer_id: "bob", observed_id: "alice" },
        { content: "bob is helpful", observer_id: "bob", observed_id: "bob" },
      ],
    });
    await req("PUT", `${W}/peers/bob/card?target=alice`, { peer_card: ["IDENTITY: alice"] });
    const { sql } = await import("drizzle-orm");
    await s.ctx.db.execute(
      sql`INSERT INTO summary_blocks (id, workspace_id, session_id, kind, start_seq, end_seq, last_message_id, content, token_count)
          SELECT 'sum-alice-0000000000x', s.workspace_id, s.id, 'short', 1, 2, 'm', 'alice gave her passport number', 5
          FROM sessions s WHERE s.name = 's1'`,
    );
  });
  afterAll(() => s.close());

  it("refuses peer and session tokens, scopes and unknown peers", async () => {
    expect(
      (await req("DELETE", `${W}/peers/alice`, undefined, as({ w: "acme", p: "alice" }))).status,
    ).toBe(401);
    expect(
      (await req("DELETE", `${W}/peers/alice`, undefined, as({ w: "acme", s: "s1" }))).status,
    ).toBe(401);
    expect((await req("DELETE", `${W}/peers/alice`, undefined, as({ w: "other" }))).status).toBe(
      401,
    );
    expect((await req("DELETE", `${W}/peers/scope.work`)).status).toBe(422);
    expect((await req("DELETE", `${W}/peers/nobody`)).status).toBe(404);
  });

  it("erases the peer's messages, memory and cards, and keeps everyone else's", async () => {
    const res = await req("DELETE", `${W}/peers/alice`, undefined, as({ w: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      peer_id: "alice",
      deleted: true,
      messages_deleted: 1,
      sessions_affected: 1,
    });
    expect(res.body.conclusions_deleted).toBeGreaterThanOrEqual(2);

    expect((await req("GET", `${W}/peers/alice`)).status).toBe(404);
    const peers = await req("POST", `${W}/peers/list`, {});
    expect(peers.body.items.map((p: { id: string }) => p.id)).toEqual(["bob"]);

    const messages = await req("POST", `${W}/sessions/s1/messages/list`, {});
    expect(messages.body.items.map((m: { content: string }) => m.content)).toEqual([
      "noted, alice",
    ]);
    const hits = await req("POST", `${W}/search`, { query: "passport", limit: 20 });
    expect(hits.body.some((m: { content: string }) => m.content.includes("X123"))).toBe(false);

    const conclusions = await req("POST", `${W}/conclusions/list`, {});
    const left = conclusions.body.items.map((c: { content: string }) => c.content);
    expect(left).toContain("bob is helpful");
    expect(left.some((c: string) => c.includes("alice"))).toBe(false);
    expect((await req("GET", `${W}/peers/bob/card?target=alice`)).body).toEqual({
      peer_card: null,
    });

    // The session lives on; its summary (which quoted alice) is dropped and rebuilt later.
    expect((await req("GET", `${W}/sessions/s1`)).status).toBe(200);
    expect((await req("GET", `${W}/sessions/s1/summaries`)).body.short_summary).toBeNull();
    const { sql } = await import("drizzle-orm");
    const jobs = (await s.ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM jobs j JOIN sessions s ON s.id = j.session_id
          WHERE j.kind = 'summarize' AND j.status = 'pending' AND s.name = 's1'`,
    )) as unknown as { rows: { n: number }[] };
    expect(jobs.rows[0]!.n).toBeGreaterThanOrEqual(1);

    // A later message recreates the peer from scratch.
    await req("POST", `${W}/sessions/s1/messages`, {
      messages: [{ peer_id: "alice", content: "hi again" }],
    });
    expect((await req("GET", `${W}/peers/alice`)).status).toBe(200);
    expect((await req("GET", `${W}/peers/alice/card`)).body).toEqual({ peer_card: null });
  });
});

describe("parity extension: webhook deliveries carry a stable event id", () => {
  it("sends the same X-Recall-Event-Id on every retry, and keeps the signed body Honcho's", async () => {
    const { createServer } = await import("node:http");
    const { drainQueue } = await import("../src/queue/worker.js");
    const { signBody } = await import("../src/webhooks/index.js");
    const received: { body: string; id?: string; signature?: string }[] = [];
    const statuses = [500];
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({
          body,
          id: req.headers["x-recall-event-id"] as string | undefined,
          signature: req.headers["x-honcho-signature"] as string | undefined,
        });
        res.statusCode = statuses.shift() ?? 200;
        res.end();
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as { port: number }).port;
    const s = await createTestServer({
      RECALL_WEBHOOK_SECRET: "hook-secret",
      RECALL_WEBHOOK_ALLOW_PRIVATE: "true",
      RECALL_WORKER_RETRY_BASE_MS: "1",
    });
    try {
      await s.request("POST", "/v3/workspaces", { id: "acme" });
      const ep = await s.request("POST", `${W}/webhooks`, { url: `http://127.0.0.1:${port}/h` });
      expect(ep.status).toBe(201);
      expect((await s.request("GET", `${W}/webhooks/test`)).status).toBe(200);
      for (let i = 0; i < 30 && received.length < 2; i++) {
        await drainQueue(s.ctx);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(received).toHaveLength(2);
      expect(received[0]!.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
      expect(received[1]!.id).toBe(received[0]!.id);
      const event = JSON.parse(received[1]!.body);
      expect(Object.keys(event)).toEqual(["data", "timestamp", "type"]);
      expect(event).toMatchObject({ type: "test.event", data: { workspace_id: "acme" } });
      expect(received[1]!.signature).toBe(signBody(received[1]!.body, "hook-secret"));
    } finally {
      await s.close();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
