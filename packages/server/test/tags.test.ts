import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { normalizeTag, normalizeTags, questionTags, singular } from "../src/lib/tags.js";
import { vecLiteral } from "../src/recall/util.js";
import { createTestServer } from "./api-helpers.js";
import { seedWorld, type World } from "./recall-helpers.js";

/**
 * Tags name what a fact is about, so a counting question can fetch every fact about one kind of
 * thing ("how many concerts") instead of the closest few by meaning.
 */

describe("tag form", () => {
  it("is lowercase and singular, without punctuation", () => {
    expect(singular("trips")).toBe("trip");
    expect(singular("parties")).toBe("party");
    expect(singular("classes")).toBe("class");
    expect(singular("glass")).toBe("glass");
    expect(singular("bus")).toBe("bus");
    expect(normalizeTag("Concerts!")).toBe("concert");
    expect(normalizeTag("  Board Games ")).toBe("board game");
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTags(["Trip", "trips", "Rome", "", "x".repeat(50)])).toEqual(["trip", "rome"]);
    expect(normalizeTags(["a", "b", "c", "d", "e", "f", "g"])).toHaveLength(6);
  });

  it("reads the tags a question may count from its words and word pairs", () => {
    expect(questionTags(["concerts", "go"])).toEqual(["concert", "concerts go", "go"]);
    expect(questionTags(["board", "games", "played"])).toContain("board game");
  });
});

describe("tags in the API and in counting questions", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let w: World;
  // Nothing in their words or meaning ties these to "concerts": only their tag does.
  const shows = [
    "Muse at the Ziggo Dome, front row",
    "Arctic Monkeys in Utrecht with Bob",
    "Jazz night at the Bimhuis",
    "Taylor Swift in Amsterdam with Mila",
    "Mahler by the Radio Philharmonic",
  ];
  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    w = await seedWorld(server.ctx, { fillers: 60 });
    const vecs = await server.ctx.embeddings.embed(shows, w.ws);
    for (const [i, text] of shows.entries()) {
      await server.ctx.db.execute(
        sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content,
              level, confidence, importance, valid_from, tags, embedding, created_at)
            VALUES (${newId()}, ${w.ws}, ${w.collection}, ${w.alice}, ${w.alice}, ${w.s1}, ${text}, 'explicit', 0.9,
              0.2, ${`2026-0${(i % 3) + 1}-1${i}T12:00:00Z`}, ARRAY['concert']::text[], ${vecLiteral(vecs[i]!)}::vector,
              ${`2026-0${(i % 3) + 1}-1${i}T12:00:00Z`})`,
      );
    }
  });
  afterAll(() => server.close());

  const ask = async (query: string) => {
    const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
      query,
      reasoning_level: "minimal",
    });
    expect(res.status).toBe(200);
    return server.ctx.llm.mock.calls.at(-1)!.req.context ?? "";
  };

  it("fetches every fact tagged with what a counting question counts", async () => {
    const ctx = await ask("How many concerts did Alice go to?");
    for (const show of shows) expect(ctx).toContain(show);
  });

  it("returns tags, accepts them on new facts and filters on them", async () => {
    const created = await server.request("POST", "/v3/workspaces/acme/conclusions", {
      conclusions: [
        {
          content: "Fontaines D.C. at Paradiso",
          observer_id: "alice",
          observed_id: "alice",
          tags: ["Concerts", "Paradiso"],
        },
      ],
    });
    expect(created.status).toBe(201);
    expect((await created.json())[0].tags).toEqual(["concert", "paradiso"]);
    const list = await server.request("POST", "/v3/workspaces/acme/conclusions/list", {
      filters: { tags: "concert" },
    });
    expect((await list.json()).items).toHaveLength(shows.length + 1);
    const bad = await server.request("POST", "/v3/workspaces/acme/conclusions", {
      conclusions: [
        {
          content: "x",
          observer_id: "alice",
          observed_id: "alice",
          tags: ["a", "b", "c", "d", "e", "f", "g"],
        },
      ],
    });
    expect(bad.status).toBe(422);
  });
});
