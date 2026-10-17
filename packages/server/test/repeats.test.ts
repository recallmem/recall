import { sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { drainQueue } from "../src/queue/worker.js";
import { createTestServer } from "./helpers.js";

/**
 * A message with the same words as an earlier one of the same peer in the session restates the
 * facts learned from it: they are reinforced in code, with no extraction call.
 */

let s: Awaited<ReturnType<typeof createTestServer>> | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

it("reinforces the facts of an exact repeat without a model call", async () => {
  s = await createTestServer({
    RECALL_REASONER_MAX_DELAY_MS: "0",
    RECALL_SUMMARIES_ENABLED: "false",
    RECALL_DREAMS_ENABLED: "false",
  });
  const say = async (content: string, at: string) => {
    const r = await s!.request("POST", "/v3/workspaces/rep/sessions/s1/messages", {
      messages: [{ peer_id: "maya", content, created_at: at }],
    });
    expect(r.status).toBe(201);
    await drainQueue(s!.ctx);
  };
  const calls = () => s!.ctx.llm.mock.calls.filter((c) => c.req.task === "reasoner").length;

  await say("I work as a nurse at the LUMC in Leiden.", "2026-03-01T10:00:00Z");
  expect(calls()).toBe(1);
  await say("Lovely weather today, by the way, very sunny.", "2026-03-01T10:05:00Z");
  const before = calls();
  await say("I work as a nurse at the LUMC   in Leiden.", "2026-03-02T09:00:00Z");
  expect(calls()).toBe(before);

  const facts = await rows<{ content: string; times_derived: number; message_ids: string[] }>(
    s.ctx.db,
    sql`SELECT content, times_derived, message_ids FROM conclusions WHERE content ILIKE '%nurse%'`,
  );
  expect(facts).toHaveLength(1);
  expect(Number(facts[0]!.times_derived)).toBe(2);
  expect(facts[0]!.message_ids).toHaveLength(2);
  const [ev] = await rows<{ reason: string }>(
    s.ctx.db,
    sql`SELECT reason FROM memory_events WHERE action = 'reinforced' ORDER BY id DESC LIMIT 1`,
  );
  expect(ev!.reason).toBe("the same words again");
});
