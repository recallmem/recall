import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Billed, billedFrom, chargesSince, usageCharges } from "../billing/ledger.js";
import { type Db, rows } from "../db/client.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import type { UsageRecorder } from "../usage.js";
import { DEFAULT_ACCOUNT_ID } from "./tenancy.js";

/**
 * Accounts (tenants) for the hosted service: CRUD for the operator's control
 * plane, month-to-date usage, and the spend-cap check used by chat (402) and
 * the worker (pauses background reasoning).
 */

type Executor = Pick<Db, "execute">;
type Obj = Record<string, unknown>;

interface AccountRow {
  id: string;
  name: string;
  monthly_budget_usd: number | null;
  webhook_secret: string | null;
  metadata: Obj;
  created_at: Date | string;
  suspended_at: Date | string | null;
  suspended_reason: string | null;
}

const ACCOUNT_COLS = sql`id, name, monthly_budget_usd, webhook_secret, metadata, created_at,
  suspended_at, suspended_reason`;

export function accountOut(r: AccountRow, opts: { secrets?: boolean } = {}) {
  return {
    id: r.id,
    name: r.name,
    monthly_budget_usd: r.monthly_budget_usd == null ? null : Number(r.monthly_budget_usd),
    metadata: r.metadata ?? {},
    created_at: new Date(r.created_at).toISOString(),
    /** Set while the operator has suspended the account (its credentials get 403). */
    suspended_at: r.suspended_at == null ? null : new Date(r.suspended_at).toISOString(),
    suspended_reason: r.suspended_reason ?? null,
    ...(opts.secrets ? { webhook_secret: r.webhook_secret } : {}),
  };
}
export type AccountOut = ReturnType<typeof accountOut>;

/**
 * What an account's own keys and members see of it (GET /v3/account, the data export): only
 * customer-facing fields. `metadata` holds the operator's notes on the account (key and model
 * routing for experiments, signup bookkeeping) and the suspension fields are the operator's
 * too; the admin API (/admin/v1/accounts) shows them.
 */
export function customerAccount(a: AccountOut) {
  return {
    id: a.id,
    name: a.name,
    monthly_budget_usd: a.monthly_budget_usd,
    created_at: a.created_at,
    ...("webhook_secret" in a ? { webhook_secret: a.webhook_secret } : {}),
  };
}
export type CustomerAccount = ReturnType<typeof customerAccount>;

const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

function checkBudget(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || v < 0) throw unprocessable("monthly_budget_usd must be >= 0");
  return v;
}

export async function createAccount(
  db: Executor,
  input: { name: string; monthlyBudgetUsd?: number | null; metadata?: Obj | null },
): Promise<AccountOut> {
  const name = input.name.trim();
  if (!name || name.length > 200) throw unprocessable("name must be 1-200 characters");
  const [row] = await rows<AccountRow>(
    db,
    sql`INSERT INTO accounts (id, name, monthly_budget_usd, webhook_secret, metadata)
        VALUES (${`acct_${newId()}`}, ${name}, ${checkBudget(input.monthlyBudgetUsd)},
                ${newWebhookSecret()}, ${JSON.stringify(input.metadata ?? {})}::jsonb)
        RETURNING ${ACCOUNT_COLS}`,
  );
  return accountOut(row!, { secrets: true });
}

export async function listAccounts(db: Executor): Promise<AccountOut[]> {
  const found = await rows<AccountRow>(
    db,
    sql`SELECT ${ACCOUNT_COLS} FROM accounts ORDER BY created_at, id`,
  );
  return found.map((r) => accountOut(r));
}

/** The account as the operator sees it, or with `customer` as the account itself does. */
export async function getAccount(
  db: Executor,
  id: string,
  opts: { secrets?: boolean; customer: true },
): Promise<CustomerAccount>;
export async function getAccount(
  db: Executor,
  id: string,
  opts?: { secrets?: boolean; customer?: false },
): Promise<AccountOut>;
export async function getAccount(
  db: Executor,
  id: string,
  opts: { secrets?: boolean; customer?: boolean } = {},
): Promise<AccountOut | CustomerAccount> {
  const [row] = await rows<AccountRow>(
    db,
    sql`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ${id}`,
  );
  if (!row) throw notFound("Account");
  const out = accountOut(row, opts);
  return opts.customer ? customerAccount(out) : out;
}

/** Partial update. `monthlyBudgetUsd: null` removes the cap; `undefined` leaves it. */
export async function updateAccount(
  db: Executor,
  id: string,
  patch: {
    name?: string;
    monthlyBudgetUsd?: number | null;
    metadata?: Obj | null;
    /** Issue a new webhook signing secret (returned in the response). */
    rotateWebhookSecret?: boolean;
  },
): Promise<AccountOut> {
  const name = patch.name?.trim();
  if (patch.name !== undefined && (!name || name.length > 200))
    throw unprocessable("name must be 1-200 characters");
  const setBudget = patch.monthlyBudgetUsd !== undefined;
  const [row] = await rows<AccountRow>(
    db,
    sql`UPDATE accounts SET
          name = COALESCE(${name ?? null}, name),
          monthly_budget_usd = CASE WHEN ${setBudget} THEN ${checkBudget(patch.monthlyBudgetUsd)}::float8
                                    ELSE monthly_budget_usd END,
          metadata = COALESCE(${patch.metadata == null ? null : JSON.stringify(patch.metadata)}::jsonb, metadata),
          webhook_secret = COALESCE(${patch.rotateWebhookSecret ? newWebhookSecret() : null}, webhook_secret)
        WHERE id = ${id}
        RETURNING ${ACCOUNT_COLS}`,
  );
  if (!row) throw notFound("Account");
  return accountOut(row, { secrets: !!patch.rotateWebhookSecret });
}

/**
 * Suspends an account (`reason` given) or lifts the suspension (`null`). While
 * suspended, its API keys, OAuth access tokens and dashboard sessions are refused
 * with 403 (ApiKeyVerifier, OAuthTokenVerifier and the dashboard's session check);
 * jobs already queued still run. Suspending again keeps the original time and
 * replaces the reason. Callers drop the account's cached credentials afterwards.
 */
export async function setAccountSuspension(
  db: Executor,
  id: string,
  reason: string | null,
): Promise<AccountOut> {
  if (reason !== null && id === DEFAULT_ACCOUNT_ID)
    throw conflict("The default account cannot be suspended (self-hosted and JWT callers use it)");
  const note = reason === null ? null : reason.trim().slice(0, 500);
  if (note === "") throw unprocessable("A reason is required to suspend an account");
  const [row] = await rows<AccountRow>(
    db,
    sql`UPDATE accounts SET
          suspended_at = CASE WHEN ${note !== null} THEN COALESCE(suspended_at, now()) END,
          suspended_reason = ${note}
        WHERE id = ${id}
        RETURNING ${ACCOUNT_COLS}`,
  );
  if (!row) throw notFound("Account");
  return accountOut(row);
}

/**
 * Deletes an account and everything it owns (GDPR erasure): its workspaces and
 * all their peers, sessions, messages, conclusions, summaries and webhooks (via
 * ON DELETE CASCADE), its API keys, its queued jobs, its usage records and the
 * chat answers kept for Idempotency-Key retries.
 */
export async function deleteAccount(db: Db, id: string): Promise<void> {
  if (id === DEFAULT_ACCOUNT_ID)
    throw conflict("The default account cannot be deleted (self-hosted and JWT callers use it)");
  await db.transaction(async (tx) => {
    // Erasing a large account cascades through every table it owns: no per-statement limit.
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    const [acct] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM accounts WHERE id = ${id} FOR UPDATE`,
    );
    if (!acct) throw notFound("Account");
    await tx.execute(
      sql`DELETE FROM jobs WHERE workspace_id IN (SELECT id FROM workspaces WHERE account_id = ${id})`,
    );
    await tx.execute(
      sql`DELETE FROM llm_usage WHERE account_id = ${id}
            OR workspace_id IN (SELECT id FROM workspaces WHERE account_id = ${id})`,
    );
    // Stored chat answers kept for Idempotency-Key retries (no foreign key to cascade through).
    await tx.execute(sql`DELETE FROM idempotency_records WHERE account_id = ${id}`);
    await tx.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
  });
}

// ---------------------------------------------------------------------------
// Usage and spend caps

/** Start of the current (or given) UTC calendar month. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function nextMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function monthToDateSpend(db: Executor, accountId: string, now = new Date()) {
  const [r] = await rows<{ cost: number | string | null }>(
    db,
    sql`SELECT COALESCE(sum(cost_usd), 0)::float8 AS cost FROM llm_usage
        WHERE account_id = ${accountId} AND created_at >= ${monthStart(now)}`,
  );
  return Number(r?.cost ?? 0);
}

/** Account-level usage for a period (default: the current UTC month). */
export async function accountUsage(
  db: Executor,
  accountId: string,
  opts: { since?: Date; until?: Date } = {},
) {
  const account = await getAccount(db, accountId);
  const now = new Date();
  const since = opts.since ?? monthStart(now);
  const until = opts.until ?? null;
  const range = sql`u.account_id = ${accountId} AND u.created_at >= ${since}
    ${until ? sql`AND u.created_at < ${until}` : sql``}`;
  const totals = (r: {
    calls: number;
    input_tokens: number | string | null;
    output_tokens: number | string | null;
    cost_usd: number | string | null;
  }) => ({
    calls: Number(r.calls),
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
  });
  const agg = sql`count(*)::int AS calls, sum(u.input_tokens) AS input_tokens,
    sum(u.output_tokens) AS output_tokens, COALESCE(sum(u.cost_usd), 0)::float8 AS cost_usd`;
  type Agg = {
    calls: number;
    input_tokens: number | string | null;
    output_tokens: number | string | null;
    cost_usd: number | string | null;
  };
  const [total] = await rows<Agg>(db, sql`SELECT ${agg} FROM llm_usage u WHERE ${range}`);
  const byWorkspace = await rows<Agg & { workspace: string | null }>(
    db,
    sql`SELECT w.name AS workspace, ${agg} FROM llm_usage u LEFT JOIN workspaces w ON w.id = u.workspace_id
        WHERE ${range} GROUP BY w.name ORDER BY cost_usd DESC, w.name`,
  );
  const byTask = await rows<Agg & { task: string }>(
    db,
    sql`SELECT u.task, ${agg} FROM llm_usage u WHERE ${range} GROUP BY u.task ORDER BY u.task`,
  );
  const [billing] = await rows<{ balance: number | string }>(
    db,
    sql`SELECT balance_micros AS balance FROM billing_accounts WHERE account_id = ${accountId}`,
  );
  // Billed (self-serve) accounts budget what they are charged, not provider cost.
  const spent = billing
    ? (await chargesSince(db, accountId, monthStart(now))) / 1_000_000
    : await monthToDateSpend(db, accountId, now);
  const budget = account.monthly_budget_usd;
  type WorkspaceUsage = { workspace_id: string | null } & ReturnType<typeof totals> & {
      billed?: Billed;
    };
  let workspaces: WorkspaceUsage[] = byWorkspace.map((r) => ({
    workspace_id: r.workspace,
    ...totals(r),
  }));
  let billed: Billed | null = null;
  if (billing) {
    // What each workspace was charged, with its billable units; a workspace charged only for
    // answers from the cache has no model calls but is listed too.
    const charges = await usageCharges(db, accountId, {
      since,
      ...(until ? { until } : {}),
      by: "workspace",
    });
    billed = billedFrom(charges);
    const names = new Set([
      ...workspaces.map((w) => w.workspace_id),
      ...charges.map((c) => c.group),
    ]);
    workspaces = [...names]
      .map((name) => ({
        ...(workspaces.find((w) => w.workspace_id === name) ??
          totals({ calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 })),
        workspace_id: name,
        billed: billedFrom(charges.filter((c) => c.group === name)),
      }))
      .sort(
        (a, b) =>
          b.billed.billed_usd - a.billed.billed_usd ||
          (a.workspace_id ?? "").localeCompare(b.workspace_id ?? ""),
      );
  }
  return {
    account_id: accountId,
    since: since.toISOString(),
    until: until ? until.toISOString() : null,
    total: totals(total!),
    by_workspace: workspaces,
    by_task: Object.fromEntries(byTask.map((r) => [r.task, totals(r)])),
    ...(billed ? { billed } : {}),
    budget: {
      monthly_budget_usd: budget,
      month_to_date_usd: spent,
      remaining_usd: budget == null ? null : Math.max(0, budget - spent),
      exceeded: budget != null && spent >= budget,
      resets_at: nextMonthStart(now).toISOString(),
    },
    ...(billing ? { credit: { balance_usd: Number(billing.balance) / 1_000_000 } } : {}),
  };
}

/** Why an account may not spend: its monthly cap is reached, or (billing on) its prepaid credit is gone. */
export type SpendBlock = "budget" | "credit";

/**
 * Cached spend-cap check. `blocked(account)` re-reads at most every `ttlMs`; the
 * usage buffer is flushed first so recent calls count. With prepaid billing on,
 * a billed account (one with a billing_accounts row) is also blocked at a zero
 * balance, and its monthly cap is compared with what it was charged rather than
 * with provider cost. Both caps are soft: calls already in flight still complete.
 */
export class BudgetGuard {
  private readonly cache = new Map<string, { verdict: SpendBlock | null; until: number }>();
  private readonly wsAccount = new Map<string, string | null>();
  private readonly inflight = new Map<string, Promise<SpendBlock | null>>();

  constructor(
    private readonly db: Executor,
    private readonly usage: Pick<UsageRecorder, "flush">,
    private readonly ttlMs: number,
    private readonly billingEnabled = false,
  ) {}

  async exceeded(accountId: string, now = Date.now()): Promise<boolean> {
    return (await this.blocked(accountId, now)) !== null;
  }

  async blocked(accountId: string, now = Date.now()): Promise<SpendBlock | null> {
    const hit = this.cache.get(accountId);
    if (hit && hit.until > now) return hit.verdict;
    // Concurrent requests for the same account share one read.
    let pending = this.inflight.get(accountId);
    if (!pending) {
      pending = this.read(accountId, now).finally(() => this.inflight.delete(accountId));
      this.inflight.set(accountId, pending);
    }
    return pending;
  }

  private async read(accountId: string, now: number): Promise<SpendBlock | null> {
    const [acct] = await rows<{
      budget: number | string | null;
      balance: number | string | null;
    }>(
      this.db,
      sql`SELECT a.monthly_budget_usd AS budget, b.balance_micros AS balance
          FROM accounts a LEFT JOIN billing_accounts b ON b.account_id = a.id WHERE a.id = ${accountId}`,
    );
    const billed = this.billingEnabled && acct?.balance != null;
    let verdict: SpendBlock | null = null;
    if (billed && Number(acct!.balance) <= 0) verdict = "credit";
    else if (acct?.budget != null) {
      let spent: number;
      if (billed) spent = (await chargesSince(this.db, accountId, monthStart())) / 1_000_000;
      else {
        await this.usage.flush();
        spent = await monthToDateSpend(this.db, accountId);
      }
      if (spent >= Number(acct.budget)) verdict = "budget";
    }
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(accountId, { verdict, until: now + this.ttlMs });
    return verdict;
  }

  /** The account that owns a workspace (internal id); cached, workspaces never change account. */
  async accountOf(workspaceId: string): Promise<string | null> {
    if (this.wsAccount.has(workspaceId)) return this.wsAccount.get(workspaceId)!;
    const [r] = await rows<{ account_id: string }>(
      this.db,
      sql`SELECT account_id FROM workspaces WHERE id = ${workspaceId}`,
    );
    const account = r?.account_id ?? null;
    if (this.wsAccount.size > 50_000) this.wsAccount.clear();
    if (account) this.wsAccount.set(workspaceId, account);
    return account;
  }

  /** `fresh` re-reads instead of trusting the cache (before pausing work, or between model calls). */
  async exceededForWorkspace(workspaceId: string | null, fresh = false): Promise<boolean> {
    if (!workspaceId) return false;
    const account = await this.accountOf(workspaceId);
    if (!account) return false;
    if (fresh) this.invalidate(account);
    return this.exceeded(account);
  }

  /** Forget a cached verdict (after the budget is changed in this process). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
    this.inflight.delete(accountId);
  }
}
