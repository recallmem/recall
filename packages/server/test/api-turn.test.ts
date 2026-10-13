import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

const url = (ws: string, session: string) => `/v3/workspaces/${ws}/sessions/${session}/turn`;

describe("turn", () => {
  let s: ApiServer;
  beforeAll(async () => {
    s = await createTestServer();
  });
  afterAll(() => s.close());

  const count = async (session: string) =>
    (
      await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT count(*)::int AS n FROM messages m JOIN sessions x ON x.id = m.session_id WHERE x.name = ${session}`,
      )
    )[0]!.n;

  it("stores the messages and returns them inside the session context", async () => {
    const res = await s.request("POST", url("w", "t1"), {
      messages: [
        { content: "My name is Alice and I live in Utrecht.", peer_id: "alice" },
        { content: "Nice to meet you, Alice.", peer_id: "bot", metadata: { turn: 1 } },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
      "My name is Alice and I live in Utrecht.",
      "Nice to meet you, Alice.",
    ]);
    expect(body.messages[1]).toMatchObject({
      peer_id: "bot",
      session_id: "t1",
      workspace_id: "w",
      metadata: { turn: 1 },
    });
    expect(body.context.id).toBe("t1");
    expect(body.context.messages.map((m: { id: string }) => m.id)).toEqual(
      body.messages.map((m: { id: string }) => m.id),
    );
    expect(body.context.summary).toBeNull();
    expect(body.context.peer_representation).toBeNull();

    // The next turn sees the earlier turn's messages too.
    const next = await (
      await s.request("POST", url("w", "t1"), {
        messages: [{ content: "What city do I live in?", peer_id: "alice" }],
      })
    ).json();
    expect(next.context.messages).toHaveLength(3);
    expect(next.context.messages.at(-1).content).toBe("What city do I live in?");
  });

  it("honours Idempotency-Key: a retried turn stores nothing twice", async () => {
    const body = { messages: [{ content: "Only once, please.", peer_id: "alice" }] };
    const headers = { "idempotency-key": "turn-key-1" };
    const first = await (await s.request("POST", url("w", "t2"), body, headers)).json();
    const retry = await s.request("POST", url("w", "t2"), body, headers);
    expect(retry.status).toBe(201);
    const second = await retry.json();
    expect(second.messages.map((m: { id: string }) => m.id)).toEqual(
      first.messages.map((m: { id: string }) => m.id),
    );
    expect(second.context.messages).toHaveLength(1);
    expect(await count("t2")).toBe(1);

    // The same key is shared with the plain message-create route.
    const viaMessages = await s.request(
      "POST",
      "/v3/workspaces/w/sessions/t2/messages",
      body,
      headers,
    );
    expect((await viaMessages.json())[0].id).toBe(first.messages[0].id);
    expect(await count("t2")).toBe(1);
  });

  it("applies context options: token budget, summary and the peer representation and card", async () => {
    await s.request("POST", "/v3/workspaces/w/conclusions", {
      conclusions: [
        { content: "Alice lives in Utrecht", observer_id: "alice", observed_id: "alice" },
      ],
    });
    await s.request("PUT", "/v3/workspaces/w/peers/alice/card", {
      peer_card: ["Lives in Utrecht"],
    });
    const res = await s.request("POST", url("w", "t3"), {
      messages: [
        { content: "first message that is moderately long", peer_id: "alice" },
        { content: "second", peer_id: "bot" },
      ],
      context: { peer_target: "alice", summary: false, tokens: 5000 },
    });
    const body = await res.json();
    expect(body.context.peer_representation).toContain("Utrecht");
    expect(body.context.peer_card).toEqual(["Lives in Utrecht"]);
    expect(body.context.messages).toHaveLength(2);

    const tiny = await (
      await s.request("POST", url("w", "t3"), {
        messages: [{ content: "third", peer_id: "alice" }],
        context: { tokens: 0 },
      })
    ).json();
    expect(tiny.messages).toHaveLength(1);
    expect(tiny.context.messages).toEqual([]);
  });

  it("rejects an invalid context request before writing anything", async () => {
    const res = await s.request("POST", url("w", "t4"), {
      messages: [{ content: "should not be stored", peer_id: "alice" }],
      context: { peer_perspective: "bob" },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe(
      "peer_target must be provided if peer_perspective is provided",
    );
    expect(await count("t4")).toBe(0);
  });

  it("validates the message list like message create does", async () => {
    expect((await s.request("POST", url("w", "t5"), { messages: [] })).status).toBe(422);
    expect((await s.request("POST", url("w", "t5"), {})).status).toBe(422);
    expect(
      (
        await s.request("POST", url("w", "t5"), {
          messages: [{ content: "x", peer_id: "alice" }],
          context: { tokens: -1 },
        })
      ).status,
    ).toBe(422);
  });
});

describe("turn (auth enabled)", () => {
  const secret = "s3cret";
  let s: ApiServer;
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  const body = { messages: [{ content: "hi", peer_id: "alice" }] };
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
  });
  afterAll(() => s.close());

  it("follows the message-create policy: workspace and own-session tokens only", async () => {
    expect((await s.request("POST", url("w", "s"), body)).status).toBe(401);
    expect((await s.request("POST", url("w", "s"), body, as({ w: "w" }))).status).toBe(201);
    expect((await s.request("POST", url("w", "s"), body, as({ w: "w", s: "s" }))).status).toBe(201);
    expect((await s.request("POST", url("w", "s"), body, as({ w: "w", s: "x" }))).status).toBe(401);
    expect((await s.request("POST", url("w", "s"), body, as({ w: "w", p: "alice" }))).status).toBe(
      401,
    );
    expect((await s.request("POST", url("w", "s"), body, as({ w: "other" }))).status).toBe(401);
    expect((await s.request("POST", url("w", "s"), body, as({ ad: true }))).status).toBe(201);
  });
});
