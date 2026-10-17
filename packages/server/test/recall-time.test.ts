import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { shapeOf } from "../src/recall/shape.js";
import { vecLiteral } from "../src/recall/util.js";
import { createTestServer } from "./api-helpers.js";
import { seedWorld, type World } from "./recall-helpers.js";

/**
 * Questions that name a time ("in April 2025", "last week") pull in what memory has from then,
 * whatever its words: facts whose event falls in it (replaced ones too), facts learned in it,
 * and the messages written in it, listed oldest first.
 */

const PEER = "/v3/workspaces/acme/peers/alice/chat";

describe("question shapes", () => {
  it("tells lookups, ordering, counting and summaries apart, and reads the time named", () => {
    const at = new Date("2026-03-25T00:00:00Z");
    expect(shapeOf("Where does Alice live?", at)).toMatchObject({
      kind: "lookup",
      window: null,
      chronological: false,
    });
    expect(shapeOf("Which did I start first, yoga or running?", at).kind).toBe("ordering");
    expect(shapeOf("In what order did I visit the three cities?", at)).toMatchObject({
      kind: "ordering",
      historical: true,
      chronological: true,
    });
    expect(shapeOf("How many books did I read?", at).kind).toBe("counting");
    expect(shapeOf("Summarize my job search so far", at).kind).toBe("summary");
    const s = shapeOf("What did I cook last week?", at);
    expect(s).toMatchObject({ kind: "lookup", historical: true, chronological: true });
    expect(s.window?.from.toISOString().slice(0, 10)).toBe("2026-03-16");
  });
});

describe("recall: questions that name a time", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let w: World;
  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    w = await seedWorld(server.ctx, { fillers: 60 });
    // Learned in January 2026, about a day in April 2025.
    const text = "Alice ran a half marathon in Rotterdam";
    const [v] = await server.ctx.embeddings.embed([text], w.ws);
    await server.ctx.db.execute(
      sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content,
            level, confidence, importance, valid_from, event_start, event_precision, embedding, created_at)
          VALUES (${newId()}, ${w.ws}, ${w.collection}, ${w.alice}, ${w.alice}, ${w.s1}, ${text}, 'explicit', 0.9,
            0.3, '2026-01-12T12:00:00Z', '2025-04-13T00:00:00Z', 'day', ${vecLiteral(v!)}::vector,
            '2026-01-12T12:00:00Z')`,
    );
  });
  afterAll(() => server.close());

  const lastContext = () => server.ctx.llm.mock.calls.at(-1)!.req.context ?? "";
  const section = (ctx: string, title: string) =>
    ctx.split("\n## ").find((s) => s.startsWith(title)) ?? "";
  const ask = async (query: string) => {
    const res = await server.request("POST", PEER, { query, reasoning_level: "minimal" });
    expect(res.status).toBe(200);
    return lastContext();
  };

  it("pulls in a fact by when it happened, not by its words", async () => {
    const off = await ask("The current date is 2026-03-25.\nWhat sporty thing did Alice do?");
    expect(off).not.toContain("half marathon");
    const on = await ask("The current date is 2026-03-25.\nWhat did Alice do in April 2025?");
    expect(section(on, "Facts")).toMatch(
      /\(event 2025-04-13\) Alice ran a half marathon in Rotterdam/,
    );
  });

  it("pulls in facts learned in the time named, replaced ones among the history", async () => {
    const ctx = await ask(
      "The current date is 2026-03-25.\nWhat was going on with Alice in January?",
    );
    expect(section(ctx, "No longer true")).toContain("Alice lived in Amsterdam");
    expect(section(ctx, "Facts")).toContain("Rover");
  });

  it("pulls in the messages written in the time named, oldest first", async () => {
    const ctx = await ask("The current date is 2026-03-08.\nWhat did Alice tell me last week?");
    const excerpts = section(ctx, "Excerpts");
    expect(excerpts).toContain("I switched jobs");
    // Excerpts run per conversation; they are listed by when each run starts.
    const starts = [...excerpts.matchAll(/^\[M\d+\] (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]!);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts).toEqual([...starts].sort());
  });
});
