import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./api-helpers.js";
import { seedWorld } from "./recall-helpers.js";

describe("recall: hybrid search", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  beforeAll(async () => {
    server = await createTestServer();
    await seedWorld(server.ctx);
  });
  afterAll(() => server.close());

  const search = async (path: string, body: unknown) => {
    const res = await server.request("POST", path, body);
    return {
      res,
      json: (await res.json()) as {
        content: string;
        peer_id: string;
        session_id: string;
        workspace_id: string;
        created_at: string;
      }[],
    };
  };

  it("ranks the lexical and semantic match first and returns the Message shape", async () => {
    const { res, json } = await search("/v3/workspaces/acme/search", {
      query: "dog named Rover",
      limit: 3,
    });
    expect(res.status).toBe(200);
    expect(json.length).toBeLessThanOrEqual(3);
    expect(json[0]!.content).toContain("Rover");
    expect(Object.keys(json[0]!).sort()).toEqual(
      [
        "content",
        "created_at",
        "id",
        "metadata",
        "peer_id",
        "session_id",
        "token_count",
        "workspace_id",
      ].sort(),
    );
    expect(json[0]!.workspace_id).toBe("acme");
  });

  it("finds a message by a keyword that appears only once (lexical leg) in a natural-language question", async () => {
    const { json } = await search("/v3/workspaces/acme/search", {
      query: "what company is Globex?",
      limit: 5,
    });
    expect(json.map((m) => m.content).join(" ")).toContain("Globex");
  });

  it("keeps web-search operators (quoted phrases, exclusions) when the query uses them", async () => {
    const phrase = await search("/v3/workspaces/acme/search", {
      query: '"golden retriever"',
      limit: 1,
    });
    expect(phrase.json[0]!.content).toContain("golden retriever");
    const rest = await search("/v3/workspaces/acme/search", {
      query: "Rover -retriever",
      limit: 20,
    });
    expect(rest.json.length).toBeGreaterThan(0);
  });

  it("restricts peer and session searches", async () => {
    const bob = await search("/v3/workspaces/acme/peers/bob/search", { query: "Rover" });
    expect(bob.json.every((m) => m.peer_id === "bob")).toBe(true);
    expect(bob.json.length).toBeGreaterThan(0);
    const s2 = await search("/v3/workspaces/acme/sessions/s2/search", { query: "trip" });
    expect(s2.json.map((m) => m.session_id)).toEqual(["s2"]);
    expect(s2.json[0]!.content).toContain("Japan");
  });

  it("applies message filters from the shared compiler and ignores a client-supplied workspace", async () => {
    const bob = await search("/v3/workspaces/acme/search", {
      query: "Rover",
      filters: { peer_id: "bob" },
    });
    expect(bob.res.status).toBe(200);
    expect(bob.json.length).toBeGreaterThan(0);
    expect(bob.json.every((m) => m.peer_id === "bob")).toBe(true);
    const recent = await search("/v3/workspaces/acme/search", {
      query: "alice",
      filters: { created_at: { gte: "2026-03-01T00:00:00Z" } },
    });
    expect(recent.json.length).toBeGreaterThan(0);
    expect(recent.json.every((m) => m.created_at >= "2026-03-01")).toBe(true);
    const forced = await search("/v3/workspaces/acme/search", {
      query: "Rover",
      filters: { workspace_id: "other" },
    });
    expect(forced.json.length).toBeGreaterThan(0);
    const clash = await search("/v3/workspaces/acme/search", {
      query: "x",
      scope: "s",
      filters: { session_id: "s1" },
    });
    expect(clash.res.status).toBe(422);
    const unknown = await search("/v3/workspaces/acme/search", {
      query: "x",
      filters: { nope: 1 },
    });
    expect(unknown.res.status).toBe(422);
  });

  it("respects limit and returns an empty array for unknown resources", async () => {
    const { json } = await search("/v3/workspaces/acme/search", { query: "alice", limit: 2 });
    expect(json.length).toBe(2);
    expect((await search("/v3/workspaces/nope/search", { query: "x" })).json).toEqual([]);
    expect((await search("/v3/workspaces/acme/peers/ghost/search", { query: "x" })).json).toEqual(
      [],
    );
  });

  it("validates the body and forces the workspace", async () => {
    const bad = await server.request("POST", "/v3/workspaces/acme/search", {
      query: "x",
      limit: 0,
    });
    expect(bad.status).toBe(422);
    const scope = await server.request("POST", "/v3/workspaces/acme/search", {
      query: "x",
      scope: "nothing",
    });
    expect(scope.status).toBe(404);
  });
});
