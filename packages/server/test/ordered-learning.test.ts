import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import type { LlmRequest } from "../src/llm/types.js";
import { enqueue } from "../src/queue/enqueue.js";
import { drainQueue, Worker } from "../src/queue/worker.js";
import { offlineExtraction, parseTranscript } from "../src/reasoner/offline.js";
import type { ExtractionOut } from "../src/reasoner/prompt.js";
import { createTestServer } from "./helpers.js";
import { seed } from "./reasoner-fixtures.js";

/**
 * Learning about one peer happens in message-time order and never concurrently, also when a
 * backfill posts several backdated sessions at once (or late): older facts never end up current
 * next to the newer facts that replaced them, and cards never move back to an older value.
 */

type Server = Awaited<ReturnType<typeof createTestServer>>;
let s: Server | null = null;
const start = async (env: Record<string, string> = {}) => {
  s = await createTestServer({
    RECALL_REASONER_MAX_DELAY_MS: "0",
    RECALL_SUMMARIES_ENABLED: "false",
    RECALL_DREAMS_ENABLED: "false",
    ...env,
  });
  return s;
};
afterEach(async () => {
  s?.ctx.llm.mock.respondWith(null);
  await s?.close();
  s = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(
  srv: Server,
  ws: string,
  session: string,
  messages: { peer_id: string; content: string; created_at: string }[],
) {
  const r = await srv.request("POST", `/v3/workspaces/${ws}/sessions/${session}/messages`, {
    messages,
  });
  expect(r.status).toBe(201);
}

interface Fact {
  content: string;
  valid_to: Date | string | null;
  superseded_by: string | null;
  id: string;
}
async function facts(srv: Server, observed: string): Promise<Fact[]> {
  return rows<Fact>(
    srv.ctx.db,
    sql`SELECT c.id, c.content, c.valid_to, c.superseded_by FROM conclusions c
        JOIN peers p ON p.id = c.observed_id
        WHERE p.name = ${observed} AND c.observer_id = c.observed_id AND c.deleted_at IS NULL
        ORDER BY c.created_at, c.id`,
  );
}
const current = (fs: Fact[]) => fs.filter((f) => f.valid_to === null).map((f) => f.content);
async function card(srv: Server, observed: string): Promise<string[]> {
  const [r] = await rows<{ peer_card: string[] }>(
    srv.ctx.db,
    sql`SELECT c.peer_card FROM collections c JOIN peers p ON p.id = c.observed_id
        WHERE p.name = ${observed} AND c.observer_id = c.observed_id`,
  );
  return r?.peer_card ?? [];
}

/** The offline extractor, slowed down so that two jobs running at once overlap their model calls. */
function slowOffline(delayMs = 120) {
  return async (req: LlmRequest) => {
    await sleep(delayMs);
    return { json: offlineExtraction(req) };
  };
}

/** Known facts the extraction call was shown, per handle. */
function knownFacts(req: LlmRequest): { handle: string; date: string; content: string }[] {
  const out: { handle: string; date: string; content: string }[] = [];
  for (const line of (req.context ?? "").split("\n")) {
    const m = line.match(/^(F\d+) (\d{4}-\d{2}-\d{2}) (.*)$/);
    if (m) out.push({ handle: m[1]!, date: m[2]!, content: m[3]! });
  }
  return out;
}

/**
 * A scripted extractor for the pet story. It answers the way the extraction prompt asks: a
 * statement that conflicts with a KNOWN FACT supersedes it, whichever of the two is older.
 */
function petStory(delayMs = 120) {
  return async (req: LlmRequest) => {
    await sleep(delayMs);
    const out: ExtractionOut = {
      changes: [],
      facts: [],
      cards: [],
      synopsis: null,
      short_summary: null,
    };
    const known = knownFacts(req);
    const transcript = req.messages.map((m) => m.content).join("\n");
    for (const line of parseTranscript(transcript)) {
      if (line.context) continue;
      const day = line.time.slice(0, 10);
      if (/I have a cat named Pip/i.test(line.text)) {
        const died = known.find((k) => /Pip died/.test(k.content));
        out.facts.push({
          about: line.peer,
          content: `${line.peer} has a cat named Pip`,
          level: "explicit",
          category: "relationship",
          confidence: 1,
          importance: 4,
          source_messages: [line.n],
          event_start: null,
          event_end: null,
          tags: [],
          action: died ? "supersede" : "add",
          target: died?.handle ?? null,
        });
        out.cards.push({ peer: line.peer, add: ["RELATIONSHIP: Pet: cat Pip"], remove: [] });
      }
      if (/Pip died/i.test(line.text)) {
        const alive = known.find((k) => /has a cat named Pip/.test(k.content));
        out.facts.push({
          about: line.peer,
          content: `${line.peer}'s cat Pip died on ${day}`,
          level: "explicit",
          category: "event",
          confidence: 1,
          importance: 4,
          source_messages: [line.n],
          event_start: null,
          event_end: null,
          tags: [],
          action: alive ? "supersede" : "add",
          target: alive?.handle ?? null,
        });
        out.cards.push({ peer: line.peer, add: [], remove: ["RELATIONSHIP: Pet: cat Pip"] });
      }
    }
    return { json: out };
  };
}

describe("bulk import of backdated sessions", () => {
  it("learns one peer's sessions in message-time order, never two at once", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(petStory());
    // Newest session first: the queue must still learn the older one first.
    await post(srv, "imp", "s-later", [
      {
        peer_id: "lena2",
        content: "Sad news: my cat Pip died today.",
        created_at: "2026-09-19T09:00:00Z",
      },
    ]);
    await post(srv, "imp", "s-early", [
      { peer_id: "lena2", content: "I have a cat named Pip.", created_at: "2026-09-01T09:00:00Z" },
    ]);
    await drainQueue(srv.ctx);
    const fs = await facts(srv, "lena2");
    expect(current(fs)).toEqual(["lena2's cat Pip died on 2026-09-19"]);
    const alive = fs.find((f) => f.content === "lena2 has a cat named Pip")!;
    expect(alive.superseded_by).toBe(fs.find((f) => f.content.includes("died"))!.id);
    expect(await card(srv, "lena2")).toEqual([]);
  });

  it("keeps the newest location current and on the card when sessions arrive at once", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(slowOffline());
    await post(srv, "imp", "dana-2", [
      { peer_id: "dana", content: "I moved to Groningen.", created_at: "2026-09-20T09:00:00Z" },
    ]);
    await post(srv, "imp", "dana-1", [
      { peer_id: "dana", content: "I live in Rotterdam.", created_at: "2026-09-01T09:00:00Z" },
    ]);
    await post(srv, "imp", "other", [
      { peer_id: "omar", content: "I live in Delft.", created_at: "2026-09-02T09:00:00Z" },
    ]);
    await drainQueue(srv.ctx);
    expect(current(await facts(srv, "dana"))).toEqual(["dana lives in Groningen"]);
    expect(await card(srv, "dana")).toEqual(["ATTRIBUTE: Location: Groningen"]);
    expect(current(await facts(srv, "omar"))).toEqual(["omar lives in Delft"]);
  });

  it("files an older session that arrives late as history, not as the current fact", async () => {
    const srv = await start();
    srv.ctx.llm.mock.respondWith(petStory(0));
    await post(srv, "late", "s-later", [
      { peer_id: "lena2", content: "My cat Pip died today.", created_at: "2026-09-19T09:00:00Z" },
    ]);
    await drainQueue(srv.ctx);
    await post(srv, "late", "s-early", [
      { peer_id: "lena2", content: "I have a cat named Pip.", created_at: "2026-09-01T09:00:00Z" },
    ]);
    await drainQueue(srv.ctx);
    const fs = await facts(srv, "lena2");
    expect(current(fs)).toEqual(["lena2's cat Pip died on 2026-09-19"]);
    const alive = fs.find((f) => f.content === "lena2 has a cat named Pip")!;
    expect(new Date(alive.valid_to!).toISOString()).toBe("2026-09-19T09:00:00.000Z");
    expect(alive.superseded_by).toBe(fs.find((f) => f.content.includes("died"))!.id);
    // The older session's card edit is older than what the card already reflects.
    expect(await card(srv, "lena2")).toEqual([]);
  });

  it("never moves a card back to an older value", async () => {
    const srv = await start();
    await post(srv, "late2", "dana-2", [
      { peer_id: "dana", content: "I moved to Groningen.", created_at: "2026-09-20T09:00:00Z" },
    ]);
    await drainQueue(srv.ctx);
    await post(srv, "late2", "dana-1", [
      { peer_id: "dana", content: "I live in Rotterdam.", created_at: "2026-09-01T09:00:00Z" },
    ]);
    await drainQueue(srv.ctx);
    expect(current(await facts(srv, "dana"))).toEqual(["dana lives in Groningen"]);
    expect(await card(srv, "dana")).toEqual(["ATTRIBUTE: Location: Groningen"]);
  });
});

describe("work-unit claims", () => {
  it("never runs two reason units for the same peer at once, and runs the older one first", async () => {
    const srv = await start();
    const a = await seed(srv.ctx, { workspace: "claims", session: "a", peers: ["kim"] });
    const b = await seed(srv.ctx, { workspace: "claims", session: "b", peers: ["kim"] });
    const c = await seed(srv.ctx, { workspace: "claims", session: "c", peers: ["lee"] });
    const insert = async (sessionId: string, peer: string, at: string, seq: number) => {
      await srv.ctx.db.execute(
        sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, internal, token_count, created_at)
            VALUES (${`m-${sessionId}-${seq}`}, ${a.workspaceId}, ${sessionId}, ${peer}, ${seq}, 'hello there friend',
                    ${JSON.stringify({ observers: [peer], reasoning: true })}::jsonb, 4, ${at})`,
      );
      await enqueue(srv.ctx.db, {
        kind: "reason",
        workKey: `reason:${sessionId}`,
        workspaceId: a.workspaceId,
        sessionId,
      });
    };
    // b's messages are older than a's although b is queued later.
    await insert(a.sessionId, a.peers.kim!, "2026-09-10T00:00:00Z", 1);
    await insert(b.sessionId, b.peers.kim!, "2026-09-01T00:00:00Z", 1);
    await insert(c.sessionId, c.peers.lee!, "2026-09-05T00:00:00Z", 1);
    const w = new Worker(srv.ctx);
    const first = await w.claim();
    expect(first?.sessionId).toBe(b.sessionId);
    const second = await w.claim();
    // a shares kim with the running b: only lee's session may run next to it.
    expect(second?.sessionId).toBe(c.sessionId);
    expect(await w.claim()).toBeNull();
  });
});

describe("learning latency", () => {
  it("learns a lone short message once the session is quiet, not after the full batch delay", async () => {
    const srv = await start({
      RECALL_REASONER_MAX_DELAY_MS: "15000",
      RECALL_REASONER_IDLE_MS: "300",
    });
    await post(srv, "quick", "s1", [
      { peer_id: "ana", content: "I live in Utrecht.", created_at: new Date().toISOString() },
    ]);
    const started = Date.now();
    await new Worker(srv.ctx).runFor(6_000, 3_000);
    expect(current(await facts(srv, "ana"))).toEqual(["ana lives in Utrecht"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still groups messages that keep arriving within the quiet period", async () => {
    const srv = await start({
      RECALL_REASONER_MAX_DELAY_MS: "15000",
      RECALL_REASONER_IDLE_MS: "1500",
    });
    const w = new Worker(srv.ctx);
    await post(srv, "burst", "s1", [
      { peer_id: "ana", content: "I live in Utrecht.", created_at: new Date().toISOString() },
    ]);
    await w.runFor(400, 0);
    await post(srv, "burst", "s1", [
      { peer_id: "ana", content: "I work as a baker.", created_at: new Date().toISOString() },
    ]);
    await w.runFor(6_000, 3_000);
    await srv.ctx.usage.flush();
    const [u] = await rows<{ n: number }>(
      srv.ctx.db,
      sql`SELECT count(*)::int AS n FROM llm_usage WHERE task = 'reasoner'`,
    );
    expect(u!.n).toBe(1);
    expect(current(await facts(srv, "ana")).sort()).toEqual([
      "ana lives in Utrecht",
      "ana works as a baker",
    ]);
  });
});
