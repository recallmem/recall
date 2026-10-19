import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

type Server = ApiServer;
const json = async (res: ApiResponse) => res.json();

describe("sessions", () => {
  let s: Server;
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  it("get-or-create returns 201 then 200, creating workspace and peers", async () => {
    const created = await s.request("POST", "/v3/workspaces/w/sessions", {
      id: "chat1",
      metadata: { topic: "x" },
      configuration: { summary: { messages_per_short_summary: 10, messages_per_long_summary: 30 } },
      peers: { alice: { observe_me: true }, bob: { observe_others: true } },
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      id: "chat1",
      is_active: true,
      workspace_id: "w",
      metadata: { topic: "x" },
    });

    const peers = await json(await s.request("GET", "/v3/workspaces/w/sessions/chat1/peers"));
    expect(peers.items.map((p: { id: string }) => p.id)).toEqual(["alice", "bob"]);

    // stored with explicit nulls
    expect(
      await json(await s.request("GET", "/v3/workspaces/w/sessions/chat1/peers/alice/config")),
    ).toEqual({
      observe_me: true,
      observe_others: null,
    });

    // existing: metadata replaced, configuration merged one level deep
    const again = await s.request("POST", "/v3/workspaces/w/sessions", {
      id: "chat1",
      metadata: { replaced: true },
      configuration: { dream: { enabled: false } },
    });
    expect(again.status).toBe(200);
    const body = await json(again);
    expect(body.metadata).toEqual({ replaced: true });
    expect(body.configuration).toEqual({
      summary: { messages_per_short_summary: 10, messages_per_long_summary: 30 },
      dream: { enabled: false },
    });
  });

  it("keeps the config of active members on add, rejoins departed members, and overwrites on set", async () => {
    await s.request("POST", "/v3/workspaces/w/sessions", {
      id: "m1",
      peers: { alice: { observe_others: true } },
    });
    await s.request("POST", "/v3/workspaces/w/sessions/m1/peers", {
      alice: { observe_others: false },
    });
    expect(
      (await json(await s.request("GET", "/v3/workspaces/w/sessions/m1/peers/alice/config")))
        .observe_others,
    ).toBe(true);

    await s.request("DELETE", "/v3/workspaces/w/sessions/m1/peers", ["alice", "unknown"]);
    expect(
      (await json(await s.request("GET", "/v3/workspaces/w/sessions/m1/peers"))).items,
    ).toEqual([]);
    // the config of a departed member is still readable
    expect(
      (await json(await s.request("GET", "/v3/workspaces/w/sessions/m1/peers/alice/config")))
        .observe_others,
    ).toBe(true);

    await s.request("POST", "/v3/workspaces/w/sessions/m1/peers", {
      alice: { observe_others: false },
    });
    expect(
      (await json(await s.request("GET", "/v3/workspaces/w/sessions/m1/peers/alice/config")))
        .observe_others,
    ).toBe(false);

    const set = await s.request("PUT", "/v3/workspaces/w/sessions/m1/peers", {
      alice: { observe_me: false },
      carol: {},
    });
    expect(set.status).toBe(200);
    const config = await json(
      await s.request("GET", "/v3/workspaces/w/sessions/m1/peers/alice/config"),
    );
    expect(config).toEqual({ observe_me: false, observe_others: null });
    const replaced = await s.request("PUT", "/v3/workspaces/w/sessions/m1/peers", { dave: {} });
    expect(replaced.status).toBe(200);
    const names = (
      await json(await s.request("GET", "/v3/workspaces/w/sessions/m1/peers"))
    ).items.map((p: { id: string }) => p.id);
    expect(names).toEqual(["dave"]);
    expect((await s.request("PUT", "/v3/workspaces/w/sessions/nope/peers", {})).status).toBe(404);
  });

  it("add peers creates the session; unknown peers and scope names are validated", async () => {
    const res = await s.request("POST", "/v3/workspaces/w/sessions/created-by-peers/peers", {
      zed: {},
    });
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe("created-by-peers");
    expect(
      (
        await s.request("POST", "/v3/workspaces/w/sessions/created-by-peers/peers", {
          "bad name": {},
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await s.request("POST", "/v3/workspaces/w/sessions/created-by-peers/peers", {
          "scope.x": {},
        })
      ).status,
    ).toBe(422);
  });

  it("limits observers to ten", async () => {
    const peers = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`o${i}`, { observe_others: true }]),
    );
    const res = await s.request("POST", "/v3/workspaces/w/sessions", { id: "many", peers });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe(
      "Cannot create session many with 11 observers. Maximum allowed is 10 observers per session. Observers are peers with 'observe_others' set to true.",
    );
    expect((await s.request("GET", "/v3/workspaces/w/sessions/many/peers")).status).toBe(200);
    const ok = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`o${i}`, { observe_others: true }]),
    );
    await s.request("POST", "/v3/workspaces/w/sessions", { id: "ten", peers: ok });
    await s.request("POST", "/v3/workspaces/w/sessions/ten/peers", { extra: {} });
    const over = await s.request("PUT", "/v3/workspaces/w/sessions/ten/peers/extra/config", {
      observe_others: true,
    });
    expect(over.status).toBe(400);
    // the failed request left nothing behind
    expect(
      (await json(await s.request("GET", "/v3/workspaces/w/sessions/ten/peers/extra/config")))
        .observe_others,
    ).toBeNull();
  });

  it("PUT upserts a session and merges its configuration", async () => {
    const first = await s.request("PUT", "/v3/workspaces/w/sessions/put1", {
      configuration: { summary: { enabled: false } },
    });
    expect(first.status).toBe(200);
    const next = await json(
      await s.request("PUT", "/v3/workspaces/w/sessions/put1", {
        configuration: { dream: { enabled: false } },
        metadata: { a: 1 },
      }),
    );
    expect(next.configuration).toEqual({ summary: { enabled: false }, dream: { enabled: false } });
    const bad = await s.request("PUT", "/v3/workspaces/w/sessions/put1", {
      configuration: { summary: { messages_per_short_summary: 50, messages_per_long_summary: 20 } },
    });
    expect(bad.status).toBe(422);
  });

  it("lists active sessions and filters them", async () => {
    await s.request("POST", "/v3/workspaces/lw/sessions", { id: "a", metadata: { kind: "x" } });
    await s.request("POST", "/v3/workspaces/lw/sessions", { id: "b", metadata: { kind: "y" } });
    await s.request("POST", "/v3/workspaces/lw/sessions", { id: "c", metadata: { kind: "y" } });
    await s.request("DELETE", "/v3/workspaces/lw/sessions/c");
    const ids = async (body?: unknown, q = "") =>
      (await json(await s.request("POST", `/v3/workspaces/lw/sessions/list${q}`, body))).items.map(
        (x: { id: string }) => x.id,
      );
    expect(await ids()).toEqual(["a", "b"]);
    expect(await ids({ filters: { metadata: { kind: "y" } } })).toEqual(["b"]);
    expect(await ids({ filters: { is_active: false } })).toEqual([]);
    expect(await ids(undefined, "?reverse=true")).toEqual(["b", "a"]);
  });

  it("deletes in two phases: inactive at once, hard-deleted by the job", async () => {
    await s.request("POST", "/v3/workspaces/dw/sessions", { id: "gone", peers: { alice: {} } });
    await s.request("POST", "/v3/workspaces/dw/sessions/gone/messages", {
      messages: [{ content: "hello", peer_id: "alice" }],
    });
    const del = await s.request("DELETE", "/v3/workspaces/dw/sessions/gone");
    expect(del.status).toBe(202);
    expect(await json(del)).toEqual({ message: "Session deleted successfully" });
    // a second delete, get-or-create and updates all see the session as missing
    expect((await s.request("DELETE", "/v3/workspaces/dw/sessions/gone")).status).toBe(404);
    expect((await s.request("POST", "/v3/workspaces/dw/sessions", { id: "gone" })).status).toBe(
      404,
    );
    expect((await s.request("PUT", "/v3/workspaces/dw/sessions/gone", {})).status).toBe(404);
    expect((await json(await s.request("POST", "/v3/workspaces/dw/sessions/list"))).items).toEqual(
      [],
    );
    // Before the job runs, reads already find nothing: the conversation is gone for the caller.
    const context = await json(await s.request("GET", "/v3/workspaces/dw/sessions/gone/context"));
    expect(context).toMatchObject({ id: "gone", messages: [], summary: null });
    const summaries = await json(
      await s.request("GET", "/v3/workspaces/dw/sessions/gone/summaries"),
    );
    expect(summaries).toMatchObject({ short_summary: null, long_summary: null });

    const jobs = await rows<{ kind: string; id: number }>(
      s.ctx.db,
      sql`SELECT id, kind FROM jobs WHERE kind = 'delete_session' AND payload ->> 'session' = 'gone'`,
    );
    expect(jobs).toHaveLength(1);
    const { handleDeleteSession } = await import("../src/core/jobs.js");
    const [row] = await rows<{ session_id: string; workspace_id: string }>(
      s.ctx.db,
      sql`SELECT session_id, workspace_id FROM jobs WHERE id = ${jobs[0]!.id}`,
    );
    await handleDeleteSession(s.ctx, {
      id: jobs[0]!.id,
      kind: "delete_session",
      workKey: "k",
      workspaceId: row!.workspace_id,
      sessionId: row!.session_id,
      payload: {},
      attempts: 0,
    });
    const [left] = await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT (SELECT count(*) FROM messages)::int + (SELECT count(*) FROM sessions WHERE name = 'gone')::int AS n`,
    );
    expect(left!.n).toBe(0);
  });

  it("clones a session, optionally up to a message", async () => {
    await s.request("POST", "/v3/workspaces/cw/sessions", {
      id: "orig",
      metadata: { m: 1 },
      peers: { alice: {}, bob: { observe_others: true } },
    });
    const created = await json(
      await s.request("POST", "/v3/workspaces/cw/sessions/orig/messages", {
        messages: [
          { content: "one", peer_id: "alice", metadata: { n: 1 } },
          { content: "two", peer_id: "bob" },
          { content: "three", peer_id: "alice" },
        ],
      }),
    );
    await s.request("DELETE", "/v3/workspaces/cw/sessions/orig/peers", ["bob"]);

    const full = await s.request("POST", "/v3/workspaces/cw/sessions/orig/clone");
    expect(full.status).toBe(201);
    const clone = await json(full);
    expect(clone.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(clone.metadata).toEqual({ m: 1 });
    const msgs = await json(
      await s.request("POST", `/v3/workspaces/cw/sessions/${clone.id}/messages/list`),
    );
    expect(msgs.items.map((m: { content: string }) => m.content)).toEqual(["one", "two", "three"]);
    expect(msgs.items[0].metadata).toEqual({ n: 1 });
    expect(msgs.items[0].id).not.toBe(created[0].id);
    expect(msgs.items[0].token_count).toBe(created[0].token_count);
    // departed members stay departed in the clone
    const members = (
      await json(await s.request("GET", `/v3/workspaces/cw/sessions/${clone.id}/peers`))
    ).items.map((p: { id: string }) => p.id);
    expect(members).toEqual(["alice"]);
    // sequence numbers continue where the clone left off
    await s.request("POST", `/v3/workspaces/cw/sessions/${clone.id}/messages`, {
      messages: [{ content: "four", peer_id: "alice" }],
    });
    const [seq] = await rows<{ seq_in_session: number | string }>(
      s.ctx.db,
      sql`SELECT seq_in_session FROM messages WHERE content = 'four'`,
    );
    expect(Number(seq!.seq_in_session)).toBe(4);

    const partial = await json(
      await s.request("POST", `/v3/workspaces/cw/sessions/orig/clone?message_id=${created[1].id}`),
    );
    const partialMsgs = await json(
      await s.request("POST", `/v3/workspaces/cw/sessions/${partial.id}/messages/list`),
    );
    expect(partialMsgs.items.map((m: { content: string }) => m.content)).toEqual(["one", "two"]);

    const missingMsg = await s.request(
      "POST",
      "/v3/workspaces/cw/sessions/orig/clone?message_id=nope",
    );
    expect(missingMsg.status).toBe(404);
    expect((await json(missingMsg)).detail).toBe("Session not found");
    const missingSession = await s.request("POST", "/v3/workspaces/cw/sessions/none/clone");
    expect((await json(missingSession)).detail).toBe("Original session not found");
  });

  it("clones embeddings and queues embedding-only work just for messages that lack one", async () => {
    await s.request("POST", "/v3/workspaces/ce/sessions", { id: "src", peers: { alice: {} } });
    await s.request("POST", "/v3/workspaces/ce/sessions/src/messages", {
      messages: [
        { content: "embedded already", peer_id: "alice" },
        { content: "not embedded yet", peer_id: "alice" },
      ],
    });
    const vector = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
    await s.ctx.db.execute(
      sql`UPDATE messages SET embedding = ${vector}::vector, embedding_model = 'mock/hash', reasoned_at = now() WHERE content = 'embedded already'`,
    );
    const clone = await json(await s.request("POST", "/v3/workspaces/ce/sessions/src/clone"));
    const copied = await rows<{
      content: string;
      has_embedding: boolean;
      reasoned: boolean;
      internal: { reasoning: boolean; observers: string[] };
    }>(
      s.ctx.db,
      sql`SELECT m.content, (m.embedding IS NOT NULL) AS has_embedding, (m.reasoned_at IS NOT NULL) AS reasoned, m.internal
          FROM messages m JOIN sessions x ON x.id = m.session_id WHERE x.name = ${clone.id} ORDER BY m.seq`,
    );
    expect(copied.map((m) => [m.content, m.has_embedding, m.reasoned])).toEqual([
      ["embedded already", true, true],
      ["not embedded yet", false, false],
    ]);
    // a clone never re-derives conclusions, so nothing observes its messages
    expect(
      copied.every((m) => m.internal.reasoning === false && m.internal.observers.length === 0),
    ).toBe(true);
    const queued = await rows<{ kind: string }>(
      s.ctx.db,
      sql`SELECT j.kind FROM jobs j JOIN sessions x ON x.id = j.session_id WHERE x.name = ${clone.id}`,
    );
    expect(queued.map((j) => j.kind)).toEqual(["reason"]);
  });

  it("merges member config fields and creates a membership when there is none", async () => {
    await s.request("POST", "/v3/workspaces/w/sessions", {
      id: "cfg",
      peers: { alice: { observe_me: true, observe_others: false } },
    });
    expect(
      (
        await s.request("PUT", "/v3/workspaces/w/sessions/cfg/peers/alice/config", {
          observe_others: true,
          observe_me: null,
        })
      ).status,
    ).toBe(204);
    expect(
      await json(await s.request("GET", "/v3/workspaces/w/sessions/cfg/peers/alice/config")),
    ).toEqual({
      observe_me: true,
      observe_others: true,
    });
    // peer must exist; scopes are refused; a missing membership is created
    expect(
      (await s.request("PUT", "/v3/workspaces/w/sessions/cfg/peers/ghost/config", {})).status,
    ).toBe(404);
    expect(
      (await s.request("GET", "/v3/workspaces/w/sessions/cfg/peers/ghost/config")).status,
    ).toBe(404);
    expect((await s.request("GET", "/v3/workspaces/w/sessions/cfg/peers/bob/config")).status).toBe(
      404,
    );
    expect(
      (
        await s.request("PUT", "/v3/workspaces/w/sessions/cfg/peers/bob/config", {
          observe_me: false,
        })
      ).status,
    ).toBe(204);
    expect(
      (await json(await s.request("GET", "/v3/workspaces/w/sessions/cfg/peers/bob/config")))
        .observe_me,
    ).toBe(false);
    expect(
      (await s.request("PUT", "/v3/workspaces/w/sessions/nosess/peers/bob/config", {})).status,
    ).toBe(404);
  });
});

describe("sessions (auth enabled)", () => {
  const secret = "s3cret";
  let s: Server;
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
    const admin = as({ ad: true });
    await s.request(
      "POST",
      "/v3/workspaces/w/sessions",
      { id: "room", peers: { alice: {}, bob: {} } },
      admin,
    );
    await s.request(
      "POST",
      "/v3/workspaces/w/sessions",
      { id: "private", peers: { carol: {} } },
      admin,
    );
    await s.request(
      "POST",
      "/v3/workspaces/w/sessions/room/messages",
      { messages: [{ content: "hi", peer_id: "alice" }] },
      admin,
    );
  });
  afterAll(() => s.close());

  it("applies the member-read policy to peer tokens", async () => {
    const alice = as({ w: "w", p: "alice" });
    expect(
      (await s.request("GET", "/v3/workspaces/w/sessions/room/peers", undefined, alice)).status,
    ).toBe(200);
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions/room/messages/list", undefined, alice))
        .status,
    ).toBe(200);
    expect(
      (await s.request("GET", "/v3/workspaces/w/sessions/private/peers", undefined, alice)).status,
    ).toBe(401);
    // writes are never member-read
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions/room/messages",
          { messages: [{ content: "x", peer_id: "alice" }] },
          alice,
        )
      ).status,
    ).toBe(401);
    expect((await s.request("PUT", "/v3/workspaces/w/sessions/room", {}, alice)).status).toBe(401);
    expect(
      (await s.request("DELETE", "/v3/workspaces/w/sessions/room", undefined, alice)).status,
    ).toBe(401);
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions/list", undefined, alice)).status,
    ).toBe(401);
    // a peer token reads only its own member config
    expect(
      (
        await s.request(
          "GET",
          "/v3/workspaces/w/sessions/room/peers/alice/config",
          undefined,
          alice,
        )
      ).status,
    ).toBe(200);
    expect(
      (await s.request("GET", "/v3/workspaces/w/sessions/room/peers/bob/config", undefined, alice))
        .status,
    ).toBe(401);
    expect(
      (await s.request("PUT", "/v3/workspaces/w/sessions/room/peers/alice/config", {}, alice))
        .status,
    ).toBe(401);
  });

  it("limits session tokens to their own session", async () => {
    const room = as({ w: "w", s: "room" });
    expect(
      (await s.request("GET", "/v3/workspaces/w/sessions/room/peers", undefined, room)).status,
    ).toBe(200);
    expect(
      (await s.request("PUT", "/v3/workspaces/w/sessions/room", { metadata: { a: 1 } }, room))
        .status,
    ).toBe(200);
    expect(
      (await s.request("GET", "/v3/workspaces/w/sessions/private/peers", undefined, room)).status,
    ).toBe(401);
    expect((await s.request("POST", "/v3/workspaces/w/peers/list", undefined, room)).status).toBe(
      401,
    );
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions", { id: "room" }, room)).status,
    ).toBe(200);
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions", { id: "private" }, room)).status,
    ).toBe(401);
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions", { id: "room", scopes: ["team"] }, room))
        .status,
    ).toBe(401);
  });

  it("applies the get-or-create rules for peer tokens", async () => {
    const alice = as({ w: "w", p: "alice" });
    const created = await s.request(
      "POST",
      "/v3/workspaces/w/sessions",
      { id: "mine", peers: { alice: {} } },
      alice,
    );
    expect(created.status).toBe(201);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions",
          { id: "mine2", peers: { alice: {}, bob: {} } },
          alice,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions",
          { id: "mine3", scopes: ["team"] },
          alice,
        )
      ).status,
    ).toBe(401);
    // existing session: members may get it, but not modify it
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions", { id: "room" }, alice)).status,
    ).toBe(200);
    const modify = await s.request(
      "POST",
      "/v3/workspaces/w/sessions",
      { id: "room", metadata: { x: 1 } },
      alice,
    );
    expect(modify.status).toBe(401);
    expect(await json(modify)).toEqual({
      detail: "Peer-scoped keys cannot modify an existing session",
    });
    const outsider = await s.request("POST", "/v3/workspaces/w/sessions", { id: "private" }, alice);
    expect(outsider.status).toBe(401);
    expect(await json(outsider)).toEqual({ detail: "JWT not permissioned for this resource" });
    // workspace tokens may attach scopes
    expect(
      (
        await s.request(
          "POST",
          "/v3/workspaces/w/sessions",
          { id: "scoped", scopes: ["team"] },
          as({ w: "w" }),
        )
      ).status,
    ).toBe(201);
  });
});
