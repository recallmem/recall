import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBillingRow, ledgerDrift } from "../src/billing/ledger.js";
import { rows } from "../src/db/client.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Payments that go wrong after the fact: an auto top-up that is still processing (a bank debit)
 * holds back the next one until Stripe says how it ended, and a disputed card payment takes back
 * the credit it bought and suspends the account until an operator has looked.
 */

let s: HostedServer;
let b: Browser;
let accountId: string;
let evt = 0;

const balance = async () => (await getBillingRow(s.ctx.db, accountId))!.balance_micros;
const customer = async () => (await getBillingRow(s.ctx.db, accountId))!.stripe_customer_id!;
const event = (type: string, object: Record<string, unknown>) => ({
  id: `evt_risk_${++evt}`,
  object: "event",
  type,
  data: { object },
});
const topUp = async (pi: string, cents: number) =>
  s.webhook(
    event("checkout.session.completed", {
      id: `cs_risk_${evt}`,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      currency: "usd",
      amount_total: cents,
      customer: await customer(),
      payment_intent: pi,
      metadata: { account_id: accountId, recall_kind: "topup" },
    }),
  );

beforeAll(async () => {
  s = await createHostedServer();
  b = new Browser(s.app);
  await b.signIn(s, "risk@example.com");
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT account_id FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'risk@example.com'`,
  );
  accountId = m!.account_id;
  // A Checkout session creates the Stripe customer; its webhook saves the card.
  expect((await b.post("/app/billing/checkout", { amount_usd: "25" })).res.status).toBe(303);
  expect((await topUp("pi_risk_first", 2500)).status).toBe(200);
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("a processing auto top-up", () => {
  it("starts no second payment while the first is processing, and counts a late failure once", async () => {
    await b.post("/app/billing/auto-topup", {
      enabled: "1",
      threshold_usd: "100",
      amount_usd: "20",
    });
    s.mocks.piCreate.mockClear();
    s.mocks.piCreate.mockImplementation(async (p: { amount: number }) => ({
      id: "pi_sepa_1",
      status: "processing",
      amount: p.amount,
    }));
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("skipped");
    // The claim expiring (or another process trying) does not start another debit.
    await s.ctx.db.execute(
      sql`UPDATE billing_accounts SET auto_topup_pending_at = now() - interval '1 hour'
          WHERE account_id = ${accountId}`,
    );
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("skipped");
    await s.ctx.billing.sweep();
    expect(s.mocks.piCreate).toHaveBeenCalledTimes(1);

    // Days later the bank refuses it: one failure, the hold is released with a backoff.
    const failed = event("payment_intent.payment_failed", {
      id: "pi_sepa_1",
      object: "payment_intent",
      customer: await customer(),
      metadata: { account_id: accountId, recall_kind: "auto_topup" },
      last_payment_error: { message: "insufficient funds" },
    });
    expect((await s.webhook(failed)).status).toBe(200);
    const row = (await getBillingRow(s.ctx.db, accountId))!;
    expect(row.auto_topup_failures).toBe(1);
    expect(row.auto_topup_last_error).toBe("insufficient funds");
    const [ref] = await rows<{ ref: string | null }>(
      s.ctx.db,
      sql`SELECT auto_topup_pending_ref AS ref FROM billing_accounts WHERE account_id = ${accountId}`,
    );
    expect(ref!.ref).toBeNull();
    // A failure event for a payment we were not waiting on changes nothing.
    await s.webhook({ ...failed, id: `evt_risk_${++evt}` });
    expect((await getBillingRow(s.ctx.db, accountId))!.auto_topup_failures).toBe(1);
    s.mocks.piCreate.mockReset();
    await b.post("/app/billing/auto-topup", { enabled: "", threshold_usd: "1", amount_usd: "20" });
  });
});

describe("disputes", () => {
  it("takes back a disputed payment's credit and suspends the account; a won dispute returns it", async () => {
    expect((await topUp("pi_disputed", 5000)).status).toBe(200);
    const before = await balance();
    s.mocks.chargesRetrieve.mockImplementation(async (id: string) => ({
      id,
      object: "charge",
      amount: 5000,
      customer: await customer(),
      payment_intent: "pi_disputed",
    }));
    const dispute = {
      id: "dp_1",
      object: "dispute",
      charge: "ch_disputed",
      amount: 5000,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
    };
    expect((await s.webhook(event("charge.dispute.created", dispute))).status).toBe(200);
    expect(await balance()).toBe(before - 50_000_000);
    const [acct] = await rows<{ suspended_at: Date | null }>(
      s.ctx.db,
      sql`SELECT suspended_at FROM accounts WHERE id = ${accountId}`,
    );
    expect(acct!.suspended_at).not.toBeNull();

    // Lost: nothing more happens. Won: the credit comes back (the suspension stays for review).
    await s.webhook(event("charge.dispute.closed", { ...dispute, status: "lost" }));
    expect(await balance()).toBe(before - 50_000_000);
    await s.webhook(event("charge.dispute.closed", { ...dispute, status: "won" }));
    await s.webhook(event("charge.dispute.closed", { ...dispute, status: "won" }));
    expect(await balance()).toBe(before);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("finds the account from the ledger when the key may not read charges", async () => {
    expect((await topUp("pi_disputed_2", 2000)).status).toBe(200);
    const before = await balance();
    s.mocks.chargesRetrieve.mockRejectedValue(new Error("restricted key"));
    const r = await s.webhook(
      event("charge.dispute.created", {
        id: "dp_2",
        object: "dispute",
        charge: "ch_disputed_2",
        payment_intent: "pi_disputed_2",
        amount: 2000,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
      }),
    );
    expect(r.status).toBe(200);
    expect(await balance()).toBe(before - 20_000_000);
  });
});
