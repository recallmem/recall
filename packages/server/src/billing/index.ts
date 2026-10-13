import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import Stripe from "stripe";
import type { ChatLevel, HostedConfig } from "../config.js";
import { type BudgetGuard, setAccountSuspension } from "../core/accounts.js";
import { purgeOAuth } from "../core/oauth.js";
import { ownerEmails, purgeExpiredLogins } from "../core/users.js";
import { type Db, rows } from "../db/client.js";
import { renderEmail } from "../lib/email.js";
import { ApiError, badRequest, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { TERMS_VERSION, withdrawalNotice } from "../lib/legal.js";
import type { Mailer } from "../lib/mailer.js";
import { metrics } from "../lib/metrics.js";
import { SpendAlerts } from "./alerts.js";
import { ecbUsdPerEur } from "./fx.js";
import {
  ensureBillingAccount,
  formatUsd,
  getBillingRow,
  MICROS_PER_CENT,
  type PostResult,
  postEntry,
} from "./ledger.js";
import { purgeSignupGrants, recordSignupGrant, signupCreditSkipReason } from "./signup.js";

/**
 * Prepaid billing for the hosted service (RECALL_HOSTED=true with Stripe
 * configured; everything here is a no-op otherwise):
 *
 * - metering: each reasoning batch is debited per 1M message tokens and each
 *   chat request per reasoning level, idempotently (ledger key per batch/request);
 * - top-ups: Stripe Checkout with an ad-hoc amount; the webhook credits the
 *   ledger (signature-verified, idempotent by event id and by payment intent);
 * - auto top-up: an off-session charge on the saved card when the balance drops
 *   below the account's threshold; failures back off and, after three in a row,
 *   switch auto top-up off and email the owners;
 * - tax (RECALL_STRIPE_TAX): amounts are credit, Stripe Tax adds tax on top; Checkout
 *   collects the address and VAT number, auto top-ups are invoiced with the same tax,
 *   and a refund takes back the refunded share of the credit, not of the tax;
 * - the Stripe customer portal for cards and invoices.
 *
 * At zero balance the spend guard blocks chat (402) and pauses background
 * reasoning; a top-up resumes the paused jobs at once.
 */

type Executor = Pick<Db, "execute">;
type Billing_ = HostedConfig["billing"];

const AUTO_TOPUP_MAX_FAILURES = 3;
const AUTO_TOPUP_CLAIM_TTL = sql`interval '15 minutes'`;
/** How long a still-processing auto top-up holds back the next one when no webhook says how it ended. */
const AUTO_TOPUP_PENDING_HOLD = sql`interval '7 days'`;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const BUDGETED_KINDS = sql`('reason', 'summarize', 'dream', 'embed')`;
/** Stripe Tax product code for credits: software as a service, business use. */
const TAX_CODE = "txcd_10103001";
/** Payment method types Checkout saves for auto top-up (see `payment_method_options`). */
const REUSABLE_METHODS = new Set(["card", "link"]);

/** The credit a payment buys: our `credit_cents` (tax excluded) when set, else the amount paid. */
function creditMicros(
  metadata: Stripe.Metadata | null | undefined,
  paidCents: number,
  currency: string,
): number | null {
  const cents = Number(metadata?.credit_cents);
  if (Number.isSafeInteger(cents) && cents > 0) return cents * MICROS_PER_CENT;
  // Without the credit in the metadata only a USD amount says what was bought.
  return currency === "usd" ? paidCents * MICROS_PER_CENT : null;
}

/** Currencies a top-up may be paid in; the credit it buys is always in USD (`credit_cents`). */
const PAID_CURRENCIES = new Set(["usd", "eur"]);

/** A top-up that credited the account (for its confirmation email). */
interface Purchase {
  micros: number;
  auto: boolean;
}

/** One auto top-up charge; `terms` is the version its consent was given under. */
interface AutoCharge {
  accountId: string;
  customer: string;
  pm: string;
  cents: number;
  terms: string | null;
}

/** The terms version a purchase was made under, for its ledger entry. */
function termsOf(metadata: Stripe.Metadata | null | undefined): { terms_version?: string } {
  const v = metadata?.terms_version;
  return v ? { terms_version: v } : {};
}

export interface BillingDeps {
  config: HostedConfig;
  /** An absolute link to a dashboard page (Checkout and portal returns, emails). */
  dashboardLink: (path: string) => string;
  db: Db;
  log: Logger;
  budget: BudgetGuard;
  mailer: Mailer;
  /** Injected in tests; built from STRIPE_SECRET_KEY otherwise. */
  stripe?: Stripe | null;
  /** USD per EUR for euro Checkout; the ECB's daily rate unless injected (tests). */
  usdPerEur?: () => Promise<number | null>;
}

export interface Invoice {
  id: string;
  number: string | null;
  created: string;
  total_cents: number;
  currency: string;
  status: string | null;
  url: string | null;
  pdf: string | null;
}

export class Billing {
  readonly enabled: boolean;
  readonly stripe: Stripe | null;
  /** Low-balance, out-of-credit and budget emails to account owners (src/billing/alerts.ts). */
  readonly alerts: SpendAlerts;
  private readonly cfg: Billing_;
  private readonly usdPerEur: () => Promise<number | null>;

  constructor(private readonly deps: BillingDeps) {
    this.cfg = deps.config.billing;
    this.enabled = this.cfg.enabled;
    this.usdPerEur = deps.usdPerEur ?? ecbUsdPerEur();
    this.alerts = new SpendAlerts({
      config: deps.config,
      db: deps.db,
      log: deps.log,
      mailer: deps.mailer,
      dashboardLink: (path) => this.url(path),
      billing: this.enabled,
    });
    this.stripe = !this.enabled
      ? null
      : (deps.stripe ??
        new Stripe(this.cfg.stripeSecretKey!, {
          maxNetworkRetries: 2,
          timeout: 20_000,
          appInfo: { name: "Recall" },
        }));
  }

  get prices() {
    return this.cfg.prices;
  }

  // -------------------------------------------------------------------------
  // Metering

  /** Billed tokens of a batch: each message counts as at least `ingestMinTokens`. */
  billedTokens(tokenCounts: number[]): number {
    const min = this.cfg.prices.ingestMinTokens;
    return tokenCounts.reduce((n, t) => n + Math.max(t, min), 0);
  }

  /** Price of one ingest batch: per 1M billed tokens, rounded up to the micro. */
  ingestMicros(tokens: number): number {
    if (tokens <= 0) return 0;
    return Math.ceil((tokens * this.cfg.prices.ingestPerMTokMicros) / 1_000_000);
  }

  /**
   * Debits a reasoning batch inside the caller's transaction (the one that marks
   * the messages reasoned), keyed by the batch's message ids. Target messages count
   * their tokens with the per-message minimum; `contextTokens` (what the call read of
   * messages it did not learn from) count as they are.
   */
  async debitIngest(
    tx: Executor,
    batch: {
      workspaceId: string;
      sessionId: string;
      messageIds: string[];
      tokenCounts: number[];
      contextMessageIds?: string[];
      contextTokens?: number;
      /** Set by the summarize job, which bills messages no reasoning call read. */
      summary?: boolean;
    },
  ): Promise<void> {
    if (!this.enabled) return;
    const context = Math.max(0, batch.contextTokens ?? 0);
    const billed = this.billedTokens(batch.tokenCounts) + context;
    const micros = this.ingestMicros(billed);
    const ids = [...batch.messageIds, ...(batch.contextMessageIds ?? [])].sort();
    if (micros <= 0 || !ids.length) return;
    const prefix = batch.summary ? "summary" : "ingest";
    const key = `${prefix}:${createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 40)}`;
    const r = await postEntry(tx, {
      account: sql`SELECT account_id FROM workspaces WHERE id = ${batch.workspaceId}`,
      amountMicros: -micros,
      kind: "ingest",
      key,
      detail: {
        workspace_id: batch.workspaceId,
        session_id: batch.sessionId,
        messages: batch.messageIds.length,
        tokens: batch.tokenCounts.reduce((n, t) => n + t, 0),
        billed_tokens: billed,
        ...(batch.contextMessageIds?.length
          ? { context_messages: batch.contextMessageIds.length, context_tokens: context }
          : {}),
        ...(batch.summary ? { summary: true } : {}),
      },
    });
    // Checked after the caller commits; the check re-reads the balance.
    if (r) this.afterDebit(r, 500);
  }

  /**
   * Takes one chat request's price before the answer is made, refusing it when the balance does
   * not cover it (so concurrent requests cannot spend credit that is not there). `key` names the
   * request: a second reservation under the same key is refused as a duplicate. A request that
   * produces no answer gets the reservation back with `releaseChat`.
   */
  async reserveChat(p: {
    accountId: string;
    workspaceId: string;
    level: ChatLevel;
    key: string;
  }): Promise<"applied" | "duplicate" | "insufficient" | "free"> {
    if (!this.enabled) return "free";
    const micros = this.cfg.prices.chatMicros[p.level];
    if (!micros) return "free";
    const r = await postEntry(this.deps.db, {
      account: p.accountId,
      amountMicros: -micros,
      kind: `chat_${p.level}`,
      key: `chat:${p.key}`,
      detail: { workspace_id: p.workspaceId, level: p.level },
      requireCredit: true,
    });
    // An account without a billing row (operator-made, unbilled) is not charged.
    if (!r) return "free";
    if (!r.applied) return r.refused ?? "duplicate";
    this.afterDebit(r, 0);
    return "applied";
  }

  /** Returns a chat reservation whose request produced no answer (idempotent). */
  async releaseChat(p: {
    accountId: string;
    workspaceId: string;
    level: ChatLevel;
    key: string;
    reason: "failed" | "no model call";
  }): Promise<void> {
    if (!this.enabled) return;
    const micros = this.cfg.prices.chatMicros[p.level];
    if (!micros) return;
    await postEntry(this.deps.db, {
      account: p.accountId,
      amountMicros: micros,
      kind: `chat_${p.level}`,
      key: `chat:${p.key}:released`,
      detail: { workspace_id: p.workspaceId, level: p.level, released: p.reason },
    });
  }

  /** True when the reservation under `key` was given back (its request may then be retried). */
  async chatReleased(accountId: string, key: string): Promise<boolean> {
    const [r] = await rows<{ used: boolean }>(
      this.deps.db,
      sql`SELECT EXISTS (SELECT 1 FROM credit_ledger WHERE account_id = ${accountId}
                           AND idempotency_key = ${`chat:${key}:released`}) AS used`,
    );
    return !!r?.used;
  }

  private afterDebit(r: PostResult, delayMs: number): void {
    if (!r.applied) return;
    if (r.balanceMicros <= 0) this.deps.budget.invalidate(r.accountId);
    this.alerts.soon(r.accountId);
    if (r.autoTopup && r.balanceMicros < r.thresholdMicros) {
      const t = setTimeout(
        () =>
          void this.maybeAutoTopUp(r.accountId).catch((err) =>
            this.deps.log.error({ err, account: r.accountId }, "auto top-up check failed"),
          ),
        delayMs,
      );
      t.unref?.();
    }
  }

  // -------------------------------------------------------------------------
  // Credits

  /**
   * Called in the sign-up transaction: makes the account billed and grants the
   * free credit, unless the client network already received one recently or the
   * day's total of welcome credits has reached its cap (the account is still
   * created, just without the credit). `ipHash` is the keyed hash of the
   * client's network (null when unknown), `emailHash` that of the normalised
   * email address (one welcome credit per address, even after deletion).
   */
  async onSignup(
    tx: Executor,
    accountId: string,
    opts: { ipHash?: string | null; emailHash?: string | null } = {},
  ): Promise<void> {
    if (!this.enabled) return;
    await ensureBillingAccount(tx, accountId);
    const amountMicros = this.cfg.signupCreditMicros;
    if (amountMicros <= 0) return;
    const ipHash = opts.ipHash ?? null;
    const emailHash = opts.emailHash ?? null;
    const skipped = await signupCreditSkipReason(tx, {
      ipHash,
      emailHash,
      perIp: this.cfg.signupCreditPerIp,
      dailyCapMicros: this.cfg.signupCreditDailyCapMicros,
    });
    if (skipped) {
      metrics.signupCreditSkipped.inc({ reason: skipped });
      this.deps.log.info({ account: accountId, reason: skipped }, "sign-up credit skipped");
      return;
    }
    const r = await postEntry(tx, {
      account: accountId,
      amountMicros,
      kind: "signup_credit",
      key: `signup:${accountId}`,
    });
    if (r?.applied) await recordSignupGrant(tx, ipHash, amountMicros, emailHash);
  }

  /**
   * Operator grant (or correction, when negative); makes the account billed. `by` names
   * the operator (the console's signed-in email) in the entry's detail.
   */
  async grant(accountId: string, micros: number, key: string, note: string | null, by?: string) {
    await ensureBillingAccount(this.deps.db, accountId);
    const r = await postEntry(this.deps.db, {
      account: accountId,
      amountMicros: micros,
      kind: "grant",
      key: `grant:${key}`,
      detail: { ...(note ? { note } : {}), ...(by ? { by } : {}) },
    });
    await this.credited(accountId);
    return r;
  }

  /** After credit lands: forget the cached verdict and wake the account's paused jobs. */
  private async credited(accountId: string): Promise<void> {
    this.deps.budget.invalidate(accountId);
    await this.deps.db.execute(
      sql`UPDATE jobs SET run_after = now()
          WHERE status = 'pending' AND run_after > now() AND kind IN ${BUDGETED_KINDS}
            AND payload->>'budget_paused_at' IS NOT NULL
            AND workspace_id IN (SELECT id FROM workspaces WHERE account_id = ${accountId})`,
    );
  }

  // -------------------------------------------------------------------------
  // Stripe: customers, Checkout, portal, invoices

  private requireStripe(): Stripe {
    if (!this.stripe) throw notFound("Billing");
    return this.stripe;
  }

  private url(path: string): string {
    const link = this.deps.dashboardLink(path);
    return /^https?:\/\//.test(link) ? link : `http://localhost:8000${link}`;
  }

  async ensureCustomer(accountId: string, email: string): Promise<string> {
    const stripe = this.requireStripe();
    const row = await getBillingRow(this.deps.db, accountId);
    if (!row) throw notFound("Billing account");
    if (row.stripe_customer_id) return row.stripe_customer_id;
    const customer = await stripe.customers.create(
      { email, metadata: { account_id: accountId } },
      { idempotencyKey: `recall-customer-${accountId}` },
    );
    await this.deps.db.execute(
      sql`UPDATE billing_accounts SET stripe_customer_id = ${customer.id}, updated_at = now()
          WHERE account_id = ${accountId} AND stripe_customer_id IS NULL`,
    );
    return (await getBillingRow(this.deps.db, accountId))!.stripe_customer_id!;
  }

  /** Validates a top-up amount (whole cents within the configured range). */
  checkTopupAmount(micros: number): number {
    const { topupMinMicros: min, topupMaxMicros: max } = this.cfg;
    if (!Number.isFinite(micros) || micros < min || micros > max)
      throw unprocessable(`Top-up amount must be between ${formatUsd(min)} and ${formatUsd(max)}`);
    return Math.round(micros / MICROS_PER_CENT) * MICROS_PER_CENT;
  }

  /** Starts a Checkout for `micros` of credit; returns the Stripe-hosted URL. */
  async createCheckout(accountId: string, email: string, micros: number): Promise<string> {
    const stripe = this.requireStripe();
    const amount = this.checkTopupAmount(micros);
    const customer = await this.ensureCustomer(accountId, email);
    const cents = amount / MICROS_PER_CENT;
    const tax = this.cfg.tax;
    // Credit is in USD. In euros the price is that credit at the ECB rate, rounded up to the cent.
    const usdPerEur = this.cfg.checkoutCurrency === "eur" ? await this.usdPerEur() : null;
    const price = usdPerEur
      ? { currency: "eur", cents: Math.ceil(cents / usdPerEur) }
      : { currency: "usd", cents };
    const meta = {
      account_id: accountId,
      recall_kind: "topup",
      credit_cents: String(cents),
      ...(usdPerEur ? { usd_per_eur: String(usdPerEur) } : {}),
      // The version the customer agrees to in the Checkout consent box; Stripe keeps the consent.
      ...(this.cfg.checkoutTermsUrl ? { terms_version: TERMS_VERSION } : {}),
    };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer,
      client_reference_id: accountId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: price.currency,
            unit_amount: price.cents,
            ...(tax ? { tax_behavior: "exclusive" as const } : {}),
            product_data: {
              name: "Recall credits",
              description: `${formatUsd(amount)} of prepaid Recall usage`,
              ...(tax ? { tax_code: TAX_CODE } : {}),
            },
          },
        },
      ],
      ...(tax
        ? {
            automatic_tax: { enabled: true },
            billing_address_collection: "required" as const,
            tax_id_collection: { enabled: true },
            // Keeps the address and VAT number on the customer, so auto top-ups are taxed alike.
            customer_update: { address: "auto" as const, name: "auto" as const },
          }
        : {}),
      // Stripe may show customers outside the price's currency their own (and the methods that
      // need it); the session, payment and refunds keep the price's currency.
      adaptive_pricing: { enabled: true },
      payment_intent_data: { metadata: meta },
      // Only methods that can be charged again later are saved for auto top-up. Asking it of the
      // whole payment would hide every method that cannot be saved (iDEAL, Bancontact, EPS, ...).
      payment_method_options: {
        card: { setup_future_usage: "off_session" },
        link: { setup_future_usage: "off_session" },
      },
      metadata: meta,
      ...(this.cfg.checkoutTermsUrl
        ? {
            // Express consent to start at once, which EU consumer law needs before credit can be
            // used inside the 14-day withdrawal period; the Terms refund unused credit on withdrawal.
            consent_collection: { terms_of_service: "required" as const },
            custom_text: {
              terms_of_service_acceptance: {
                message: `I agree to the [Terms of Service](${this.cfg.checkoutTermsUrl}) and ask Recall to make the credit available immediately. If I am a consumer, I keep my 14-day right of withdrawal for credit I have not used.`,
              },
            },
          }
        : {}),
      ...(this.cfg.invoices
        ? {
            invoice_creation: {
              enabled: true,
              ...(this.invoiceFields ? { invoice_data: this.invoiceFields } : {}),
            },
          }
        : {}),
      success_url: this.url("/billing?checkout=success"),
      cancel_url: this.url("/billing?checkout=cancelled"),
    });
    if (!session.url) throw new ApiError(502, "Stripe did not return a Checkout URL");
    return session.url;
  }

  /**
   * Invoice extras: the seller's VAT number as a field (EU invoices must show it) and, with legal
   * pages, the consumer withdrawal notice as the footer (the purchase confirmation on paper).
   */
  private get invoiceFields() {
    const vat = this.cfg.invoiceVatNumber;
    const legal = this.deps.config.legal;
    if (!vat && !legal) return undefined;
    return {
      ...(vat ? { custom_fields: [{ name: "Seller VAT number", value: vat }] } : {}),
      ...(legal ? { footer: withdrawalNotice(legal) } : {}),
    };
  }

  async portalUrl(accountId: string, email: string): Promise<string> {
    const stripe = this.requireStripe();
    const customer = await this.ensureCustomer(accountId, email);
    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: this.url("/billing"),
      ...(this.cfg.portalConfiguration ? { configuration: this.cfg.portalConfiguration } : {}),
    });
    return session.url;
  }

  async invoices(accountId: string): Promise<Invoice[]> {
    if (!this.stripe) return [];
    const row = await getBillingRow(this.deps.db, accountId);
    if (!row?.stripe_customer_id) return [];
    const list = await this.stripe.invoices.list({ customer: row.stripe_customer_id, limit: 24 });
    return list.data.map((i) => ({
      id: i.id ?? "",
      number: i.number ?? null,
      created: new Date(i.created * 1000).toISOString(),
      total_cents: i.total,
      currency: i.currency,
      status: i.status ?? null,
      url: i.hosted_invoice_url ?? null,
      pdf: i.invoice_pdf ?? null,
    }));
  }

  /**
   * Saves the auto top-up settings. With legal pages each automatic top-up is a purchase of its
   * own, so switching it on needs `consent` to start each one at once (EU withdrawal rules),
   * unless it was already given under the current terms version.
   */
  async updateAutoTopup(
    accountId: string,
    s: { enabled: boolean; thresholdMicros: number; amountMicros: number; consent?: boolean },
  ): Promise<void> {
    const amount = this.checkTopupAmount(s.amountMicros);
    if (
      !Number.isFinite(s.thresholdMicros) ||
      s.thresholdMicros < 0 ||
      s.thresholdMicros > amount * 10
    )
      throw unprocessable("Threshold must be between $0 and ten times the top-up amount");
    const consent = s.enabled && !!this.deps.config.legal && !!s.consent;
    if (s.enabled) {
      const row = await getBillingRow(this.deps.db, accountId);
      if (!row?.payment_method_id)
        throw unprocessable(
          "Buy credits once first: auto top-up charges the card saved at Checkout",
        );
      if (this.deps.config.legal && !consent && row.auto_topup_consent_version !== TERMS_VERSION)
        throw unprocessable(
          "Tick the box to agree that each automatic top-up is a purchase under the Terms of Service",
        );
    }
    await this.deps.db.execute(
      sql`UPDATE billing_accounts SET auto_topup_enabled = ${s.enabled},
            auto_topup_consent_version = CASE WHEN ${consent} THEN ${TERMS_VERSION} ELSE auto_topup_consent_version END,
            auto_topup_consent_at = CASE WHEN ${consent} THEN now() ELSE auto_topup_consent_at END,
            auto_topup_threshold_micros = ${Math.round(s.thresholdMicros)},
            auto_topup_amount_micros = ${amount},
            auto_topup_failures = CASE WHEN ${s.enabled} THEN 0 ELSE auto_topup_failures END,
            auto_topup_retry_after = CASE WHEN ${s.enabled} THEN NULL ELSE auto_topup_retry_after END,
            updated_at = now()
          WHERE account_id = ${accountId}`,
    );
    if (s.enabled) void this.maybeAutoTopUp(accountId).catch(() => undefined);
  }

  /** Best effort: removes the Stripe customer (GDPR erasure); Stripe keeps legally required records. */
  async deleteCustomer(customerId: string | null): Promise<void> {
    if (!this.stripe || !customerId) return;
    try {
      await this.stripe.customers.del(customerId);
    } catch (err) {
      this.deps.log.warn({ err, customer: customerId }, "could not delete the Stripe customer");
    }
  }

  // -------------------------------------------------------------------------
  // Auto top-up

  /**
   * Charges the saved card when the balance is under the threshold. At most one
   * attempt per account runs at a time (a claim on the billing row); Stripe's
   * idempotency key is per attempt, so a retried request cannot charge twice.
   */
  async maybeAutoTopUp(accountId: string): Promise<"skipped" | "succeeded" | "failed"> {
    if (!this.stripe) return "skipped";
    const [claim] = await rows<{
      customer: string;
      pm: string;
      amount: string | number;
      attempts: number;
      failures: number;
      terms: string | null;
    }>(
      this.deps.db,
      sql`UPDATE billing_accounts SET auto_topup_pending_at = now(), auto_topup_attempts = auto_topup_attempts + 1
          WHERE account_id = ${accountId} AND auto_topup_enabled
            AND payment_method_id IS NOT NULL AND stripe_customer_id IS NOT NULL
            AND balance_micros < auto_topup_threshold_micros
            AND (auto_topup_pending_at IS NULL OR auto_topup_pending_at < now() - ${AUTO_TOPUP_CLAIM_TTL})
            AND (auto_topup_retry_after IS NULL OR auto_topup_retry_after <= now())
          RETURNING stripe_customer_id AS customer, payment_method_id AS pm,
                    auto_topup_amount_micros AS amount, auto_topup_attempts AS attempts,
                    auto_topup_failures AS failures, auto_topup_consent_version AS terms`,
    );
    if (!claim) return "skipped";
    const cents = Math.round(Number(claim.amount) / MICROS_PER_CENT);
    const charge = { accountId, customer: claim.customer, pm: claim.pm, cents, terms: claim.terms };
    const idem = `recall-autotopup-${accountId}-${claim.attempts}`;
    try {
      const paid = this.cfg.tax
        ? await this.autoTopUpInvoice(charge, idem)
        : await this.autoTopUpPayment(charge, idem);
      // Still processing (a bank debit can take days): no new attempt until its webhook says
      // how it ended, or the hold runs out. Without this hold a new payment would start each
      // time the claim expired, and every one of them would be collected later.
      if ("pending" in paid) {
        await this.deps.db.execute(
          sql`UPDATE billing_accounts SET auto_topup_pending_ref = ${paid.pending},
                auto_topup_retry_after = now() + ${AUTO_TOPUP_PENDING_HOLD}, updated_at = now()
              WHERE account_id = ${accountId}`,
        );
        return "skipped";
      }
      const posted = await postEntry(this.deps.db, {
        account: accountId,
        amountMicros: cents * MICROS_PER_CENT,
        kind: "auto_topup",
        key: paid.key,
        detail: paid.detail,
      });
      await this.deps.db.execute(
        sql`UPDATE billing_accounts SET auto_topup_pending_at = NULL, auto_topup_pending_ref = NULL,
              auto_topup_failures = 0, auto_topup_retry_after = NULL, auto_topup_last_error = NULL,
              updated_at = now()
            WHERE account_id = ${accountId}`,
      );
      metrics.autoTopups.inc({ outcome: "succeeded" });
      await this.credited(accountId);
      if (posted?.applied) await this.confirmPurchase(accountId, cents * MICROS_PER_CENT, true);
      return "succeeded";
    } catch (err) {
      await this.autoTopupFailed(accountId, claim.failures + 1, err);
      return "failed";
    }
  }

  private async autoTopUpPayment(
    c: AutoCharge,
    idem: string,
  ): Promise<{ key: string; detail: Record<string, unknown> } | { pending: string }> {
    const pi = await this.stripe!.paymentIntents.create(
      {
        amount: c.cents,
        currency: "usd",
        customer: c.customer,
        payment_method: c.pm,
        off_session: true,
        confirm: true,
        description: "Recall credits (auto top-up)",
        metadata: {
          account_id: c.accountId,
          recall_kind: "auto_topup",
          credit_cents: String(c.cents),
          ...(c.terms ? { terms_version: c.terms } : {}),
        },
      },
      { idempotencyKey: idem },
    );
    if (pi.status === "processing") return { pending: pi.id };
    if (pi.status !== "succeeded") throw new Error(`payment ${pi.status.replaceAll("_", " ")}`);
    return {
      key: `topup:${pi.id}`,
      detail: { payment_intent: pi.id, ...(c.terms ? { terms_version: c.terms } : {}) },
    };
  }

  /**
   * With Stripe Tax: an invoice for the credit plus tax, paid off-session with the saved card,
   * so an auto top-up gets the same tax and a tax invoice like a Checkout top-up. A failed
   * attempt voids (or deletes) its invoice; the next attempt makes a new one.
   */
  private async autoTopUpInvoice(
    c: AutoCharge,
    idem: string,
  ): Promise<{ key: string; detail: Record<string, unknown> } | { pending: string }> {
    const stripe = this.stripe!;
    // A kind of its own: should Stripe ever copy it to the invoice's payment intent, the
    // payment_intent.succeeded handler must not credit it a second time.
    const metadata = {
      account_id: c.accountId,
      recall_kind: "auto_topup_invoice",
      credit_cents: String(c.cents),
      ...(c.terms ? { terms_version: c.terms } : {}),
    };
    const invoice = await stripe.invoices.create(
      {
        customer: c.customer,
        currency: "usd",
        collection_method: "charge_automatically",
        auto_advance: false,
        automatic_tax: { enabled: true },
        default_payment_method: c.pm,
        pending_invoice_items_behavior: "exclude",
        description: "Recall credits (auto top-up)",
        metadata,
        ...this.invoiceFields,
      },
      { idempotencyKey: `${idem}-invoice` },
    );
    const id = invoice.id!;
    let finalized = false;
    try {
      await stripe.invoiceItems.create(
        {
          customer: c.customer,
          invoice: id,
          currency: "usd",
          amount: c.cents,
          description: "Recall credits",
          tax_behavior: "exclusive",
          tax_code: TAX_CODE,
        },
        { idempotencyKey: `${idem}-item` },
      );
      await stripe.invoices.finalizeInvoice(id, {}, { idempotencyKey: `${idem}-finalize` });
      finalized = true;
      const paid = await stripe.invoices.pay(
        id,
        { off_session: true, expand: ["payments"] },
        { idempotencyKey: `${idem}-pay` },
      );
      if (paid.status !== "paid") return { pending: id };
      const pi = paid.payments?.data[0]?.payment.payment_intent;
      return {
        key: `topup:${id}`,
        detail: {
          invoice: id,
          payment_intent: typeof pi === "string" ? pi : (pi?.id ?? null),
          ...(c.terms ? { terms_version: c.terms } : {}),
        },
      };
    } catch (err) {
      await (finalized ? stripe.invoices.voidInvoice(id) : stripe.invoices.del(id)).catch((e) =>
        this.deps.log.warn({ err: e, invoice: id }, "could not void a failed auto top-up invoice"),
      );
      throw err;
    }
  }

  private async autoTopupFailed(accountId: string, failures: number, err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const disable = failures >= AUTO_TOPUP_MAX_FAILURES;
    const backoffMs = Math.min(24 * 3_600_000, 3_600_000 * 2 ** (failures - 1));
    this.deps.log.warn({ err, account: accountId, failures, disable }, "auto top-up failed");
    metrics.autoTopups.inc({ outcome: disable ? "disabled" : "failed" });
    await this.deps.db.execute(
      sql`UPDATE billing_accounts SET auto_topup_pending_at = NULL, auto_topup_pending_ref = NULL,
            auto_topup_failures = ${failures},
            auto_topup_retry_after = ${new Date(Date.now() + backoffMs)},
            auto_topup_last_error = ${message},
            auto_topup_enabled = auto_topup_enabled AND NOT ${disable}, updated_at = now()
          WHERE account_id = ${accountId}`,
    );
    const owners = await ownerEmails(this.deps.db, accountId);
    const billingUrl = this.url("/billing");
    const text = disable
      ? `Automatic top-up of your Recall credits failed ${failures} times and has been switched off.\n\nLast error: ${message}\n\nUpdate your card and re-enable it at ${billingUrl}`
      : `An automatic top-up of your Recall credits failed: ${message}\n\nWe will retry later. You can update your card at ${billingUrl}`;
    for (const to of owners) {
      await this.deps.mailer
        .send({
          to,
          subject: disable ? "Recall: auto top-up switched off" : "Recall: auto top-up failed",
          ...renderEmail(
            // Images come from the same deployment that serves the billing page.
            new URL(billingUrl, "https://recallmem.dev").origin,
            {
              preheader: disable
                ? "Automatic top-up was switched off."
                : "An automatic top-up failed.",
              heading: disable ? "Auto top-up switched off" : "Auto top-up failed",
              paragraphs: text.split("\n\n").slice(0, -1),
              button: { label: "Open billing", url: billingUrl },
            },
          ),
        })
        .catch((e) => this.deps.log.error({ err: e }, "could not send the auto top-up email"));
    }
  }

  /**
   * Emails the account owners a confirmation of a purchase that just landed (once per top-up):
   * the amount, the consent to start at once, and how a consumer withdraws. EU consumer law asks
   * for this confirmation on a durable medium; it goes out only with legal pages configured.
   */
  private async confirmPurchase(accountId: string, micros: number, auto: boolean): Promise<void> {
    const legal = this.deps.config.legal;
    if (!legal) return;
    const billingUrl = this.url("/billing");
    const amount = formatUsd(micros);
    const day = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/Amsterdam",
    });
    const what = auto ? "automatic top-up" : "top-up";
    for (const to of await ownerEmails(this.deps.db, accountId)) {
      await this.deps.mailer
        .send({
          to,
          subject: `Recall: ${amount} of credit added`,
          ...renderEmail(new URL(billingUrl, "https://recallmem.dev").origin, {
            preheader: `Your ${what} of ${amount} is on your balance.`,
            heading: "Credit added",
            paragraphs: [
              `We added ${amount} of Recall credit to your account on ${day} (${what}). Your invoice, with any VAT, is on the billing page.`,
              withdrawalNotice(legal),
              `To withdraw, write for example: "I withdraw from my ${what} of ${amount} on ${day}."`,
            ],
            button: { label: "Open billing", url: billingUrl },
          }),
        })
        .catch((err) => this.deps.log.error({ err }, "could not send the purchase confirmation"));
    }
  }

  /**
   * Retries due auto top-ups (e.g. after a restart), sends the spend alerts that are due and
   * purges expired sign-in and sign-up records.
   */
  async sweep(): Promise<void> {
    if (this.deps.config.dashboard) {
      await purgeExpiredLogins(this.deps.db);
      await purgeSignupGrants(this.deps.db);
      await this.alerts
        .sweep()
        .catch((err) => this.deps.log.error({ err }, "spend alert sweep failed"));
    }
    if (this.deps.config.oauth.enabled) await purgeOAuth(this.deps.db);
    if (!this.stripe) return;
    // Processed Stripe event ids are kept with the financial records, which go after 7 years.
    await this.deps.db.execute(
      sql`DELETE FROM stripe_events WHERE processed_at < now() - interval '7 years'`,
    );
    const due = await rows<{ account_id: string }>(
      this.deps.db,
      sql`SELECT account_id FROM billing_accounts
          WHERE auto_topup_enabled AND payment_method_id IS NOT NULL
            AND balance_micros < auto_topup_threshold_micros
            AND (auto_topup_pending_at IS NULL OR auto_topup_pending_at < now() - ${AUTO_TOPUP_CLAIM_TTL})
            AND (auto_topup_retry_after IS NULL OR auto_topup_retry_after <= now())
          LIMIT 100`,
    );
    for (const r of due) await this.maybeAutoTopUp(r.account_id);
  }

  /** Runs `sweep` every few minutes (worker processes, hosted mode). */
  startSweeper(): () => Promise<void> {
    if (!this.stripe && !this.deps.config.dashboard) return async () => {};
    const timer = setInterval(
      () => void this.sweep().catch((err) => this.deps.log.error({ err }, "billing sweep failed")),
      SWEEP_INTERVAL_MS,
    );
    timer.unref?.();
    return async () => clearInterval(timer);
  }

  // -------------------------------------------------------------------------
  // Stripe webhook

  /**
   * Verifies and applies one webhook delivery. Idempotent by event id (and every
   * credit by its payment intent), so replays and overlapping events are harmless.
   * Throws (500) on transient failures so Stripe retries.
   */
  async handleWebhook(
    payload: string,
    signature: string | undefined,
  ): Promise<{ received: true; duplicate?: boolean; ignored?: string }> {
    const stripe = this.requireStripe();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        payload,
        signature ?? "",
        this.cfg.stripeWebhookSecret!,
      );
    } catch {
      throw badRequest("Invalid Stripe signature");
    }
    const [seen] = await rows<{ id: string }>(
      this.deps.db,
      sql`SELECT id FROM stripe_events WHERE id = ${event.id}`,
    );
    if (seen) return { received: true, duplicate: true };

    const plan = await this.planEvent(event);
    let duplicate = false;
    let purchase: Purchase | undefined;
    await this.deps.db.transaction(async (tx) => {
      const inserted = await rows<{ id: string }>(
        tx,
        sql`INSERT INTO stripe_events (id, type, account_id) VALUES (${event.id}, ${event.type}, ${plan.accountId})
            ON CONFLICT (id) DO NOTHING RETURNING id`,
      );
      if (!inserted.length) {
        duplicate = true;
        return;
      }
      purchase = await plan.apply?.(tx);
    });
    if (!duplicate && plan.accountId && plan.credits) await this.credited(plan.accountId);
    if (!duplicate) await plan.after?.();
    if (purchase && plan.accountId)
      await this.confirmPurchase(plan.accountId, purchase.micros, purchase.auto);
    return duplicate
      ? { received: true, duplicate: true }
      : { received: true, ...(plan.ignored ? { ignored: plan.ignored } : {}) };
  }

  private async accountForCustomer(
    accountId: string | null | undefined,
    customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  ): Promise<string | null> {
    const customerId = typeof customer === "string" ? customer : (customer?.id ?? null);
    if (!customerId) return null;
    const [r] = await rows<{ account_id: string }>(
      this.deps.db,
      sql`SELECT account_id FROM billing_accounts WHERE stripe_customer_id = ${customerId}`,
    );
    // The customer is the source of truth; metadata must agree when present.
    if (!r || (accountId && accountId !== r.account_id)) return null;
    return r.account_id;
  }

  /** The account a top-up payment credited, from our own ledger. */
  private async accountForPayment(paymentIntent: string | null): Promise<string | null> {
    if (!paymentIntent) return null;
    const [r] = await rows<{ account_id: string }>(
      this.deps.db,
      sql`SELECT account_id FROM credit_ledger
          WHERE kind IN ('topup', 'auto_topup') AND detail->>'payment_intent' = ${paymentIntent}
          LIMIT 1`,
    );
    return r?.account_id ?? null;
  }

  private async planEvent(event: Stripe.Event): Promise<{
    accountId: string | null;
    credits?: boolean;
    ignored?: string;
    /** Resolves to the purchase when it credited the account for the first time. */
    apply?: (tx: Executor) => Promise<Purchase | undefined>;
    /** Runs after the event is recorded (first delivery only). */
    after?: () => Promise<void>;
  }> {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        if (s.mode !== "payment" || s.metadata?.recall_kind !== "topup")
          return { accountId: null, ignored: "not a top-up" };
        const accountId = await this.accountForCustomer(s.metadata?.account_id, s.customer);
        if (!accountId) return { accountId: null, ignored: "unknown customer" };
        if (s.payment_status !== "paid") return { accountId, ignored: "not paid yet" };
        // With tax the total includes it; the credit is what was bought.
        const amount =
          s.amount_total == null || !PAID_CURRENCIES.has(s.currency ?? "")
            ? null
            : creditMicros(s.metadata, s.amount_subtotal ?? s.amount_total, s.currency!);
        if (amount === null) return { accountId, ignored: "unsupported currency" };
        const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
        const paymentMethod = pi ? await this.paymentMethodOf(pi) : null;
        if (paymentMethod) {
          await this.stripe!.customers.update(
            typeof s.customer === "string" ? s.customer : s.customer!.id,
            { invoice_settings: { default_payment_method: paymentMethod } },
          ).catch((err) => this.deps.log.warn({ err }, "could not set the default payment method"));
        }
        return {
          accountId,
          credits: true,
          apply: async (tx) => {
            const posted = await postEntry(tx, {
              account: accountId,
              amountMicros: amount,
              kind: "topup",
              key: `topup:${pi ?? s.id}`,
              detail: {
                checkout_session: s.id,
                payment_intent: pi ?? null,
                ...termsOf(s.metadata),
              },
            });
            if (paymentMethod) {
              await tx.execute(
                sql`UPDATE billing_accounts SET payment_method_id = ${paymentMethod}, updated_at = now()
                    WHERE account_id = ${accountId}`,
              );
            }
            return posted?.applied ? { micros: amount, auto: false } : undefined;
          },
        };
      }
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const kind = pi.metadata?.recall_kind;
        if (kind !== "auto_topup" && kind !== "topup")
          return { accountId: null, ignored: "not a top-up" };
        const accountId = await this.accountForCustomer(pi.metadata?.account_id, pi.customer);
        if (!accountId) return { accountId: null, ignored: "unknown customer" };
        const micros = PAID_CURRENCIES.has(pi.currency)
          ? creditMicros(pi.metadata, pi.amount_received || pi.amount, pi.currency)
          : null;
        if (micros === null) return { accountId, ignored: "unsupported currency" };
        return {
          accountId,
          credits: true,
          apply: async (tx) => {
            const posted = await postEntry(tx, {
              account: accountId,
              amountMicros: micros,
              kind: kind === "auto_topup" ? "auto_topup" : "topup",
              key: `topup:${pi.id}`,
              detail: { payment_intent: pi.id, ...termsOf(pi.metadata) },
            });
            if (kind === "auto_topup") {
              await tx.execute(
                sql`UPDATE billing_accounts SET auto_topup_pending_at = NULL, auto_topup_pending_ref = NULL,
                      auto_topup_failures = 0, auto_topup_retry_after = NULL, auto_topup_last_error = NULL
                    WHERE account_id = ${accountId}`,
              );
            }
            return posted?.applied ? { micros, auto: kind === "auto_topup" } : undefined;
          },
        };
      }
      case "invoice.paid": {
        // An auto top-up invoice (Stripe Tax) that was still processing when it was charged.
        const inv = event.data.object;
        if (inv.metadata?.recall_kind !== "auto_topup_invoice")
          return { accountId: null, ignored: "not a top-up" };
        const accountId = await this.accountForCustomer(inv.metadata?.account_id, inv.customer);
        if (!accountId) return { accountId: null, ignored: "unknown customer" };
        if (inv.currency !== "usd") return { accountId, ignored: "unsupported currency" };
        const pi = await this.paymentIntentOfInvoice(inv.id!);
        return {
          accountId,
          credits: true,
          apply: async (tx) => {
            const micros = creditMicros(inv.metadata, inv.subtotal, inv.currency) ?? 0;
            const posted = await postEntry(tx, {
              account: accountId,
              amountMicros: micros,
              kind: "auto_topup",
              key: `topup:${inv.id}`,
              detail: { invoice: inv.id, payment_intent: pi, ...termsOf(inv.metadata) },
            });
            await tx.execute(
              sql`UPDATE billing_accounts SET auto_topup_pending_at = NULL, auto_topup_pending_ref = NULL,
                    auto_topup_failures = 0, auto_topup_retry_after = NULL, auto_topup_last_error = NULL
                  WHERE account_id = ${accountId}`,
            );
            return posted?.applied ? { micros, auto: true } : undefined;
          },
        };
      }
      case "payment_intent.payment_failed":
      case "invoice.payment_failed": {
        // An auto top-up that was still processing when it was charged has failed after all.
        const o = event.data.object;
        const kind = event.type === "invoice.payment_failed" ? "auto_topup_invoice" : "auto_topup";
        if (o.metadata?.recall_kind !== kind) return { accountId: null, ignored: "not a top-up" };
        const accountId = await this.accountForCustomer(o.metadata?.account_id, o.customer);
        if (!accountId) return { accountId: null, ignored: "unknown customer" };
        const reason =
          event.type === "payment_intent.payment_failed"
            ? event.data.object.last_payment_error?.message
            : null;
        return {
          accountId,
          after: () => this.pendingAutoTopUpFailed(accountId, o.id!, reason ?? "payment failed"),
        };
      }
      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const d = event.data.object;
        const chargeId = typeof d.charge === "string" ? d.charge : d.charge.id;
        // The charge names the customer and the amount paid. A key that may not read charges
        // still works: the payment intent then finds the top-up in our ledger, taken in full.
        const ch = await this.stripe!.charges.retrieve(chargeId).catch((err) => {
          this.deps.log.warn({ err, charge: chargeId }, "could not read the disputed charge");
          return null;
        });
        const idOf = (x: string | { id: string } | null | undefined) =>
          typeof x === "string" ? x : (x?.id ?? null);
        const pi = idOf(d.payment_intent) ?? idOf(ch?.payment_intent);
        const accountId = ch
          ? await this.accountForCustomer(null, ch.customer)
          : await this.accountForPayment(pi);
        if (!accountId) return { accountId: null, ignored: "unknown customer" };
        if (!PAID_CURRENCIES.has(d.currency)) return { accountId, ignored: "unsupported currency" };
        if (event.type === "charge.dispute.created") {
          // The disputed share of the credit this payment bought goes at once, and the account
          // is suspended until an operator has looked at it: a stolen card's credit stops here.
          return {
            accountId,
            apply: async (tx) => {
              const taken = await this.creditShare(
                tx,
                accountId,
                pi,
                d.amount,
                ch?.amount ?? d.amount,
                d.currency,
              );
              if (taken > 0)
                await postEntry(tx, {
                  account: accountId,
                  amountMicros: -taken,
                  kind: "refund",
                  key: `dispute:${d.id}`,
                  detail: { dispute: d.id, charge: chargeId, payment_intent: pi, reason: d.reason },
                });
              await setAccountSuspension(
                tx,
                accountId,
                `Card payment disputed (${d.reason}); held until an operator has reviewed it`,
              );
              return undefined;
            },
            after: async () => this.deps.budget.invalidate(accountId),
          };
        }
        if (d.status !== "won") return { accountId, ignored: `dispute ${d.status}` };
        // Won: the money stays with us, so the credit taken at the dispute comes back.
        return {
          accountId,
          credits: true,
          apply: async (tx) => {
            const [taken] = await rows<{ micros: string | number }>(
              tx,
              sql`SELECT -amount_micros AS micros FROM credit_ledger
                  WHERE account_id = ${accountId} AND idempotency_key = ${`dispute:${d.id}`}`,
            );
            const micros = Number(taken?.micros ?? 0);
            if (micros > 0)
              await postEntry(tx, {
                account: accountId,
                amountMicros: micros,
                kind: "refund",
                key: `dispute_won:${d.id}`,
                detail: { dispute: d.id, charge: chargeId, payment_intent: pi, won: true },
              });
            return undefined;
          },
        };
      }
      case "charge.refunded": {
        const ch = event.data.object;
        const accountId = await this.accountForCustomer(null, ch.customer);
        if (!accountId) return { accountId: null, ignored: "unknown customer" };
        if (!PAID_CURRENCIES.has(ch.currency))
          return { accountId, ignored: "unsupported currency" };
        const pi =
          typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id;
        return {
          accountId,
          apply: async (tx) => {
            const refunded = await this.creditShare(
              tx,
              accountId,
              pi,
              ch.amount_refunded,
              ch.amount,
              ch.currency,
            );
            const [done] = await rows<{ micros: string | number | null }>(
              tx,
              sql`SELECT COALESCE(-sum(amount_micros), 0) AS micros FROM credit_ledger
                  WHERE account_id = ${accountId} AND kind = 'refund' AND detail->>'charge' = ${ch.id}`,
            );
            const delta = refunded - Number(done?.micros ?? 0);
            if (delta <= 0) return;
            await postEntry(tx, {
              account: accountId,
              amountMicros: -delta,
              kind: "refund",
              key: `refund:${ch.id}:${ch.amount_refunded}`,
              detail: { charge: ch.id, payment_intent: pi ?? null },
            });
          },
        };
      }
      default:
        return { accountId: null, ignored: event.type };
    }
  }

  /**
   * The part of the credit a payment bought that `cents` of it stand for. With tax a charge
   * costs more than the credit it bought, so the share is taken of the credit, not of the tax.
   * A payment the ledger does not know falls back to its USD amount.
   */
  private async creditShare(
    tx: Executor,
    accountId: string,
    paymentIntent: string | null | undefined,
    cents: number,
    chargeCents: number,
    currency: string,
  ): Promise<number> {
    const [bought] = paymentIntent
      ? await rows<{ micros: string | number }>(
          tx,
          sql`SELECT amount_micros AS micros FROM credit_ledger
              WHERE account_id = ${accountId} AND kind IN ('topup', 'auto_topup')
                AND detail->>'payment_intent' = ${paymentIntent}
              LIMIT 1`,
        )
      : [];
    if (bought && chargeCents > 0)
      return Math.round((Math.min(cents, chargeCents) / chargeCents) * Number(bought.micros));
    // A payment the ledger does not know: only a USD amount can stand for credit.
    return currency === "usd" ? cents * MICROS_PER_CENT : 0;
  }

  /** A processing auto top-up failed after all: counted like a direct failure, once. */
  private async pendingAutoTopUpFailed(accountId: string, ref: string, message: string) {
    const [row] = await rows<{ failures: number }>(
      this.deps.db,
      sql`UPDATE billing_accounts SET auto_topup_pending_ref = NULL
          WHERE account_id = ${accountId} AND auto_topup_pending_ref = ${ref}
          RETURNING auto_topup_failures AS failures`,
    );
    if (!row) return;
    await this.autoTopupFailed(accountId, row.failures + 1, new Error(message));
  }

  private async paymentIntentOfInvoice(invoiceId: string): Promise<string | null> {
    try {
      const list = await this.stripe!.invoicePayments.list({ invoice: invoiceId, limit: 1 });
      const pi = list.data[0]?.payment.payment_intent;
      return typeof pi === "string" ? pi : (pi?.id ?? null);
    } catch (err) {
      this.deps.log.warn({ err, invoice: invoiceId }, "could not look up the invoice's payment");
      return null;
    }
  }

  /**
   * The payment method a Checkout paid with, when auto top-up can charge it later: saved to the
   * customer (card or Link). One-off methods such as iDEAL or Bancontact give null, so the method
   * saved earlier stays in place.
   */
  private async paymentMethodOf(paymentIntentId: string): Promise<string | null> {
    try {
      const pi = await this.stripe!.paymentIntents.retrieve(paymentIntentId, {
        expand: ["payment_method"],
      });
      const pm = pi.payment_method;
      if (!pm || typeof pm === "string") return null;
      return REUSABLE_METHODS.has(pm.type) && pm.customer ? pm.id : null;
    } catch (err) {
      this.deps.log.warn({ err }, "could not read the Checkout payment method");
      return null;
    }
  }
}

/** A unique idempotency key for a request that did not send one. */
export const requestKey = () => `req_${newId()}`;
