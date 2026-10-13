import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainQueue } from "../src/queue/worker.js";
import { createTestServer } from "./api-helpers.js";
import { chatUsage, parseSse } from "./recall-helpers.js";

/** The whole loop through the public API: ingest, background reasoning, then recall. */
describe("recall: end to end with the real write path", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  beforeAll(async () => {
    server = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
  });
  afterAll(() => server.close());

  const post = (path: string, body: unknown) =>
    server.request("POST", `/v3/workspaces/e2e${path}`, body);
  const chat = async (query: string, extra: Record<string, unknown> = {}) => {
    const res = await post("/peers/alice/chat", { query, include_evidence: true, ...extra });
    return {
      res,
      json: (await res.json()) as {
        content: string | null;
        citations: string[];
        abstained: boolean;
        evidence: { conclusions: { id: string; content: string }[]; messages: unknown[] };
      },
    };
  };

  it("answers from freshly ingested messages before the reasoner has run, then from conclusions", async () => {
    const created = await post("/sessions/s1/messages", {
      messages: [
        {
          peer_id: "alice",
          content: "I live in Amsterdam and I work as a nurse at the OLVG hospital.",
        },
        { peer_id: "bob", content: "Nice. I love climbing on weekends." },
        { peer_id: "alice", content: "My dog is called Rover." },
      ],
    });
    expect(created.status).toBe(201);

    // Messages are searchable at once through the lexical leg, even though nothing is embedded yet.
    const found = (await (await post("/search", { query: "nurse OLVG" })).json()) as {
      content: string;
    }[];
    expect(found[0]?.content).toContain("nurse");
    const early = await chat("What is the name of Alice's dog?");
    expect(early.json.content).toContain("Rover");
    expect(early.json.evidence.messages.length).toBeGreaterThan(0);

    await drainQueue(server.ctx);
    const late = await chat("Where does Alice live?");
    expect(late.json.content).toContain("Amsterdam");
    expect(late.json.abstained).toBe(false);
    expect(late.json.citations.length).toBeGreaterThan(0);
    const known = new Set(late.json.evidence.conclusions.map((c) => c.id));
    expect(late.json.citations.every((id) => known.has(id))).toBe(true);

    const rep = (await (await post("/peers/alice/representation", {})).json()) as {
      representation: string;
    };
    expect(rep.representation).toContain("Amsterdam");
    const ctx = (await (
      await server.request("GET", "/v3/workspaces/e2e/sessions/s1/context?tokens=2000")
    ).json()) as {
      messages: unknown[];
    };
    expect(ctx.messages).toHaveLength(3);
  });

  it("serves a repeated question from cache, and a new fact invalidates it", async () => {
    await chat("Where does Alice live?");
    const before = (await chatUsage(server.ctx)).length;
    const again = await post("/peers/alice/chat", {
      query: "Where does Alice live?",
      include_evidence: true,
    });
    expect(again.headers.get("x-recall-cache")).toBe("hit");
    expect((await chatUsage(server.ctx)).length).toBe(before);

    await post("/sessions/s1/messages", {
      messages: [{ peer_id: "alice", content: "I moved to Utrecht last week." }],
    });
    await drainQueue(server.ctx);
    const after = await post("/peers/alice/chat", {
      query: "Where does Alice live?",
      include_evidence: true,
    });
    expect(after.headers.get("x-recall-cache")).toBe("miss");
    const json = (await after.json()) as { content: string };
    expect(json.content).toMatch(/Utrecht|Amsterdam/);
  });

  it("streams over the real data", async () => {
    const res = await post("/peers/alice/chat", { query: "Who is Rover?", stream: true });
    const frames = parseSse(await res.text());
    expect(frames.at(-1)?.done).toBe(true);
    expect(frames.map((f) => f.delta?.content ?? "").join("")).toContain("Rover");
  });
});
