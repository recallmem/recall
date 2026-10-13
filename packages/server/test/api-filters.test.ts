import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSessionAllowlist, SESSION_ALLOWLIST_MAX } from "../src/http/filters.js";
import { countTokens } from "../src/lib/tokens.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

const json = async (res: ApiResponse) => res.json();

describe("filter language", () => {
  let s: ApiServer;
  const base = "/v3/workspaces/f/sessions/s/messages/list";
  /** Contents of the messages matched by `filters`. */
  const match = async (filters: unknown) => {
    const res = await s.request("POST", base, { filters });
    if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(await res.json())}`);
    return ((await res.json()).items as { content: string }[]).map((m) => m.content);
  };
  const reject = async (filters: unknown) => {
    const res = await s.request("POST", base, { filters });
    expect(res.status).toBe(422);
    const detail = (await res.json()).detail;
    expect(typeof detail).toBe("string");
    return detail as string;
  };

  beforeAll(async () => {
    s = await createTestServer();
    const msg = (content: string, peer_id: string, created_at: string, metadata?: unknown) => ({
      content,
      peer_id,
      created_at,
      metadata,
    });
    await s.request("POST", "/v3/workspaces/f/sessions/s/messages", {
      messages: [
        msg("m1", "alice", "2024-01-01T10:00:00Z", {
          n: 5,
          flag: true,
          tag: "alpha",
          when: "2024-01-01",
          nested: { a: { b: 1 }, c: 2 },
          label: "100%_sure",
          tags: ["x", "y"],
        }),
        msg("m2", "bob", "2024-02-01T10:00:00Z", {
          n: 12,
          flag: false,
          tag: "Beta",
          when: "2024-03-01",
          nested: { a: { b: 2 } },
          label: "ok",
        }),
        msg("m3", "alice", "2024-03-01T10:00:00Z", { n: "7", tag: "alphabet", when: "2023-12-31" }),
        msg("m4", "carol", "2024-04-01T10:00:00Z", { n: "not a number", flag: "true" }),
        msg("m5", "alice", "2024-05-01T10:00:00Z"),
      ],
    });
  });
  afterAll(() => s.close());

  it("matches equality, the list shorthand, null and the wildcard", async () => {
    expect(await match({ peer_id: "bob" })).toEqual(["m2"]);
    expect(await match({ peer_id: ["bob", "carol"] })).toEqual(["m2", "m4"]);
    expect(await match({ peer_id: { in: ["bob", "carol"] } })).toEqual(["m2", "m4"]);
    expect(await match({ peer_id: "*" })).toHaveLength(5);
    expect(await match({ peer_id: { in: ["bob", "*"] } })).toHaveLength(5);
    expect(await match({ peer_id: { in: [] } })).toEqual([]);
    expect(await match({ peer_id: [] })).toEqual([]);
    expect(await match({})).toHaveLength(5);
    expect(await match({ peer_id: "*", session_id: "*", metadata: { n: "*" } })).toHaveLength(5);
    expect(await match({ AND: [], OR: [], NOT: [] })).toHaveLength(5);
    expect(await match({ peer_id: null })).toEqual([]);
    expect(
      await match({ workspace_id: "f", session_id: "s", token_count: countTokens("m1") }),
    ).toHaveLength(5);
  });

  it("supports comparison operators on numbers and datetimes", async () => {
    const tokens = countTokens("m1");
    expect(await match({ token_count: { gte: tokens, lt: tokens + 1 } })).toHaveLength(5);
    expect(await match({ token_count: { gt: String(tokens) } })).toEqual([]);
    expect(await match({ token_count: { ne: tokens } })).toEqual([]);
    expect(await match({ token_count: { gt: 0, lte: 1000 } })).toHaveLength(5);
    expect(await match({ created_at: { gt: "2024-03-01T10:00:00Z" } })).toEqual(["m4", "m5"]);
    expect(await match({ created_at: { gte: "2024-03-01 10:00:00" } })).toEqual(["m3", "m4", "m5"]);
    expect(await match({ created_at: { lt: "2024-02-01" } })).toEqual(["m1"]);
    expect(
      await match({
        created_at: { gte: "2024-02-01T12:00:00.123456", lte: "2024-04-01T10:00:00+00:00" },
      }),
    ).toEqual(["m3", "m4"]);
    // an offset shifts the instant
    expect(await match({ created_at: { lt: "2024-01-01T11:30:00+02:00" } })).toEqual([]);
    expect(await match({ created_at: { lt: "2024-01-01T12:30:00+02:00" } })).toEqual(["m1"]);
    expect(await match({ created_at: "2024-01-01T10:00:00" })).toEqual(["m1"]);
    expect(await match({ created_at: { in: ["2024-01-01T10:00:00Z", "2024-05-01"] } })).toEqual([
      "m1",
    ]);
  });

  it("treats NOT as 'is not true' and ne as 'is distinct from'", async () => {
    // m5 has no metadata at all: NOT/ne must keep rows whose value is missing
    expect(await match({ NOT: [{ metadata: { tag: "alpha" } }] })).toEqual([
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    expect(await match({ metadata: { tag: { ne: "alpha" } } })).toEqual(["m2", "m3", "m4", "m5"]);
    expect(await match({ metadata: { n: { ne: 5 } } })).toEqual(["m2", "m3", "m4", "m5"]);
    expect(await match({ metadata: { tag: { ne: null } } })).toEqual(["m1", "m2", "m3"]);
    expect(await match({ NOT: [{ peer_id: "alice" }, { peer_id: "bob" }] })).toEqual(["m4"]);
    expect(await match({ NOT: [{ OR: [{ peer_id: "alice" }, { peer_id: "bob" }] }] })).toEqual([
      "m4",
    ]);
    expect(await match({ peer_id: { ne: "alice" } })).toEqual(["m2", "m4"]);
  });

  it("composes AND / OR / NOT", async () => {
    expect(await match({ OR: [{ peer_id: "bob" }, { peer_id: "carol" }] })).toEqual(["m2", "m4"]);
    expect(
      await match({ AND: [{ peer_id: "alice" }, { created_at: { gte: "2024-03-01" } }] }),
    ).toEqual(["m3", "m5"]);
    expect(
      await match({
        peer_id: "alice",
        OR: [{ created_at: { lt: "2024-02-01" } }, { created_at: { gt: "2024-04-01" } }],
      }),
    ).toEqual(["m1", "m5"]);
    // a sub-filter that imposes no condition makes the OR match everything
    expect(await match({ OR: [{ peer_id: "bob" }, { peer_id: "*" }] })).toHaveLength(5);
    expect(await match({ AND: [{ peer_id: "*" }, { peer_id: "bob" }] })).toEqual(["m2"]);
    const nest = (depth: number): unknown =>
      depth === 0 ? { peer_id: "bob" } : { AND: [nest(depth - 1)] };
    expect(await match(nest(5))).toEqual(["m2"]); // five logical levels is the limit
    expect(await reject(nest(6))).toBe("Filter nesting exceeds maximum depth of 5");
  });

  it("matches text with contains / icontains, escaping wildcards", async () => {
    expect(await match({ peer_id: { contains: "AL" } })).toEqual(["m1", "m3", "m5"]);
    expect(await match({ peer_id: { icontains: "o" } })).toEqual(["m2", "m4"]);
    expect(await match({ peer_id: { contains: "%" } })).toEqual([]);
    expect(await match({ peer_id: { contains: "_" } })).toEqual([]);
    expect(await match({ session_id: { contains: "s", ne: "other" } })).toHaveLength(5);
  });

  it("matches metadata by containment", async () => {
    expect(await match({ metadata: { tag: "alpha" } })).toEqual(["m1"]);
    expect(await match({ metadata: { flag: true } })).toEqual(["m1"]);
    expect(await match({ metadata: { n: 5 } })).toEqual(["m1"]);
    expect(await match({ metadata: { nested: { a: { b: 1 } } } })).toEqual(["m1"]); // partial object match
    expect(await match({ metadata: { nested: { a: { b: 2 } } } })).toEqual(["m2"]);
    expect(await match({ metadata: { tags: ["x"] } })).toEqual(["m1"]);
    expect(await match({ metadata: { tag: "alpha", flag: true } })).toEqual(["m1"]);
    expect(await match({ metadata: { tag: "alpha", flag: false } })).toEqual([]);
    expect(await match({ metadata: { contains: { nested: { c: 2 } } } })).toEqual(["m1"]);
    expect(await match({ metadata: {} })).toHaveLength(5);
  });

  it("compares metadata values as numbers, booleans or text depending on the operand", async () => {
    // numbers: text values are cast, anything non-numeric or missing never matches
    expect(await match({ metadata: { n: { gt: 6 } } })).toEqual(["m2", "m3"]);
    expect(await match({ metadata: { n: { gte: "7", lte: 12 } } })).toEqual(["m2", "m3"]);
    expect(await match({ metadata: { n: { lt: 100 } } })).toEqual(["m1", "m2", "m3"]);
    // booleans compare to "true"/"false"
    expect(await match({ metadata: { flag: { ne: true } } })).toEqual(["m2", "m3", "m5"]);
    // strings compare lexicographically, which orders ISO dates
    expect(await match({ metadata: { when: { gte: "2024-01-01", lt: "2024-02-01" } } })).toEqual([
      "m1",
    ]);
    expect(await match({ metadata: { when: { lt: "2024-01-01" } } })).toEqual(["m3"]);
    expect(await match({ metadata: { tag: { in: ["alpha", "Beta"] } } })).toEqual(["m1", "m2"]);
    expect(await match({ metadata: { n: { in: [5, "7"] } } })).toEqual(["m1", "m3"]);
    expect(await match({ metadata: { n: { in: [] } } })).toEqual([]);
    expect(await match({ metadata: { n: { in: ["*"] } } })).toHaveLength(5);
    expect(await match({ metadata: { tag: { contains: "ALPH" } } })).toEqual(["m1", "m3"]);
    expect(await match({ metadata: { label: { icontains: "100%_" } } })).toEqual(["m1"]);
    expect(await match({ metadata: { label: { contains: "%" } } })).toEqual(["m1"]);
    expect(await match({ metadata: { n: { gt: 1 }, tag: { contains: "alpha" } } })).toEqual([
      "m1",
      "m3",
    ]);
  });

  it("rejects what it cannot interpret with a string 422", async () => {
    expect(await reject({ nope: 1 })).toBe(
      "Column 'nope' is not allowed to be filtered on or does not exist on Message",
    );
    expect(await reject({ id: "x" })).toContain("Column 'id' is not allowed");
    expect(await reject({ configuration: {} })).toContain("Column 'configuration' is not allowed");
    expect(await reject({ AND: {} })).toBe("AND operator must contain a list, got dict");
    expect(await reject({ OR: "x" })).toBe("OR operator must contain a list, got str");
    expect(await reject({ NOT: null })).toBe("NOT operator must contain a list, got NoneType");
    expect(await reject({ peer_id: { regex: "x" } })).toBe(
      "Unsupported comparison operator: regex",
    );
    expect(await reject({ token_count: { gt: null } })).toMatch(
      /^Operator 'gt' does not accept null/,
    );
    expect(await reject({ peer_id: { contains: null } })).toMatch(
      /^Operator 'contains' does not accept null/,
    );
    expect(await reject({ peer_id: 5 })).toContain("expected a string");
    expect(await reject({ peer_id: { contains: 5 } })).toContain("expected a string");
    expect(await reject({ token_count: { contains: "1" } })).toContain(
      "only supported on text fields",
    );
    expect(await reject({ token_count: "abc" })).toContain("expected a number");
    expect(await reject({ token_count: 1e30 })).toContain("out of range");
    expect(await reject({ created_at: "not a date" })).toBe('Invalid datetime value: "not a date"');
    expect(await reject({ created_at: "2024-13-45" })).toContain("Invalid datetime value");
    expect(await reject({ created_at: 5 })).toContain("Invalid datetime value");
    expect(await reject({ peer_id: { in: "bob" } })).toContain("requires a list");
    expect(await reject({ metadata: "x" })).toContain("expected an object");
    expect(await reject({ metadata: { n: { gt: null } } })).toMatch(
      /^Operator 'gt' does not accept null/,
    );
    expect(await reject({ AND: [5] })).toContain("must be objects");
    expect(await reject({ session_id: { in: [null] } })).toContain("does not accept null");
  });

  it("whitelists fields per resource", async () => {
    const ws = await s.request("POST", "/v3/workspaces/list", { filters: { workspace_id: "x" } });
    expect((await json(ws)).detail).toBe("Column 'workspace_id' does not exist on Workspace");
    const sessions = await s.request("POST", "/v3/workspaces/f/sessions/list", {
      filters: { peer_id: "x" },
    });
    expect((await json(sessions)).detail).toBe("Column 'peer_id' does not exist on Session");
    const peers = await s.request("POST", "/v3/workspaces/f/peers/list", {
      filters: { is_active: true },
    });
    expect((await json(peers)).detail).toBe("Column 'is_active' does not exist on Peer");
    const conclusions = await s.request("POST", "/v3/workspaces/f/conclusions/list", {
      filters: { deleted_at: null },
    });
    expect((await json(conclusions)).detail).toContain("Column 'deleted_at' is not allowed");
    expect(
      (await s.request("POST", "/v3/workspaces/f/sessions/list", { filters: { is_active: "yes" } }))
        .status,
    ).toBe(422);
    expect(
      (await s.request("POST", "/v3/workspaces/f/sessions/list", { filters: { is_active: true } }))
        .status,
    ).toBe(200);
    // non-object filters are a schema error
    expect(
      (await s.request("POST", "/v3/workspaces/f/sessions/list", { filters: [1] })).status,
    ).toBe(422);
  });
});

describe("session allowlist dialect", () => {
  const fail = (filters: unknown, sessionId?: string) => {
    try {
      parseSessionAllowlist(filters, sessionId);
    } catch (err) {
      const e = err as { status: number; detail: string };
      expect(e.status).toBe(422);
      return e.detail;
    }
    throw new Error("expected a 422");
  };

  it("accepts the three equivalent shapes and de-duplicates", () => {
    expect(parseSessionAllowlist(null)).toBeNull();
    expect(parseSessionAllowlist(undefined)).toBeNull();
    expect(parseSessionAllowlist({ session_id: "a" })).toEqual(["a"]);
    expect(parseSessionAllowlist({ session_id: ["a", "b", "a"] })).toEqual(["a", "b"]);
    expect(parseSessionAllowlist({ session_id: { in: ["a", "b"] } })).toEqual(["a", "b"]);
    // an explicit empty list means "recall nothing"
    expect(parseSessionAllowlist({ session_id: [] })).toEqual([]);
    expect(parseSessionAllowlist({ session_id: ["a", "b"] }, "b")).toEqual(["a", "b"]);
  });

  it("rejects everything else", () => {
    expect(fail({ session_id: "a", peer_id: "x" })).toBe(
      "Unsupported filter key(s) for this endpoint: ['peer_id']. Only 'session_id' is supported.",
    );
    expect(fail({})).toContain("Only 'session_id' is supported");
    expect(fail({ peer_id: "x" })).toContain("Unsupported filter key(s)");
    expect(fail({ session_id: 5 })).toContain("filters.session_id must be");
    expect(fail({ session_id: { gt: "a" } })).toContain("filters.session_id must be");
    expect(fail({ session_id: [""] })).toContain("non-empty");
    expect(fail({ session_id: [5] })).toContain("non-empty");
    expect(fail({ session_id: ["*"] })).toContain("wildcard");
    expect(fail({ session_id: "*" })).toContain("wildcard");
    expect(fail({ session_id: ["bad id"] })).toContain("invalid session id");
    expect(
      fail({ session_id: Array.from({ length: SESSION_ALLOWLIST_MAX + 1 }, (_, i) => `s${i}`) }),
    ).toContain("at most 1000");
    expect(fail({ session_id: ["a"] }, "b")).toBe(
      "session_id must be included in filters.session_id",
    );
    expect(fail("x")).toBe("filters must be an object");
  });
});

describe("pagination", () => {
  let s: ApiServer;
  beforeAll(async () => {
    s = await createTestServer();
    await s.request("POST", "/v3/workspaces/p/sessions", { id: "s" });
    for (let i = 0; i < 7; i++)
      await s.request("POST", "/v3/workspaces/p/peers", { id: `peer${i}` });
  });
  afterAll(() => s.close());
  const list = (q: string) => s.request("POST", `/v3/workspaces/p/peers/list${q}`);

  it("returns the offset envelope by default", async () => {
    const page = await json(await list(""));
    expect(page).toEqual({ items: expect.any(Array), total: 7, page: 1, size: 50, pages: 1 });
    const second = await json(await list("?size=3&page=2"));
    expect(second).toMatchObject({ total: 7, page: 2, size: 3, pages: 3 });
    expect(second.items.map((p: { id: string }) => p.id)).toEqual(["peer3", "peer4", "peer5"]);
    const beyond = await json(await list("?size=3&page=9"));
    expect(beyond).toMatchObject({ items: [], total: 7, page: 9, pages: 3 });
    const empty = await json(await s.request("POST", "/v3/workspaces/p/scopes/list"));
    expect(empty).toMatchObject({ items: [], total: 0, pages: 0 });
  });

  it("validates page, size and reverse", async () => {
    for (const q of ["?page=0", "?size=0", "?size=101", "?page=abc", "?reverse=maybe"]) {
      const res = await list(q);
      expect(res.status, q).toBe(422);
      expect((await json(res)).detail[0].loc[0]).toBe("query");
    }
    expect((await list("?size=100")).status).toBe(200);
    expect(
      (await json(await list("?reverse=1&size=2"))).items.map((p: { id: string }) => p.id),
    ).toEqual(["peer6", "peer5"]);
  });

  it("walks forward and backward with cursors, without skipping or repeating", async () => {
    const forward: string[] = [];
    let cursor = "";
    const pages: Awaited<ReturnType<typeof json>>[] = [];
    for (;;) {
      const page = await json(await list(`?size=3&cursor=${cursor}&page=99`)); // page is ignored in cursor mode
      pages.push(page);
      expect(page.total).toBeNull();
      forward.push(...page.items.map((p: { id: string }) => p.id));
      if (!page.next_page) break;
      cursor = page.next_page;
    }
    expect(forward).toEqual(Array.from({ length: 7 }, (_, i) => `peer${i}`));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({ previous_page: null, current_page: null });
    expect(pages[2].next_page).toBeNull();
    expect(pages[1].current_page).not.toBeNull();

    const backward: string[] = [];
    let back = pages[2].previous_page as string | null;
    while (back) {
      const page = await json(await list(`?size=3&cursor=${back}`));
      backward.unshift(...page.items.map((p: { id: string }) => p.id));
      back = page.previous_page;
    }
    expect(backward).toEqual(["peer0", "peer1", "peer2", "peer3", "peer4", "peer5"]);

    // the first page of a reversed walk starts at the end
    const reversed = await json(await list("?size=3&cursor=&reverse=true"));
    expect(reversed.items.map((p: { id: string }) => p.id)).toEqual(["peer6", "peer5", "peer4"]);
  });

  it("stays consistent when rows are added between pages", async () => {
    const first = await json(await list("?size=2&cursor="));
    await s.request("POST", "/v3/workspaces/p/peers", { id: "latecomer" });
    const second = await json(await list(`?size=2&cursor=${first.next_page}`));
    expect(second.items.map((p: { id: string }) => p.id)).toEqual(["peer2", "peer3"]);
  });

  it("rejects malformed, foreign and tampered cursors with 400 before doing anything else", async () => {
    const first = await json(await list("?size=2&cursor="));
    const cursor = first.next_page as string;
    for (const bad of [
      "garbage",
      "!!!",
      Buffer.from("{}").toString("base64url"),
      Buffer.from("[1]").toString("base64url"),
      // Four characters, so the tail always decodes to extra bytes (a single trailing base64
      // character is ignored by the decoder, which made a one-character suffix a no-op 1 in 4 runs).
      `${cursor}xxxx`,
    ]) {
      const res = await list(`?cursor=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(await json(res)).toEqual({ detail: "Invalid cursor" });
    }
    // minted for a different query (other filters, direction, route, size-independent)
    expect(
      (
        await s.request("POST", "/v3/workspaces/p/peers/list?cursor=" + cursor, {
          filters: { id: "peer1" },
        })
      ).status,
    ).toBe(400);
    expect((await list(`?reverse=true&cursor=${cursor}`)).status).toBe(400);
    expect((await s.request("POST", `/v3/workspaces/p/scopes/list?cursor=${cursor}`)).status).toBe(
      400,
    );
    expect(
      (await s.request("POST", `/v3/workspaces/other/peers/list?cursor=${cursor}`)).status,
    ).toBe(400);
    expect((await list(`?size=5&cursor=${cursor}`)).status).toBe(200);
    // a hand-built cursor with a hostile key value cannot reach SQL
    const forged = Buffer.from(
      JSON.stringify({ v: 1, f: "x", d: "n", i: 0, k: ["'; DROP TABLE peers; --", "x"] }),
    ).toString("base64url");
    expect((await list(`?cursor=${forged}`)).status).toBe(400);
  });
});
