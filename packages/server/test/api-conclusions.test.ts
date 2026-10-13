import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { drainQueue } from "../src/queue/worker.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

type Server = ApiServer;
const json = async (res: ApiResponse) => res.json();

describe("conclusions", () => {
  let s: Server;
  const ws = "cw";
  const create = (conclusions: unknown[], key = "conclusions") =>
    s.request("POST", `/v3/workspaces/${ws}/conclusions`, { [key]: conclusions });
  const version = async (observer: string, observed: string) =>
    Number(
      (
        await rows<{ version: number | string }>(
          s.ctx.db,
          sql`SELECT c.version FROM collections c JOIN peers o ON o.id = c.observer_id JOIN peers d ON d.id = c.observed_id WHERE o.name = ${observer} AND d.name = ${observed}`,
        )
      )[0]!.version,
    );

  beforeAll(async () => {
    s = await createTestServer();
    for (const id of ["alice", "bob"])
      await s.request("POST", `/v3/workspaces/${ws}/peers`, { id });
    await s.request("POST", `/v3/workspaces/${ws}/sessions`, { id: "s1" });
    await s.request("POST", `/v3/workspaces/${ws}/scopes`, { id: "team" });
  });
  afterAll(() => s.close());

  it("creates explicit conclusions, embeds them, and bumps the collection version", async () => {
    const res = await create([
      { content: "Alice loves hiking in the Alps", observer_id: "bob", observed_id: "alice" },
      {
        content: "Alice works as a pastry chef",
        observer_id: "bob",
        observed_id: "alice",
        session_id: "s1",
      },
    ]);
    expect(res.status).toBe(201);
    const items = await json(res);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      content: "Alice loves hiking in the Alps",
      observer_id: "bob",
      observed_id: "alice",
      session_id: null,
      level: "explicit",
      source_ids: [],
      times_derived: 1,
    });
    expect(items[1].session_id).toBe("s1");
    expect(items[0].id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    const stored = await rows<{ n: number; embedded: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n, count(embedding)::int AS embedded FROM conclusions`,
    );
    expect(stored[0]).toEqual({ n: 2, embedded: 2 });
    expect(await version("bob", "alice")).toBe(1);
    await create([
      { content: "Alice has a dog named Rex", observer_id: "bob", observed_id: "alice" },
    ]);
    expect(await version("bob", "alice")).toBe(2);
  });

  it("accepts the legacy 'observations' key", async () => {
    const res = await create(
      [{ content: "Bob plays chess", observer_id: "alice", observed_id: "bob" }],
      "observations",
    );
    expect(res.status).toBe(201);
    expect((await s.request("POST", `/v3/workspaces/${ws}/conclusions`, {})).status).toBe(422);
  });

  it("validates peers, sessions and sizes", async () => {
    expect(
      (await create([{ content: "x", observer_id: "ghost", observed_id: "alice" }])).status,
    ).toBe(404);
    expect(
      (await create([{ content: "x", observer_id: "alice", observed_id: "ghost" }])).status,
    ).toBe(404);
    expect(
      (
        await create([
          { content: "x", observer_id: "alice", observed_id: "bob", session_id: "nope" },
        ])
      ).status,
    ).toBe(404);
    expect(
      (
        await s.request("POST", "/v3/workspaces/nowhere/conclusions", {
          conclusions: [{ content: "x", observer_id: "a", observed_id: "b" }],
        })
      ).status,
    ).toBe(404);
    const toScope = await create([
      { content: "x", observer_id: "alice", observed_id: "scope.team" },
    ]);
    expect(toScope.status).toBe(422);
    // a scope may observe
    expect(
      (
        await create([
          { content: "Alice is a team lead", observer_id: "scope.team", observed_id: "alice" },
        ])
      ).status,
    ).toBe(201);
    expect((await create([])).status).toBe(422);
    expect((await create([{ content: "", observer_id: "alice", observed_id: "bob" }])).status).toBe(
      422,
    );
    expect(
      (await create([{ content: "x".repeat(65_536), observer_id: "alice", observed_id: "bob" }]))
        .status,
    ).toBe(422);
    const tooManyTokens = await create([
      { content: "word ".repeat(9000), observer_id: "alice", observed_id: "bob" },
    ]);
    expect(tooManyTokens.status).toBe(422);
    expect((await json(tooManyTokens)).detail).toMatch(
      /^Content exceeds maximum embedding token limit of 8192 \(got \d+ tokens\)$/,
    );
    expect(
      (
        await create(
          Array.from({ length: 101 }, () => ({
            content: "x",
            observer_id: "alice",
            observed_id: "bob",
          })),
        )
      ).status,
    ).toBe(422);
  });

  it("lists newest first, with filters and both pagination modes", async () => {
    const list = async (filters?: unknown, q = "") =>
      json(
        await s.request(
          "POST",
          `/v3/workspaces/${ws}/conclusions/list${q}`,
          filters === undefined ? undefined : { filters },
        ),
      );
    const all = await list();
    expect(all.items.length).toBeGreaterThanOrEqual(5);
    const times = all.items.map((c: { created_at: string }) => c.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    const reversed = await list(undefined, "?reverse=true");
    expect(reversed.items.map((c: { id: string }) => c.id)).toEqual(
      [...all.items].reverse().map((c: { id: string }) => c.id),
    );

    expect(
      (await list({ observer_id: "alice" })).items.map((c: { content: string }) => c.content),
    ).toEqual(["Bob plays chess"]);
    // observer/observed are accepted as aliases
    expect((await list({ observer: "alice", observed: "bob" })).items).toHaveLength(1);
    expect(
      (await list({ session_id: "s1" })).items.map((c: { content: string }) => c.content),
    ).toEqual(["Alice works as a pastry chef"]);
    expect((await list({ session_id: null })).items.length).toBe(all.items.length - 1);
    expect((await list({ level: "explicit", observed_id: { in: ["bob"] } })).items).toHaveLength(1);
    expect((await list({ level: "deductive" })).items).toEqual([]);
    expect((await list({ times_derived: { gte: 2 } })).items).toEqual([]);
    expect((await list({ observed_id: "alice", NOT: [{ session_id: "s1" }] })).items.length).toBe(
      3,
    );
    expect((await list({ id: { in: [all.items[0].id] } })).items).toHaveLength(1);
    const badLevel = await s.request("POST", `/v3/workspaces/${ws}/conclusions/list`, {
      filters: { level: "bogus" },
    });
    expect(badLevel.status).toBe(422);
    const rawColumn = await s.request("POST", `/v3/workspaces/${ws}/conclusions/list`, {
      filters: { content: "x" },
    });
    expect(rawColumn.status).toBe(422);
    expect((await json(rawColumn)).detail).toContain("Column 'content' is not allowed");

    // cursor walk equals the offset order
    const seen: string[] = [];
    let cursor = "";
    for (;;) {
      const page = await list(undefined, `?size=2&cursor=${cursor}`);
      seen.push(...page.items.map((c: { id: string }) => c.id));
      if (!page.next_page) break;
      cursor = page.next_page;
    }
    expect(seen).toEqual(all.items.map((c: { id: string }) => c.id));
  });

  it("filters on source_ids with its own semantics", async () => {
    const [a, b] = await json(
      await create([
        { content: "premise one", observer_id: "bob", observed_id: "alice" },
        { content: "premise two", observer_id: "bob", observed_id: "alice" },
      ]),
    );
    const [row] = await rows<{
      workspace_id: string;
      collection_id: string;
      observer_id: string;
      observed_id: string;
    }>(
      s.ctx.db,
      sql`SELECT workspace_id, collection_id, observer_id, observed_id FROM conclusions WHERE id = ${a.id}`,
    );
    await s.ctx.db.execute(
      sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, content, level, source_ids)
          VALUES ('derivedDerivedDerived1', ${row!.workspace_id}, ${row!.collection_id}, ${row!.observer_id}, ${row!.observed_id},
                  'Alice is consistent', 'deductive', ARRAY[${a.id}, ${b.id}]::text[])`,
    );
    const ids = async (filters: unknown) =>
      (
        await json(await s.request("POST", `/v3/workspaces/${ws}/conclusions/list`, { filters }))
      ).items.map((c: { id: string }) => c.id);
    expect(await ids({ source_ids: a.id })).toEqual(["derivedDerivedDerived1"]);
    expect(await ids({ source_ids: { contains: b.id } })).toEqual(["derivedDerivedDerived1"]);
    expect(await ids({ source_ids: [a.id, b.id] })).toEqual(["derivedDerivedDerived1"]);
    expect(await ids({ source_ids: [a.id, "missing"] })).toEqual([]);
    expect(await ids({ source_ids: { in: ["missing", b.id] } })).toEqual([
      "derivedDerivedDerived1",
    ]);
    expect(await ids({ source_ids: { in: [] } })).toEqual([]);
    expect((await ids({ source_ids: "*" })).length).toBeGreaterThan(3);
    expect(
      (
        await s.request("POST", `/v3/workspaces/${ws}/conclusions/list`, {
          filters: { source_ids: { gt: "a" } },
        })
      ).status,
    ).toBe(422);
    const got = await json(
      await s.request("GET", `/v3/workspaces/${ws}/conclusions/derivedDerivedDerived1`),
    );
    expect(got).toMatchObject({ level: "deductive", source_ids: [a.id, b.id] });
  });

  it("answers semantic queries within one collection, ranked by similarity", async () => {
    const query = (body: unknown) =>
      s.request("POST", `/v3/workspaces/${ws}/conclusions/query`, body);
    const hits = await json(
      await query({
        query: "hiking in the Alps",
        top_k: 2,
        filters: { observer_id: "bob", observed_id: "alice" },
      }),
    );
    expect(hits).toHaveLength(2);
    expect(hits[0].content).toBe("Alice loves hiking in the Alps");
    expect(hits.every((h: { observer_id: string }) => h.observer_id === "bob")).toBe(true);
    // aliases and extra filters
    const aliased = await json(
      await query({
        query: "pastry",
        filters: { observer: "bob", observed: "alice", session_id: "s1" },
      }),
    );
    expect(aliased.map((h: { content: string }) => h.content)).toEqual([
      "Alice works as a pastry chef",
    ]);
    // distance cutoff: nothing is as close as 0 to an unrelated query
    expect(
      await json(
        await query({
          query: "zzzz qqqq",
          distance: 0.01,
          filters: { observer: "bob", observed: "alice" },
        }),
      ),
    ).toEqual([]);
    // an unknown collection is an empty result
    expect(
      await json(await query({ query: "x", filters: { observer: "alice", observed: "alice" } })),
    ).toEqual([]);
    const missing = await query({ query: "x", filters: { observer_id: "bob" } });
    expect(missing.status).toBe(422);
    expect((await json(missing)).detail).toMatch(
      /^observer and observed must be specified for semantic search\./,
    );
    expect((await query({ query: "x" })).status).toBe(422);
    expect(
      (await query({ query: "x", top_k: 101, filters: { observer: "a", observed: "b" } })).status,
    ).toBe(422);
    expect(
      (await query({ query: "x", distance: 2, filters: { observer: "a", observed: "b" } })).status,
    ).toBe(422);
  });

  it("gets and deletes a conclusion, removing the row", async () => {
    const [c] = await json(
      await create([
        { content: "Alice drinks espresso", observer_id: "bob", observed_id: "alice" },
      ]),
    );
    expect(
      await json(await s.request("GET", `/v3/workspaces/${ws}/conclusions/${c.id}`)),
    ).toMatchObject({ id: c.id, content: "Alice drinks espresso" });
    const before = await version("bob", "alice");
    const del = await s.request("DELETE", `/v3/workspaces/${ws}/conclusions/${c.id}`);
    expect(del.status).toBe(204);
    expect(await version("bob", "alice")).toBe(before + 1);
    const gone = await s.request("GET", `/v3/workspaces/${ws}/conclusions/${c.id}`);
    expect(gone.status).toBe(404);
    expect(await json(gone)).toEqual({ detail: "Conclusion not found" });
    expect((await s.request("DELETE", `/v3/workspaces/${ws}/conclusions/${c.id}`)).status).toBe(
      404,
    );
    const listed = await json(
      await s.request("POST", `/v3/workspaces/${ws}/conclusions/list`, { filters: { id: c.id } }),
    );
    expect(listed.items).toEqual([]);
    const hits = await json(
      await s.request("POST", `/v3/workspaces/${ws}/conclusions/query`, {
        query: "espresso",
        filters: { observer: "bob", observed: "alice" },
      }),
    );
    expect(hits.map((h: { id: string }) => h.id)).not.toContain(c.id);
    // the row is gone, not just hidden (right to erasure)
    const left = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM conclusions WHERE id = ${c.id}`,
    );
    expect(left).toEqual([]);
  });
});

describe("conclusions (auth enabled)", () => {
  const secret = "s3cret";
  let s: Server;
  const as = (claims: Parameters<typeof signToken>[0]) => ({
    authorization: `Bearer ${signToken(claims, secret)}`,
  });
  beforeAll(async () => {
    s = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
  });
  afterAll(() => s.close());

  it("requires a workspace or admin token", async () => {
    const list = (headers: Record<string, string>) =>
      s.request("POST", "/v3/workspaces/w/conclusions/list", undefined, headers);
    expect((await list(as({ w: "w" }))).status).toBe(200);
    expect((await list(as({ ad: true }))).status).toBe(200);
    expect((await list(as({ w: "w", p: "alice" }))).status).toBe(401);
    expect((await list(as({ w: "w", s: "s1" }))).status).toBe(401);
    expect((await list(as({ w: "other" }))).status).toBe(401);
    expect(
      (
        await s.request(
          "GET",
          "/v3/workspaces/w/conclusions/x",
          undefined,
          as({ w: "w", p: "alice" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await s.request(
          "DELETE",
          "/v3/workspaces/w/conclusions/x",
          undefined,
          as({ w: "w", p: "alice" }),
        )
      ).status,
    ).toBe(401);
  });
});

describe("conclusions: validity and provenance", () => {
  let s: Server;
  const ws = "validity";
  const ids: Record<string, string> = {};
  const list = async (filters?: unknown) =>
    json(
      await s.request(
        "POST",
        `/v3/workspaces/${ws}/conclusions/list`,
        filters === undefined ? undefined : { filters },
      ),
    );
  const say = async (content: string, created_at: string) => {
    const res = await s.request("POST", `/v3/workspaces/${ws}/sessions/s1/messages`, {
      messages: [{ peer_id: "dana", content, created_at }],
    });
    expect(res.status).toBe(201);
    await drainQueue(s.ctx);
    return (await json(res))[0].id as string;
  };
  beforeAll(async () => {
    s = await createTestServer({
      RECALL_REASONER_MAX_DELAY_MS: "0",
      RECALL_SUMMARIES_ENABLED: "false",
      RECALL_DREAMS_ENABLED: "false",
    });
    ids.rotterdam = await say("I live in Rotterdam.", "2026-09-01T09:00:00Z");
    ids.groningen = await say("I moved to Groningen.", "2026-09-20T09:00:00Z");
  });
  afterAll(() => s.close());

  it("shows when a learned fact held, what replaced it and the messages it came from", async () => {
    const all = (await list({ observer_id: "dana", observed_id: "dana" })).items;
    const old = all.find((c: { content: string }) => c.content === "dana lives in Rotterdam");
    const now = all.find((c: { content: string }) => c.content === "dana lives in Groningen");
    expect(old).toMatchObject({
      valid_from: "2026-09-01T09:00:00.000Z",
      valid_to: "2026-09-20T09:00:00.000Z",
      superseded_by: now.id,
      message_ids: [ids.rotterdam],
      source_ids: [],
    });
    expect(now).toMatchObject({
      valid_from: "2026-09-20T09:00:00.000Z",
      valid_to: null,
      superseded_by: null,
      message_ids: [ids.groningen],
    });
    // the single read shows the same fields
    expect(
      await json(await s.request("GET", `/v3/workspaces/${ws}/conclusions/${old.id}`)),
    ).toEqual(old);
  });

  it("filters on current facts, validity and source messages; the default is unchanged", async () => {
    const pair = { observer_id: "dana", observed_id: "dana" };
    const contents = async (filters: unknown) =>
      (await list(filters)).items.map((c: { content: string }) => c.content).sort();
    expect(await contents(pair)).toEqual(["dana lives in Groningen", "dana lives in Rotterdam"]);
    expect(await contents({ ...pair, current: true })).toEqual(["dana lives in Groningen"]);
    expect(await contents({ ...pair, current: false })).toEqual(["dana lives in Rotterdam"]);
    expect(await contents({ ...pair, message_ids: ids.rotterdam })).toEqual([
      "dana lives in Rotterdam",
    ]);
    expect(await contents({ ...pair, valid_from: { gte: "2026-09-10" } })).toEqual([
      "dana lives in Groningen",
    ]);
    expect(await contents({ ...pair, valid_to: { ne: null } })).toEqual([
      "dana lives in Rotterdam",
    ]);
    const bad = await s.request("POST", `/v3/workspaces/${ws}/conclusions/list`, {
      filters: { current: "yes" },
    });
    expect(bad.status).toBe(422);

    const hits = await json(
      await s.request("POST", `/v3/workspaces/${ws}/conclusions/query`, {
        query: "where does dana live",
        filters: { observer: "dana", observed: "dana", current: true },
      }),
    );
    expect(hits.map((h: { content: string }) => h.content)).toEqual(["dana lives in Groningen"]);
  });

  it("gives a fact saved through the API a start time and no source messages", async () => {
    const [c] = await json(
      await s.request("POST", `/v3/workspaces/${ws}/conclusions`, {
        conclusions: [
          { content: "Dana is on the Team plan", observer_id: "dana", observed_id: "dana" },
        ],
      }),
    );
    expect(c).toMatchObject({ valid_to: null, superseded_by: null, message_ids: [] });
    expect(c.valid_from).toBe(c.created_at);
  });
});

describe("conclusions: no identical current fact twice", () => {
  let s: Server;
  const ws = "dedupe";
  const create = (conclusions: unknown[]) =>
    s.request("POST", `/v3/workspaces/${ws}/conclusions`, { conclusions });
  const fact = (content: string, observer = "alice") => ({
    content,
    observer_id: observer,
    observed_id: "alice",
  });
  const stored = (content: string) =>
    rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM conclusions WHERE content ILIKE ${content} AND deleted_at IS NULL`,
    );
  beforeAll(async () => {
    s = await createTestServer();
    for (const id of ["alice", "bob"])
      await s.request("POST", `/v3/workspaces/${ws}/peers`, { id });
  });
  afterAll(() => s.close());

  it("returns the stored fact instead of saving the same one again", async () => {
    const [first] = await json(await create([fact("Alice likes green tea")]));
    const again = await create([fact(" alice likes  green tea"), fact("Alice likes jasmine tea")]);
    expect(again.status).toBe(201);
    const [same, other] = await json(again);
    expect(same.id).toBe(first.id);
    expect(same.content).toBe("Alice likes green tea");
    // said again: reinforced, as the reasoner does with a fact it learns twice
    expect(same.times_derived).toBe(2);
    expect(other.id).not.toBe(first.id);
    expect(await stored("Alice likes green tea")).toHaveLength(1);

    // the same text twice in one request is saved once
    const twice = await json(await create([fact("Alice has a cat"), fact("Alice has a cat")]));
    expect(twice[0].id).toBe(twice[1].id);
    expect(twice[0].times_derived).toBe(1);
    expect(await stored("Alice has a cat")).toHaveLength(1);
  });

  it("keeps other observers' views and facts that no longer hold apart", async () => {
    const [mine] = await json(await create([fact("Alice plays chess")]));
    const [bobs] = await json(await create([fact("Alice plays chess", "bob")]));
    expect(bobs.id).not.toBe(mine.id);
    const [next] = await json(await create([fact("Alice plays go")]));
    await s.ctx.db.execute(
      sql`UPDATE conclusions SET valid_to = now(), superseded_by = ${next.id} WHERE id = ${mine.id}`,
    );
    const [back] = await json(await create([fact("Alice plays chess")]));
    expect(back.id).not.toBe(mine.id);
    expect(back.valid_to).toBeNull();
    const current = await json(
      await s.request("POST", `/v3/workspaces/${ws}/conclusions/list`, {
        filters: { observer_id: "alice", observed_id: "alice", current: true },
      }),
    );
    const texts = current.items.map((c: { content: string }) => c.content.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });
});
