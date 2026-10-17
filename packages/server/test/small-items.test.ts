import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { expireFacts } from "../src/core/history.js";
import { rows } from "../src/db/client.js";
import { drainQueue } from "../src/queue/worker.js";
import { cardProblems } from "../src/reasoner/cards.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/** expires_at, explain on search, and the card size check with one repair. */

let s: ApiServer | null = null;
afterEach(async () => {
  s?.ctx.llm.mock.respondWith(null);
  await s?.close();
  s = null;
});
const WS = "small";

describe("fact expiry", () => {
  it("stops a fact counting as current once its expiry date passes, and the sweep closes it", async () => {
    s = await createTestServer();
    await s.request("POST", `/v3/workspaces/${WS}/peers`, { id: "ana" });
    const r = await s.request("POST", `/v3/workspaces/${WS}/conclusions`, {
      conclusions: [
        {
          content: "ana is on call this week",
          observer_id: "ana",
          observed_id: "ana",
          expires_at: "2099-01-01T00:00:00Z",
        },
        { content: "ana is vegetarian", observer_id: "ana", observed_id: "ana" },
      ],
    });
    const [oncall] = (await r.json()) as { id: string; expires_at: string }[];
    expect(oncall!.expires_at).toBe("2099-01-01T00:00:00.000Z");
    const current = async () =>
      (
        await (
          await s!.request("POST", `/v3/workspaces/${WS}/conclusions/list`, {
            filters: { current: true },
          })
        ).json()
      ).items.map((c: { content: string }) => c.content);
    expect(await current()).toHaveLength(2);

    // Moved into the past: no longer current at once, closed for good by the sweep.
    const p = await s.request("PATCH", `/v3/workspaces/${WS}/conclusions/${oncall!.id}`, {
      expires_at: "2020-01-01T00:00:00Z",
    });
    expect(p.status).toBe(200);
    expect(await current()).toEqual(["ana is vegetarian"]);
    expect(await expireFacts(s.ctx.db)).toBe(1);
    const [row] = await rows<{ valid_to: Date | null }>(
      s.ctx.db,
      sql`SELECT valid_to FROM conclusions WHERE id = ${oncall!.id}`,
    );
    expect(row!.valid_to).not.toBeNull();
    const h = await (
      await s.request("GET", `/v3/workspaces/${WS}/conclusions/${oncall!.id}/history`)
    ).json();
    expect(h.events.map((e: { action: string }) => e.action)).toEqual([
      "created",
      "edited",
      "expired",
    ]);
    expect(
      (await s.request("PATCH", `/v3/workspaces/${WS}/conclusions/${oncall!.id}`, {})).status,
    ).toBe(422);
  });
});

describe("explain", () => {
  it("says why each search result ranked where it did", async () => {
    s = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
    await s.request("POST", `/v3/workspaces/${WS}/sessions/s1/messages`, {
      messages: [
        { peer_id: "ana", content: "We booked a cabin in Norway for the summer holiday" },
        { peer_id: "ana", content: "The printer at work is broken again" },
      ],
    });
    await drainQueue(s.ctx);
    const res = await s.request("POST", `/v3/workspaces/${WS}/search`, {
      query: "cabin in Norway",
      explain: true,
    });
    const hits = await res.json();
    expect(hits[0].content).toContain("Norway");
    expect(hits[0].explain).toMatchObject({ rank: 1, rank_by_words: 1 });
    expect(typeof hits[0].explain.score).toBe("number");
    const plain = await (
      await s.request("POST", `/v3/workspaces/${WS}/search`, { query: "cabin" })
    ).json();
    expect(plain[0].explain).toBeUndefined();
  });
});

describe("card size check", () => {
  it("finds what breaks the card rules", () => {
    expect(cardProblems(["ATTRIBUTE: Home: Leiden"])).toEqual([]);
    expect(cardProblems(["Home: Leiden", `ATTRIBUTE: Bio: ${"x".repeat(300)}`])[0]).toMatch(
      /^2 entries are not/,
    );
    expect(cardProblems(Array.from({ length: 41 }, (_, i) => `ATTRIBUTE: K${i}: v`))[0]).toMatch(
      /41 entries/,
    );
  });

  it("repairs once, then keeps the old card and shows why", async () => {
    s = await createTestServer();
    await s.request("POST", `/v3/workspaces/${WS}/peers`, { id: "ana" });
    await s.request("PUT", `/v3/workspaces/${WS}/peers/ana/card`, {
      peer_card: ["ATTRIBUTE: Home: Leiden"],
    });
    await s.request("POST", `/v3/workspaces/${WS}/conclusions`, {
      conclusions: [{ content: "ana lives in Porto", observer_id: "ana", observed_id: "ana" }],
    });
    let calls = 0;
    s.ctx.llm.mock.respondWith((req) => {
      if (req.task !== "card") return { json: {} };
      calls++;
      return { json: { card: Array.from({ length: 45 }, (_, i) => `ATTRIBUTE: K${i}: v`) } };
    });
    const d = await s.request("POST", `/v3/workspaces/${WS}/schedule_dream`, {
      observer: "ana",
      dream_type: "card_refresh",
    });
    expect(d.status).toBe(204);
    await drainQueue(s.ctx);
    expect(calls).toBe(2);
    const [col] = await rows<{ peer_card: string[]; card_blocked: string | null }>(
      s.ctx.db,
      sql`SELECT peer_card, card_blocked FROM collections`,
    );
    expect(col!.peer_card).toEqual(["ATTRIBUTE: Home: Leiden"]);
    expect(col!.card_blocked).toMatch(/45 entries/);

    // A person saving the card clears it.
    await s.request("PUT", `/v3/workspaces/${WS}/peers/ana/card`, {
      peer_card: ["ATTRIBUTE: Home: Porto"],
    });
    const [after] = await rows<{ card_blocked: string | null }>(
      s.ctx.db,
      sql`SELECT card_blocked FROM collections`,
    );
    expect(after!.card_blocked).toBeNull();
  });
});
