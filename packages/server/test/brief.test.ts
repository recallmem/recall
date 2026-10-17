import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { BRIEF_LIMITS, fitBrief } from "../src/consolidate/index.js";
import { rows } from "../src/db/client.js";
import { countTokens } from "../src/lib/tokens.js";
import { drainQueue } from "../src/queue/worker.js";
import { createTestServer } from "./helpers.js";

/**
 * Briefs: a short dated account per (observer, observed), kept by dreams from the facts learned
 * since the last update, shown for overview questions, and dropped when a fact behind it is
 * deleted so nothing forgotten lives on in it.
 */

type Server = Awaited<ReturnType<typeof createTestServer>>;
let s: Server | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const WS = "briefs";

async function setup() {
  s = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0", RECALL_CHAT_CACHE_TTL_S: "0" });
  await s.request("POST", "/v3/workspaces", { id: WS });
  await s.request("POST", `/v3/workspaces/${WS}/peers`, { id: "sam" });
  return s;
}

async function remember(srv: Server, facts: string[]) {
  const r = await srv.request("POST", `/v3/workspaces/${WS}/conclusions`, {
    conclusions: facts.map((content) => ({ content, observer_id: "sam", observed_id: "sam" })),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string }[];
}

async function dream(srv: Server) {
  // Requested dreams have a minimum gap: let the earlier ones be long past.
  await srv.ctx.db.execute(
    sql`UPDATE jobs SET finished_at = now() - interval '1 day' WHERE kind = 'dream'`,
  );
  const r = await srv.request("POST", `/v3/workspaces/${WS}/schedule_dream`, {
    observer: "sam",
    dream_type: "omni",
  });
  expect(r.status).toBe(204);
  await drainQueue(srv.ctx);
}

async function brief(srv: Server) {
  const [r] = await rows<{ brief: string | null; brief_through: Date | null }>(
    srv.ctx.db,
    sql`SELECT brief, brief_through FROM collections`,
  );
  return r!;
}

const briefCalls = (srv: Server) =>
  srv.ctx.llm.mock.calls.filter(
    (c) => c.req.task === "card" && c.req.messages[0]?.content.startsWith("NEW FACTS"),
  ).length;

describe("briefs", () => {
  it("are written by a dream, updated only with what is new, and cut to size", async () => {
    const srv = await setup();
    await remember(srv, ["sam moved to Leiden", "sam started as a nurse at the LUMC"]);
    await dream(srv);
    const first = await brief(srv);
    expect(first.brief).toContain("sam moved to Leiden");
    expect(first.brief).toContain("nurse at the LUMC");
    expect(first.brief_through).not.toBeNull();
    expect(briefCalls(srv)).toBe(1);

    // Nothing new: no call.
    await dream(srv);
    expect(briefCalls(srv)).toBe(1);

    await remember(srv, ["sam adopted a cat named Miso"]);
    await dream(srv);
    expect((await brief(srv)).brief).toContain("Miso");
    expect(briefCalls(srv)).toBe(2);

    const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i} about sam.`).join(" ");
    const cut = fitBrief(long)!;
    expect(countTokens(cut)).toBeLessThanOrEqual(BRIEF_LIMITS.maxTokens);
    expect(cut.endsWith(".")).toBe(true);
  });

  it("is dropped when a fact behind it is deleted, and written again from what is left", async () => {
    const srv = await setup();
    const [secret] = await remember(srv, [
      "sam is planning a surprise party for Noor",
      "sam likes jazz",
    ]);
    await dream(srv);
    expect((await brief(srv)).brief).toContain("surprise party");

    const del = await srv.request("DELETE", `/v3/workspaces/${WS}/conclusions/${secret!.id}`);
    expect(del.status).toBeLessThan(300);
    expect(await brief(srv)).toEqual({ brief: null, brief_through: null });

    await dream(srv);
    const again = await brief(srv);
    expect(again.brief).toContain("jazz");
    expect(again.brief).not.toContain("surprise party");
  });

  it("is shown for overview questions and left out of lookups", async () => {
    const srv = await setup();
    await remember(srv, ["sam moved to Leiden", "sam started as a nurse at the LUMC"]);
    await dream(srv);
    const ask = async (query: string) => {
      const r = await srv.request("POST", `/v3/workspaces/${WS}/peers/sam/chat`, { query });
      expect(r.status).toBe(200);
      return srv.ctx.llm.mock.calls.at(-1)!.req.context ?? "";
    };
    expect(await ask("Summarize what sam has been up to so far")).toContain("## Brief");
    expect(await ask("Where does sam work?")).not.toContain("## Brief");
  });
});
