import { type SQL, sql } from "drizzle-orm";
import type { ChatLevel } from "../config.js";
import { type Db, rows } from "../db/client.js";
import { metrics } from "../lib/metrics.js";

/**
 * The prepaid-credit ledger: append-only entries in integer micro-USD
 * (1 USD = 1,000,000), each with an idempotency key unique per account. The
 * balance is cached on `billing_accounts` and changed by the same statement
 * that appends the entry, so the two never disagree (`ledgerDrift` checks).
 * An account without a `billing_accounts` row is not billed: posts are no-ops.
 */

type Executor = Pick<Db, "execute">;
type Obj = Record<string, unknown>;

export const MICROS_PER_USD = 1_000_000;
export const MICROS_PER_CENT = 10_000;

/** Credits add balance; debits (negative amounts) spend it. */
export type LedgerKind =
  | "signup_credit"
  | "topup"
  | "auto_topup"
  | "grant"
  | "refund"
  | "ingest"
  | "store"
  | `chat_${"minimal" | "low" | "medium" | "high" | "max"}`;

/** Kinds that count as spend against a monthly budget. */
export const USAGE_KINDS_SQL = sql`(kind IN ('ingest', 'store') OR kind LIKE 'chat\\_%')`;

export interface PostResult {
  /** False when the idempotency key was already used, or a guarded debit found too little credit. */
  applied: boolean;
  /** Why nothing changed: the key was used before, or (`requireCredit`) the balance was short. */
  refused?: "duplicate" | "insufficient";
  accountId: string;
  balanceMicros: number;
  thresholdMicros: number;
  autoTopup: boolean;
}

export interface Entry {
  /** The account, or a SQL expression yielding it (e.g. a workspace's account). */
  account: string | SQL;
  amountMicros: number;
  kind: LedgerKind;
  key: string;
  detail?: Obj;
  /** Refuse a debit the balance does not cover (the balance never goes below zero for it). */
  requireCredit?: boolean;
}

/**
 * Appends one entry and moves the cached balance, in one statement (atomic with
 * or without a surrounding transaction; the billing row is locked meanwhile).
 * Returns null when the account is not billed.
 */
export async function postEntry(db: Executor, e: Entry): Promise<PostResult | null> {
  if (!Number.isSafeInteger(e.amountMicros)) throw new Error("ledger amounts are integer micros");
  const account = typeof e.account === "string" ? sql`${e.account}` : e.account;
  const covered = e.requireCredit ? sql`WHERE balance_micros + ${e.amountMicros} >= 0` : sql``;
  const [r] = await rows<{
    account_id: string | null;
    applied: number;
    balance: string | number | null;
    threshold: string | number | null;
    auto: boolean | null;
  }>(
    db,
    sql`WITH b AS (
          SELECT account_id, balance_micros, auto_topup_threshold_micros, auto_topup_enabled
          FROM billing_accounts WHERE account_id = (${account}) FOR UPDATE
        ), ins AS (
          INSERT INTO credit_ledger (account_id, amount_micros, kind, idempotency_key, balance_after_micros, detail)
          SELECT account_id, ${e.amountMicros}, ${e.kind}, ${e.key}, balance_micros + ${e.amountMicros},
                 ${JSON.stringify(e.detail ?? {})}::jsonb
          FROM b ${covered}
          ON CONFLICT (account_id, idempotency_key) DO NOTHING
          RETURNING amount_micros
        ), upd AS (
          UPDATE billing_accounts SET balance_micros = balance_micros + (SELECT amount_micros FROM ins),
                 updated_at = now()
          WHERE account_id = (SELECT account_id FROM b) AND EXISTS (SELECT 1 FROM ins)
          RETURNING balance_micros
        )
        SELECT (SELECT account_id FROM b) AS account_id,
               (SELECT count(*) FROM ins)::int AS applied,
               COALESCE((SELECT balance_micros FROM upd), (SELECT balance_micros FROM b)) AS balance,
               (SELECT auto_topup_threshold_micros FROM b) AS threshold,
               (SELECT auto_topup_enabled FROM b) AS auto`,
  );
  if (!r?.account_id) return null;
  const applied = r.applied > 0;
  let refused: PostResult["refused"];
  if (!applied) {
    // A separate statement, so a key committed by a concurrent post is seen.
    const [k] = await rows<{ used: boolean }>(
      db,
      sql`SELECT EXISTS (SELECT 1 FROM credit_ledger WHERE account_id = ${r.account_id}
                           AND idempotency_key = ${e.key}) AS used`,
    );
    refused = k?.used ? "duplicate" : "insufficient";
  }
  if (applied) {
    const usd = Math.abs(e.amountMicros) / MICROS_PER_USD;
    const direction = e.amountMicros >= 0 ? "credit" : "debit";
    (direction === "credit" ? metrics.ledgerCredits : metrics.ledgerDebits).inc(
      { kind: e.kind },
      usd,
    );
    metrics.ledgerEntries.inc({ kind: e.kind, direction });
  }
  return {
    applied,
    ...(refused ? { refused } : {}),
    accountId: r.account_id,
    balanceMicros: Number(r.balance ?? 0),
    thresholdMicros: Number(r.threshold ?? 0),
    autoTopup: !!r.auto,
  };
}

/** Makes an account billed (idempotent). */
export async function ensureBillingAccount(db: Executor, accountId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO billing_accounts (account_id) VALUES (${accountId}) ON CONFLICT DO NOTHING`,
  );
}

export interface BillingRow {
  account_id: string;
  stripe_customer_id: string | null;
  payment_method_id: string | null;
  balance_micros: number;
  auto_topup_enabled: boolean;
  auto_topup_threshold_micros: number;
  auto_topup_amount_micros: number;
  auto_topup_failures: number;
  auto_topup_retry_after: Date | null;
  auto_topup_last_error: string | null;
  /** Terms version the auto top-up consent was given under, if any. */
  auto_topup_consent_version: string | null;
}

export async function getBillingRow(db: Executor, accountId: string): Promise<BillingRow | null> {
  const [r] = await rows<BillingRow>(
    db,
    sql`SELECT account_id, stripe_customer_id, payment_method_id, balance_micros, auto_topup_enabled,
               auto_topup_threshold_micros, auto_topup_amount_micros, auto_topup_failures,
               auto_topup_retry_after, auto_topup_last_error, auto_topup_consent_version
        FROM billing_accounts WHERE account_id = ${accountId}`,
  );
  if (!r) return null;
  return {
    ...r,
    balance_micros: Number(r.balance_micros),
    auto_topup_threshold_micros: Number(r.auto_topup_threshold_micros),
    auto_topup_amount_micros: Number(r.auto_topup_amount_micros),
    auto_topup_retry_after: r.auto_topup_retry_after ? new Date(r.auto_topup_retry_after) : null,
  };
}

export interface LedgerEntryOut {
  id: number;
  amount_micros: number;
  kind: string;
  balance_after_micros: number;
  detail: Obj;
  created_at: string;
}

export async function ledgerEntries(
  db: Executor,
  accountId: string,
  limit = 50,
): Promise<LedgerEntryOut[]> {
  const found = await rows<{
    id: string | number;
    amount_micros: string | number;
    kind: string;
    balance_after_micros: string | number;
    detail: Obj;
    created_at: Date | string;
  }>(
    db,
    sql`SELECT id, amount_micros, kind, balance_after_micros, detail, created_at FROM credit_ledger
        WHERE account_id = ${accountId} ORDER BY id DESC LIMIT ${limit}`,
  );
  return found.map((r) => ({
    id: Number(r.id),
    amount_micros: Number(r.amount_micros),
    kind: r.kind,
    balance_after_micros: Number(r.balance_after_micros),
    detail: r.detail ?? {},
    created_at: new Date(r.created_at).toISOString(),
  }));
}

/** One line of the credit history: a single entry, or a UTC day's ingest or storage charges added up. */
export interface LedgerLine {
  kind: string;
  /** Entries in this line: 1, or the number of batches of that kind charged that day. */
  entries: number;
  amount_micros: number;
  /** The balance after the line's last entry. */
  balance_after_micros: number;
  /** The last entry's time (a day's group: its latest charge). */
  created_at: string;
  /** "YYYY-MM-DD" when the line groups a day's charges of one kind, else null. */
  day: string | null;
}

/**
 * The credit history, newest first, a page at a time. Ingest and storage charges (one per batch,
 * often hundreds a day) are added up per kind and UTC day; every other entry is its own line. A day's
 * line sits where its last charge does and shows the balance after it.
 */
export async function ledgerHistory(
  db: Executor,
  accountId: string,
  page: number,
  size = 50,
): Promise<{ items: LedgerLine[]; page: number; pages: number; total: number }> {
  const grouped = sql`SELECT CASE WHEN kind IN ('ingest', 'store')
            THEN 'd:' || to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') || ':' || kind
            ELSE 'e:' || id::text END AS grp,
          id, kind, amount_micros, balance_after_micros, created_at
        FROM credit_ledger WHERE account_id = ${accountId}`;
  const [count] = await rows<{ n: number }>(
    db,
    sql`SELECT count(DISTINCT grp)::int AS n FROM (${grouped}) g`,
  );
  const total = Number(count?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const found = await rows<{
    grp: string;
    kind: string;
    n: number;
    amount: string | number;
    balance: string | number;
    created_at: Date | string;
  }>(
    db,
    sql`SELECT grp, min(kind) AS kind, count(*)::int AS n, sum(amount_micros) AS amount,
               (array_agg(balance_after_micros ORDER BY id DESC))[1] AS balance,
               max(created_at) AS created_at
        FROM (${grouped}) g GROUP BY grp ORDER BY max(id) DESC
        LIMIT ${size} OFFSET ${(current - 1) * size}`,
  );
  return {
    items: found.map((r) => ({
      kind: r.kind,
      entries: Number(r.n),
      amount_micros: Number(r.amount),
      balance_after_micros: Number(r.balance),
      created_at: new Date(r.created_at).toISOString(),
      day: r.grp.startsWith("d:") ? r.grp.slice(2, 12) : null,
    })),
    page: current,
    pages,
    total,
  };
}

/** Usage charges (ingest, storage and chat) since `since`, in micros. */
export async function chargesSince(db: Executor, accountId: string, since: Date): Promise<number> {
  const [r] = await rows<{ micros: string | number | null }>(
    db,
    sql`SELECT COALESCE(-sum(amount_micros), 0) AS micros FROM credit_ledger
        WHERE account_id = ${accountId} AND created_at >= ${since} AND ${USAGE_KINDS_SQL}`,
  );
  return Number(r?.micros ?? 0);
}

/** Usage charges by kind (ingest, store, chat_<level>) since `since`. */
export async function chargesByKind(
  db: Executor,
  accountId: string,
  since: Date,
): Promise<{ kind: string; count: number; micros: number }[]> {
  const found = await rows<{ kind: string; n: number; micros: string | number }>(
    db,
    // A returned charge (positive entry of a usage kind) cancels its debit in both columns.
    sql`SELECT kind, (count(*) FILTER (WHERE amount_micros < 0) - count(*) FILTER (WHERE amount_micros > 0))::int AS n,
               -sum(amount_micros) AS micros FROM credit_ledger
        WHERE account_id = ${accountId} AND created_at >= ${since} AND ${USAGE_KINDS_SQL}
        GROUP BY kind ORDER BY kind`,
  );
  return found.map((r) => ({ kind: r.kind, count: r.n, micros: Number(r.micros) }));
}

export const CHAT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "max",
] as const satisfies ChatLevel[];

/** One kind of usage charge in one group (a workspace, a UTC day, or the whole period). */
export interface UsageCharge {
  /** The workspace's name, the day ("YYYY-MM-DD"), or null (no grouping, or a deleted workspace). */
  group: string | null;
  /** "ingest", "store" or "chat_<level>". */
  kind: string;
  /** Charges, less those given back: ingest or storage batches, or questions for chat. */
  count: number;
  micros: number;
  /** Ingest and storage: billed tokens (each message or fact at least the per-item minimum). */
  tokens: number;
}

/**
 * Usage charges (ingest, storage and chat) by kind, net of charges given back, optionally only those of one
 * workspace (its internal id) and grouped by workspace name or by UTC day. `until` is exclusive.
 */
export async function usageCharges(
  db: Executor,
  accountId: string,
  opts: { since?: Date; until?: Date; workspaceId?: string; by?: "workspace" | "day" } = {},
): Promise<UsageCharge[]> {
  const group =
    opts.by === "workspace"
      ? sql`w.name`
      : opts.by === "day"
        ? sql`to_char(date_trunc('day', l.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`
        : sql`NULL::text`;
  const found = await rows<{
    grp: string | null;
    kind: string;
    n: number;
    micros: string | number;
    tokens: string | number | null;
  }>(
    db,
    sql`SELECT ${group} AS grp, l.kind,
               (count(*) FILTER (WHERE l.amount_micros < 0) - count(*) FILTER (WHERE l.amount_micros > 0))::int AS n,
               -sum(l.amount_micros) AS micros,
               sum(CASE WHEN l.kind IN ('ingest', 'store')
                        THEN (CASE WHEN l.amount_micros < 0 THEN 1 ELSE -1 END)
                             * COALESCE((l.detail->>'billed_tokens')::bigint, 0) END) AS tokens
        FROM credit_ledger l
        ${opts.by === "workspace" ? sql`LEFT JOIN workspaces w ON w.id = l.detail->>'workspace_id'` : sql``}
        WHERE l.account_id = ${accountId} AND (l.kind IN ('ingest', 'store') OR l.kind LIKE 'chat\\_%')
          ${opts.since ? sql`AND l.created_at >= ${opts.since}` : sql``}
          ${opts.until ? sql`AND l.created_at < ${opts.until}` : sql``}
          ${opts.workspaceId ? sql`AND l.detail->>'workspace_id' = ${opts.workspaceId}` : sql``}
        GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  return found.map((r) => ({
    group: r.grp,
    kind: r.kind,
    count: Number(r.n),
    micros: Number(r.micros),
    tokens: Number(r.tokens ?? 0),
  }));
}

/** What an account was charged for usage, with the billable units (the usage API's `billed`). */
export interface Billed {
  /** Learning, storage and chat together, net of charges given back. */
  billed_usd: number;
  learning: { message_tokens: number; billed_usd: number };
  /** Messages kept without being learned from, and facts added through the API. */
  storage: { tokens: number; billed_usd: number };
  chat: {
    questions: number;
    billed_usd: number;
    by_level: Record<ChatLevel, { questions: number; billed_usd: number }>;
  };
}

/** Adds usage charges up into `Billed` (every chat level present, 0 when unused). */
export function billedFrom(
  charges: Pick<UsageCharge, "kind" | "count" | "micros" | "tokens">[],
): Billed {
  const usd = (micros: number) => micros / MICROS_PER_USD;
  let learning = { tokens: 0, micros: 0 };
  let storage = { tokens: 0, micros: 0 };
  const levels = new Map<string, { count: number; micros: number }>(
    CHAT_LEVELS.map((l) => [l, { count: 0, micros: 0 }]),
  );
  for (const c of charges) {
    if (c.kind === "ingest") {
      learning = { tokens: learning.tokens + c.tokens, micros: learning.micros + c.micros };
      continue;
    }
    if (c.kind === "store") {
      storage = { tokens: storage.tokens + c.tokens, micros: storage.micros + c.micros };
      continue;
    }
    const level = levels.get(c.kind.replace(/^chat_/, ""));
    if (level) {
      level.count += c.count;
      level.micros += c.micros;
    }
  }
  const chat = [...levels.values()].reduce(
    (t, l) => ({ count: t.count + l.count, micros: t.micros + l.micros }),
    { count: 0, micros: 0 },
  );
  return {
    billed_usd: usd(learning.micros + storage.micros + chat.micros),
    learning: { message_tokens: learning.tokens, billed_usd: usd(learning.micros) },
    storage: { tokens: storage.tokens, billed_usd: usd(storage.micros) },
    chat: {
      questions: chat.count,
      billed_usd: usd(chat.micros),
      by_level: Object.fromEntries(
        CHAT_LEVELS.map((l) => {
          const v = levels.get(l)!;
          return [l, { questions: v.count, billed_usd: usd(v.micros) }];
        }),
      ) as Billed["chat"]["by_level"],
    },
  };
}

/** Difference between the cached balance and the ledger's sum (0 when consistent). */
export async function ledgerDrift(db: Executor, accountId: string): Promise<number> {
  const [r] = await rows<{ drift: string | number }>(
    db,
    sql`SELECT b.balance_micros - COALESCE((SELECT sum(amount_micros) FROM credit_ledger l
                                             WHERE l.account_id = b.account_id), 0) AS drift
        FROM billing_accounts b WHERE b.account_id = ${accountId}`,
  );
  return Number(r?.drift ?? 0);
}

/**
 * Dollars for display, from micros. One rule everywhere: two decimals from one cent up
 * ($29.97, $1,250.00) and up to four significant digits below a cent ($0.007839, $0.0005), so
 * small charges stay visible. With `exact` (a unit price or a single charge) an amount that is not
 * a whole number of cents is never rounded: $0.015 stays $0.015 instead of becoming $0.02.
 */
export function formatUsd(micros: number, opts: { exact?: boolean } = {}): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(Math.round(micros));
  if (abs === 0) return "$0.00";
  let text: string;
  if (abs < MICROS_PER_CENT) {
    // At least one micro, so never exponent notation.
    text = Number((abs / MICROS_PER_USD).toPrecision(4)).toString();
  } else if (opts.exact && abs % MICROS_PER_CENT !== 0) {
    const whole = Math.floor(abs / MICROS_PER_USD);
    const fraction = String(abs % MICROS_PER_USD)
      .padStart(6, "0")
      .replace(/0+$/, "");
    text = `${whole.toLocaleString("en-US")}.${fraction}`;
  } else {
    text = (Math.round(abs / MICROS_PER_CENT) / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return `${sign}$${text}`;
}
