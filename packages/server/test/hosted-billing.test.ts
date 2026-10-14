import { sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getBillingRow, ledgerDrift } from "../src/billing/ledger.js";
import { rows } from "../src/db/client.js";
import { drainQueue } from "../src/queue/worker.js";
import { createTestServer } from "./api-helpers.js";
import {
  ADMIN,
  Browser,
  createHostedServer,
  type HostedServer,
  signStripe,
} from "./hosted-helpers.js";

/**
 * Prepaid billing: Stripe Checkout top-ups through the signed webhook, the
 * append-only ledger and its idempotency, per-batch ingest and per-request
 * chat debits, 402 at zero balance with background work paused and resumed by
 * a top-up, auto top-up (success and failure), refunds, portal and operator grants.
 */

let s: HostedServer;
let b: Browser;
let accountId: string;
let auth: Record<string, string>;
let evt = 0;
const op = { authorization: `Bearer ${ADMIN}` };

const balance = async () => (await getBillingRow(s.ctx.db, accountId))!.balance_micros;
const entries = (kind: string) =>
  rows<{ amount_micros: string; detail: Record<string, unknown> }>(
    s.ctx.db,
    sql`SELECT amount_micros, detail FROM credit_ledger WHERE account_id = ${accountId} AND kind = ${kind} ORDER BY id`,
  );
const customer = async () => (await getBillingRow(s.ctx.db, accountId))!.stripe_customer_id!;
const checkoutEvent = (
  cust: string,
  pi: string,
  cents: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `evt_${++evt}`,
  object: "event",
  type: "checkout.session.completed",
  data: {
    object: {
      id: `cs_${evt}`,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      currency: "usd",
      amount_total: cents,
      customer: cust,
      payment_intent: pi,
      metadata: { account_id: accountId, recall_kind: "topup" },
      ...extra,
    },
  },
});
const chat = (level = "low", headers: Record<string, string> = {}) =>
  s.api(
    "POST",
    "/v3/workspaces/main/peers/alice/chat",
    { query: "What does alice like to drink?", reasoning_level: level },
    { ...auth, ...headers },
  );
const addMessages = (...contents: string[]) =>
  s.api(
    "POST",
    "/v3/workspaces/main/sessions/s1/messages",
    { messages: contents.map((content) => ({ peer_id: "alice", content })) },
    auth,
  );

beforeAll(async () => {
  s = await createHostedServer({ env: { RECALL_REASONER_MAX_DELAY_MS: "0" } });
  b = new Browser(s.app);
  await b.signIn(s, "payer@example.com");
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'payer@example.com'`,
  );
  accountId = m!.account_id;
  const key = (await b.createKey({ name: "app" })).html.match(/pk_live_[A-Za-z0-9]{32}/)![0];
  auth = { authorization: `Bearer ${key}` };
  expect((await s.api("POST", "/v3/workspaces", { id: "main" }, auth)).status).toBe(201);
  await s.api("POST", "/v3/workspaces/main/peers", { id: "alice" }, auth);
  await s.api("POST", "/v3/workspaces/main/sessions", { id: "s1", peers: { alice: {} } }, auth);
  // Something to answer from: a chat over empty memory makes no model call and costs nothing.
  const facts = [
    "alice drinks oolong tea every morning",
    "alice lives in Utrecht",
    "alice likes coffee after lunch",
  ].map((content) => ({ content, observer_id: "alice", observed_id: "alice" }));
  expect(
    (await s.api("POST", "/v3/workspaces/main/conclusions", { conclusions: facts }, auth)).status,
  ).toBeLessThan(300);
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("Checkout top-ups", () => {
  it("redirects to Stripe Checkout with an ad-hoc amount and creates the customer once", async () => {
    const r = await b.post("/app/billing/checkout", { amount_usd: "25" });
    expect(r.res.status).toBe(303);
    expect(r.res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const params = s.mocks.checkoutCreate.mock.calls.at(-1)![0];
    expect(params.mode).toBe("payment");
    // Without RECALL_CHECKOUT_TERMS_URL there is no terms checkbox.
    expect(params.consent_collection).toBeUndefined();
    // $25 of credit, charged in euros at the day's rate (1.25 USD per EUR in tests), rounded up.
    expect(params.line_items[0].price_data).toMatchObject({ currency: "eur", unit_amount: 2000 });
    // Local currencies (and the methods that need them) via Adaptive Pricing; only cards and Link
    // are saved for auto top-up, so methods that cannot be saved still show.
    expect(params.adaptive_pricing).toEqual({ enabled: true });
    expect(params.payment_intent_data.setup_future_usage).toBeUndefined();
    expect(params.payment_method_options).toEqual({
      card: { setup_future_usage: "off_session" },
      link: { setup_future_usage: "off_session" },
    });
    expect(params.metadata).toEqual({
      account_id: accountId,
      recall_kind: "topup",
      credit_cents: "2500",
      usd_per_eur: "1.25",
    });
    expect(params.customer).toBe(await customer());
    expect(params.success_url).toBe("https://recall.test/app/billing?checkout=success");
    await b.post("/app/billing/checkout", { amount_usd: "10" });
    expect(s.mocks.customersCreate).toHaveBeenCalledTimes(1);
    expect(s.mocks.customersCreate.mock.calls[0]![1]).toEqual({
      idempotencyKey: `recall-customer-${accountId}`,
    });
  });

  it("rounds the euro price up to the cent, and charges USD while no rate is known", async () => {
    s.fx.usdPerEur = 1.1627;
    await b.post("/app/billing/checkout", { amount_usd: "10" });
    let params = s.mocks.checkoutCreate.mock.calls.at(-1)![0];
    // 1000 / 1.1627 = 860.07...: the customer pays 861 cents, never less than the credit is worth.
    expect(params.line_items[0].price_data).toMatchObject({ currency: "eur", unit_amount: 861 });
    s.fx.usdPerEur = null;
    try {
      await b.post("/app/billing/checkout", { amount_usd: "10" });
      params = s.mocks.checkoutCreate.mock.calls.at(-1)![0];
      expect(params.line_items[0].price_data).toMatchObject({ currency: "usd", unit_amount: 1000 });
      expect(params.metadata.usd_per_eur).toBeUndefined();
    } finally {
      s.fx.usdPerEur = 1.25;
    }
  });

  it("validates the amount", async () => {
    expect((await b.post("/app/billing/checkout", { amount_usd: "1" })).res.status).toBe(422);
    expect((await b.post("/app/billing/checkout", { amount_usd: "5000" })).res.status).toBe(422);
    expect((await b.post("/app/billing/checkout", { amount_usd: "abc" })).res.status).toBe(422);
  });

  it("rejects webhooks with a bad or missing signature", async () => {
    const before = await balance();
    const event = checkoutEvent(await customer(), "pi_forged", 100_000);
    expect(
      (await s.webhook(event, { signature: signStripe(JSON.stringify(event), "whsec_wrong") }))
        .status,
    ).toBe(400);
    expect((await s.webhook(event, { signature: "" })).status).toBe(400);
    const stale = signStripe(
      JSON.stringify(event),
      undefined,
      Math.floor(Date.now() / 1000) - 3600,
    );
    expect((await s.webhook(event, { signature: stale })).status).toBe(400);
    expect(await balance()).toBe(before);
  });

  it("credits a paid Checkout once, however often Stripe delivers it", async () => {
    const before = await balance();
    const event = checkoutEvent(await customer(), "pi_topup_1", 2500);
    const first = await s.webhook(event);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(await balance()).toBe(before + 25_000_000);
    // The saved card becomes the default for auto top-up.
    expect((await getBillingRow(s.ctx.db, accountId))!.payment_method_id).toBe("pm_card_visa");
    expect(s.mocks.customersUpdate).toHaveBeenCalledWith(await customer(), {
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });

    // Replay of the same event.
    const replay = await s.webhook(event);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });
    // A different event for the same payment.
    const pi = {
      id: `evt_${++evt}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_topup_1",
          object: "payment_intent",
          amount: 2500,
          amount_received: 2500,
          currency: "usd",
          customer: await customer(),
          metadata: { account_id: accountId, recall_kind: "topup" },
        },
      },
    };
    expect((await s.webhook(pi)).status).toBe(200);
    expect(await balance()).toBe(before + 25_000_000);
    expect(await entries("topup")).toHaveLength(1);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("credits the USD credit a euro Checkout bought, and refuses one that does not say", async () => {
    const before = await balance();
    const paid = checkoutEvent(await customer(), "pi_eur_1", 2000, {
      currency: "eur",
      metadata: {
        account_id: accountId,
        recall_kind: "topup",
        credit_cents: "2500",
        usd_per_eur: "1.25",
      },
    });
    expect((await s.webhook(paid)).status).toBe(200);
    expect(await balance()).toBe(before + 25_000_000);
    // Euro cents are not USD cents: without credit_cents nothing is credited.
    const bare = checkoutEvent(await customer(), "pi_eur_2", 2000, { currency: "eur" });
    expect((await s.webhook(bare)).status).toBe(200);
    expect(await balance()).toBe(before + 25_000_000);
  });

  it("credits a Checkout paid with a one-off method and keeps the saved card for auto top-up", async () => {
    expect((await getBillingRow(s.ctx.db, accountId))!.payment_method_id).toBe("pm_card_visa");
    const updates = s.mocks.customersUpdate.mock.calls.length;
    s.mocks.piRetrieve.mockResolvedValueOnce({
      id: "pi_ideal_1",
      payment_method: { id: "pm_ideal_1", type: "ideal", customer: null },
    });
    const before = await balance();
    expect((await s.webhook(checkoutEvent(await customer(), "pi_ideal_1", 1000))).status).toBe(200);
    expect(await balance()).toBe(before + 10_000_000);
    // iDEAL cannot be charged again later: the card stays the one auto top-up uses.
    expect((await getBillingRow(s.ctx.db, accountId))!.payment_method_id).toBe("pm_card_visa");
    expect(s.mocks.customersUpdate.mock.calls.length).toBe(updates);
  });

  it("ignores unpaid sessions, unknown customers and mismatched metadata", async () => {
    const before = await balance();
    const unpaid = checkoutEvent(await customer(), "pi_unpaid", 2500, { payment_status: "unpaid" });
    expect(await (await s.webhook(unpaid)).json()).toMatchObject({ ignored: "not paid yet" });
    const stranger = checkoutEvent("cus_someone_else", "pi_x", 2500);
    expect(await (await s.webhook(stranger)).json()).toMatchObject({ ignored: "unknown customer" });
    const mismatch = checkoutEvent(await customer(), "pi_y", 2500, {
      metadata: { account_id: "acct_other", recall_kind: "topup" },
    });
    expect(await (await s.webhook(mismatch)).json()).toMatchObject({ ignored: "unknown customer" });
    const other = { id: `evt_${++evt}`, type: "customer.created", data: { object: {} } };
    expect((await s.webhook(other)).status).toBe(200);
    expect(await balance()).toBe(before);
  });
});

describe("metering", () => {
  it("debits chat per request by level; a retry with the Idempotency-Key replays the answer free", async () => {
    const before = await balance();
    const r1 = await chat("low", { "idempotency-key": "chat-retry-1" });
    expect(r1.status).toBe(200);
    // The retry gets the first answer again, without running the model or a second debit.
    const r2 = await chat("low", { "idempotency-key": "chat-retry-1" });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(await r2.text()).toBe(await r1.text());
    expect(await balance()).toBe(before - 5_000);
    await chat("medium");
    await chat("medium");
    expect(await balance()).toBe(before - 5_000 - 2 * 25_000);
    expect((await entries("chat_medium")).length).toBe(2);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("refuses a reused Idempotency-Key for another question or level, without charging", async () => {
    const before = await balance();
    const ask = (query: string, level: string) =>
      s.api(
        "POST",
        "/v3/workspaces/main/peers/alice/chat",
        { query, reasoning_level: level },
        { ...auth, "idempotency-key": "chat-reused-key" },
      );
    expect((await ask("What does alice like to drink?", "low")).status).toBe(200);
    // A different question under the same key is not a retry: 409, nothing debited.
    const other = await ask("Where does alice live?", "low");
    expect(other.status).toBe(409);
    expect((await other.json()).detail).toBe(
      "Idempotency-Key was already used for a different request",
    );
    // Nor is the same question at another level.
    expect((await ask("What does alice like to drink?", "medium")).status).toBe(409);
    expect(await balance()).toBe(before - 5_000);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("keeps the cached balance exact under concurrent debits (and duplicate keys)", async () => {
    const before = await balance();
    const charge = (key: string) =>
      s.ctx.billing.reserveChat({ accountId, workspaceId: "ws_x", level: "minimal", key });
    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => charge(`concurrent-${i}`)),
      ...Array.from({ length: 10 }, () => charge("concurrent-dup")),
    ]);
    expect(await balance()).toBe(before - 26 * 800);
    expect((await entries("chat_minimal")).length).toBe(26);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("debits each reasoning batch once, per 1M message tokens, a message counting as at least 50", async () => {
    const before = await balance();
    const long =
      "Next spring I am walking the Camino Portugues from Porto to Santiago with two old friends " +
      "from university, carrying a light pack, sleeping in small albergues along the coast and " +
      "hoping to arrive in Santiago in time for my fortieth birthday in the middle of May.";
    expect(
      (
        await addMessages(
          "I drink oolong tea every morning before work.",
          "My sister lives in Lisbon.",
          long,
        )
      ).status,
    ).toBe(201);
    await drainQueue(s.ctx);
    const ingest = await entries("ingest");
    expect(ingest).toHaveLength(1);
    const counts = (
      await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT token_count AS n FROM messages WHERE content LIKE 'I drink oolong%' OR content LIKE 'My sister%' OR content LIKE 'Next spring%' ORDER BY seq_in_session`,
      )
    ).map((r) => Number(r.n));
    expect(counts[0]).toBeLessThan(50);
    expect(counts[1]).toBeLessThan(50);
    expect(counts[2]).toBeGreaterThan(50);
    const billed = 50 + 50 + counts[2]!;
    expect(ingest[0]!.detail.tokens).toBe(counts[0]! + counts[1]! + counts[2]!);
    expect(ingest[0]!.detail.billed_tokens).toBe(billed);
    // $1.00 per 1M tokens = 1 micro-USD per token.
    expect(Number(ingest[0]!.amount_micros)).toBe(-billed);
    expect(await balance()).toBe(before - billed);
    await drainQueue(s.ctx);
    expect(await entries("ingest")).toHaveLength(1);
  });
});

describe("out of credit", () => {
  it("answers 402, pauses reasoning without dropping it, and resumes after a top-up", async () => {
    const left = await balance();
    const zero = await s.api(
      "POST",
      `/admin/v1/accounts/${accountId}/credits`,
      { amount_usd: -left / 1_000_000, idempotency_key: "drain-to-zero" },
      op,
    );
    expect(zero.status).toBe(201);
    expect(await balance()).toBe(0);

    const denied = await chat("low");
    expect(denied.status).toBe(402);
    expect((await denied.json()).detail).toContain("Out of credit");
    expect((await b.get("/app")).html).toContain("Out of credit");
    // Adding facts embeds them at once (a model call), so it needs credit too.
    const fact = await s.api(
      "POST",
      "/v3/workspaces/main/conclusions",
      {
        conclusions: [
          { content: "alice likes jasmine tea", observer_id: "alice", observed_id: "alice" },
        ],
      },
      auth,
    );
    expect(fact.status).toBe(402);
    expect((await fact.json()).detail).toContain("Out of credit");

    // Ingest is still accepted; reasoning waits.
    expect((await addMessages("I adopted a grey cat named Pixel last week.")).status).toBe(201);
    await drainQueue(s.ctx);
    const pending = await rows<{ reasoned_at: Date | null }>(
      s.ctx.db,
      sql`SELECT reasoned_at FROM messages WHERE content LIKE 'I adopted%'`,
    );
    expect(pending[0]!.reasoned_at).toBeNull();
    const [job] = await rows<{ status: string; paused: string | null }>(
      s.ctx.db,
      sql`SELECT status, payload->>'budget_paused_at' AS paused FROM jobs WHERE kind = 'reason' AND status = 'pending'`,
    );
    expect(job).toMatchObject({ status: "pending" });
    expect(job!.paused).not.toBeNull();

    // Top-up: the paused job runs at once.
    expect((await s.webhook(checkoutEvent(await customer(), "pi_topup_2", 1000))).status).toBe(200);
    expect(await balance()).toBe(10_000_000);
    await drainQueue(s.ctx);
    const done = await rows<{ reasoned_at: Date | null }>(
      s.ctx.db,
      sql`SELECT reasoned_at FROM messages WHERE content LIKE 'I adopted%'`,
    );
    expect(done[0]!.reasoned_at).not.toBeNull();
    expect((await entries("ingest")).length).toBe(2);
    expect((await chat("low")).status).toBe(200);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("enforces the monthly budget against charges for billed accounts", async () => {
    await b.post("/app/settings/budget", { monthly_budget_usd: "0.01" });
    const r = await chat("max");
    // This month's charges already exceed one cent.
    expect(r.status).toBe(402);
    expect((await r.json()).detail).toBe("Monthly budget exceeded");
    await b.post("/app/settings/budget", { monthly_budget_usd: "" });
    expect((await chat("minimal")).status).toBe(200);
  });
});

describe("auto top-up", () => {
  it("charges the saved card off-session when a debit crosses the threshold", async () => {
    const saved = await b.post("/app/billing/auto-topup", {
      enabled: "1",
      threshold_usd: "1",
      amount_usd: "20",
    });
    expect(saved.res.status).toBe(303);
    s.mocks.piCreate.mockClear();
    const now = await balance();
    // Bring the balance just above the threshold, then spend across it.
    await s.api(
      "POST",
      `/admin/v1/accounts/${accountId}/credits`,
      { amount_usd: -(now - 1_010_000) / 1_000_000, idempotency_key: "near-threshold" },
      op,
    );
    expect(await balance()).toBe(1_010_000);
    expect((await chat("medium")).status).toBe(200); // -$0.025 → below $1
    await vi.waitFor(async () => expect(await balance()).toBeGreaterThan(20_000_000), {
      timeout: 5000,
    });
    expect(s.mocks.piCreate).toHaveBeenCalledTimes(1);
    const [params, options] = s.mocks.piCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      amount: 2000,
      currency: "usd",
      customer: await customer(),
      payment_method: "pm_card_visa",
      off_session: true,
      confirm: true,
      metadata: { account_id: accountId, recall_kind: "auto_topup" },
    });
    expect(options.idempotencyKey).toMatch(new RegExp(`^recall-autotopup-${accountId}-\\d+$`));
    expect(await entries("auto_topup")).toHaveLength(1);
    // Stripe's webhook for the same payment intent does not credit twice.
    const pi = s.mocks.piCreate.mock.results[0]!.value as Promise<{ id: string }>;
    const piId = (await pi).id;
    const before = await balance();
    await s.webhook({
      id: `evt_${++evt}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          amount: 2000,
          amount_received: 2000,
          currency: "usd",
          customer: await customer(),
          metadata: { account_id: accountId, recall_kind: "auto_topup" },
        },
      },
    });
    expect(await balance()).toBe(before);
    // Above the threshold now: nothing more to do.
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("skipped");
  });

  it("backs off on card failures, emails the owner, and switches off after three", async () => {
    s.mocks.piCreate.mockImplementation(async () => {
      throw new Stripe.errors.StripeCardError({
        type: "card_error",
        message: "Your card was declined.",
        code: "card_declined",
      });
    });
    await s.ctx.db.execute(
      sql`UPDATE billing_accounts SET auto_topup_threshold_micros = balance_micros + 1 WHERE account_id = ${accountId}`,
    );
    const before = await balance();
    const outbox = s.mailer.outbox.length;
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("failed");
    let row = (await getBillingRow(s.ctx.db, accountId))!;
    expect(row.auto_topup_failures).toBe(1);
    expect(row.auto_topup_last_error).toBe("Your card was declined.");
    expect(row.auto_topup_retry_after!.getTime()).toBeGreaterThan(Date.now());
    expect(row.auto_topup_enabled).toBe(true);
    expect(s.mailer.outbox.at(-1)).toMatchObject({
      to: "payer@example.com",
      subject: "Recall: auto top-up failed",
    });
    // Backing off: no new attempt until retry_after.
    expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("skipped");
    for (let i = 0; i < 2; i++) {
      await s.ctx.db.execute(
        sql`UPDATE billing_accounts SET auto_topup_retry_after = now() - interval '1 second' WHERE account_id = ${accountId}`,
      );
      expect(await s.ctx.billing.maybeAutoTopUp(accountId)).toBe("failed");
    }
    row = (await getBillingRow(s.ctx.db, accountId))!;
    expect(row.auto_topup_failures).toBe(3);
    expect(row.auto_topup_enabled).toBe(false);
    expect(s.mailer.outbox.at(-1)!.subject).toBe("Recall: auto top-up switched off");
    expect(s.mailer.outbox.length).toBe(outbox + 3);
    expect(await balance()).toBe(before);
    expect((await b.get("/app/billing")).html).toContain("Your card was declined.");
    s.mocks.piCreate.mockReset();
  });

  it("refuses to enable auto top-up without a saved card", async () => {
    const other = new Browser(s.app, "198.18.0.5");
    await other.signIn(s, "nocard@example.com");
    const r = await other.post("/app/billing/auto-topup", {
      enabled: "1",
      threshold_usd: "5",
      amount_usd: "25",
    });
    expect(r.res.status).toBe(422);
  });
});

describe("refunds, portal, invoices and grants", () => {
  it("debits refunds by the refunded delta, idempotently", async () => {
    const before = await balance();
    const refund = (cents: number) => ({
      id: `evt_${++evt}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", customer: "", currency: "usd", amount_refunded: cents } },
    });
    const send = async (cents: number) => {
      const e = refund(cents);
      (e.data.object as { customer: string }).customer = await customer();
      return s.webhook(e);
    };
    await send(1000);
    await send(1000);
    expect(await balance()).toBe(before - 10_000_000);
    await send(1500);
    expect(await balance()).toBe(before - 15_000_000);
    expect(await entries("refund")).toHaveLength(2);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  });

  it("opens the Stripe customer portal for the account's customer", async () => {
    const r = await b.post("/app/billing/portal");
    expect(r.res.status).toBe(303);
    expect(r.res.headers.get("location")).toBe("https://billing.stripe.com/p/session/test_1");
    expect(s.mocks.portalCreate.mock.calls.at(-1)![0]).toEqual({
      customer: await customer(),
      return_url: "https://recall.test/app/billing",
    });
  });

  it("lists invoices and the credit history on the billing page", async () => {
    s.mocks.invoicesList.mockResolvedValueOnce({
      data: [
        {
          id: "in_1",
          number: "PAR-0001",
          created: 1_760_000_000,
          total: 2500,
          currency: "usd",
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.com/i/x",
          invoice_pdf: null,
        },
      ],
    });
    const page = await b.get("/app/billing");
    expect(page.html).toContain("PAR-0001");
    expect(page.html).toContain("https://invoice.stripe.com/i/x");
    expect(page.html).toContain("Welcome credit");
    expect(page.html).toContain("$1.00 per 1M tokens");
  });

  it("operator grants are idempotent", async () => {
    const before = await balance();
    const grant = () =>
      s.api(
        "POST",
        `/admin/v1/accounts/${accountId}/credits`,
        { amount_usd: 3, idempotency_key: "startup-program" },
        op,
      );
    expect((await grant()).status).toBe(201);
    expect((await grant()).status).toBe(200);
    expect(await balance()).toBe(before + 3_000_000);
    const list = await (
      await s.api("GET", `/admin/v1/accounts/${accountId}/credits`, undefined, op)
    ).json();
    expect(list.billed).toBe(true);
    expect(list.entries[0].kind).toBe("grant");
  });

  it("the ledger is append-only", async () => {
    await expect(
      s.ctx.db.execute(sql`UPDATE credit_ledger SET amount_micros = 0`),
    ).rejects.toThrow();
    await expect(
      s.ctx.db.execute(sql`DELETE FROM credit_ledger WHERE account_id = ${accountId}`),
    ).rejects.toThrow();
  });

  it("GET /v3/usage reports charges and the credit balance for billed accounts", async () => {
    const usage = await (await s.api("GET", "/v3/usage", undefined, auth)).json();
    expect(usage.credit.balance_usd).toBe((await balance()) / 1_000_000);
    expect(usage.budget.month_to_date_usd).toBeGreaterThan(0);
  });
});

describe("self-hosted mode", () => {
  it("never meters or blocks", async () => {
    const plain = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
    try {
      await plain.request("POST", "/v3/workspaces", { id: "w" });
      await plain.request("POST", "/v3/workspaces/w/peers", { id: "p" });
      const r = await plain.request("POST", "/v3/workspaces/w/peers/p/chat", {
        query: "hi there?",
      });
      expect(r.status).toBe(200);
      expect(plain.ctx.billing.enabled).toBe(false);
      expect(await rows(plain.ctx.db, sql`SELECT 1 FROM credit_ledger`)).toHaveLength(0);
      expect(await rows(plain.ctx.db, sql`SELECT 1 FROM billing_accounts`)).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });
});
