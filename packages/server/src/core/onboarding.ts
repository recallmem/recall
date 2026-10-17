import { createHmac, timingSafeEqual } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { formatUsd } from "../billing/ledger.js";
import { type Config, dashboardLink } from "../config.js";
import type { AppContext } from "../context.js";
import { type Db, rows } from "../db/client.js";
import { type EmailBlock, renderEmail } from "../lib/email.js";
import type { MailMessage } from "../lib/mailer.js";
import { ownerEmails } from "./users.js";

/**
 * Onboarding emails to the owners of new self-serve accounts (0019_onboarding_emails.sql):
 *
 * - welcome: once, at the first check after sign-up (up to a day after it): how to start (the
 *   Claude Code plugin, the SDKs, the MCP connector), the welcome credit if this account got one,
 *   and that a reply reaches a person;
 * - nudge: once, from 48 hours after sign-up, only while the account is unused: no message
 *   stored, no app connected over OAuth and no API key used (`api_keys.last_used_at`). Never to
 *   accounts older than 14 days.
 *
 * Only in hosted mode with the dashboard (the links and the opt-out page live there), with a live
 * mailer (Resend; the development mailer only logs) and RECALL_ONBOARDING_EMAILS_ENABLED. Accounts
 * made through the admin API (no `metadata.signup = "self_serve"`), suspended accounts and accounts
 * that turned these emails off get none. Accounts that existed before migration 0019 are marked as
 * sent, so deploying it emails nobody.
 *
 * Each email is claimed with one conditional UPDATE (`SET welcome_email_at = now() WHERE ... IS
 * NULL RETURNING id`, repeating every condition) before it is built, so of several workers or
 * serverless instances checking at once exactly one sends it. A claim whose email reached nobody
 * is given back, so the next check tries again. Checked by the worker every 10 minutes
 * (`startOnboardingEmails`) and by the serverless tick every minute, like the weekly funnel report.
 *
 * Every email carries a link to turn them off (`/unsubscribe` on the dashboard, a token signed with
 * the session secret, no sign-in) and a List-Unsubscribe header for one-click unsubscribe in the
 * mail client. Sign-in links, billing emails and spend alerts do not depend on it.
 */

type Deps = Pick<AppContext, "config" | "db" | "log" | "mailer">;
type Executor = Pick<Db, "execute">;

export type OnboardingEmail = "welcome" | "nudge";
export type OnboardingOutcome = "off" | Record<OnboardingEmail, number>;

/** Replies go to a person. */
export const SUPPORT_EMAIL = "support@recallmem.dev";
const CHECK_EVERY_MS = 10 * 60_000;
/** Accounts claimed per email kind and check; the rest wait for the next check. */
const BATCH = 20;

/**
 * The welcome email goes out up to a day after sign-up (later it would be a surprise), the nudge
 * from two days after it, so the two are at least a day apart. No nudge after 14 days.
 */
const WELCOME_WITHIN = sql`interval '24 hours'`;
const NUDGE_AFTER = sql`interval '48 hours'`;
const NUDGE_UNTIL = sql`interval '14 days'`;

const COLUMN: Record<OnboardingEmail, string> = {
  welcome: "welcome_email_at",
  nudge: "nudge_email_at",
};

/** Accounts that may get onboarding emails at all (SQL on `accounts a`). */
const ELIGIBLE = sql`a.metadata->>'signup' = 'self_serve'
  AND a.suspended_at IS NULL AND a.onboarding_emails_off_at IS NULL
  AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = a.id AND m.role = 'owner')`;

/** Nothing has used the account: no message stored, no app connected, no API key used. */
const UNUSED = sql`a.first_message_at IS NULL AND a.first_app_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.account_id = a.id AND k.last_used_at IS NOT NULL)`;

const DUE: Record<OnboardingEmail, SQL> = {
  welcome: sql`a.welcome_email_at IS NULL AND a.created_at > now() - ${WELCOME_WITHIN}`,
  nudge: sql`a.nudge_email_at IS NULL
    AND a.created_at <= now() - ${NUDGE_AFTER} AND a.created_at > now() - ${NUDGE_UNTIL}
    AND ${UNUSED}`,
};

/** True when onboarding emails can go out from this deployment. */
export function onboardingEmailsOn(ctx: Pick<Deps, "config" | "mailer">): boolean {
  const { config, mailer } = ctx;
  return (
    config.tenancy.hosted &&
    config.hosted.dashboard &&
    config.hosted.onboardingEmails &&
    mailer.live
  );
}

/** Sends the onboarding emails that are due; returns how many accounts got each, or "off". */
export async function sendOnboardingEmails(ctx: Deps): Promise<OnboardingOutcome> {
  if (!onboardingEmailsOn(ctx)) return "off";
  const sent: Record<OnboardingEmail, number> = { welcome: 0, nudge: 0 };
  for (const kind of ["welcome", "nudge"] as const) {
    const due = await rows<{ id: string }>(
      ctx.db,
      sql`SELECT a.id FROM accounts a WHERE ${ELIGIBLE} AND ${DUE[kind]}
          ORDER BY a.created_at, a.id LIMIT ${BATCH}`,
    );
    for (const { id } of due) if (await sendOne(ctx, kind, id)) sent[kind]++;
  }
  return sent;
}

/** Claims, builds and sends one email; false when another check had it or nobody got it. */
async function sendOne(ctx: Deps, kind: OnboardingEmail, accountId: string): Promise<boolean> {
  const col = sql.raw(COLUMN[kind]);
  const claimed = await rows<{ id: string }>(
    ctx.db,
    sql`UPDATE accounts a SET ${col} = now()
        WHERE a.id = ${accountId} AND ${ELIGIBLE} AND ${DUE[kind]} RETURNING a.id`,
  );
  if (!claimed.length) return false;
  const release = () =>
    ctx.db
      .execute(sql`UPDATE accounts SET ${col} = NULL WHERE id = ${accountId}`)
      .catch((err) => ctx.log.error({ err, account: accountId }, "could not release an email"));

  let to: string[];
  let mail: Omit<MailMessage, "to">;
  try {
    to = await ownerEmails(ctx.db, accountId);
    mail = renderOnboardingEmail(kind, ctx.config, await creditOf(ctx, accountId), accountId);
  } catch (err) {
    await release();
    ctx.log.error(
      { err, account: accountId, onboarding: kind },
      "could not build an onboarding email",
    );
    return false;
  }
  let delivered = 0;
  for (const address of to) {
    try {
      await ctx.mailer.send({ to: address, ...mail });
      delivered++;
    } catch (err) {
      ctx.log.error(
        { err, account: accountId, onboarding: kind },
        "could not send an onboarding email",
      );
    }
  }
  // Nobody got it: let the next check try again rather than lose it.
  if (!delivered) {
    await release();
    return false;
  }
  ctx.log.info({ account: accountId, onboarding: kind }, "onboarding email sent");
  return true;
}

/** Checks for due onboarding emails every few minutes (worker processes); returns a stop function. */
export function startOnboardingEmails(ctx: Deps): () => Promise<void> {
  if (!onboardingEmailsOn(ctx)) return async () => {};
  const check = () =>
    void sendOnboardingEmails(ctx).catch((err) =>
      ctx.log.error({ err }, "onboarding email check failed"),
    );
  const timer = setInterval(check, CHECK_EVERY_MS);
  timer.unref?.();
  check();
  return async () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Opting out

const unsubscribeMac = (secret: Buffer, accountId: string) =>
  createHmac("sha256", secret).update(`onboarding-unsubscribe:${accountId}`).digest("base64url");

/** The token in an account's unsubscribe link: its id and an HMAC of it (no expiry). */
export function unsubscribeToken(secret: Buffer, accountId: string): string {
  return `${accountId}.${unsubscribeMac(secret, accountId)}`;
}

/** The account an unsubscribe token was made for, or null when it is not one of ours. */
export function verifyUnsubscribeToken(secret: Buffer, token: string): string | null {
  if (!token || token.length > 200) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const accountId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(unsubscribeMac(secret, accountId));
  return given.length === want.length && timingSafeEqual(given, want) ? accountId : null;
}

/** Turns the account's onboarding emails off (idempotent; keeps the first time). */
export async function stopOnboardingEmails(db: Executor, accountId: string): Promise<void> {
  await db.execute(
    sql`UPDATE accounts SET onboarding_emails_off_at = COALESCE(onboarding_emails_off_at, now())
        WHERE id = ${accountId}`,
  );
}

// ---------------------------------------------------------------------------
// The emails

/** The account's welcome credit and balance, when it is billed (prepaid billing on). */
interface Credit {
  /** The welcome credit this account was granted, in micro-USD; null without one. */
  welcomeMicros: number | null;
  /** The welcome credit held back by the day's cap and still on its way; null without one. */
  pendingMicros?: number | null;
  balanceMicros: number;
}

async function creditOf(ctx: Deps, accountId: string): Promise<Credit | null> {
  if (!ctx.config.hosted.billing.enabled) return null;
  const [r] = await rows<{
    balance: string | number;
    welcome: string | number | null;
    pending: string | number | null;
  }>(
    ctx.db,
    sql`SELECT b.balance_micros AS balance,
               (SELECT l.amount_micros FROM credit_ledger l
                WHERE l.account_id = b.account_id AND l.kind = 'signup_credit' AND l.amount_micros > 0
                ORDER BY l.created_at LIMIT 1) AS welcome,
               (SELECT p.amount_micros FROM signup_credit_pending p
                WHERE p.account_id = b.account_id) AS pending
        FROM billing_accounts b WHERE b.account_id = ${accountId}`,
  );
  if (!r) return null;
  return {
    welcomeMicros: r.welcome == null ? null : Number(r.welcome),
    pendingMicros: r.pending == null ? null : Number(r.pending),
    balanceMicros: Number(r.balance),
  };
}

/** The subject, HTML, text and headers of one onboarding email. */
export function renderOnboardingEmail(
  kind: OnboardingEmail,
  config: Pick<Config, "server" | "hosted">,
  credit: Credit | null,
  accountId: string,
): Omit<MailMessage, "to"> {
  const { server, hosted } = config;
  const api = (server.publicUrl ?? "").replace(/\/+$/, "");
  const site = (server.siteUrl ?? api).replace(/\/+$/, "");
  const keys = dashboardLink(config, "/keys");
  const billing = dashboardLink(config, "/billing");
  const playground = dashboardLink(config, "/playground");
  const quickstart = `${site}/docs#quickstart`;
  const unsubscribe = dashboardLink(
    config,
    `/unsubscribe?t=${encodeURIComponent(unsubscribeToken(hosted.sessionSecret, accountId))}`,
  );
  const reply = `Reply to this email: a person reads every reply. Or write to ${SUPPORT_EMAIL}.`;
  const pending = credit?.pendingMicros ?? null;
  const noCredit = !!credit && credit.balanceMicros <= 0 && !pending;
  const onItsWay = pending
    ? `Your ${formatUsd(pending)} of free credit is on its way. So many people signed up today that the day's free credit ran out, so yours is added automatically, usually within a day. You can create an API key and set things up now.`
    : null;

  let subject: string;
  let preheader: string;
  let heading: string;
  let body: EmailBlock[];
  let footnote: string;
  if (kind === "welcome") {
    /** Each way to start: what to do, then what to paste. */
    const ways: [string, EmailBlock][] = [
      [
        `Claude Code: install the plugin. It asks for an API key, which you create at ${keys}.`,
        {
          code: "/plugin marketplace add recallmem/recall-plugin\n/plugin install recall-memory@recall",
        },
      ],
      [
        "Your own code: the SDK for TypeScript or Python, with an API key from the same page.",
        { code: "npm install @recall-memory/sdk\npip install recall-mem" },
      ],
    ];
    // Signing in from the app needs OAuth (on whenever the dashboard is, unless switched off).
    if (hosted.oauth.enabled)
      ways.push([
        "Claude, ChatGPT, Cursor or another MCP client: add Recall as a connector with this address and sign in with your email. No key needed.",
        { code: hosted.oauth.resource },
      ]);
    subject = "Welcome to Recall";
    preheader = `${ways.length === 3 ? "Three" : "Two"} ways to start, and how to reach us.`;
    heading = "Welcome to Recall";
    body = [
      "Thanks for signing up. Recall gives your agents a memory: it learns from their conversations and answers questions about the people in them.",
      ...(credit?.welcomeMicros
        ? [
            `We added ${formatUsd(credit.welcomeMicros)} of free credit to your account, so you can try it without a card.`,
          ]
        : onItsWay
          ? [onItsWay]
          : noCredit
            ? [
                `Your account has no credit yet. Add some at ${billing} before you start: Recall needs it to learn from messages and answer questions.`,
              ]
            : []),
      `${ways.length === 3 ? "Three" : "Two"} ways to start:`,
      ...ways.flatMap(([intro, code], i) => [`${i + 1}. ${intro}`, code]),
      `The quickstart goes from your first message to your first answer: ${quickstart}. Guides by use case and framework: ${site}/guides.`,
      `Questions, or stuck somewhere? ${reply}`,
    ];
    footnote = `You get this because you signed up for Recall. We send new accounts at most two of these getting-started emails. Turn them off: ${unsubscribe}`;
  } else {
    subject = "Stuck? See Recall work in 30 seconds, no code";
    preheader = "One click loads a sample conversation; ask about it and see the sources.";
    heading = "See it work in 30 seconds";
    body = [
      "You signed up for Recall, but nothing has used your account yet. The quickest way to see it work needs no code at all.",
      `Open the Playground and press Try the sample: ${playground}. It loads a short conversation about Alex, who moved from Chicago to Lisbon. Ask "Where does Alex live now?" and you get the answer, the message it came from, and the old city kept in the history instead of overwritten. It uses less than a cent of your credit.`,
      "When you want it in your own app, it takes two calls:",
      ...(noCredit
        ? [
            `Your account has no credit yet: add some at ${billing} first, or the question below answers 402.`,
          ]
        : pending
          ? [
              `Your ${formatUsd(pending)} of free credit is still on its way; it is added automatically. Until it arrives the question below answers 402.`,
            ]
          : []),
      `1. Create an API key at ${keys}.`,
      "2. Store a message, give Recall about 20 seconds to learn from it, then ask:",
      {
        code: [
          "export RECALL_API_KEY=pk_live_...",
          "",
          `curl ${api}/v3/workspaces/my-app/sessions/chat-1/messages \\`,
          `  -H "Authorization: Bearer $RECALL_API_KEY" -H "Content-Type: application/json" \\`,
          `  -d '{"messages":[{"peer_id":"alice","content":"I moved to New York and I am vegetarian now."}]}'`,
          "",
          `curl ${api}/v3/workspaces/my-app/peers/alice/chat \\`,
          `  -H "Authorization: Bearer $RECALL_API_KEY" -H "Content-Type: application/json" \\`,
          `  -d '{"query":"What should I cook for Alice?"}'`,
        ].join("\n"),
      },
      `Recall answers from what it learned about Alice. The quickstart explains each step: ${quickstart}.`,
      `Still stuck, or not sure Recall fits what you are building? Tell us what you tried and we will help. ${reply}`,
    ];
    footnote = `You get this because you signed up for Recall. It is the last getting-started email we send. Turn them off: ${unsubscribe}`;
  }
  return {
    subject,
    ...renderEmail(site, {
      preheader,
      heading,
      paragraphs: body,
      button:
        kind === "welcome"
          ? { label: "Create an API key", url: keys }
          : { label: "Try the sample", url: playground },
      footnote,
    }),
    replyTo: SUPPORT_EMAIL,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
