import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { drainQueue } from "../src/queue/worker.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

const W = "/v3/workspaces/w";

describe("erasing a peer while its session is being summarized", () => {
  let s: ApiServer;

  beforeAll(async () => {
    s = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
  });
  afterAll(async () => {
    s.ctx.llm.mock.respondWith(null);
    await s.close();
  });

  async function eraseDuringSummary(session: string, peer: string, configuration: object) {
    const created = await s.request("POST", `${W}/sessions`, {
      id: session,
      peers: { [peer]: {}, bob: {} },
      configuration: { ...configuration, summary: { messages_per_short_summary: 10 } },
    });
    expect(created.status).toBe(201);
    let erased = false;
    // The model echoes its input as the summary; the first call that sees the peer's message
    // erases the peer while it is in flight.
    s.ctx.llm.mock.respondWith(async (req) => {
      const text = req.messages.map((m) => ("content" in m ? String(m.content) : "")).join("\n");
      if (!erased && text.includes("X123")) {
        erased = true;
        expect((await s.request("DELETE", `${W}/peers/${peer}`)).status).toBeLessThan(300);
      }
      const summary = { synopsis: text, short_summary: text };
      if (!req.jsonSchema) return { text };
      return { json: req.task === "reasoner" ? { facts: [], cards: [], ...summary } : summary };
    });

    await s.request("POST", `${W}/sessions/${session}/messages`, {
      messages: [
        { peer_id: peer, content: "my passport number is X123" },
        ...Array.from({ length: 9 }, (_, i) => ({ peer_id: "bob", content: `noted, thanks ${i}` })),
      ],
    });
    await drainQueue(s.ctx);

    expect(erased).toBe(true);
    const summaries = await rows<{ kind: string; content: string }>(
      s.ctx.db,
      sql`SELECT b.kind, b.content FROM summary_blocks b JOIN sessions se ON se.id = b.session_id
          WHERE se.name = ${session}`,
    );
    expect(summaries.some((b) => b.content.includes("X123"))).toBe(false);
    expect(summaries.some((b) => b.kind === "short" && b.content.includes("noted"))).toBe(true);
  }

  it("drops a summary the reasoner built from the erased peer's messages, then rebuilds", async () => {
    await eraseDuringSummary("s1", "alice", {});
  });

  it("drops a summary the summarize job built from the erased peer's messages, then rebuilds", async () => {
    await eraseDuringSummary("s2", "carol", { reasoning: { enabled: false } });
  });
});
