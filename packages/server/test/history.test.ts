import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { DreamOut } from "../src/consolidate/index.js";
import { rows } from "../src/db/client.js";
import type { LlmRequest } from "../src/llm/types.js";
import { drainQueue } from "../src/queue/worker.js";
import { parseTranscript } from "../src/reasoner/offline.js";
import type { ExtractionOut, FactOut } from "../src/reasoner/prompt.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * The memory change log, per-fact history, `as_of`, and pinned facts: every change says who made
 * it and why; a pinned fact is never replaced by what the reasoner or a dream concludes, and what
 * disagrees with it is kept next to it and flagged.
 */

let s: ApiServer | null = null;
afterEach(async () => {
  s?.ctx.llm.mock.respondWith(null);
  await s?.close();
  s = null;
});

const WS = "hist";
const start = async (dreams = false) => {
  s = await createTestServer({
    RECALL_REASONER_MAX_DELAY_MS: "0",
    RECALL_SUMMARIES_ENABLED: "false",
    RECALL_DREAMS_ENABLED: dreams ? "true" : "false",
  });
  await s.request("POST", `/v3/workspaces/${WS}/peers`, { id: "alice" });
  return s;
};

async function say(srv: ApiServer, content: string, at: string) {
  const r = await srv.request("POST", `/v3/workspaces/${WS}/sessions/s1/messages`, {
    messages: [{ peer_id: "alice", content, created_at: at }],
  });
  expect(r.status).toBe(201);
  await drainQueue(srv.ctx);
}

/** Known facts shown to the extraction call, by handle. */
function known(req: LlmRequest): { handle: string; content: string }[] {
  const out: { handle: string; content: string }[] = [];
  for (const line of (req.context ?? "").split("\n")) {
    const m = line.match(/^(F\d+) \d{4}-\d{2}-\d{2} (?:event \S+(?: to \S+)? )?(.*)$/);
    if (m) out.push({ handle: m[1]!, content: m[2]! });
  }
  return out;
}

/** "I live in X" adds or supersedes alice's home; anything else is ignored. */
function homes() {
  return (req: LlmRequest) => {
    const out: ExtractionOut = {
      changes: [],
      facts: [],
      cards: [],
      synopsis: null,
      short_summary: null,
    };
    if (req.task !== "reasoner") return { json: out };
    for (const line of parseTranscript(req.messages.map((m) => m.content).join("\n"))) {
      const m = line.text.match(/I live in (\w+)/);
      if (!m || line.context) continue;
      const home = known(req).find((k) => /lives in/.test(k.content));
      const same = home?.content === `alice lives in ${m[1]}`;
      const fact: FactOut = {
        about: line.peer,
        content: `alice lives in ${m[1]}`,
        event_start: null,
        event_end: null,
        tags: ["home"],
        level: "explicit",
        category: "identity",
        confidence: 1,
        importance: 4,
        source_messages: [line.n],
        action: home ? (same ? "reinforce" : "supersede") : "add",
        target: home?.handle ?? null,
      };
      out.facts.push(fact);
    }
    return { json: out };
  };
}

const list = async (srv: ApiServer, body: Record<string, unknown> = {}) =>
  (await (await srv.request("POST", `/v3/workspaces/${WS}/conclusions/list`, body)).json())
    .items as {
    id: string;
    content: string;
    valid_to: string | null;
    pinned: boolean;
  }[];
const history = async (srv: ApiServer, id: string) => {
  const r = await srv.request("GET", `/v3/workspaces/${WS}/conclusions/${id}/history`);
  expect(r.status).toBe(200);
  return r.json();
};

describe("memory change log", () => {
  it("records who created, restated and replaced a fact, and why", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(homes());
    await say(srv, "I live in Leiden", "2026-03-01T10:00:00Z");
    await say(srv, "Yes, I live in Leiden", "2026-03-02T10:00:00Z");
    await say(srv, "We moved! I live in Porto", "2026-05-01T10:00:00Z");
    const facts = await list(srv);
    const leiden = facts.find((f) => f.content.includes("Leiden"))!;
    const porto = facts.find((f) => f.content.includes("Porto"))!;

    const h = await history(srv, leiden.id);
    expect(h.events.map((e: { action: string; actor: string }) => [e.action, e.actor])).toEqual([
      ["created", "reasoner"],
      ["reinforced", "reasoner"],
      ["superseded", "reasoner"],
    ]);
    expect(h.events[2].sources[0]).toBe(porto.id);
    expect(h.events[2].after.superseded_by).toBe(porto.id);
    expect(h.replaced_by.id).toBe(porto.id);

    const p = await history(srv, porto.id);
    expect(p.events[0]).toMatchObject({
      action: "created",
      reason: "replaces an earlier statement",
    });
    expect(p.replaced.map((r: { id: string }) => r.id)).toEqual([leiden.id]);

    // as_of: what held on a date.
    const april = await list(srv, { as_of: "2026-04-01" });
    expect(april.map((f) => f.content)).toEqual(["alice lives in Leiden"]);
    const june = await list(srv, { as_of: "2026-06-01T00:00:00Z" });
    expect(june.map((f) => f.content)).toEqual(["alice lives in Porto"]);
    expect(
      (await srv.request("POST", `/v3/workspaces/${WS}/conclusions/list`, { as_of: "soon" }))
        .status,
    ).toBe(422);

    // Deleting a fact takes its history with it.
    await srv.request("DELETE", `/v3/workspaces/${WS}/conclusions/${leiden.id}`);
    const [left] = await rows<{ n: number }>(
      srv.ctx.db,
      sql`SELECT count(*)::int AS n FROM memory_events WHERE conclusion_id = ${leiden.id}`,
    );
    expect(left!.n).toBe(0);
  });

  it("records card changes made through the API, with what was added and removed", async () => {
    const srv = await start();
    const put = (card: string[]) =>
      srv.request("PUT", `/v3/workspaces/${WS}/peers/alice/card`, { peer_card: card });
    expect((await put(["ATTRIBUTE: Home: Leiden"])).status).toBeLessThan(300);
    expect((await put(["ATTRIBUTE: Home: Porto"])).status).toBeLessThan(300);
    const events = await rows<{ actor: string; before: string[]; after: string[] }>(
      srv.ctx.db,
      sql`SELECT actor, before, after FROM memory_events WHERE action = 'card' ORDER BY id`,
    );
    expect(events).toEqual([
      { actor: "api", before: [], after: ["ATTRIBUTE: Home: Leiden"] },
      { actor: "api", before: ["ATTRIBUTE: Home: Leiden"], after: ["ATTRIBUTE: Home: Porto"] },
    ]);
  });
});

describe("pinned facts", () => {
  it("are never replaced by the reasoner: what disagrees is kept and flagged", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(homes());
    const created = await srv.request("POST", `/v3/workspaces/${WS}/conclusions`, {
      conclusions: [
        {
          content: "alice lives in Leiden",
          observer_id: "alice",
          observed_id: "alice",
          pinned: true,
        },
      ],
    });
    const pinned = (await created.json())[0];
    expect(pinned.pinned).toBe(true);
    // Said before the message below (a fact added today would be the newer one).
    await srv.ctx.db.execute(
      sql`UPDATE conclusions SET valid_from = '2026-01-01T00:00:00Z' WHERE id = ${pinned.id}`,
    );
    await say(srv, "I live in Porto", "2026-05-01T10:00:00Z");

    const facts = await list(srv);
    expect(
      facts
        .filter((f) => f.valid_to === null)
        .map((f) => f.content)
        .sort(),
    ).toEqual(["alice lives in Leiden", "alice lives in Porto"]);
    const h = await history(srv, pinned.id);
    expect(h.events.map((e: { action: string }) => e.action)).toEqual(["created", "conflict"]);
    const porto = facts.find((f) => f.content.includes("Porto"))!;
    expect(h.events[1].sources[0]).toBe(porto.id);

    // Unpinned, the next change replaces it as usual.
    const patched = await srv.request("PATCH", `/v3/workspaces/${WS}/conclusions/${pinned.id}`, {
      pinned: false,
    });
    expect((await patched.json()).pinned).toBe(false);
    await say(srv, "Now I live in Lisbon", "2026-07-01T10:00:00Z");
    const after = await list(srv);
    const current = after.filter((f) => f.valid_to === null).map((f) => f.content);
    expect(current).toContain("alice lives in Lisbon");
    expect(
      (await history(srv, pinned.id)).events.map((e: { action: string }) => e.action),
    ).toContain("unpinned");
  });

  it("are never merged or closed by a dream", async () => {
    const srv = await start(true);
    const r = await srv.request("POST", `/v3/workspaces/${WS}/conclusions`, {
      conclusions: [
        { content: "alice prefers tea", observer_id: "alice", observed_id: "alice", pinned: true },
        { content: "alice prefers coffee now", observer_id: "alice", observed_id: "alice" },
        { content: "Alice prefers tea.", observer_id: "alice", observed_id: "alice" },
      ],
    });
    const [tea, coffee, tea2] = (await r.json()) as { id: string }[];
    await srv.ctx.db.execute(
      sql`UPDATE conclusions SET valid_from = now() + interval '1 day' WHERE id = ${coffee!.id}`,
    );
    srv.ctx.llm.mock.respondWith((req) => {
      const out: DreamOut = {
        merge: [],
        supersede: [],
        inductive: [],
        contradictions: [],
        card: { add: [], remove: [] },
      };
      if (req.task !== "dream") return { json: {} };
      const h = new Map<string, string>();
      for (const line of req.messages
        .map((m) => m.content)
        .join("\n")
        .split("\n")) {
        const m = line.match(/^(D\d+) \[[^\]]*\] (.*)$/);
        if (m) h.set(m[2]!, m[1]!);
      }
      out.merge.push({
        ids: [h.get("alice prefers tea")!, h.get("Alice prefers tea.")!],
        content: "alice likes tea",
      });
      out.supersede.push({
        old: h.get("alice prefers tea")!,
        new: h.get("alice prefers coffee now")!,
        keep: [],
      });
      return { json: out };
    });
    const d = await srv.request("POST", `/v3/workspaces/${WS}/schedule_dream`, {
      observer: "alice",
      dream_type: "omni",
    });
    expect(d.status).toBe(204);
    await drainQueue(srv.ctx);
    const facts = await list(srv);
    const teaNow = facts.find((f) => f.id === tea!.id)!;
    expect(teaNow).toMatchObject({ content: "alice prefers tea", valid_to: null, pinned: true });
    expect(facts.some((f) => f.id === tea2!.id)).toBe(true);
  });
});
