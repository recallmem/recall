import { type SQL, sql } from "drizzle-orm";
import { USAGE_KINDS_SQL } from "../billing/ledger.js";
import { type Db, rows } from "../db/client.js";
import { DEFAULT_ACCOUNT_ID } from "./tenancy.js";

/**
 * Read models for the operator console (<dashboard>/admin): sign-ups, money,
 * model cost, the job queue, and per-account summaries. Amounts are integer
 * micro-USD; provider cost (llm_usage.cost_usd, float USD) is converted.
 *
 * Every query is bounded: a date range on an indexed column (accounts.created_at,
 * credit_ledger.created_at, llm_usage.created_at, signup_credit_grants.created_at),
 * a LIMIT, or an `account_id IN (<one page>)` list, aggregated with GROUP BY. The
 * built-in `default` account (self-hosted/JWT callers) is not a customer and is
 * left out of counts and lists.
 */

type Executor = Pick<Db, "execute">;
type Num = string | number | null;

const DAY_MS = 86_400_000;
const num = (v: Num | undefined) => Number(v ?? 0);
const usdMicros = (v: Num | undefined) => Math.round(num(v) * 1_000_000);
const iso = (v: Date | string | null | undefined) => (v == null ? null : new Date(v).toISOString());
/** Credit bought with money: top-ups and auto top-ups, less refunds (negative entries). */
const TOPUP_KINDS_SQL = sql`kind IN ('topup', 'auto_topup', 'refund')`;
const NOT_DEFAULT = sql`id <> ${DEFAULT_ACCOUNT_ID}`;
const utcDay = (col: string) =>
  sql.raw(`to_char(date_trunc('day', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`);
const inList = (ids: string[]): SQL =>
  sql`(${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;

export const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ---------------------------------------------------------------------------
// Overview

export interface MoneyWindow {
  days: number;
  /** Top-ups and auto top-ups, net of refunds. */
  topupsMicros: number;
  /** Usage charged to billed accounts (ingest and chat debits). */
  billedMicros: number;
  /** Provider cost of the model calls of billed accounts: what the billed usage cost us. */
  costBilledMicros: number;
  /** Provider cost of every model call, unbilled (operator) accounts included. */
  costAllMicros: number;
  /**
   * The part of `costAllMicros` estimated at list price rather than reported by the provider
   * (direct providers, embeddings, BYOK calls on OpenRouter that reported no upstream charge).
   */
  costEstimatedMicros: number;
}

export interface QueueRow {
  kind: string;
  pending: number;
  /** Pending jobs whose run_after has passed (the backlog proper). */
  due: number;
  running: number;
  failed: number;
  /** Age in seconds of the oldest pending job (by creation), null without any. */
  oldestPendingS: number | null;
}

export interface DayRow {
  day: string;
  signups: number;
  topupsMicros: number;
  billedMicros: number;
  costMicros: number;
}

export interface ConsoleOverview {
  accounts: { total: number; suspended: number; last24h: number; last7d: number; last30d: number };
  /** Welcome credit granted since 00:00 UTC, against the daily cap (0 = no cap). */
  welcome: { todayMicros: number; todayGrants: number; capMicros: number };
  windows: MoneyWindow[];
  queue: QueueRow[];
  /** The last 14 UTC days, newest first. */
  days: DayRow[];
}

export async function consoleOverview(
  db: Executor,
  opts: { welcomeCapMicros: number; now?: Date },
): Promise<ConsoleOverview> {
  const now = opts.now ?? new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const d1 = ago(1);
  const d7 = ago(7);
  const d30 = ago(30);
  const today = startOfUtcDay(now);
  const first = new Date(today.getTime() - 13 * DAY_MS);

  const [accounts, welcome, ledger, cost, queue, signupDays, ledgerDays, costDays] =
    await Promise.all([
      rows<{ total: number; suspended: number; d1: number; d7: number; d30: number }>(
        db,
        sql`SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE suspended_at IS NOT NULL)::int AS suspended,
                   count(*) FILTER (WHERE created_at >= ${d1})::int AS d1,
                   count(*) FILTER (WHERE created_at >= ${d7})::int AS d7,
                   count(*) FILTER (WHERE created_at >= ${d30})::int AS d30
            FROM accounts WHERE ${NOT_DEFAULT}`,
      ),
      rows<{ micros: Num; n: number }>(
        db,
        sql`SELECT COALESCE(sum(amount_micros), 0) AS micros, count(*)::int AS n
            FROM signup_credit_grants WHERE created_at >= ${today}`,
      ),
      rows<{ t7: Num; t30: Num; b7: Num; b30: Num }>(
        db,
        sql`SELECT COALESCE(sum(amount_micros) FILTER (WHERE ${TOPUP_KINDS_SQL} AND created_at >= ${d7}), 0) AS t7,
                   COALESCE(sum(amount_micros) FILTER (WHERE ${TOPUP_KINDS_SQL}), 0) AS t30,
                   COALESCE(-sum(amount_micros) FILTER (WHERE ${USAGE_KINDS_SQL} AND created_at >= ${d7}), 0) AS b7,
                   COALESCE(-sum(amount_micros) FILTER (WHERE ${USAGE_KINDS_SQL}), 0) AS b30
            FROM credit_ledger WHERE created_at >= ${d30}`,
      ),
      rows<{ a7: Num; a30: Num; b7: Num; b30: Num; e7: Num; e30: Num }>(
        db,
        sql`SELECT COALESCE(sum(u.cost_usd) FILTER (WHERE u.created_at >= ${d7}), 0)::float8 AS a7,
                   COALESCE(sum(u.cost_usd), 0)::float8 AS a30,
                   COALESCE(sum(u.cost_usd) FILTER (WHERE u.cost_estimated AND u.created_at >= ${d7}), 0)::float8 AS e7,
                   COALESCE(sum(u.cost_usd) FILTER (WHERE u.cost_estimated), 0)::float8 AS e30,
                   COALESCE(sum(u.cost_usd) FILTER (WHERE b.account_id IS NOT NULL AND u.created_at >= ${d7}), 0)::float8 AS b7,
                   COALESCE(sum(u.cost_usd) FILTER (WHERE b.account_id IS NOT NULL), 0)::float8 AS b30
            FROM llm_usage u LEFT JOIN billing_accounts b ON b.account_id = u.account_id
            WHERE u.created_at >= ${d30}`,
      ),
      // Done jobs are purged after a day, so this reads only the live part of the table.
      rows<{
        kind: string;
        pending: number;
        due: number;
        running: number;
        failed: number;
        oldest: Num;
      }>(
        db,
        sql`SELECT kind,
                   count(*) FILTER (WHERE status = 'pending')::int AS pending,
                   count(*) FILTER (WHERE status = 'pending' AND run_after <= now())::int AS due,
                   count(*) FILTER (WHERE status = 'running')::int AS running,
                   count(*) FILTER (WHERE status = 'failed')::int AS failed,
                   EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::float8 AS oldest
            FROM jobs WHERE status <> 'done' GROUP BY kind ORDER BY kind`,
      ),
      rows<{ day: string; n: number }>(
        db,
        sql`SELECT ${utcDay("created_at")} AS day, count(*)::int AS n FROM accounts
            WHERE created_at >= ${first} AND ${NOT_DEFAULT} GROUP BY 1`,
      ),
      rows<{ day: string; topups: Num; billed: Num }>(
        db,
        sql`SELECT ${utcDay("created_at")} AS day,
                   COALESCE(sum(amount_micros) FILTER (WHERE ${TOPUP_KINDS_SQL}), 0) AS topups,
                   COALESCE(-sum(amount_micros) FILTER (WHERE ${USAGE_KINDS_SQL}), 0) AS billed
            FROM credit_ledger WHERE created_at >= ${first} GROUP BY 1`,
      ),
      rows<{ day: string; cost: Num }>(
        db,
        sql`SELECT ${utcDay("created_at")} AS day, COALESCE(sum(cost_usd), 0)::float8 AS cost
            FROM llm_usage WHERE created_at >= ${first} GROUP BY 1`,
      ),
    ]);

  const a = accounts[0]!;
  const l = ledger[0]!;
  const c = cost[0]!;
  const byDay = <T extends { day: string }>(list: T[]) => new Map(list.map((r) => [r.day, r]));
  const s = byDay(signupDays);
  const m = byDay(ledgerDays);
  const k = byDay(costDays);
  const days: DayRow[] = [];
  for (let i = 0; i < 14; i++) {
    const day = new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    days.push({
      day,
      signups: s.get(day)?.n ?? 0,
      topupsMicros: num(m.get(day)?.topups),
      billedMicros: num(m.get(day)?.billed),
      costMicros: usdMicros(k.get(day)?.cost),
    });
  }
  return {
    accounts: {
      total: a.total,
      suspended: a.suspended,
      last24h: a.d1,
      last7d: a.d7,
      last30d: a.d30,
    },
    welcome: {
      todayMicros: num(welcome[0]?.micros),
      todayGrants: welcome[0]?.n ?? 0,
      capMicros: opts.welcomeCapMicros,
    },
    windows: [
      {
        days: 7,
        topupsMicros: num(l.t7),
        billedMicros: num(l.b7),
        costBilledMicros: usdMicros(c.b7),
        costAllMicros: usdMicros(c.a7),
        costEstimatedMicros: usdMicros(c.e7),
      },
      {
        days: 30,
        topupsMicros: num(l.t30),
        billedMicros: num(l.b30),
        costBilledMicros: usdMicros(c.b30),
        costAllMicros: usdMicros(c.a30),
        costEstimatedMicros: usdMicros(c.e30),
      },
    ],
    queue: queue.map((r) => ({
      kind: r.kind,
      pending: r.pending,
      due: r.due,
      running: r.running,
      failed: r.failed,
      oldestPendingS: r.oldest == null ? null : Math.max(0, Math.round(num(r.oldest))),
    })),
    days,
  };
}

// ---------------------------------------------------------------------------
// Accounts

export interface AccountSummary {
  id: string;
  name: string;
  createdAt: string;
  suspendedAt: string | null;
  /** Has a billing row (self-serve, prepaid); false for operator-created accounts. */
  billed: boolean;
  balanceMicros: number | null;
  stripeCustomerId: string | null;
  /** The first owner's email (else the first member's). */
  ownerEmail: string | null;
  billed30Micros: number;
  cost30Micros: number;
  /** Latest of: an API key or OAuth connection used, a member signing in, a model call (30 days). */
  lastActivity: string | null;
}

export interface AccountPage {
  items: AccountSummary[];
  /** Cursor for the next (older) page, or null on the last one. */
  next: string | null;
}

/** Keyset cursor: the last row's created_at (microsecond text) and id. */
function parseCursor(raw: string | undefined): { ts: string; id: string } | null {
  if (!raw || raw.length > 200) return null;
  const at = raw.indexOf("~");
  if (at <= 0) return null;
  const ts = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(ts) || !id) return null;
  return { ts, id };
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * One page of accounts, newest first: search by exact account id, or a substring of the
 * name or of a member's email. Per-account figures come from one grouped query per
 * source over the page's ids.
 */
export async function consoleAccounts(
  db: Executor,
  opts: { q?: string; cursor?: string; limit?: number; now?: Date } = {},
): Promise<AccountPage> {
  const limit = opts.limit ?? 50;
  const q = (opts.q ?? "").trim().slice(0, 200);
  const cursor = parseCursor(opts.cursor);
  const conds: SQL[] = [sql`a.id <> ${DEFAULT_ACCOUNT_ID}`];
  if (q) {
    const like = likePattern(q);
    conds.push(sql`(a.id = ${q} OR a.name ILIKE ${like} OR a.id IN (
      SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id
      WHERE u.email ILIKE ${like}))`);
  }
  if (cursor) conds.push(sql`(a.created_at, a.id) < (${cursor.ts}::timestamptz, ${cursor.id})`);
  const found = await rows<{
    id: string;
    name: string;
    created_at: Date | string;
    ts: string;
    suspended_at: Date | string | null;
  }>(
    db,
    sql`SELECT a.id, a.name, a.created_at, a.suspended_at,
               to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
        FROM accounts a WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit + 1}`,
  );
  const page = found.slice(0, limit);
  const items = await summarize(db, page, opts.now ?? new Date());
  const last = page.at(-1);
  return { items, next: found.length > limit && last ? `${last.ts}~${last.id}` : null };
}

/** Billing, owner, 30-day money and last activity for a page of accounts (one query per source). */
export async function summarize(
  db: Executor,
  accounts: {
    id: string;
    name: string;
    created_at: Date | string;
    suspended_at: Date | string | null;
  }[],
  now: Date,
): Promise<AccountSummary[]> {
  if (!accounts.length) return [];
  const ids = inList(accounts.map((a) => a.id));
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const [billing, owners, billed, cost, seen] = await Promise.all([
    rows<{ account_id: string; balance_micros: Num; stripe_customer_id: string | null }>(
      db,
      sql`SELECT account_id, balance_micros, stripe_customer_id FROM billing_accounts
          WHERE account_id IN ${ids}`,
    ),
    rows<{ account_id: string; email: string }>(
      db,
      sql`SELECT DISTINCT ON (m.account_id) m.account_id, u.email
          FROM account_members m JOIN users u ON u.id = m.user_id
          WHERE m.account_id IN ${ids}
          ORDER BY m.account_id, (m.role = 'owner') DESC, m.created_at, u.email`,
    ),
    rows<{ account_id: string; micros: Num }>(
      db,
      sql`SELECT account_id, -sum(amount_micros) AS micros FROM credit_ledger
          WHERE account_id IN ${ids} AND created_at >= ${since} AND ${USAGE_KINDS_SQL}
          GROUP BY account_id`,
    ),
    rows<{ account_id: string; cost: Num; last: Date | string | null }>(
      db,
      sql`SELECT account_id, COALESCE(sum(cost_usd), 0)::float8 AS cost, max(created_at) AS last
          FROM llm_usage WHERE account_id IN ${ids} AND created_at >= ${since}
          GROUP BY account_id`,
    ),
    rows<{ account_id: string; last: Date | string | null }>(
      db,
      sql`SELECT account_id, max(t) AS last FROM (
            SELECT account_id, last_used_at AS t FROM api_keys WHERE account_id IN ${ids}
            UNION ALL
            SELECT account_id, last_used_at FROM oauth_grants WHERE account_id IN ${ids}
            UNION ALL
            SELECT m.account_id, u.last_login_at FROM account_members m JOIN users u ON u.id = m.user_id
            WHERE m.account_id IN ${ids}
          ) x GROUP BY account_id`,
    ),
  ]);
  const by = <T extends { account_id: string }>(list: T[]) =>
    new Map(list.map((r) => [r.account_id, r]));
  const b = by(billing);
  const o = by(owners);
  const d = by(billed);
  const c = by(cost);
  const s = by(seen);
  const latest = (...ts: (Date | string | null | undefined)[]) => {
    const times = ts.filter((t) => t != null).map((t) => new Date(t!).getTime());
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  };
  return accounts.map((a) => {
    const bill = b.get(a.id);
    return {
      id: a.id,
      name: a.name,
      createdAt: new Date(a.created_at).toISOString(),
      suspendedAt: iso(a.suspended_at),
      billed: !!bill,
      balanceMicros: bill ? num(bill.balance_micros) : null,
      stripeCustomerId: bill?.stripe_customer_id ?? null,
      ownerEmail: o.get(a.id)?.email ?? null,
      billed30Micros: num(d.get(a.id)?.micros),
      cost30Micros: usdMicros(c.get(a.id)?.cost),
      lastActivity: latest(c.get(a.id)?.last, s.get(a.id)?.last),
    };
  });
}

export interface TaskUsage {
  task: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

/** Model calls by task since `since` (provider cost). */
export async function usageByTask(
  db: Executor,
  accountId: string,
  since: Date,
): Promise<TaskUsage[]> {
  const found = await rows<{
    task: string;
    calls: number;
    input_tokens: Num;
    output_tokens: Num;
    cost: Num;
  }>(
    db,
    sql`SELECT task, count(*)::int AS calls, COALESCE(sum(input_tokens), 0) AS input_tokens,
               COALESCE(sum(output_tokens), 0) AS output_tokens, COALESCE(sum(cost_usd), 0)::float8 AS cost
        FROM llm_usage WHERE account_id = ${accountId} AND created_at >= ${since}
        GROUP BY task ORDER BY cost DESC, task`,
  );
  return found.map((r) => ({
    task: r.task,
    calls: r.calls,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    costMicros: usdMicros(r.cost),
  }));
}

export interface MemberRow {
  email: string;
  role: string;
  joinedAt: string;
  lastLoginAt: string | null;
}

export async function membersOf(db: Executor, accountId: string): Promise<MemberRow[]> {
  const found = await rows<{
    email: string;
    role: string;
    created_at: Date | string;
    last_login_at: Date | string | null;
  }>(
    db,
    sql`SELECT u.email, m.role, m.created_at, u.last_login_at
        FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = ${accountId} ORDER BY m.created_at, u.email LIMIT 100`,
  );
  return found.map((r) => ({
    email: r.email,
    role: r.role,
    joinedAt: new Date(r.created_at).toISOString(),
    lastLoginAt: iso(r.last_login_at),
  }));
}
