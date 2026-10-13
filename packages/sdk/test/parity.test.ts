import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, Recall } from "../src/index.js";
import { recordingFetch, startTestServer, type TestServer } from "./harness.js";

/** Client behaviours closed by the parity audit (docs/PARITY.md). */

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

let counter = 0;
function fresh(opts: ConstructorParameters<typeof Recall>[0] = {}) {
  const workspaceId = `parity-${++counter}-${Math.random().toString(36).slice(2, 7)}`;
  return new Recall({ baseURL: server.url, workspaceId, retryBaseDelay: 5, ...opts });
}

const paths = (calls: { method: string; url: string }[]) =>
  calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace(/^\/v3/, "")}`);

describe("autoCreate: get-or-create handles", () => {
  it("creates the workspace and the peer before the first read, once", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const recall = fresh({ autoCreate: true, fetch: spy });
    const alice = recall.peer("alice");
    expect(calls).toHaveLength(0);

    // A brand-new peer has no card yet: null (not a 404).
    expect(await alice.getCard()).toBeNull();
    const ws = recall.workspaceId;
    expect(paths(calls)).toEqual([
      "POST /workspaces",
      `POST /workspaces/${ws}/peers`,
      `GET /workspaces/${ws}/peers/alice/card`,
    ]);

    await alice.getCard();
    expect(calls).toHaveLength(4); // no second get-or-create
    const ids = (await (await recall.peers()).toArray()).map((p) => p.id);
    expect(ids).toEqual(["alice"]);
  });

  it("creates sessions and scopes on their first read", async () => {
    const recall = fresh({ autoCreate: true });
    const summaries = await recall.session("chat-1").summaries();
    expect(summaries).toMatchObject({ id: "chat-1", shortSummary: null, longSummary: null });
    expect((await (await recall.sessions()).toArray()).map((s) => s.id)).toEqual(["chat-1"]);

    const page = await recall.scope("team").sessions();
    expect(page.items).toEqual([]);
    expect(await recall.scope("team").status()).toEqual({ backfillStatus: {} });
    expect((await (await recall.scopes()).toArray()).map((s) => s.id)).toEqual(["team"]);
  });

  it("is off by default: reads of what was never created are 404s and create nothing", async () => {
    const recall = fresh();
    await expect(recall.peer("alice").getCard()).rejects.toBeInstanceOf(NotFoundError);
    await expect(recall.scope("team").sessions()).rejects.toBeInstanceOf(NotFoundError);
    await expect(recall.scope("team").status()).rejects.toBeInstanceOf(NotFoundError);
    await expect(recall.getMetadata()).resolves.toEqual({}); // the workspace accessor is get-or-create
    expect((await (await recall.peers()).toArray()).length).toBe(0);
    expect((await (await recall.scopes()).toArray()).length).toBe(0);
  });

  it("still sends a scope's pending metadata before its first read", async () => {
    const recall = fresh();
    const scope = recall.scope("team", { metadata: { owner: "ops" } });
    expect(await scope.status()).toEqual({ backfillStatus: {} });
    expect(scope.metadata).toEqual({ owner: "ops" });
    expect((await recall.getScope("team")).metadata).toEqual({ owner: "ops" });
  });

  it("sends a session's pending options before reads too", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const recall = fresh({ fetch: spy });
    const session = recall.session("chat-9", { metadata: { topic: "x" } });
    const page = await session.messages();
    expect(page.items).toEqual([]);
    expect(paths(calls)).toEqual([
      `POST /workspaces/${recall.workspaceId}/sessions`,
      `POST /workspaces/${recall.workspaceId}/sessions/chat-9/messages/list`,
    ]);
    expect(session.metadata).toEqual({ topic: "x" });
  });
});

describe("chat and representation: what memory is read", () => {
  it("rejects scope together with sessions or session, before any request", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const alice = fresh({ fetch: spy }).peer("alice");
    await expect(alice.chat("q", { scope: "team", sessions: ["s1"] })).rejects.toThrow(
      "`scope` and `sessions` are mutually exclusive",
    );
    await expect(alice.chat("q", { scope: "team", session: "s1" })).rejects.toThrow(
      "`scope` and `session` are mutually exclusive",
    );
    await expect(alice.chatStream("q", { scope: "team", sessions: ["s1"] })).rejects.toThrow(
      TypeError,
    );
    await expect(alice.representation({ scope: ["a"], sessions: [] })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("keeps an empty sessions list: it means recall nothing", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const recall = fresh({ fetch: spy });
    const session = recall.session("s1");
    await session.addMessages([
      recall.peer("alice").message("I live in Utrecht and I bake bread."),
    ]);
    await recall.waitForIdle({ timeout: 20_000 });
    const alice = recall.peer("alice");
    expect(await alice.representation()).not.toBe("");

    calls.length = 0;
    expect(await alice.representation({ sessions: [] })).toBe("");
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ filters: { session_id: [] } });

    await alice.chat("Where do I live?", { sessions: [] });
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ filters: { session_id: [] } });
  });
});

describe("Peer.delete (Recall extension)", () => {
  it("erases a peer, its messages and its memory", async () => {
    const recall = fresh();
    const session = recall.session("s1");
    await session.addMessages([
      recall.peer("alice").message("My passport number is X123."),
      recall.peer("bob").message("Noted."),
    ]);
    await recall.conclusions.list(); // the workspace exists
    await recall
      .peer("alice")
      .conclusions.create([{ content: "alice has passport X123", sessionId: "s1" }]);

    const removed = await recall.peer("alice").delete();
    expect(removed).toMatchObject({ peerId: "alice", messagesDeleted: 1, sessionsAffected: 1 });
    expect(removed.conclusionsDeleted).toBeGreaterThanOrEqual(1);

    const left = await (await session.messages()).toArray();
    expect(left.map((m) => m.content)).toEqual(["Noted."]);
    expect((await (await recall.peers()).toArray()).map((p) => p.id)).toEqual(["bob"]);
    await expect(recall.peer("alice").getCard()).rejects.toBeInstanceOf(NotFoundError);
    await expect(recall.peer("alice").delete()).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("uploadFile: object form", () => {
  it("accepts content_type and guesses the type from the name otherwise", async () => {
    const recall = fresh();
    const session = recall.session("docs");
    const bytes = new TextEncoder().encode('{"city": "Utrecht"}');
    const viaSnakeCaseKey = await session.uploadFile(
      { filename: "data.bin", content: bytes, content_type: "application/json" },
      "alice",
    );
    expect(viaSnakeCaseKey[0]!.content).toBe('{"city":"Utrecht"}');
    const guessed = await session.uploadFile(
      { filename: "notes.md", content: new TextEncoder().encode("# Notes\nhello") },
      "alice",
    );
    expect(guessed[0]!.content).toContain("hello");
    const json = await session.uploadFile({ filename: "x.json", content: bytes }, "alice");
    expect(json[0]!.content).toBe('{"city":"Utrecht"}');
  });
});
