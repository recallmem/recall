import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainQueue } from "../src/queue/worker.js";
import { createTestServer } from "./helpers.js";

/**
 * A question to one peer that names another ("What book did alice read on bob's
 * suggestion?") must see the named peer's facts, but only those from sessions the
 * asking peer was part of.
 */
describe("recall: peers named in the question", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  const ws = "/v3/workspaces/mention";

  beforeAll(async () => {
    server = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
    await server.request("POST", "/v3/workspaces", { id: "mention" });
    await server.request("POST", `${ws}/sessions`, { id: "shared", peers: { alice: {}, bob: {} } });
    await server.request("POST", `${ws}/sessions`, {
      id: "private",
      peers: { bob: {}, carol: {} },
    });
    await server.request("POST", `${ws}/sessions/shared/messages`, {
      messages: [
        { peer_id: "bob", content: "I recommend the novel Lanterns of Delft to everyone." },
      ],
    });
    await server.request("POST", `${ws}/sessions/private/messages`, {
      messages: [{ peer_id: "bob", content: "I secretly keep a diary called Midnight Ledger." }],
    });
    await drainQueue(server.ctx);
  });
  afterAll(() => server.close());

  const evidenceFor = async (query: string) => {
    const res = await server.request("POST", `${ws}/peers/alice/chat`, {
      query,
      include_evidence: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evidence?: { conclusions?: { content: string }[] } };
    return (body.evidence?.conclusions ?? []).map((c) => c.content).join("\n");
  };

  it("includes facts about a peer the question names", async () => {
    expect(await evidenceFor("Which novel did bob recommend?")).toMatch(/Lanterns of Delft/);
  });

  it("does not include that peer's facts from sessions the asker was not in", async () => {
    expect(await evidenceFor("What diary does bob keep?")).not.toMatch(/Midnight Ledger/);
  });
});
