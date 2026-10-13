import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { DreamOut } from "../src/consolidate/index.js";
import { rows } from "../src/db/client.js";
import type { LlmRequest } from "../src/llm/types.js";
import { drainQueue } from "../src/queue/worker.js";
import { createTestServer } from "./helpers.js";

/**
 * The night shift (dreams) may only make memory better: closing a fact that bundles several
 * details keeps the details that still hold, a conflict keeps the newest dated fact current, and
 * the card never goes back to a value that newer facts replaced.
 */

type Server = Awaited<ReturnType<typeof createTestServer>>;
let s: Server | null = null;
afterEach(async () => {
  s?.ctx.llm.mock.respondWith(null);
  await s?.close();
  s = null;
});

const WS = "night";

async function setup() {
  s = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
  await s.request("POST", "/v3/workspaces", { id: WS });
  await s.request("POST", `/v3/workspaces/${WS}/peers`, { id: "sam" });
  return s;
}

/** Stores facts about sam (sam's own view) with the given dates. */
async function remember(srv: Server, facts: { content: string; at: string }[]) {
  const r = await srv.request("POST", `/v3/workspaces/${WS}/conclusions`, {
    conclusions: facts.map((f) => ({ content: f.content, observer_id: "sam", observed_id: "sam" })),
  });
  expect(r.status).toBe(201);
  for (const f of facts) {
    await srv.ctx.db.execute(
      sql`UPDATE conclusions SET valid_from = ${f.at}::timestamptz, created_at = ${f.at}::timestamptz
          WHERE content = ${f.content}`,
    );
  }
}

async function setCard(srv: Server, card: string[], dates: Record<string, string> = {}) {
  await srv.ctx.db.execute(
    sql`UPDATE collections SET peer_card = ${JSON.stringify(card)}::jsonb, card_dates = ${JSON.stringify(dates)}::jsonb`,
  );
}

async function state(srv: Server) {
  const facts = await rows<{ content: string; valid_to: Date | null; deleted_at: Date | null }>(
    srv.ctx.db,
    sql`SELECT content, valid_to, deleted_at FROM conclusions ORDER BY created_at, id`,
  );
  const [col] = await rows<{ peer_card: string[] }>(
    srv.ctx.db,
    sql`SELECT peer_card FROM collections`,
  );
  return {
    current: facts
      .filter((f) => !f.valid_to && !f.deleted_at)
      .map((f) => f.content)
      .sort(),
    closed: facts.filter((f) => f.valid_to).map((f) => f.content),
    card: col?.peer_card ?? [],
  };
}

/** Handles of the dream's FACTS listing by content. */
function handles(req: LlmRequest): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of req.messages
    .map((m) => m.content)
    .join("\n")
    .split("\n")) {
    const m = line.match(/^(D\d+) \[[^\]]*\] (.*)$/);
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

function dreamWith(build: (h: Map<string, string>) => Partial<DreamOut>) {
  return (req: LlmRequest) => {
    if (req.task !== "dream") return { json: {} };
    const out: DreamOut = {
      merge: [],
      supersede: [],
      inductive: [],
      contradictions: [],
      card: { add: [], remove: [] },
      ...build(handles(req)),
    };
    return { json: out };
  };
}

async function dream(srv: Server, type: "omni" | "card_refresh" = "omni") {
  const r = await srv.request("POST", `/v3/workspaces/${WS}/schedule_dream`, {
    observer: "sam",
    dream_type: type,
  });
  expect(r.status).toBe(204);
  await drainQueue(srv.ctx);
}

describe("night shift", () => {
  it("closes only the changed part of a compound fact and keeps the rest current", async () => {
    const srv = await setup();
    const compound = "sam uses pnpm, tab indentation and TypeScript strict mode";
    const change = "sam switched from tab indentation to 2-space indentation";
    await remember(srv, [
      { content: compound, at: "2026-09-01T10:00:00Z" },
      { content: change, at: "2026-09-20T10:00:00Z" },
    ]);
    srv.ctx.llm.mock.respondWith(
      dreamWith((h) => ({
        supersede: [
          {
            old: h.get(compound)!,
            new: h.get(change)!,
            keep: ["sam uses pnpm", "sam uses TypeScript strict mode"],
          },
        ],
      })),
    );
    await dream(srv);
    const st = await state(srv);
    expect(st.closed).toEqual([compound]);
    expect(st.current).toEqual([change, "sam uses TypeScript strict mode", "sam uses pnpm"].sort());
  });

  it("keeps the newest dated fact current and the card on its newest value", async () => {
    const srv = await setup();
    const jest = "sam uses Jest as the test framework";
    const vitest = "sam moved from Jest to Vitest for tests";
    await remember(srv, [
      { content: jest, at: "2026-09-01T10:00:00Z" },
      { content: vitest, at: "2026-09-20T10:00:00Z" },
    ]);
    await setCard(srv, ["ATTRIBUTE: Test framework: Vitest"]);
    // A confused consolidation: it closes the newer fact and puts the older value on the card.
    srv.ctx.llm.mock.respondWith(
      dreamWith((h) => ({
        supersede: [{ old: h.get(vitest)!, new: h.get(jest)!, keep: [] }],
        card: { add: ["ATTRIBUTE: Test framework: Jest"], remove: [] },
      })),
    );
    await dream(srv);
    const st = await state(srv);
    expect(st.current).toEqual([vitest]);
    expect(st.closed).toEqual([jest]);
    expect(st.card).toEqual(["ATTRIBUTE: Test framework: Vitest"]);
  });

  it("never puts a value back on the card that only superseded facts hold", async () => {
    const srv = await setup();
    const old = "sam deploys to Fly.io";
    const now = "sam deploys to Railway";
    await remember(srv, [
      { content: old, at: "2026-09-01T10:00:00Z" },
      { content: now, at: "2026-09-20T10:00:00Z" },
    ]);
    await srv.ctx.db.execute(
      sql`UPDATE conclusions SET valid_to = '2026-09-20T10:00:00Z' WHERE content = ${old}`,
    );
    await setCard(srv, []);
    srv.ctx.llm.mock.respondWith(
      dreamWith(() => ({
        card: {
          add: ["ATTRIBUTE: Hosting: Fly.io", "ATTRIBUTE: Deploys to: Railway"],
          remove: [],
        },
      })),
    );
    // The dream needs two current facts to look at.
    await remember(srv, [{ content: "sam writes TypeScript", at: "2026-09-21T10:00:00Z" }]);
    await dream(srv);
    expect((await state(srv)).card).toEqual(["ATTRIBUTE: Deploys to: Railway"]);
  });

  it("card_refresh writes the newest values and leaves out superseded ones", async () => {
    const srv = await setup();
    await remember(srv, [
      { content: "sam lives in Rotterdam", at: "2026-09-01T10:00:00Z" },
      { content: "sam lives in Groningen", at: "2026-09-20T10:00:00Z" },
    ]);
    await srv.ctx.db.execute(
      sql`UPDATE conclusions SET valid_to = '2026-09-20T10:00:00Z' WHERE content = 'sam lives in Rotterdam'`,
    );
    srv.ctx.llm.mock.respondWith((req) =>
      req.task === "card"
        ? {
            json: {
              card: [
                "ATTRIBUTE: Location: Rotterdam",
                "ATTRIBUTE: Address: Vismarkt 12, Groningen",
              ],
            },
          }
        : { json: {} },
    );
    await dream(srv, "card_refresh");
    expect((await state(srv)).card).toEqual(["ATTRIBUTE: Address: Vismarkt 12, Groningen"]);
  });

  it("points history at the fact that survives a merge", async () => {
    const srv = await setup();
    const [rome, oslo, osloAgain] = [
      "sam lives in Rome",
      "sam lives in Oslo",
      "sam lives in Oslo, Norway",
    ];
    await remember(srv, [
      { content: rome, at: "2026-08-01T10:00:00Z" },
      { content: oslo, at: "2026-09-01T10:00:00Z" },
      { content: osloAgain, at: "2026-09-02T10:00:00Z" },
    ]);
    const id = async (content: string) =>
      (
        await rows<{ id: string }>(
          srv.ctx.db,
          sql`SELECT id FROM conclusions WHERE content = ${content}`,
        )
      )[0]!.id;
    await srv.ctx.db.execute(
      sql`UPDATE conclusions SET valid_to = '2026-09-02T10:00:00Z', superseded_by = ${await id(osloAgain)}
          WHERE content = ${rome}`,
    );
    srv.ctx.llm.mock.respondWith(
      dreamWith((h) => ({ merge: [{ ids: [h.get(oslo)!, h.get(osloAgain)!], content: oslo }] })),
    );
    await dream(srv);
    const listed = await srv.request("POST", `/v3/workspaces/${WS}/conclusions/list`, {
      filters: { observer_id: "sam" },
    });
    const { items } = (await listed.json()) as {
      items: { content: string; superseded_by: string }[];
    };
    expect(items.map((c) => c.content).sort()).toEqual([oslo, rome]);
    expect(items.find((c) => c.content === rome)!.superseded_by).toBe(await id(oslo));
  });
});
