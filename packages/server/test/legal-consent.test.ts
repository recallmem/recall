import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBillingRow } from "../src/billing/ledger.js";
import { rows } from "../src/db/client.js";
import { TERMS_VERSION } from "../src/lib/legal.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * With legal pages (RECALL_LEGAL_URL): the terms notice and links in the dashboard, the accepted
 * terms version per user, consent for auto top-up, the terms version on every purchase, the
 * withdrawal notice on invoices and one confirmation email per top-up.
 */

const LEGAL = "https://legal.test";
let s: HostedServer;
let b: Browser;
let accountId: string;
let evt = 0;

const user = async (email: string) => {
  const [u] = await rows<{ terms_version: string | null; terms_accepted_at: Date | null }>(
    s.ctx.db,
    sql`SELECT terms_version, terms_accepted_at FROM users WHERE email = ${email}`,
  );
  return u!;
};
const customer = async () => (await getBillingRow(s.ctx.db, accountId))!.stripe_customer_id!;
const confirmations = () => s.mailer.outbox.filter((m) => m.subject.endsWith("of credit added"));

beforeAll(async () => {
  s = await createHostedServer({
    env: {
      RECALL_LEGAL_URL: `${LEGAL}/terms`,
      RECALL_CHECKOUT_TERMS_URL: `${LEGAL}/terms`,
      RECALL_INVOICE_VAT_NUMBER: "NL000099998B57",
    },
  });
  b = new Browser(s.app);
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("terms at sign-in", () => {
  it("shows the terms notice and the legal links before anyone signs in", async () => {
    const { html } = await b.get("/app/login");
    expect(html).toContain("By signing in or creating an account, you agree to the");
    expect(html).toContain(`href="${LEGAL}/terms"`);
    expect(html).toContain(`href="${LEGAL}/dpa"`);
    expect(html).toContain(`href="${LEGAL}/privacy"`);
    expect(html).toContain(`(version ${TERMS_VERSION})`);
    expect(html).toMatch(/<footer class="legal">.*Terms.*Privacy.*DPA.*Security.*Support/);
  });

  it("records the accepted terms version when the account is created", async () => {
    await b.signIn(s, "consumer@example.com");
    const u = await user("consumer@example.com");
    expect(u.terms_version).toBe(TERMS_VERSION);
    expect(u.terms_accepted_at).not.toBeNull();
    const [m] = await rows<{ account_id: string }>(
      s.ctx.db,
      sql`SELECT account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'consumer@example.com'`,
    );
    accountId = m!.account_id;
  });

  it("records it again at the first sign-in under a new version, and not after that", async () => {
    await s.ctx.db.execute(
      sql`UPDATE users SET terms_version = '1.0', terms_accepted_at = now() - interval '1 day'
          WHERE email = 'consumer@example.com'`,
    );
    await new Browser(s.app, "198.51.100.20").signIn(s, "consumer@example.com");
    const renewed = await user("consumer@example.com");
    expect(renewed.terms_version).toBe(TERMS_VERSION);
    expect(Date.now() - new Date(renewed.terms_accepted_at!).getTime()).toBeLessThan(60_000);
    await new Browser(s.app, "198.51.100.21").signIn(s, "consumer@example.com");
    expect((await user("consumer@example.com")).terms_accepted_at).toEqual(
      renewed.terms_accepted_at,
    );
  });

  it("keeps the terms version printed on the published terms and DPA", () => {
    for (const page of ["terms", "dpa"])
      expect(readFileSync(new URL(`../public/${page}.html`, import.meta.url), "utf8")).toContain(
        `Version ${TERMS_VERSION}`,
      );
  });
});

describe("purchases", () => {
  it("sends Checkout the consent box, the terms version and the withdrawal notice for the invoice", async () => {
    const r = await b.post("/app/billing/checkout", { amount_usd: "25" });
    expect(r.res.status).toBe(303);
    const params = s.mocks.checkoutCreate.mock.calls.at(-1)![0];
    expect(params.consent_collection).toEqual({ terms_of_service: "required" });
    expect(params.metadata.terms_version).toBe(TERMS_VERSION);
    expect(params.payment_intent_data.metadata.terms_version).toBe(TERMS_VERSION);
    const invoice = params.invoice_creation.invoice_data;
    expect(invoice.custom_fields).toEqual([{ name: "Seller VAT number", value: "NL000099998B57" }]);
    expect(invoice.footer).toContain("within 14 days");
    expect(invoice.footer).toContain(`${LEGAL}/terms#withdrawal-form`);
    expect(invoice.footer.length).toBeLessThanOrEqual(5000);
  });

  it("credits a top-up once, records its terms version and emails one confirmation", async () => {
    const before = confirmations().length;
    const cust = await customer();
    const meta = {
      account_id: accountId,
      recall_kind: "topup",
      credit_cents: "2500",
      terms_version: TERMS_VERSION,
    };
    await s.webhook({
      id: `evt_legal_${++evt}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_legal_1",
          mode: "payment",
          payment_status: "paid",
          currency: "usd",
          amount_total: 2500,
          amount_subtotal: 2500,
          customer: cust,
          payment_intent: "pi_legal_1",
          metadata: meta,
        },
      },
    });
    // Stripe also reports the payment intent; it must not credit or email again.
    await s.webhook({
      id: `evt_legal_${++evt}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_legal_1",
          amount: 2500,
          amount_received: 2500,
          currency: "usd",
          customer: cust,
          metadata: meta,
        },
      },
    });
    const [entry] = await rows<{ detail: Record<string, unknown> }>(
      s.ctx.db,
      sql`SELECT detail FROM credit_ledger WHERE account_id = ${accountId} AND kind = 'topup'`,
    );
    expect(entry!.detail.terms_version).toBe(TERMS_VERSION);
    const mails = confirmations();
    expect(mails.length).toBe(before + 1);
    const mail = mails.at(-1)!;
    expect(mail.to).toBe("consumer@example.com");
    expect(mail.subject).toBe("Recall: $25.00 of credit added");
    expect(mail.text).toContain("make this credit available immediately");
    expect(mail.text).toContain(`${LEGAL}/terms#withdrawal-form`);
    expect(mail.text).toContain("I withdraw from my top-up of $25.00");
  });

  it("asks for consent before auto top-up is switched on, once per terms version", async () => {
    expect((await b.get("/app/billing")).html).toContain('name="consent"');
    const settings = { enabled: "1", threshold_usd: "5", amount_usd: "20" };
    expect((await b.post("/app/billing/auto-topup", settings)).res.status).toBe(422);
    expect(
      (await b.post("/app/billing/auto-topup", { ...settings, consent: "1" })).res.status,
    ).toBe(303);
    const [row] = await rows<{ v: string | null; at: Date | null; on: boolean }>(
      s.ctx.db,
      sql`SELECT auto_topup_consent_version AS v, auto_topup_consent_at AS at, auto_topup_enabled AS on
          FROM billing_accounts WHERE account_id = ${accountId}`,
    );
    expect(row).toMatchObject({ v: TERMS_VERSION, on: true });
    expect(row!.at).not.toBeNull();
    // Given once: later changes to the amounts need no new tick.
    expect((await b.get("/app/billing")).html).not.toContain('name="consent"');
    expect(
      (await b.post("/app/billing/auto-topup", { ...settings, threshold_usd: "4" })).res.status,
    ).toBe(303);
  });

  it("charges an auto top-up under the consented terms and confirms it by email", async () => {
    const before = confirmations().length;
    s.mocks.piCreate.mockClear();
    await s.ctx.db.execute(
      sql`UPDATE billing_accounts SET auto_topup_threshold_micros = balance_micros + 1,
            auto_topup_pending_at = NULL, auto_topup_retry_after = NULL
          WHERE account_id = ${accountId}`,
    );
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("succeeded");
    expect(s.mocks.piCreate.mock.calls[0]![0].metadata.terms_version).toBe(TERMS_VERSION);
    const mails = confirmations();
    expect(mails.length).toBe(before + 1);
    expect(mails.at(-1)!.text).toContain("automatic top-up of $20.00");
  });
});
