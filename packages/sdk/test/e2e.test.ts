import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  NotFoundError,
  Recall,
  RecallError,
  ServerError,
  TimeoutError,
  UnprocessableEntityError,
} from "../src/index.js";
import { recordingFetch, startTestServer, type TestServer } from "./harness.js";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

let counter = 0;
/** A client in a fresh workspace, so tests do not see each other's data. */
function fresh(opts: ConstructorParameters<typeof Recall>[0] = {}) {
  const workspaceId = `ws-${++counter}-${Math.random().toString(36).slice(2, 7)}`;
  return new Recall({ baseURL: server.url, workspaceId, retryBaseDelay: 5, ...opts });
}

describe("lazy handles", () => {
  it("send a peer's pending settings before its first message, not after", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const recall = fresh({ fetch: spy });
    const npc = recall.peer("npc", { configuration: { observeMe: false } });
    const scene = recall.session("scene", {
      peers: [recall.peer("player"), [npc, { observeOthers: true }]],
    });
    await scene.addMessages([npc.message("Welcome, traveller.")]);
    const route = (c: { method: string; url: string }) =>
      `${c.method} ${new URL(c.url).pathname.split("/").slice(4).join("/")}`;
    expect(calls.map(route)).toEqual([
      "POST peers",
      "POST sessions",
      "POST sessions/scene/messages",
    ]);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ configuration: { observe_me: false } });
    // A message alone carries its author's settings too, also through turn().
    const bard = recall.peer("bard", { configuration: { observeMe: false } });
    await scene.turn([bard.message("A song!")]);
    expect((await recall.peer("bard").getConfiguration()).observeMe).toBe(false);
    // The handle never leaks into the request body.
    expect(calls.at(-2)!.body).not.toContain("recall.author");
  });

  it("make no request until they are used, and then only the ones needed", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const recall = fresh({ fetch: spy });
    const alice = recall.peer("alice", { metadata: { plan: "pro" } });
    const session = recall.session("chat-1", { peers: ["alice", "bot"] });
    const scope = recall.scope("team");
    expect(calls).toHaveLength(0);
    expect(alice.metadata).toBeUndefined();
    expect(String(alice)).toBe("Peer(alice)");

    // Code that awaits the handle still works.
    expect(await recall.peer("bob")).toBeDefined();
    expect(calls).toHaveLength(0);

    await session.addMessages([alice.message("hello")]);
    // pending options travel first (one upsert), then the write
    expect(
      calls.map(
        (c) =>
          `${c.method} ${new URL(c.url).pathname
            .split("/")
            .slice(3 + 1)
            .join("/")}`,
      ),
    ).toEqual(["POST peers", "POST sessions", "POST sessions/chat-1/messages"]);
    // alice's pending metadata goes first, before the message that would create her without it
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ id: "alice", metadata: { plan: "pro" } });
    expect(alice.metadata).toEqual({ plan: "pro" });
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({
      id: "chat-1",
      peers: { alice: {}, bot: {} },
    });
    await session.addMessages([alice.message("again")]);
    expect(calls).toHaveLength(4); // nothing pending any more: just the write

    await alice.getCard().catch(() => undefined);
    expect(
      calls.slice(4).map((c) => c.method + " " + new URL(c.url).pathname.split("/").pop()),
    ).toEqual(["GET card"]);
    expect(scope.id).toBe("team");
    expect(calls).toHaveLength(5);
  });

  it("works with awaited handles", async () => {
    const recall = new Recall({ baseURL: server.url, workspaceId: "awaited-handles" });
    const peer = await recall.peer("alice");
    const session = await recall.session("s");
    await session.addPeers([peer]);
    const messages = await session.addMessages(peer.message("I like tea."));
    expect(messages[0]).toMatchObject({ peerId: "alice", content: "I like tea.", sessionId: "s" });
    expect(await session.getMessage(messages[0]!.id)).toMatchObject({ id: messages[0]!.id });
  });
});

describe("recording and reading messages", () => {
  it("round-trips messages, metadata and pagination", async () => {
    const recall = fresh();
    const alice = recall.peer("alice");
    const bot = recall.peer("bot");
    const session = recall.session("s1", { metadata: { topic: "pets" } });
    const stored = await session.addMessages([
      alice.message("My dog is called Rover.", { metadata: { camelCase: { snake_key: 1 } } }),
      bot.message("Nice name!"),
      alice.message("He is three."),
    ]);
    expect(stored.map((m) => m.content)).toEqual([
      "My dog is called Rover.",
      "Nice name!",
      "He is three.",
    ]);
    expect(stored[0]).toMatchObject({
      peerId: "alice",
      sessionId: "s1",
      workspaceId: recall.workspaceId,
      metadata: { camelCase: { snake_key: 1 } },
    });
    expect(stored[0]!.tokenCount).toBeGreaterThan(0);

    const page = await session.messages({ size: 2 });
    expect(page.total).toBe(3);
    expect(page.items.map((m) => m.content)).toEqual(["My dog is called Rover.", "Nice name!"]);
    expect(page.hasNextPage).toBe(true);
    expect((await page.toArray()).map((m) => m.content)).toEqual(stored.map((m) => m.content));
    const newestFirst = await session.messages({ reverse: true });
    expect(newestFirst.items[0]!.content).toBe("He is three.");
    const onlyBot = await session.messages({ filters: { peer_id: "bot" } });
    expect(onlyBot.items.map((m) => m.content)).toEqual(["Nice name!"]);

    const updated = await session.updateMessage(stored[1]!, { reaction: "heart" });
    expect(updated.metadata).toEqual({ reaction: "heart" });
    expect((await session.getMessage(stored[1]!.id)).metadata).toEqual({ reaction: "heart" });

    expect(await session.getMetadata()).toEqual({ topic: "pets" });
    await session.setMetadata({ topic: "dogs" });
    expect(session.metadata).toEqual({ topic: "dogs" });
    expect((await session.peers()).map((p) => p.id).sort()).toEqual(["alice", "bot"]);
  });

  it("sends an Idempotency-Key and survives a dropped response without storing twice", async () => {
    let dropped = false;
    const { fetch: spy, calls } = recordingFetch(async (req, next) => {
      if (req.method === "POST" && req.url.endsWith("/messages") && !dropped) {
        dropped = true;
        await next(); // the server processed the request...
        throw new TypeError("fetch failed"); // ...but the response never arrived
      }
      return next();
    });
    const recall = fresh({ fetch: spy });
    const session = recall.session("retry-me");
    const stored = await session.addMessages([
      recall.peer("alice").message("Only once, please."),
      recall.peer("alice").message("Two messages in one batch."),
    ]);
    expect(stored).toHaveLength(2);
    const posts = calls.filter((c) => c.url.endsWith("/messages"));
    expect(posts).toHaveLength(2);
    const key = posts[0]!.headers.get("idempotency-key");
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1]!.headers.get("idempotency-key")).toBe(key);
    expect((await session.messages()).total).toBe(2);

    // A caller-chosen key dedupes across separate calls.
    const again = await session.addMessages([recall.peer("alice").message("x")], {
      idempotencyKey: "mine-1",
    });
    const replay = await session.addMessages([recall.peer("alice").message("x")], {
      idempotencyKey: "mine-1",
    });
    expect(replay[0]!.id).toBe(again[0]!.id);
    expect((await session.messages()).total).toBe(3);
  });

  it("splits more than 100 messages into ordered batches", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const recall = fresh({ fetch: spy });
    const alice = recall.peer("alice");
    const session = recall.session("bulk");
    const inputs = Array.from({ length: 230 }, (_, i) => alice.message(`message ${i}`));
    const stored = await session.addMessages(inputs, { idempotencyKey: "bulk-1" });
    expect(stored.map((m) => m.content)).toEqual(inputs.map((m) => m.content));
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));
    expect(posts.map((p) => p.headers.get("idempotency-key"))).toEqual([
      "bulk-1:0",
      "bulk-1:1",
      "bulk-1:2",
    ]);
    expect(posts.map((p) => JSON.parse(p.body!).messages.length)).toEqual([100, 100, 30]);
    expect((await session.messages({ size: 100 })).total).toBe(230);
  });

  it("uploads a file as messages", async () => {
    const recall = fresh();
    const session = recall.session("files");
    const out = await session.uploadFile(
      {
        filename: "notes.txt",
        content: new TextEncoder().encode("Rover is a dog.\n\nHe likes walks."),
        contentType: "text/plain",
      },
      "alice",
      { metadata: { source: "test" } },
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.map((m) => m.content).join("")).toContain("Rover is a dog.");
    expect(out[0]).toMatchObject({ peerId: "alice", metadata: { source: "test" } });
    const viaBlob = await session.uploadFile(
      new File(["A second file."], "two.txt", { type: "text/plain" }),
      recall.peer("alice"),
    );
    expect(viaBlob[0]!.content).toContain("A second file.");
  });

  it("clones and deletes sessions", async () => {
    const recall = fresh();
    const session = recall.session("orig");
    const [m1] = await session.addMessages([
      recall.peer("alice").message("one"),
      recall.peer("alice").message("two"),
    ]);
    const copy = await session.clone(m1!.id);
    expect(copy.id).not.toBe("orig");
    expect((await copy.messages()).items.map((m) => m.content)).toEqual(["one"]);
    await copy.delete();
    const ids: string[] = [];
    for await (const s of await recall.sessions()) ids.push(s.id);
    expect(ids).toContain("orig");
    expect(ids).not.toContain(copy.id);
  });
});

describe("memory loop", () => {
  it("records, waits for reasoning, then answers, searches and builds prompt context", async () => {
    const recall = fresh();
    const alice = recall.peer("alice");
    const bot = recall.peer("bot", { configuration: { observeMe: false } });
    const session = recall.session("chat-1");
    await session.addMessages([
      alice.message("I live in Utrecht. I work as a teacher."),
      bot.message("That sounds lovely."),
    ]);
    const status = await recall.waitForIdle({ timeout: 20_000 });
    expect(status.pendingWorkUnits + status.inProgressWorkUnits).toBe(0);
    expect(status.idle).toBe(true);
    expect((await session.queueStatus()).totalWorkUnits).toBeGreaterThan(0);

    // chat
    const answer = await alice.chat("Where do I live?");
    expect(answer).toContain("Utrecht");
    const detailed = await alice.chat("Where do I live?", {
      includeEvidence: true,
      reasoningLevel: "minimal",
    });
    expect(detailed.content).toContain("Utrecht");
    expect(detailed.abstained).toBe(false);
    expect(detailed.confidence).toBeGreaterThan(0);
    expect(detailed.evidence!.conclusions.some((c) => c.content.includes("Utrecht"))).toBe(true);
    expect(detailed.citations.length).toBeGreaterThan(0);
    expect(await recall.chat("Who lives in Utrecht?")).toContain("Utrecht");
    expect(await alice.chat("What is my favourite colour?", { reasoningLevel: "minimal" })).toMatch(
      /don't have|no information/i,
    );
    const scoped = await alice.chat("Where do I live?", { session, sessions: [session] });
    expect(scoped).toBeTypeOf("string");

    // structured output
    const typed = await alice.chat("Where do I live?", {
      responseFormat: {
        jsonSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        parse: (d) => d as { city: string },
      },
    });
    expect(typed!.city).toContain("Utrecht");
    const raw = await alice.chat("Where do I live?", {
      responseFormat: { type: "object", properties: { city: { type: "string" } } },
    });
    expect(raw).toMatchObject({ city: expect.stringContaining("Utrecht") });

    // streaming
    const stream = await alice.chatStream("Where do I live?");
    const deltas: string[] = [];
    for await (const delta of stream) deltas.push(delta);
    expect(deltas.length).toBeGreaterThan(0);
    expect(await stream.getFinalResponse()).toBe(deltas.join(""));
    expect(await stream.getFinalResponse()).toContain("Utrecht");
    expect(stream.isComplete).toBe(true);
    expect(stream.abstained).toBe(false);
    expect(stream.citations.length).toBeGreaterThan(0);
    const wsStream = await recall.chatStream("Where does alice live?");
    expect(await wsStream.getFinalResponse()).toContain("Utrecht");
    const drained = await (await alice.chatStream("Where do I live?")).toArray();
    expect(drained.join("")).toContain("Utrecht");

    // search at every level
    expect((await recall.search("Utrecht")).map((m) => m.content)).toContain(
      "I live in Utrecht. I work as a teacher.",
    );
    expect((await alice.search("teacher")).every((m) => m.peerId === "alice")).toBe(true);
    expect((await session.search("lovely", { limit: 3 })).map((m) => m.peerId)).toContain("bot");

    // cards and representations
    const card = await alice.getCard();
    expect(card!.join(" ")).toContain("Utrecht");
    expect(await alice.setCard(["Likes tea", "Lives in Utrecht"])).toEqual([
      "Likes tea",
      "Lives in Utrecht",
    ]);
    expect(await alice.getCard()).toEqual(["Likes tea", "Lives in Utrecht"]);
    expect(await alice.getCard("bot")).toBeNull();
    expect(await alice.representation()).toContain("Utrecht");
    expect(await alice.representation({ searchQuery: "job", maxConclusions: 1 })).toBeTypeOf(
      "string",
    );
    expect(await session.representation(alice)).toContain("Utrecht");
    const peerContext = await alice.context();
    expect(peerContext).toMatchObject({ peerId: "alice", targetId: "alice" });
    expect(peerContext.representation).toContain("Utrecht");
    expect(peerContext.peerCard).toEqual(["Likes tea", "Lives in Utrecht"]);
    expect((await alice.sessions()).items.map((s) => s.id)).toEqual(["chat-1"]);

    // session context -> prompts
    const ctx = await session.context({ peerTarget: alice, tokens: 4000, summary: false });
    expect(ctx.messages.map((m) => m.peerId)).toEqual(["alice", "bot"]);
    expect(ctx.peerRepresentation).toContain("Utrecht");
    expect(ctx.peerCard).toEqual(["Likes tea", "Lives in Utrecht"]);
    const openai = ctx.toOpenAI(bot);
    expect(openai.map((m) => m.role)).toEqual(["system", "system", "user", "assistant"]);
    expect(openai[0]!.content).toContain("<peer_representation>");
    expect(openai.at(-1)).toMatchObject({
      role: "assistant",
      name: "bot",
      content: "That sounds lovely.",
    });
    const anthropic = ctx.toAnthropicParams(bot);
    expect(anthropic.system).toContain("<peer_card>");
    expect(anthropic.messages).toEqual([
      { role: "user", content: "alice: I live in Utrecht. I work as a teacher." },
      { role: "assistant", content: "That sounds lovely." },
    ]);
    const flat = await session.context({
      peerTarget: "alice",
      searchQuery: "teacher",
      maxConclusions: 5,
      limitToSession: true,
    });
    expect(flat.peerRepresentation).toBeTypeOf("string");
    const nested = await session.context({
      peerTarget: "alice",
      representationOptions: { searchQuery: "teacher", maxConclusions: 5 },
    });
    expect(nested.peerRepresentation).toBeTypeOf("string");
    expect((await session.summaries()).sessionId).toBe("chat-1");

    // usage is metered
    const usage = await recall.usage();
    expect(usage.workspaceId).toBe(recall.workspaceId);
    expect(usage.total.calls).toBeGreaterThan(0);
    expect(Object.keys(usage.byTask).length).toBeGreaterThan(0);
    expect(usage.items[0]).toHaveProperty("provider");
    // A server of your own reports the provider cost (0 on the mock model) and bills nothing.
    expect(usage.total.costUsd).toBe(0);
    expect(usage.billed).toBeNull();
    expect((await recall.usage({ since: new Date(Date.now() + 60_000) })).total.calls).toBe(0);
  });

  it("waits for background work inside addMessages when asked", async () => {
    const recall = fresh();
    const alice = recall.peer("alice");
    await recall.session("w").addMessages([alice.message("I live in Ghent.")], { wait: true });
    expect(await alice.chat("Where do I live?")).toContain("Ghent");
  });

  it("waitForIdle returns at once for a workspace with nothing recorded, and times out loudly", async () => {
    const recall = fresh();
    expect((await recall.waitForIdle()).idle).toBe(true);
    const { fetch: spy } = recordingFetch(async () =>
      Response.json({
        total_work_units: 1,
        completed_work_units: 0,
        in_progress_work_units: 0,
        pending_work_units: 1,
        sessions: null,
      }),
    );
    const stuck = fresh({ fetch: spy });
    const err = await stuck.waitForIdle({ timeout: 300, pollInterval: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("300 ms");
  });
});

describe("turn", () => {
  it("stores the messages and returns the next prompt's context in one request", async () => {
    const { fetch: spy, calls } = recordingFetch();
    const recall = fresh({ fetch: spy });
    const alice = recall.peer("alice");
    const bot = recall.peer("bot");
    const session = recall.session("turns");

    await session.addMessages([alice.message("I live in Utrecht.")], { wait: true });
    calls.length = 0;
    const { messages, context } = await session.turn(
      [alice.message("What is a good bakery near me?")],
      { peerTarget: alice, tokens: 4000, summary: false },
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toMatch(/\/sessions\/turns\/turn$/);
    expect(calls[0]!.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(messages).toHaveLength(1);
    expect(context.messages.map((m) => m.content)).toEqual([
      "I live in Utrecht.",
      "What is a good bakery near me?",
    ]);
    expect(context.peerRepresentation).toContain("Utrecht");
    expect(context.toOpenAI(bot).at(-1)).toMatchObject({ role: "user", name: "alice" });

    const reply = await session.turn(bot.message("Try one on the Oudegracht."), { tokens: 4000 });
    expect(reply.context.messages).toHaveLength(3);
    expect(reply.context.peerRepresentation).toBeNull();

    // a retried turn with the same key stores nothing twice
    const first = await session.turn(alice.message("Thanks!"), { idempotencyKey: "turn-9" });
    const second = await session.turn(alice.message("Thanks!"), { idempotencyKey: "turn-9" });
    expect(second.messages[0]!.id).toBe(first.messages[0]!.id);
    expect((await session.messages()).total).toBe(4);
    await expect(session.turn([])).rejects.toThrow(/at least one message/);
    await expect(
      session.turn(Array.from({ length: 101 }, () => alice.message("x"))),
    ).rejects.toThrow(RangeError);
  });

  it("surfaces an invalid context request as a 422 without storing the messages", async () => {
    const recall = fresh();
    const session = recall.session("bad");
    const err = await session
      .turn([recall.peer("alice").message("never stored")], { peerPerspective: "bob" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect(err.message).toContain("peer_target must be provided");
    expect((await session.messages()).total).toBe(0);
  });
});

describe("conclusions", () => {
  it("creates, lists, queries, reads, derives and deletes", async () => {
    const recall = fresh();
    const alice = recall.peer("alice");
    const mine = alice.conclusions;
    const created = await mine.create([
      "Alice owns a dog named Rover",
      { content: "Alice prefers tea over coffee" },
    ]);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      observerId: "alice",
      observedId: "alice",
      level: "explicit",
      timesDerived: 1,
      sourceIds: [],
      validTo: null,
      supersededBy: null,
      messageIds: [],
    });
    expect(created[0]!.validFrom).toBe(created[0]!.createdAt);
    const [dog, tea] = created as [(typeof created)[number], (typeof created)[number]];
    // the same fact again is the stored one, reinforced
    const [again] = await mine.create("alice owns a dog named  Rover");
    expect(again).toMatchObject({ id: dog.id, timesDerived: 2 });
    expect((await mine.list({ filters: { current: true } })).total).toBe(2);

    const listed = await mine.list();
    expect(listed.total).toBe(2);
    expect(listed.items.map((c) => c.id).sort()).toEqual([dog.id, tea.id].sort());
    expect((await mine.query("dog named Rover", 1)).map((c) => c.id)).toEqual([dog.id]);
    expect((await mine.query("tea", { topK: 5, distance: 1 })).length).toBeGreaterThan(0);
    expect(await mine.get(dog.id)).toMatchObject({ content: "Alice owns a dog named Rover" });
    expect((await mine.getMany([tea.id, "missing", dog.id])).map((c) => c.id)).toEqual([
      tea.id,
      dog.id,
    ]);
    expect((await recall.conclusions.get(dog.id)).id).toBe(dog.id);
    expect((await recall.conclusions.list()).total).toBe(2);
    expect((await recall.conclusions.getMany([dog.id])).length).toBe(1);
    expect((await mine.derived(dog.id)).total).toBe(0);
    expect(await mine.representation()).toContain("Rover");

    const about = alice.conclusionsOf("bob");
    await about.create("Bob is Alice's brother");
    expect((await about.list()).items.map((c) => c.content)).toEqual(["Bob is Alice's brother"]);
    expect((await mine.list()).total).toBe(2);

    await recall.session("filed").addMessages([alice.message("hi")]);
    const filed = await mine.create({ content: "Filed under a session", sessionId: "filed" });
    expect(filed[0]!.sessionId).toBe("filed");
    expect((await mine.list({ session: "filed" })).items.map((c) => c.id)).toEqual([filed[0]!.id]);

    await mine.delete(dog.id);
    expect((await mine.list()).total).toBe(2);
    await expect(mine.get(dog.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(() => mine.list({ filters: { observer_id: "x" } })).toThrow(/set by the view/);
    await expect(mine.create([])).rejects.toThrow(/at least one/);
  });
});

describe("scopes", () => {
  it("are created lazily, collect sessions, and report backfill status", async () => {
    const recall = fresh();
    const alice = recall.peer("alice");
    await recall.session("s1").addMessages([alice.message("I live in Utrecht.")]);
    await recall.session("s2").addMessages([alice.message("I like tea.")]);

    const scope = recall.scope("team", { metadata: { owner: "me" } });
    await expect(recall.getScope("team")).rejects.toBeInstanceOf(NotFoundError);
    await scope.addSessions(["s1", recall.session("s2")]);
    expect((await recall.getScope("team")).metadata).toEqual({ owner: "me" });
    const members = await scope.sessions();
    expect(members.items.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(Object.keys((await scope.status()).backfillStatus).sort()).toEqual(["s1", "s2"]);
    await recall.waitForIdle();
    expect(await recall.chat("Where does alice live?", { scope })).toBeTypeOf("string");
    expect((await recall.scopes()).items.map((s) => s.id)).toEqual(["team"]);
    await scope.removeSession("s2");
    expect((await scope.sessions()).items.map((s) => s.id)).toEqual(["s1"]);
    expect(() => recall.scope("scope.nope")).toThrow();
  });
});

describe("lists", () => {
  it("page through peers, sessions and workspace data", async () => {
    const recall = fresh();
    const session = recall.session("many");
    await session.addMessages(
      ["a", "b", "c", "d", "e"].map((n) => recall.peer(`p-${n}`).message(`from ${n}`)),
    );
    const page = await recall.peers({ size: 2 });
    expect(page.total).toBe(5);
    expect(page.pages).toBe(3);
    expect(page.hasNextPage).toBe(true);
    const next = await page.getNextPage();
    expect(next!.page).toBe(2);
    const all: string[] = [];
    for await (const p of page) all.push(p.id);
    // (peers created in one request share a timestamp, so their order within a page is not fixed)
    expect([...all].sort()).toEqual(["p-a", "p-b", "p-c", "p-d", "p-e"]);
    expect(page.items[0]!.createdAt).toBeTypeOf("string");
    expect((await recall.sessions()).items[0]!.id).toBe("many");
    expect((await recall.peers({ filters: { id: "p-c" } })).items.map((p) => p.id)).toEqual([
      "p-c",
    ]);
    expect((await session.peers()).length).toBe(5);

    await session.removePeers(["p-a", recall.peer("p-b")]);
    expect((await session.peers()).map((p) => p.id).sort()).toEqual(["p-c", "p-d", "p-e"]);
    await session.setPeers({ "p-a": { observeMe: false }, "p-c": {} });
    expect((await session.peers()).map((p) => p.id).sort()).toEqual(["p-a", "p-c"]);
    expect(await session.getPeerConfiguration("p-a")).toMatchObject({ observeMe: false });
    await session.setPeerConfiguration("p-c", { observeOthers: false });
    expect(await session.getPeerConfiguration("p-c")).toMatchObject({ observeOthers: false });
  });

  it("reads and writes workspace and peer settings", async () => {
    const recall = fresh();
    expect(await recall.getMetadata()).toEqual({});
    await recall.setMetadata({ team: "memory" });
    expect(recall.metadata).toEqual({ team: "memory" });
    await recall.setConfiguration({
      reasoning: { enabled: true, customInstructions: "be concise" },
      summary: { messagesPerShortSummary: 12 },
    });
    expect(await recall.getConfiguration()).toMatchObject({
      reasoning: { enabled: true, customInstructions: "be concise" },
      summary: { messagesPerShortSummary: 12 },
    });
    const peer = recall.peer("carol");
    await peer.setMetadata({ role: "admin" });
    expect(await peer.getMetadata()).toEqual({ role: "admin" });
    await peer.setConfiguration({ observeMe: false });
    expect(await peer.getConfiguration()).toMatchObject({ observeMe: false });
    await expect(recall.deleteWorkspace()).resolves.toBeUndefined();
  });

  it("can ask for a dream", async () => {
    const recall = fresh();
    await recall
      .session("d")
      .addMessages([recall.peer("alice").message("I live in Ghent.")], { wait: true });
    await expect(
      recall.scheduleDream({ observer: "alice", dreamType: "omni" }),
    ).resolves.toBeUndefined();
  });
});

describe("webhooks", () => {
  it("registers, lists and deletes endpoints", async () => {
    const recall = fresh();
    const hook = await recall.webhooks.create("https://example.com/hooks/recall");
    expect(hook).toMatchObject({
      workspaceId: recall.workspaceId,
      url: "https://example.com/hooks/recall",
    });
    expect((await recall.webhooks.create("https://example.com/hooks/recall")).id).toBe(hook.id);
    const listed = await recall.webhooks.list();
    expect(listed.items.map((h) => h.id)).toEqual([hook.id]);
    await expect(recall.webhooks.test()).resolves.toBeUndefined();
    await recall.webhooks.delete(hook.id);
    expect((await recall.webhooks.list()).total).toBe(0);
  });
});

describe("errors", () => {
  it("maps server answers to typed errors with the server's message", async () => {
    const recall = fresh();
    const missing = await recall
      .peer("ghost")
      .getCard()
      .catch((e) => e);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(RecallError);
    expect(missing.status).toBe(404);
    expect(missing.message).toContain("ghost");
    await expect(recall.getScope("nothing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(recall.session("s").context({ peerPerspective: "x" })).rejects.toThrow(
      UnprocessableEntityError,
    );
    const invalid = await recall
      .peer("alice")
      .search("")
      .catch((e) => e);
    expect(invalid).toBeInstanceOf(UnprocessableEntityError);
    expect(invalid.message).toMatch(/query/);
    await recall
      .session("busy")
      .addMessages([recall.peer("alice").message("x")], { idempotencyKey: "k" });
    const conflict = await recall
      .session("busy")
      .addMessages([recall.peer("alice").message("x"), recall.peer("alice").message("y")], {
        idempotencyKey: "k",
      })
      .catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictError);
  });

  it("reports an unreachable server and a hung one", async () => {
    const down = new Recall({ baseURL: "http://127.0.0.1:9", maxRetries: 0 });
    await expect(down.search("x")).rejects.toBeInstanceOf(ConnectionError);
    const slow = fresh({
      timeout: 40,
      maxRetries: 0,
      fetch: (_url, init) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        ),
    });
    await expect(slow.search("x")).rejects.toBeInstanceOf(TimeoutError);
    const failing = fresh({
      maxRetries: 1,
      fetch: async () => Response.json({ detail: "boom" }, { status: 500 }),
    });
    await expect(failing.search("x")).rejects.toBeInstanceOf(ServerError);
  });
});

describe("auth", () => {
  let secured: TestServer;
  beforeAll(async () => {
    secured = await startTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: "sdk-test-secret",
    });
  });
  afterAll(() => secured.close());

  it("sends the API key, rejects a bad one, and mints scoped keys", async () => {
    const anonymous = new Recall({ baseURL: secured.url, workspaceId: "acme", maxRetries: 0 });
    await expect(anonymous.search("x")).rejects.toBeInstanceOf(AuthenticationError);

    const { signToken } = await import("../../server/src/http/auth.js");
    const adminKey = signToken({ ad: true }, "sdk-test-secret");
    const admin = new Recall({ baseURL: secured.url, workspaceId: "acme", apiKey: adminKey });
    const workspaceKey = await admin.createKey({
      workspaceId: "acme",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const client = new Recall({
      baseURL: secured.url,
      workspaceId: "acme",
      apiKey: workspaceKey,
    });
    await client
      .session("s")
      .addMessages([client.peer("alice").message("I live in Utrecht.")], { wait: true });
    expect(await client.peer("alice").chat("Where do I live?")).toContain("Utrecht");
    const otherWorkspace = new Recall({
      baseURL: secured.url,
      workspaceId: "rival",
      apiKey: workspaceKey,
      maxRetries: 0,
    });
    await expect(otherWorkspace.search("x")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(client.createKey({ workspaceId: "acme" })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect((await admin.workspaces()).items).toContain("acme");
  });

  it("reads RECALL_URL / RECALL_API_KEY / RECALL_WORKSPACE_ID from the environment", async () => {
    const { signToken } = await import("../../server/src/http/auth.js");
    const key = signToken({ w: "env-ws" }, "sdk-test-secret");
    const saved = { ...process.env };
    process.env.RECALL_URL = secured.url;
    process.env.RECALL_API_KEY = key;
    process.env.RECALL_WORKSPACE_ID = "env-ws";
    try {
      const fromEnv = new Recall();
      expect(fromEnv.baseURL).toBe(secured.url);
      expect(fromEnv.workspaceId).toBe("env-ws");
      await fromEnv.session("e").addMessages([fromEnv.peer("alice").message("hello from env")]);
      expect((await fromEnv.search("hello")).length).toBeGreaterThan(0);
    } finally {
      for (const k of ["RECALL_URL", "RECALL_API_KEY", "RECALL_WORKSPACE_ID"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
