import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { SAMPLE_PEER, SAMPLE_WS, sampleMessages } from "../src/http/dashboard/sample.js";
import { drainQueue } from "../src/queue/worker.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * The dashboard's first run without code: one click stores a sample conversation in the user's
 * own account, and the Playground waits for Recall to read it, then suggests questions.
 */

let s: HostedServer;
let user: Browser;
beforeAll(async () => {
  s = await createHostedServer();
  user = new Browser(s.app, "203.0.113.50");
  await user.signIn(s, "newcomer@example.com");
}, 60_000);
afterAll(async () => {
  await s.close();
});

const sampleMessageCount = async () =>
  (
    await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n FROM messages m JOIN workspaces w ON w.id = m.workspace_id
          WHERE w.name = ${SAMPLE_WS}`,
    )
  )[0]!.n;

describe("sample conversation", () => {
  it("is a dated conversation that ends in the last week", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const m = sampleMessages(now);
    expect(m).toHaveLength(11);
    const times = m.map((x) => x.created_at!.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(now.getTime() - times.at(-1)!).toBeLessThan(7 * 86_400_000);
    expect(now.getTime() - times[0]!).toBeGreaterThan(100 * 86_400_000);
    expect(new Set(m.map((x) => x.peer_id))).toEqual(new Set([SAMPLE_PEER, "assistant"]));
  });

  it("is offered on the Overview, the Playground and Memory while the account has no messages", async () => {
    for (const path of ["/app", "/app/playground", "/app/memory"]) {
      const h = (await user.get(path)).html;
      expect(h, path).toContain('action="/app/playground/sample" class="try-sample"');
      expect(h, path).toContain("No code needed: try it on a sample conversation.");
    }
  });

  it("loads once, with the form's CSRF token, then the Playground waits and suggests questions", async () => {
    const forged = await user.post("/app/playground/sample", {}, { csrf: null });
    expect(forged.res.status).toBe(403);
    expect(await sampleMessageCount()).toBe(0);

    await user.get("/app");
    const r = await user.post("/app/playground/sample");
    expect(r.res.status).toBe(303);
    expect(r.res.headers.get("location")).toBe(
      `/app/playground?ws=${SAMPLE_WS}&peer=${SAMPLE_PEER}`,
    );
    expect(await sampleMessageCount()).toBe(11);
    // A second click changes nothing.
    await user.get("/app");
    expect((await user.post("/app/playground/sample")).res.status).toBe(303);
    expect(await sampleMessageCount()).toBe(11);

    // Before Recall has read it: a waiting card that refreshes itself, with a way to read the chat.
    const waiting = (await user.get(`/app/playground?ws=${SAMPLE_WS}&peer=${SAMPLE_PEER}`)).html;
    expect(waiting).toContain("Recall is reading the conversation");
    expect(waiting).toContain(
      'data-refresh-after="5" data-refresh-href="/app/playground?ws=try-recall&amp;peer=alex&amp;t=1"',
    );
    expect(waiting).toContain('href="/app/memory/try-recall/sessions/chats-with-alex"');
    // After 24 waits it stops refreshing.
    const late = (await user.get(`/app/playground?ws=${SAMPLE_WS}&peer=${SAMPLE_PEER}&t=24`)).html;
    expect(late).toContain("taking longer than usual");
    expect(late).not.toContain("data-refresh-after");

    // Once facts exist: the questions, each filling in the ask form.
    // The mock model may or may not conclude anything; make sure one fact exists either way.
    await drainQueue(s.ctx);
    await s.ctx.db.execute(sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id)
      SELECT 'col_sample_test', p.workspace_id, p.id, p.id
      FROM peers p JOIN workspaces w ON w.id = p.workspace_id
      WHERE w.name = ${SAMPLE_WS} AND p.name = ${SAMPLE_PEER}
      ON CONFLICT DO NOTHING`);
    await s.ctx.db.execute(sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, content)
      SELECT 'c_sample_test', c.workspace_id, c.id, c.observer_id, c.observed_id, 'Alex lives in Lisbon.'
      FROM collections c JOIN peers p ON p.id = c.observed_id JOIN workspaces w ON w.id = c.workspace_id
      WHERE w.name = ${SAMPLE_WS} AND p.name = ${SAMPLE_PEER} AND c.observer_id = c.observed_id
      LIMIT 1
      ON CONFLICT DO NOTHING`);
    const ready = (await user.get(`/app/playground?ws=${SAMPLE_WS}&peer=${SAMPLE_PEER}`)).html;
    expect(ready).toContain("Ask about Alex");
    // Per-question prices exactly as the site states them, not rounded to the cent.
    expect(ready).toContain('<span class="level-price">$0.025</span>');
    expect(ready).toContain(
      'href="/app/playground?ws=try-recall&amp;peer=alex&amp;q=Where+does+Alex+live+now%3F#ask"',
    );
    const filled = (
      await user.get(
        `/app/playground?ws=${SAMPLE_WS}&peer=${SAMPLE_PEER}&q=Where+does+Alex+live+now%3F`,
      )
    ).html;
    expect(filled).toMatch(/<textarea id="ask-q"[^>]*>Where does Alex live now\?<\/textarea>/);
    expect(filled).not.toContain("style=");

    // With messages in the account, the Overview stops offering it.
    expect((await user.get("/app")).html).not.toContain('class="try-sample"');
  });
});
