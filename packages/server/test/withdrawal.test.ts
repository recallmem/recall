import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBillingAccount, type LedgerKind, postEntry } from "../src/billing/ledger.js";
import { topupStatus } from "../src/billing/withdrawal.js";
import { rows } from "../src/db/client.js";
import { createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * What is left of each top-up for a consumer withdrawal (terms 9 and 10): usage counts first
 * against free credit, then against top-ups in the order they were bought; refunds belong to the
 * top-up whose payment they returned. Also: processed Stripe event ids go after seven years.
 */

let s: HostedServer;
const acct = "acct_withdrawal_1";
const M = 1_000_000;
let n = 0;
const post = (kind: LedgerKind, usd: number, detail: Record<string, unknown> = {}) =>
  postEntry(s.ctx.db, {
    account: acct,
    amountMicros: Math.round(usd * M),
    kind,
    key: `w:${++n}`,
    detail,
  });

beforeAll(async () => {
  s = await createHostedServer();
  await s.ctx.db.execute(sql`INSERT INTO accounts (id, name) VALUES (${acct}, 'Withdrawal')`);
  await ensureBillingAccount(s.ctx.db, acct);
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("topupStatus", () => {
  it("is empty without top-ups", async () => {
    expect(await topupStatus(s.ctx.db, acct)).toEqual([]);
  });

  it("spends free credit first, then top-ups oldest first", async () => {
    await post("signup_credit", 5);
    await post("topup", 25, { payment_intent: "pi_a" });
    await post("grant", 2, { note: "goodwill" });
    await post("auto_topup", 10, { payment_intent: "pi_b", invoice: "in_b" });
    await post("ingest", -9);
    await post("chat_low", -3);
    // A correction (negative grant) counts as usage; it is not free credit.
    await post("grant", -2);
    const [a, b] = await topupStatus(s.ctx.db, acct);
    // Usage 14, free credit 7: 7 of the first top-up is used.
    expect(a).toMatchObject({
      kind: "topup",
      creditMicros: 25 * M,
      refundedMicros: 0,
      unusedMicros: 18 * M,
      refundShare: 0.72,
      paymentIntent: "pi_a",
    });
    expect(b).toMatchObject({
      kind: "auto_topup",
      unusedMicros: 10 * M,
      refundShare: 1,
      invoice: "in_b",
    });
    const bought = new Date(a!.at).getTime();
    expect(new Date(a!.withdrawUntil).getTime() - bought).toBeGreaterThan(13 * 86_400_000);
  });

  it("keeps a refund with the top-up it returned", async () => {
    await post("refund", -4, { charge: "ch_b", payment_intent: "pi_b" });
    const [a, b] = await topupStatus(s.ctx.db, acct);
    expect(a!.unusedMicros).toBe(18 * M);
    expect(b).toMatchObject({ refundedMicros: 4 * M, unusedMicros: 6 * M, refundShare: 0.6 });
  });

  it("uses up later top-ups once earlier ones are spent", async () => {
    await post("chat_medium", -20);
    const [a, b] = await topupStatus(s.ctx.db, acct);
    expect(a!.unusedMicros).toBe(0);
    expect(b!.unusedMicros).toBe(4 * M);
  });
});

describe("retention", () => {
  it("purges processed Stripe events after seven years", async () => {
    await s.ctx.db.execute(
      sql`INSERT INTO stripe_events (id, type, account_id, processed_at) VALUES
            ('evt_old', 'checkout.session.completed', ${acct}, now() - interval '7 years 1 day'),
            ('evt_new', 'checkout.session.completed', ${acct}, now() - interval '6 years')`,
    );
    await s.ctx.billing.sweep();
    const left = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM stripe_events WHERE id IN ('evt_old', 'evt_new') ORDER BY id`,
    );
    expect(left.map((r) => r.id)).toEqual(["evt_new"]);
  });
});
