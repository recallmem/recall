import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getBillingRow, ledgerDrift } from "../src/billing/ledger.js";
import { rows } from "../src/db/client.js";
import { LlmError } from "../src/llm/types.js";
import { drainQueue } from "../src/queue/worker.js";
import { ADMIN, Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Background work is paid for and bounded: every message a model reads is billed once (targets
 * in full, context and summary-only messages for what was read), credit is checked before each
 * model call so a job overdraws by at most one window, a window the model cannot handle is not
 * retried forever, and requested dreams cannot be repeated back to back.
 */

let s: HostedServer;
let accountId: string;
let auth: Record<string, string>;
const op = { authorization: `Bearer ${ADMIN}` };

const balance = async () => (await getBillingRow(s.ctx.db, accountId))!.balance_micros;
const count = async (q: SQL) => Number((await rows<{ n: number }>(s.ctx.db, q))[0]!.n);
const llmCalls = async (task: string) => {
  await s.ctx.usage.flush();
  return count(
    sql`SELECT count(*)::int AS n FROM llm_usage WHERE account_id = ${accountId} AND task = ${task}`,
  );
};
const add = (session: string, ...messages: { peer_id: string; content: string }[]) =>
  s.api("POST", `/v3/workspaces/main/sessions/${session}/messages`, { messages }, auth);
let grants = 0;
async function setBalance(micros: number) {
  if ((await balance()) === micros) return;
  const r = await s.api(
    "POST",
    `/admin/v1/accounts/${accountId}/credits`,
    { amount_usd: (micros - (await balance())) / 1_000_000, idempotency_key: `set-${++grants}` },
    op,
  );
  expect(r.status).toBe(201);
}

beforeAll(async () => {
  s = await createHostedServer({ env: { RECALL_REASONER_MAX_DELAY_MS: "0" } });
  const b = new Browser(s.app);
  await b.signIn(s, "background@example.com");
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT account_id FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'background@example.com'`,
  );
  accountId = m!.account_id;
  const key = (await b.createKey({ name: "app" })).html.match(/pk_live_[A-Za-z0-9]{32}/)![0];
  auth = { authorization: `Bearer ${key}` };
  await s.api("POST", "/v3/workspaces", { id: "main" }, auth);
  await s.api("POST", "/v3/workspaces/main/peers", { id: "alice" }, auth);
  await s.api(
    "POST",
    "/v3/workspaces/main/peers",
    { id: "bot", configuration: { observe_me: false } },
    auth,
  );
  await setBalance(10_000_000);
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("background billing", () => {
  it("bills messages read only for context, for what the call read", async () => {
    await s.api(
      "POST",
      "/v3/workspaces/main/sessions",
      { id: "ctx", peers: { alice: {}, bot: {} } },
      auth,
    );
    const before = await balance();
    await add(
      "ctx",
      { peer_id: "alice", content: "I moved to Utrecht last month and cycle to work." },
      {
        peer_id: "bot",
        content: `Noted. ${"Here is a long reply about cycling routes. ".repeat(80)}`,
      },
    );
    await drainQueue(s.ctx);
    const [e] = await rows<{ amount_micros: string; detail: Record<string, number> }>(
      s.ctx.db,
      sql`SELECT amount_micros, detail FROM credit_ledger WHERE account_id = ${accountId}
            AND kind = 'ingest' AND detail->>'session_id' IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    expect(e!.detail.context_messages).toBe(1);
    // The bot's reply is cut to what the reasoner reads of a context message.
    expect(e!.detail.context_tokens).toBe(200);
    expect(e!.detail.billed_tokens).toBe(50 + 200);
    expect(await balance()).toBe(before - 250);
  });

  it("bills a session with reasoning off for its summaries", async () => {
    await s.api(
      "POST",
      "/v3/workspaces/main/sessions",
      { id: "free", peers: { alice: {} }, configuration: { reasoning: { enabled: false } } },
      auth,
    );
    const before = await balance();
    const summaries = await llmCalls("summary");
    const note = (i: number) =>
      `Note ${i}: ${"the quarterly plan covers hiring, pricing and the launch in Lisbon. ".repeat(20)}`;
    await add(
      "free",
      ...Array.from({ length: 30 }, (_, i) => ({ peer_id: "alice", content: note(i) })),
    );
    await drainQueue(s.ctx);
    expect(await llmCalls("summary")).toBeGreaterThan(summaries);
    const billed = await count(
      sql`SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${accountId}
            AND kind = 'ingest' AND detail->>'summary' = 'true'`,
    );
    expect(billed).toBeGreaterThan(0);
    expect(await balance()).toBeLessThan(before);
    // Each message is billed once: nothing is left tagged unbilled in the summarised range.
    const left = await count(
      sql`SELECT count(*)::int AS n FROM messages m JOIN sessions se ON se.id = m.session_id
            WHERE se.name = 'free' AND m.seq_in_session <= 20 AND m.internal ? 'unbilled'`,
    );
    expect(left).toBe(0);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("makes no summary call once the credit is gone", async () => {
    await setBalance(0);
    const summaries = await llmCalls("summary");
    const note = (i: number) => `Later note ${i}: ${"budget review and hiring plan. ".repeat(30)}`;
    await add(
      "free",
      ...Array.from({ length: 30 }, (_, i) => ({ peer_id: "alice", content: note(i) })),
    );
    await drainQueue(s.ctx);
    expect(await llmCalls("summary")).toBe(summaries);
    expect(await balance()).toBe(0);
  });

  it("passes over a small window the model cannot handle, billed, instead of retrying it forever", async () => {
    await setBalance(10_000_000);
    await s.api(
      "POST",
      "/v3/workspaces/main/sessions",
      { id: "poison", peers: { alice: {} } },
      auth,
    );
    const bad = vi
      .spyOn(s.ctx.llm, "structured")
      .mockRejectedValue(new LlmError("unusable output", "invalid_output"));
    await add("poison", { peer_id: "alice", content: "My favourite colour is teal, not blue." });
    await drainQueue(s.ctx);
    bad.mockRestore();
    const [m] = await rows<{ reasoned_at: Date | null }>(
      s.ctx.db,
      sql`SELECT reasoned_at FROM messages WHERE content LIKE 'My favourite colour%'`,
    );
    expect(m!.reasoned_at).not.toBeNull();
    const failed = await count(
      sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'reason' AND status = 'failed'`,
    );
    expect(failed).toBe(0);
  });

  it("runs a requested dream once, then skips repeats for a while", async () => {
    const cards = await llmCalls("card");
    for (let i = 0; i < 3; i++) {
      const r = await s.api(
        "POST",
        "/v3/workspaces/main/schedule_dream",
        { observer: "alice", dream_type: "card_refresh" },
        auth,
      );
      expect(r.status).toBe(204);
      await drainQueue(s.ctx);
    }
    expect(await llmCalls("card")).toBe(cards + 1);
  });

  it("overdraws by at most one window when the credit runs out mid-backlog", async () => {
    await setBalance(1);
    await s.api("POST", "/v3/workspaces/main/sessions", { id: "bulk", peers: { alice: {} } }, auth);
    const big = (i: number) =>
      `Entry ${i}: ${Array.from({ length: 1200 }, (_, j) => `w${(i * 7919 + j) % 100000}`).join(" ")}`;
    const r = await add(
      "bulk",
      ...Array.from({ length: 40 }, (_, i) => ({ peer_id: "alice", content: big(i) })),
    );
    expect(r.status).toBe(201);
    await drainQueue(s.ctx);
    const windows = await count(
      sql`SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${accountId} AND kind = 'ingest'
            AND detail->>'session_id' = (SELECT id FROM sessions WHERE name = 'bulk')`,
    );
    expect(windows).toBe(1);
    const unreasoned = await count(
      sql`SELECT count(*)::int AS n FROM messages m JOIN sessions se ON se.id = m.session_id
            WHERE se.name = 'bulk' AND m.reasoned_at IS NULL`,
    );
    expect(unreasoned).toBeGreaterThan(0);
    const [job] = await rows<{ paused: string | null }>(
      s.ctx.db,
      sql`SELECT payload->>'budget_paused_at' AS paused FROM jobs WHERE kind = 'reason' AND status = 'pending'`,
    );
    expect(job?.paused).toBeTruthy();
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });
});
