import { type SQL, sql } from "drizzle-orm";
import type { HostedConfig } from "../config.js";
import { type Db, rows } from "../db/client.js";
import { DEFAULT_ACCOUNT_ID } from "./tenancy.js";

/**
 * The activation funnel for the operator (console Funnel page, weekly report): of the self-serve
 * accounts that signed up in a period, how many reached each step, by sign-up week (UTC, weeks
 * from Monday), and the median time from sign-up to the first chat answer.
 *
 * Steps, from what the database already keeps (no content is read):
 *
 * - signed up: accounts created by dashboard sign-up (`metadata.signup = "self_serve"`, set by
 *   `signIn`). Operator-created accounts (admin API, unbilled) never carry it and are left out,
 *   as are test accounts (`testAccount`).
 * - API key or app: the first API key (`api_keys`, revoked but never deleted) or OAuth connection
 *   (`accounts.first_app_at`, stamped when the grant is made, since grants are purged after
 *   they lapse; surviving `oauth_grants` rows count too).
 * - first message: `accounts.first_message_at`, stamped by the transaction that stores the
 *   account's first message (messages can be deleted, and their created_at is client-set).
 * - first chat answer: the first chat model call (`llm_usage`, task chat_*) or billed chat that was
 *   not given back (`credit_ledger` chat_* debit without its `:released` entry; a cached answer is
 *   billed but makes no model call). Chat that produced no answer (empty memory, errors) does not
 *   count.
 * - paid top-up: the first `topup` or `auto_topup` ledger credit (welcome credit and operator
 *   grants are not paid).
 * - active in the last 7 days: an API key or connected app used (`last_used_at`), or a model call
 *   made for the account (`llm_usage`), within 7 days of now. Dashboard sign-ins alone do not count.
 *
 * Every step is counted on its own as of now (an account can have topped up without a message),
 * as a share of the sign-ups. Queries are bounded by the sign-up period on accounts.created_at and
 * per-account lookups on the (account_id, created_at) indexes.
 */

type Executor = Pick<Db, "execute">;
type Ts = Date | string | null;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** The steps in funnel order. */
export const FUNNEL_STEPS = [
  "signed_up",
  "connected",
  "message",
  "answer",
  "topup",
  "active",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const STEP_LABELS: Record<FunnelStep, string> = {
  signed_up: "Signed up",
  connected: "API key or app",
  message: "First message",
  answer: "First chat answer",
  topup: "Paid top-up",
  active: "Active, last 7 days",
};

/** Periods the console offers, in days of sign-ups. */
export const FUNNEL_PERIODS = [7, 30, 90] as const;
export type FunnelPeriod = (typeof FUNNEL_PERIODS)[number];
export const DEFAULT_FUNNEL_PERIOD: FunnelPeriod = 30;
/** "Still active" looks back this many days. */
export const ACTIVE_DAYS = 7;

/** A period from a query parameter: 7, 30 or 90, else the default. */
export function funnelPeriod(raw: string | undefined): FunnelPeriod {
  const n = Number(raw);
  return (FUNNEL_PERIODS as readonly number[]).includes(n)
    ? (n as FunnelPeriod)
    : DEFAULT_FUNNEL_PERIOD;
}

/** One self-serve sign-up and when it first reached each step (null: not yet). */
export interface FunnelAccount {
  id: string;
  name: string;
  createdAt: Date;
  suspended: boolean;
  connectedAt: Date | null;
  messageAt: Date | null;
  answerAt: Date | null;
  topupAt: Date | null;
  /** Latest key or app use, or model call, within the last 7 days; null without one. */
  lastActiveAt: Date | null;
}

/** The steps an account has reached, in funnel order. */
export function stepsReached(a: FunnelAccount, now: Date): FunnelStep[] {
  const active =
    !!a.lastActiveAt && a.lastActiveAt.getTime() >= now.getTime() - ACTIVE_DAYS * DAY_MS;
  const has: Record<FunnelStep, boolean> = {
    signed_up: true,
    connected: !!a.connectedAt,
    message: !!a.messageAt,
    answer: !!a.answerAt,
    topup: !!a.topupAt,
    active,
  };
  return FUNNEL_STEPS.filter((s) => has[s]);
}

export interface FunnelGroup {
  /** The sign-up week's Monday (UTC, YYYY-MM-DD), or "total". */
  key: string;
  signups: number;
  reached: Record<FunnelStep, number>;
  /** Median time from sign-up to the first chat answer, over those who got one; null without any. */
  medianAnswerMs: number | null;
}

export interface RecentSignup {
  id: string;
  name: string;
  /** The first owner's email (else the first member's), as the console's account list shows it. */
  email: string | null;
  createdAt: string;
  suspended: boolean;
  reached: FunnelStep[];
  furthest: FunnelStep;
}

export interface Funnel {
  days: number;
  since: Date;
  now: Date;
  total: FunnelGroup;
  /** Sign-up weeks in the period, newest first (the oldest and the current one are partial). */
  weeks: FunnelGroup[];
  /** The newest sign-ups of the period, newest first. */
  recent: RecentSignup[];
  /** Accounts created in the period that the funnel leaves out. */
  leftOut: { operatorCreated: number; test: number };
}

/** The Monday 00:00 UTC of `d`'s week. */
export function utcWeekStart(d: Date): Date {
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - sinceMonday * DAY_MS);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A duration for people: "< 1 min", "14 min", "3.5 h", "2.1 d". */
export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return "< 1 min";
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / DAY_MS).toFixed(1)} d`;
}

/** Share of `of` as a whole percentage ("—" when there is nothing to share). */
export const percent = (n: number, of: number): string =>
  of > 0 ? `${Math.round((n / of) * 100)}%` : "—";

/**
 * Addresses whose accounts are the operator's own tests: the operator console's users and the
 * app-directory reviewer (lower-cased).
 */
export function testEmails(hosted: Pick<HostedConfig, "operatorEmails" | "reviewer">): string[] {
  const all = [...hosted.operatorEmails, ...(hosted.reviewer ? [hosted.reviewer.email] : [])];
  return [...new Set(all.map((e) => e.toLowerCase()))];
}

/**
 * True (SQL, on `accounts a`) for a test account: one the operator marked
 * (`metadata.test_account = true`), a benchmark account (`metadata.llm_key = "eval"`), or one
 * signed up with or owned by one of `emails` (operators, the reviewer).
 */
function testAccount(emails: string[]): SQL {
  const conds: SQL[] = [
    sql`COALESCE(a.metadata->>'test_account', '') = 'true'`,
    sql`COALESCE(a.metadata->>'llm_key', '') = 'eval'`,
  ];
  if (emails.length) {
    const list = sql`(${sql.join(
      emails.map((e) => sql`${e}`),
      sql`, `,
    )})`;
    conds.push(sql`lower(COALESCE(a.metadata->>'signup_email', '')) IN ${list}`);
    conds.push(sql`EXISTS (SELECT 1 FROM account_members m JOIN users u ON u.id = m.user_id
                          WHERE m.account_id = a.id AND m.role = 'owner' AND u.email IN ${list})`);
  }
  return sql`(${sql.join(conds, sql` OR `)})`;
}

const SELF_SERVE = sql`a.metadata->>'signup' = 'self_serve'`;
const date = (v: Ts): Date | null => (v == null ? null : new Date(v));

/** Self-serve, non-test sign-ups created in [since, now], newest first, with their step times. */
export async function funnelAccounts(
  db: Executor,
  opts: { since: Date; now: Date; testEmails: string[] },
): Promise<FunnelAccount[]> {
  const activeSince = new Date(opts.now.getTime() - ACTIVE_DAYS * DAY_MS);
  const found = await rows<{
    id: string;
    name: string;
    created_at: Ts;
    suspended: boolean;
    connected_at: Ts;
    message_at: Ts;
    answer_at: Ts;
    topup_at: Ts;
    last_active_at: Ts;
  }>(
    db,
    sql`SELECT a.id, a.name, a.created_at, a.suspended_at IS NOT NULL AS suspended,
               LEAST(a.first_app_at,
                     (SELECT min(k.created_at) FROM api_keys k WHERE k.account_id = a.id),
                     (SELECT min(g.created_at) FROM oauth_grants g WHERE g.account_id = a.id)) AS connected_at,
               a.first_message_at AS message_at,
               LEAST((SELECT min(u.created_at) FROM llm_usage u
                      WHERE u.account_id = a.id AND u.task LIKE 'chat\\_%'),
                     (SELECT min(l.created_at) FROM credit_ledger l
                      WHERE l.account_id = a.id AND l.kind LIKE 'chat\\_%' AND l.amount_micros < 0
                        AND NOT EXISTS (SELECT 1 FROM credit_ledger r
                                        WHERE r.account_id = l.account_id
                                          AND r.idempotency_key = l.idempotency_key || ':released'))) AS answer_at,
               (SELECT min(l.created_at) FROM credit_ledger l
                WHERE l.account_id = a.id AND l.kind IN ('topup', 'auto_topup') AND l.amount_micros > 0) AS topup_at,
               GREATEST((SELECT max(k.last_used_at) FROM api_keys k
                         WHERE k.account_id = a.id AND k.last_used_at >= ${activeSince}),
                        (SELECT max(g.last_used_at) FROM oauth_grants g
                         WHERE g.account_id = a.id AND g.last_used_at >= ${activeSince}),
                        (SELECT max(u.created_at) FROM llm_usage u
                         WHERE u.account_id = a.id AND u.created_at >= ${activeSince})) AS last_active_at
        FROM accounts a
        WHERE a.created_at >= ${opts.since} AND a.created_at <= ${opts.now}
          AND a.id <> ${DEFAULT_ACCOUNT_ID} AND ${SELF_SERVE} AND NOT ${testAccount(opts.testEmails)}
        ORDER BY a.created_at DESC, a.id DESC`,
  );
  return found.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: new Date(r.created_at!),
    suspended: !!r.suspended,
    connectedAt: date(r.connected_at),
    messageAt: date(r.message_at),
    answerAt: date(r.answer_at),
    topupAt: date(r.topup_at),
    lastActiveAt: date(r.last_active_at),
  }));
}

/** Counts per step for a group of sign-ups. */
export function groupFunnel(key: string, accounts: FunnelAccount[], now: Date): FunnelGroup {
  const reached = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0])) as Record<FunnelStep, number>;
  const waits: number[] = [];
  for (const a of accounts) {
    for (const s of stepsReached(a, now)) reached[s]++;
    if (a.answerAt) waits.push(Math.max(0, a.answerAt.getTime() - a.createdAt.getTime()));
  }
  return { key, signups: accounts.length, reached, medianAnswerMs: median(waits) };
}

/** The funnel of the self-serve sign-ups of the last `days` days. */
export async function funnel(
  db: Executor,
  opts: { days: number; now?: Date; testEmails: string[]; recent?: number },
): Promise<Funnel> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.days * DAY_MS);
  const [accounts, [left]] = await Promise.all([
    funnelAccounts(db, { since, now, testEmails: opts.testEmails }),
    rows<{ operator_created: number; test: number }>(
      db,
      sql`SELECT count(*) FILTER (WHERE NOT COALESCE(${SELF_SERVE}, false))::int AS operator_created,
                 count(*) FILTER (WHERE ${SELF_SERVE} AND ${testAccount(opts.testEmails)})::int AS test
          FROM accounts a
          WHERE a.created_at >= ${since} AND a.created_at <= ${now} AND a.id <> ${DEFAULT_ACCOUNT_ID}`,
    ),
  ]);

  const byWeek = new Map<number, FunnelAccount[]>();
  for (let w = utcWeekStart(now).getTime(); w + WEEK_MS > since.getTime(); w -= WEEK_MS)
    byWeek.set(w, []);
  for (const a of accounts) byWeek.get(utcWeekStart(a.createdAt).getTime())?.push(a);
  const weeks = [...byWeek].map(([w, list]) =>
    groupFunnel(new Date(w).toISOString().slice(0, 10), list, now),
  );

  const newest = accounts.slice(0, opts.recent ?? 20);
  const emails = await ownerEmails(
    db,
    newest.map((a) => a.id),
  );
  const recent = newest.map((a) => {
    const reached = stepsReached(a, now);
    return {
      id: a.id,
      name: a.name,
      email: emails.get(a.id) ?? null,
      createdAt: a.createdAt.toISOString(),
      suspended: a.suspended,
      reached,
      furthest: reached.at(-1) ?? "signed_up",
    };
  });

  return {
    days: opts.days,
    since,
    now,
    total: groupFunnel("total", accounts, now),
    weeks,
    recent,
    leftOut: { operatorCreated: left?.operator_created ?? 0, test: left?.test ?? 0 },
  };
}

/** The first owner's email (else the first member's) of each account. */
async function ownerEmails(db: Executor, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const found = await rows<{ account_id: string; email: string }>(
    db,
    sql`SELECT DISTINCT ON (m.account_id) m.account_id, u.email
        FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
        ORDER BY m.account_id, (m.role = 'owner') DESC, m.created_at, u.email`,
  );
  return new Map(found.map((r) => [r.account_id, r.email]));
}

/** Self-serve sign-ups of a period from one source and campaign, and how many called the API. */
export interface SourceRow {
  /** `accounts.signup_source`; null when unknown (direct visits, sign-ups before 0029). */
  source: string | null;
  campaign: string | null;
  signups: number;
  /** Accounts whose API key or connected app was used at least once. */
  apiCalls: number;
}

/**
 * Sign-ups of the last `days` days by where they came from (core/signup-source.ts), with the
 * accounts that made a first API call: an API key or OAuth-connected app used at least once.
 * Test and operator-created accounts are left out, as in the funnel. Most sign-ups first.
 */
export async function signupsBySource(
  db: Executor,
  opts: { days: number; now?: Date; testEmails: string[] },
): Promise<SourceRow[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.days * DAY_MS);
  const found = await rows<{
    source: string | null;
    campaign: string | null;
    signups: number;
    api_calls: number;
  }>(
    db,
    sql`SELECT a.signup_source AS source, a.signup_campaign AS campaign, count(*)::int AS signups,
               count(*) FILTER (WHERE
                 EXISTS (SELECT 1 FROM api_keys k WHERE k.account_id = a.id AND k.last_used_at IS NOT NULL)
                 OR EXISTS (SELECT 1 FROM oauth_grants g WHERE g.account_id = a.id AND g.last_used_at IS NOT NULL)
               )::int AS api_calls
        FROM accounts a
        WHERE a.created_at >= ${since} AND a.created_at <= ${now}
          AND a.id <> ${DEFAULT_ACCOUNT_ID} AND ${SELF_SERVE} AND NOT ${testAccount(opts.testEmails)}
        GROUP BY 1, 2
        ORDER BY 3 DESC, 1 NULLS LAST, 2 NULLS FIRST`,
  );
  return found.map((r) => ({
    source: r.source,
    campaign: r.campaign,
    signups: r.signups,
    apiCalls: r.api_calls,
  }));
}

/** A tagged link's sign-ups (core/links.ts): accounts made since the link with its source and campaign. */
export interface LinkSignups {
  signups: number;
  /** Of those, the accounts whose API key or connected app was used at least once. */
  apiCalls: number;
}

/**
 * Sign-ups per live tagged link: self-serve, non-test accounts created since the link was made
 * whose sign-up source and campaign are the link's (links that share both share these counts).
 */
export async function signupsByLink(
  db: Executor,
  opts: { testEmails: string[] },
): Promise<Map<string, LinkSignups>> {
  const found = await rows<{ id: string; signups: number; api_calls: number }>(
    db,
    sql`SELECT l.id, count(a.id)::int AS signups,
               count(a.id) FILTER (WHERE
                 EXISTS (SELECT 1 FROM api_keys k WHERE k.account_id = a.id AND k.last_used_at IS NOT NULL)
                 OR EXISTS (SELECT 1 FROM oauth_grants g WHERE g.account_id = a.id AND g.last_used_at IS NOT NULL)
               )::int AS api_calls
        FROM utm_links l
        LEFT JOIN accounts a ON a.signup_source = l.source AND a.signup_campaign = l.campaign
          AND a.created_at >= l.created_at AND a.id <> ${DEFAULT_ACCOUNT_ID} AND ${SELF_SERVE}
          AND NOT ${testAccount(opts.testEmails)}
        WHERE l.archived_at IS NULL
        GROUP BY l.id`,
  );
  return new Map(found.map((r) => [r.id, { signups: r.signups, apiCalls: r.api_calls }]));
}
