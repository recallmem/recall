import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./api-helpers.js";
import { seedWorld } from "./recall-helpers.js";

const lines = (rep: string) => rep.split("\n").filter((l) => l.startsWith("["));

describe("recall: representation and peer context", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  beforeAll(async () => {
    server = await createTestServer();
    await seedWorld(server.ctx, { fillers: 30 });
  });
  afterAll(() => server.close());

  const rep = async (body: unknown, peer = "alice") => {
    const res = await server.request(
      "POST",
      `/v3/workspaces/acme/peers/${peer}/representation`,
      body,
    );
    return { res, json: (await res.json()) as { representation: string; detail?: unknown } };
  };

  it("renders current facts as sectioned Markdown with timestamps and premises, newest facts replacing old ones", async () => {
    const { res, json } = await rep({ max_conclusions: 100 });
    expect(res.status).toBe(200);
    const text = json.representation;
    expect(text).toContain("## Explicit Observations");
    expect(text).toContain("[2026-03-02 12:00:00] Alice lives in Utrecht");
    expect(text).not.toContain("lived in Amsterdam");
    expect(text).toContain("## Deductive Observations");
    expect(text).toContain("   Premises:\n   - Alice loves hiking in the Alps");
  });

  it("defaults to 25 conclusions, null means 100, and ranks by importance, reinforcement and recency", async () => {
    expect(lines((await rep({})).json.representation).length).toBe(25);
    expect(
      lines((await rep({ max_conclusions: null })).json.representation).length,
    ).toBeGreaterThan(25);
    const small = (await rep({ max_conclusions: 4 })).json.representation;
    expect(lines(small).length).toBe(4);
    // the fillers (importance 0.2) lose to real facts even though they are many
    expect(small).not.toContain("gardening");
    expect(small).toContain("Utrecht");
  });

  it("curates by search_query, honouring search_top_k and search_max_distance", async () => {
    const q = (
      await rep({ search_query: "Japan trip with Mila", search_top_k: 1, max_conclusions: 3 })
    ).json.representation;
    expect(q).toContain("trip to Japan");
    const none = (
      await rep({
        search_query: "Japan trip with Mila",
        search_top_k: 1,
        max_conclusions: 1,
        search_max_distance: 0.0001,
      })
    ).json.representation;
    expect(none).not.toContain("Japan");
  });

  it("include_most_frequent pulls in the most re-derived facts", async () => {
    const t = (await rep({ include_most_frequent: true, max_conclusions: 2 })).json.representation;
    expect(t).toContain("Rover");
  });

  it("session allowlists serve only provable provenance and fail closed when empty", async () => {
    const s2 = (await rep({ session_id: "s2", max_conclusions: 100 })).json.representation;
    expect(s2).toContain("Japan");
    expect(s2).not.toContain("Utrecht");
    expect(s2).not.toContain("Deductive");
    const s1 = (await rep({ filters: { session_id: ["s1"] }, max_conclusions: 100 })).json
      .representation;
    expect(s1).toContain("Utrecht");
    expect(s1).not.toContain("Japan");
    expect(s1).toContain("outdoorsy"); // derived, but every source lies inside the allowlist
    expect((await rep({ filters: { session_id: [] } })).json.representation).toBe("");
  });

  it("rejects bad filters and scope combinations", async () => {
    expect((await rep({ filters: { peer_id: "x" } })).res.status).toBe(422);
    expect((await rep({ filters: { session_id: ["s1"] }, session_id: "s2" })).res.status).toBe(422);
    expect((await rep({ scope: "x", session_id: "s1" })).res.status).toBe(422);
    expect((await rep({ target: "scope.x" })).res.status).toBe(422);
    expect((await rep({ scope: "nope" })).res.status).toBe(404);
    expect((await rep({ max_conclusions: 101 })).res.status).toBe(422);
  });

  it("returns an empty representation for unknown peers", async () => {
    expect((await rep({}, "ghost")).json.representation).toBe("");
  });

  it("peer context bundles the representation and the card", async () => {
    const res = await server.request(
      "GET",
      "/v3/workspaces/acme/peers/alice/context?max_conclusions=5",
    );
    const json = (await res.json()) as {
      peer_id: string;
      target_id: string;
      representation: string;
      peer_card: string[];
    };
    expect(res.status).toBe(200);
    expect(json.peer_id).toBe("alice");
    expect(json.target_id).toBe("alice");
    expect(json.peer_card).toContain("Lives in Utrecht");
    expect(lines(json.representation).length).toBe(5);
    const other = (await (
      await server.request("GET", "/v3/workspaces/acme/peers/alice/context?target=bob")
    ).json()) as {
      peer_card: string[] | null;
    };
    expect(other.peer_card).toBeNull();
    expect((await server.request("GET", "/v3/workspaces/acme/peers/ghost/context")).status).toBe(
      404,
    );
    expect(
      (await server.request("GET", "/v3/workspaces/acme/peers/alice/context?max_conclusions=0"))
        .status,
    ).toBe(422);
  });
});
