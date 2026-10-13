import { sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getBillingRow, ledgerDrift } from "../src/billing/ledger.js";
import { loadConfig } from "../src/config.js";
import { rows } from "../src/db/client.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Stripe Tax (RECALL_STRIPE_TAX): top-up amounts are credit and tax comes on top, so every
 * path credits the amount before tax: Checkout (whichever of its events lands first), auto
 * top-ups (invoiced with automatic tax, voided when the charge fails, credited by
 * `invoice.paid` when the charge was still processing) and refunds (the refunded share of the
 * credit, not of the tax).
 */

let s: HostedServer;
let b: Browser;
let accountId: string;
let evt = 0;

const balance = async () => (await getBillingRow(s.ctx.db, accountId))!.balance_micros;
const entries = (kind: string) =>
  rows<{ amount_micros: string; detail: Record<string, unknown> }>(
    s.ctx.db,
    sql`SELECT amount_micros, detail FROM credit_ledger WHERE account_id = ${accountId} AND kind = ${kind} ORDER BY id`,
  );
const customer = async () => (await getBillingRow(s.ctx.db, accountId))!.stripe_customer_id!;
const event = (type: string, object: Record<string, unknown>) => ({
  id: `evt_tax_${++evt}`,
  object: "event",
  type,
  data: { object },
});
const topupMeta = (cents: number) => ({
  account_id: accountId,
  recall_kind: "topup",
  credit_cents: String(cents),
});
/** Puts the balance just under the auto top-up threshold, with no back-off pending. */
const dueForTopUp = () =>
  s.ctx.db.execute(
    sql`UPDATE billing_accounts SET auto_topup_threshold_micros = balance_micros + 1,
          auto_topup_retry_after = NULL, auto_topup_failures = 0, auto_topup_pending_at = NULL
        WHERE account_id = ${accountId}`,
  );

beforeAll(async () => {
  s = await createHostedServer({
    env: {
      RECALL_STRIPE_TAX: "true",
      RECALL_INVOICE_VAT_NUMBER: "NL000099998B57",
      RECALL_CHECKOUT_TERMS_URL: "https://recall.test/terms",
    },
  });
  b = new Browser(s.app);
  await b.signIn(s, "taxed@example.com");
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'taxed@example.com'`,
  );
  accountId = m!.account_id;
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("Stripe Tax", () => {
  it("needs invoices, since auto top-ups are taxed through them", () => {
    expect(() =>
      loadConfig({
        RECALL_HOSTED: "true",
        RECALL_AUTH_ENABLED: "true",
        RECALL_AUTH_SECRET: "hosted-test-auth-secret",
        RECALL_ADMIN_TOKEN: "operator-token-0123456789abcdef",
        RECALL_DATABASE_URL: "postgres://recall@localhost/recall",
        RECALL_STRIPE_TAX: "true",
        RECALL_STRIPE_INVOICES: "false",
      }),
    ).toThrow(/RECALL_STRIPE_TAX/);
  });

  it("Checkout adds tax on top of the credit and collects the address and VAT number", async () => {
    const r = await b.post("/app/billing/checkout", { amount_usd: "25" });
    expect(r.res.status).toBe(303);
    const params = s.mocks.checkoutCreate.mock.calls.at(-1)![0];
    expect(params).toMatchObject({
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      metadata: topupMeta(2500),
      payment_intent_data: { metadata: topupMeta(2500) },
      invoice_creation: {
        enabled: true,
        invoice_data: { custom_fields: [{ name: "Seller VAT number", value: "NL000099998B57" }] },
      },
      consent_collection: { terms_of_service: "required" },
    });
    expect(params.custom_text.terms_of_service_acceptance.message).toContain(
      "[Terms of Service](https://recall.test/terms) and ask Recall to make the credit available immediately",
    );
    expect(params.custom_text.terms_of_service_acceptance.message).toContain(
      "14-day right of withdrawal",
    );
    expect(params.line_items[0].price_data).toMatchObject({
      currency: "eur",
      unit_amount: 2000,
      tax_behavior: "exclusive",
      product_data: { tax_code: "txcd_10103001" },
    });
    expect((await b.get("/app/billing")).html).toContain("VAT or sales tax is added at checkout");
  });

  it("credits the amount before tax, whichever Checkout event arrives first", async () => {
    const start = await balance();
    // payment_intent.succeeded first: the payment includes 21% VAT.
    await s.webhook(
      event("payment_intent.succeeded", {
        id: "pi_tax_1",
        amount: 3025,
        amount_received: 3025,
        currency: "usd",
        customer: await customer(),
        metadata: topupMeta(2500),
      }),
    );
    expect(await balance()).toBe(start + 25_000_000);
    const session = (pi: string, sub: number, total: number) =>
      event("checkout.session.completed", {
        id: `cs_${pi}`,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        currency: "usd",
        amount_subtotal: sub,
        amount_total: total,
        customer: "",
        payment_intent: pi,
        metadata: topupMeta(sub),
      });
    const first = session("pi_tax_1", 2500, 3025);
    first.data.object.customer = await customer();
    await s.webhook(first);
    expect(await balance()).toBe(start + 25_000_000);
    // Checkout first this time (and it saves the card for auto top-up).
    const second = session("pi_tax_2", 1000, 1210);
    second.data.object.customer = await customer();
    await s.webhook(second);
    expect(await balance()).toBe(start + 35_000_000);
    expect((await getBillingRow(s.ctx.db, accountId))!.payment_method_id).toBe("pm_card_visa");
  });

  it("a refund takes back the refunded share of the credit, not the tax", async () => {
    const start = await balance();
    const refund = async (refunded: number) =>
      s.webhook(
        event("charge.refunded", {
          id: "ch_tax_1",
          customer: await customer(),
          currency: "usd",
          amount: 3025,
          amount_refunded: refunded,
          payment_intent: "pi_tax_1",
        }),
      );
    await refund(1210); // 40% of the charge
    expect(await balance()).toBe(start - 10_000_000);
    await refund(3025); // the rest
    expect(await balance()).toBe(start - 25_000_000);
    expect(await entries("refund")).toHaveLength(2);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("invoices an auto top-up with tax and credits it once", async () => {
    const saved = await b.post("/app/billing/auto-topup", {
      enabled: "1",
      threshold_usd: "1",
      amount_usd: "20",
    });
    expect(saved.res.status).toBe(303);
    await dueForTopUp();
    const start = await balance();
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("succeeded");
    expect(await balance()).toBe(start + 20_000_000);
    expect(s.mocks.piCreate).not.toHaveBeenCalled();
    const [params, opts] = s.mocks.invoicesCreate.mock.calls.at(-1)!;
    expect(params).toMatchObject({
      customer: await customer(),
      currency: "usd",
      collection_method: "charge_automatically",
      automatic_tax: { enabled: true },
      default_payment_method: "pm_card_visa",
      metadata: { account_id: accountId, recall_kind: "auto_topup_invoice", credit_cents: "2000" },
      custom_fields: [{ name: "Seller VAT number", value: "NL000099998B57" }],
    });
    expect(opts.idempotencyKey).toMatch(new RegExp(`^recall-autotopup-${accountId}-\\d+-invoice$`));
    const invoice = (await s.mocks.invoicesCreate.mock.results.at(-1)!.value) as { id: string };
    expect(s.mocks.invoiceItemsCreate.mock.calls.at(-1)![0]).toMatchObject({
      invoice: invoice.id,
      amount: 2000,
      tax_behavior: "exclusive",
      tax_code: "txcd_10103001",
    });
    expect(s.mocks.invoicesPay.mock.calls.at(-1)![1]).toMatchObject({ off_session: true });
    const [entry] = await entries("auto_topup");
    expect(entry!.detail).toEqual({ invoice: invoice.id, payment_intent: `pi_for_${invoice.id}` });

    // Stripe's events for the same charge do not credit it again.
    await s.webhook(
      event("invoice.paid", {
        id: invoice.id,
        customer: await customer(),
        currency: "usd",
        subtotal: 2000,
        total: 2420,
        metadata: {
          account_id: accountId,
          recall_kind: "auto_topup_invoice",
          credit_cents: "2000",
        },
      }),
    );
    await s.webhook(
      event("payment_intent.succeeded", {
        id: `pi_for_${invoice.id}`,
        amount: 2420,
        amount_received: 2420,
        currency: "usd",
        customer: await customer(),
        metadata: {},
      }),
    );
    expect(await balance()).toBe(start + 20_000_000);
    expect(await entries("auto_topup")).toHaveLength(1);
  });

  it("voids the invoice of a declined auto top-up", async () => {
    s.mocks.invoicesPay.mockImplementationOnce(async () => {
      throw new Stripe.errors.StripeCardError({
        type: "card_error",
        message: "Your card was declined.",
        code: "card_declined",
      });
    });
    await dueForTopUp();
    const start = await balance();
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("failed");
    const invoice = (await s.mocks.invoicesCreate.mock.results.at(-1)!.value) as { id: string };
    expect(s.mocks.invoicesVoid).toHaveBeenCalledWith(invoice.id);
    expect(await balance()).toBe(start);
    expect((await getBillingRow(s.ctx.db, accountId))!.auto_topup_last_error).toBe(
      "Your card was declined.",
    );
  });

  it("credits an auto top-up that was still processing when invoice.paid arrives", async () => {
    s.mocks.invoicesPay.mockImplementationOnce(async (id: string) => ({ id, status: "open" }));
    await dueForTopUp();
    const start = await balance();
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("skipped");
    expect(await balance()).toBe(start);
    const invoice = (await s.mocks.invoicesCreate.mock.results.at(-1)!.value) as { id: string };
    const res = await s.webhook(
      event("invoice.paid", {
        id: invoice.id,
        customer: await customer(),
        currency: "usd",
        subtotal: 2000,
        total: 2420,
        metadata: {
          account_id: accountId,
          recall_kind: "auto_topup_invoice",
          credit_cents: "2000",
        },
      }),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect(await balance()).toBe(start + 20_000_000));
    const last = (await entries("auto_topup")).at(-1)!;
    expect(last.detail).toEqual({ invoice: invoice.id, payment_intent: `pi_for_${invoice.id}` });
    const row = (await getBillingRow(s.ctx.db, accountId))!;
    expect(row.auto_topup_last_error).toBeNull();
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });
});
