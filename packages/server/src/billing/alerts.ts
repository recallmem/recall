import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { HostedConfig } from "../config.js";
import { monthStart, monthToDateSpend, nextMonthStart } from "../core/accounts.js";
import { ownerEmails } from "../core/users.js";
import { type Db, rows } from "../db/client.js";
import { renderEmail } from "../lib/email.js";
import type { Mailer } from "../lib/mailer.js";
import { chargesSince, formatUsd, MICROS_PER_USD } from "./ledger.js";

/**
 * Spend alerts: emails to an account's owners when its credit runs low or out, and when this
 * month's spend reaches 80% and 100% of its monthly budget. Each alert can be turned off in the
 * dashboard (Settings), and the low-balance line is the customer's to choose.
 *
 * Each alert goes out at most once per crossing. Who sends is decided in the database: a
 * conditional UPDATE claims the alert, so concurrent checks (a debit in one process, the sweep in
 * another) send it once. A balance alert re-arms only after the balance has recovered past the
 * line by a margin (so a refunded query does not send it twice); a budget alert is keyed by the
 * month and the cap, so it comes back next month or after the cap changes.
 *
 * Checks run shortly after a debit (`soon`) and from the billing sweep for accounts with recent
 * activity (`sweep`), which also covers unbilled accounts whose budget counts model cost.
 */

type Executor = Pick<Db, "execute">;

export type AlertKind = "low_balance" | "out_of_credit" | "budget_80" | "budget_100";

export interface AlertSettings {
  lowBalance: boolean;
  lowBalanceThresholdMicros: number;
  outOfCredit: boolean;
  budget80: boolean;
  budget100: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  lowBalance: true,
  lowBalanceThresholdMicros: 2 * MICROS_PER_USD,
  outOfCredit: true,
  budget80: true,
  budget100: true,
};

/** The low-balance line must sit between one cent and this. */
export const MAX_LOW_BALANCE_MICROS = 100_000 * MICROS_PER_USD;
/** How far above the line the balance must climb before a balance alert can fire again. */
const rearmMargin = (thresholdMicros: number) =>
  Math.max(500_000, Math.floor(thresholdMicros / 10));
/** Out of credit re-arms once the balance is back to at least this. */
const OUT_REARM_MICROS = 500_000;
/** Accounts with ledger or model activity this recent are checked by the sweep. */
const RECENT = sql`interval '20 minutes'`;
/** Checks after debits wait this long, so a burst of debits is one check. */
const SOON_MS = 2_000;

interface AlertRow {
  low_balance_enabled: boolean;
  low_balance_micros: string | number;
  out_of_credit_enabled: boolean;
  budget_80_enabled: boolean;
  budget_100_enabled: boolean;
  low_balance_sent_at: Date | string | null;
  out_of_credit_sent_at: Date | string | null;
  budget_80_sent_for: string | null;
  budget_100_sent_for: string | null;
}

const toSettings = (r: AlertRow | undefined): AlertSettings =>
  r
    ? {
        lowBalance: r.low_balance_enabled,
        lowBalanceThresholdMicros: Number(r.low_balance_micros),
        outOfCredit: r.out_of_credit_enabled,
        budget80: r.budget_80_enabled,
        budget100: r.budget_100_enabled,
      }
    : { ...DEFAULT_ALERT_SETTINGS };

export async function getAlertSettings(db: Executor, accountId: string): Promise<AlertSettings> {
  const [r] = await rows<AlertRow>(
    db,
    sql`SELECT * FROM account_alerts WHERE account_id = ${accountId}`,
  );
  return toSettings(r);
}

/**
 * Saves an account's alert settings. Changing the low-balance line re-arms that alert, so a
 * line moved above the current balance warns on the next check.
 */
export async function saveAlertSettings(
  db: Executor,
  accountId: string,
  s: AlertSettings,
): Promise<void> {
  const threshold = Math.round(s.lowBalanceThresholdMicros);
  if (!Number.isSafeInteger(threshold) || threshold < 10_000 || threshold > MAX_LOW_BALANCE_MICROS)
    throw new RangeError("low balance threshold out of range");
  await db.execute(
    sql`INSERT INTO account_alerts (account_id, low_balance_enabled, low_balance_micros,
                                    out_of_credit_enabled, budget_80_enabled, budget_100_enabled)
        VALUES (${accountId}, ${s.lowBalance}, ${threshold}, ${s.outOfCredit}, ${s.budget80}, ${s.budget100})
        ON CONFLICT (account_id) DO UPDATE SET
          low_balance_enabled = EXCLUDED.low_balance_enabled,
          low_balance_sent_at = CASE WHEN account_alerts.low_balance_micros = EXCLUDED.low_balance_micros
                                     THEN account_alerts.low_balance_sent_at END,
          low_balance_micros = EXCLUDED.low_balance_micros,
          out_of_credit_enabled = EXCLUDED.out_of_credit_enabled,
          budget_80_enabled = EXCLUDED.budget_80_enabled,
          budget_100_enabled = EXCLUDED.budget_100_enabled,
          updated_at = now()`,
  );
}

export interface SpendAlertDeps {
  config: HostedConfig;
  db: Db;
  log: Logger;
  mailer: Mailer;
  /** An absolute link to a dashboard page. */
  dashboardLink: (path: string) => string;
  /** Prepaid billing is on: billed accounts budget their charges and have a balance. */
  billing: boolean;
}

interface AccountState {
  budgetMicros: number | null;
  /** Null when the account is not billed. */
  balanceMicros: number | null;
  autoTopup: boolean;
  suspended: boolean;
}

export class SpendAlerts {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: SpendAlertDeps) {}

  /** Checks an account a moment after a debit (several debits in a row make one check). */
  soon(accountId: string): void {
    if (!this.deps.config.dashboard || this.pending.has(accountId)) return;
    const t = setTimeout(() => {
      this.pending.delete(accountId);
      void this.check(accountId).catch((err) =>
        this.deps.log.error({ err, account: accountId }, "spend alert check failed"),
      );
    }, SOON_MS);
    t.unref?.();
    this.pending.set(accountId, t);
  }

  /** Checks every account with recent charges or model use (the billing sweep). */
  async sweep(): Promise<void> {
    if (!this.deps.config.dashboard) return;
    const due = await rows<{ account_id: string }>(
      this.deps.db,
      sql`SELECT account_id FROM credit_ledger WHERE created_at > now() - ${RECENT}
          UNION
          SELECT u.account_id FROM llm_usage u JOIN accounts a ON a.id = u.account_id
          WHERE u.created_at > now() - ${RECENT} AND a.monthly_budget_usd IS NOT NULL
          LIMIT 1000`,
    );
    for (const r of due) {
      await this.check(r.account_id).catch((err) =>
        this.deps.log.error({ err, account: r.account_id }, "spend alert check failed"),
      );
    }
  }

  /** Re-arms the alerts that recovered and sends the ones due. Returns the alerts sent. */
  async check(accountId: string, now = new Date()): Promise<AlertKind[]> {
    const db = this.deps.db;
    const state = await this.state(accountId);
    if (!state || state.suspended) return [];
    await db.execute(
      sql`INSERT INTO account_alerts (account_id) VALUES (${accountId}) ON CONFLICT DO NOTHING`,
    );
    const [row] = await rows<AlertRow>(
      db,
      sql`SELECT * FROM account_alerts WHERE account_id = ${accountId}`,
    );
    if (!row) return [];
    const s = toSettings(row);
    const due: { kind: AlertKind; claim: () => Promise<boolean>; undo: () => Promise<void> }[] = [];

    // ---- balance (prepaid accounts)
    const bal = state.balanceMicros;
    if (bal !== null) {
      const line = s.lowBalanceThresholdMicros;
      if (row.low_balance_sent_at && bal >= line + rearmMargin(line))
        await db.execute(
          sql`UPDATE account_alerts SET low_balance_sent_at = NULL WHERE account_id = ${accountId}`,
        );
      if (row.out_of_credit_sent_at && bal >= OUT_REARM_MICROS)
        await db.execute(
          sql`UPDATE account_alerts SET out_of_credit_sent_at = NULL WHERE account_id = ${accountId}`,
        );
      const claimAt = (col: "low_balance_sent_at" | "out_of_credit_sent_at") => ({
        claim: async () =>
          (
            await rows(
              db,
              sql`UPDATE account_alerts SET ${sql.raw(col)} = now()
                  WHERE account_id = ${accountId} AND ${sql.raw(col)} IS NULL RETURNING account_id`,
            )
          ).length > 0,
        undo: async () => {
          await db.execute(
            sql`UPDATE account_alerts SET ${sql.raw(col)} = NULL WHERE account_id = ${accountId}`,
          );
        },
      });
      const out = bal <= 0 && s.outOfCredit;
      if (out) due.push({ kind: "out_of_credit", ...claimAt("out_of_credit_sent_at") });
      if (bal < line && !out && s.lowBalance && !state.autoTopup)
        due.push({ kind: "low_balance", ...claimAt("low_balance_sent_at") });
      // Out of credit says it all: the low-balance alert counts as sent for this dip.
      if (out)
        await db.execute(
          sql`UPDATE account_alerts SET low_balance_sent_at = COALESCE(low_balance_sent_at, now())
              WHERE account_id = ${accountId}`,
        );
    }

    // ---- monthly budget
    let spentMicros = 0;
    if (state.budgetMicros !== null && state.budgetMicros > 0) {
      spentMicros =
        bal !== null
          ? await chargesSince(db, accountId, monthStart(now))
          : Math.round((await monthToDateSpend(db, accountId, now)) * MICROS_PER_USD);
      const key = `${monthStart(now).toISOString().slice(0, 7)}:${state.budgetMicros}`;
      const claimFor = (col: "budget_80_sent_for" | "budget_100_sent_for") => ({
        claim: async () =>
          (
            await rows(
              db,
              sql`UPDATE account_alerts SET ${sql.raw(col)} = ${key}
                  WHERE account_id = ${accountId} AND ${sql.raw(col)} IS DISTINCT FROM ${key}
                  RETURNING account_id`,
            )
          ).length > 0,
        undo: async () => {
          await db.execute(
            sql`UPDATE account_alerts SET ${sql.raw(col)} = NULL
                WHERE account_id = ${accountId} AND ${sql.raw(col)} = ${key}`,
          );
        },
      });
      const reached = spentMicros >= state.budgetMicros;
      if (reached && s.budget100)
        due.push({ kind: "budget_100", ...claimFor("budget_100_sent_for") });
      else if (!reached && spentMicros >= state.budgetMicros * 0.8 && s.budget80)
        due.push({ kind: "budget_80", ...claimFor("budget_80_sent_for") });
      // Reaching the cap says it all: the 80% alert counts as sent for this month and cap.
      if (reached)
        await db.execute(
          sql`UPDATE account_alerts SET budget_80_sent_for = ${key}
              WHERE account_id = ${accountId} AND budget_80_sent_for IS DISTINCT FROM ${key}`,
        );
    }
    if (!due.length) return [];

    const owners = await ownerEmails(db, accountId);
    if (!owners.length) return [];
    const sent: AlertKind[] = [];
    for (const d of due) {
      if (!(await d.claim())) continue;
      const mail = this.render(d.kind, {
        balanceMicros: bal ?? 0,
        thresholdMicros: s.lowBalanceThresholdMicros,
        budgetMicros: state.budgetMicros ?? 0,
        spentMicros,
        resetsAt: nextMonthStart(now),
      });
      let delivered = 0;
      for (const to of owners) {
        try {
          await this.deps.mailer.send({ to, ...mail });
          delivered++;
        } catch (err) {
          this.deps.log.error(
            { err, account: accountId, alert: d.kind },
            "could not send a spend alert",
          );
        }
      }
      // Nobody got it: let the next check try again rather than lose the alert.
      if (!delivered) await d.undo();
      else {
        sent.push(d.kind);
        this.deps.log.info({ account: accountId, alert: d.kind }, "spend alert sent");
      }
    }
    return sent;
  }

  private async state(accountId: string): Promise<AccountState | null> {
    const [r] = await rows<{
      budget: number | string | null;
      balance: number | string | null;
      auto: boolean | null;
      suspended: boolean;
    }>(
      this.deps.db,
      sql`SELECT a.monthly_budget_usd AS budget, b.balance_micros AS balance,
                 b.auto_topup_enabled AS auto, a.suspended_at IS NOT NULL AS suspended
          FROM accounts a LEFT JOIN billing_accounts b ON b.account_id = a.id
          WHERE a.id = ${accountId}`,
    );
    if (!r) return null;
    const billed = this.deps.billing && r.balance != null;
    return {
      budgetMicros: r.budget == null ? null : Math.round(Number(r.budget) * MICROS_PER_USD),
      balanceMicros: billed ? Number(r.balance) : null,
      autoTopup: billed && !!r.auto,
      suspended: r.suspended,
    };
  }

  private render(
    kind: AlertKind,
    v: {
      balanceMicros: number;
      thresholdMicros: number;
      budgetMicros: number;
      spentMicros: number;
      resetsAt: Date;
    },
  ): { subject: string; html: string; text: string } {
    const billing = this.deps.dashboardLink("/billing");
    const budgetPage = this.deps.dashboardLink("/settings#budget");
    const settings = this.deps.dashboardLink("/settings#alerts");
    const site = new URL(billing, "https://recallmem.dev").origin;
    const reset = v.resetsAt.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
    const footnote = `Sent to the owners of this Recall account, once each time this line is crossed. Change the line or turn these emails off in Settings: ${settings}`;
    const usd = (m: number) => formatUsd(m);
    const pct = v.budgetMicros > 0 ? Math.floor((v.spentMicros / v.budgetMicros) * 100) : 100;
    const content = {
      low_balance: {
        subject: `Recall: your credit is below ${usd(v.thresholdMicros)}`,
        preheader: `Your Recall balance is ${usd(v.balanceMicros)}.`,
        heading: "Credit running low",
        paragraphs: [
          `Your Recall credit balance is ${usd(v.balanceMicros)}, below the ${usd(v.thresholdMicros)} you chose for this alert.`,
          "When it reaches zero, chat answers 402 and background learning pauses until you add credit. Messages your agents send meanwhile are kept and learned from once credit is back.",
          "Add credit now, or turn on auto top-up so a low balance never interrupts your agents.",
        ],
        button: { label: "Add credit", url: billing },
      },
      out_of_credit: {
        subject: "Recall: out of credit",
        preheader: "Chat answers 402 and learning is paused until you add credit.",
        heading: "Out of credit",
        paragraphs: [
          "Your Recall credit is used up. Chat requests now answer 402 and background learning is paused.",
          "Nothing is dropped: messages your agents send are stored, and learned from as soon as you add credit.",
        ],
        button: { label: "Add credit", url: billing },
      },
      budget_80: {
        subject: "Recall: 80% of your monthly budget used",
        preheader: `${usd(v.spentMicros)} of your ${usd(v.budgetMicros)} budget is used.`,
        heading: `${pct}% of your budget used`,
        paragraphs: [
          `This month's charges are ${usd(v.spentMicros)} of your ${usd(v.budgetMicros)} monthly budget.`,
          `At ${usd(v.budgetMicros)}, chat answers 402 and background learning pauses until the budget resets on ${reset} or you raise it.`,
        ],
        button: { label: "Review the budget", url: budgetPage },
      },
      budget_100: {
        subject: "Recall: monthly budget reached",
        preheader: "Chat answers 402 and learning is paused until the budget resets.",
        heading: "Monthly budget reached",
        paragraphs: [
          `This month's charges have reached your ${usd(v.budgetMicros)} budget.`,
          `Chat now answers 402 and background learning is paused until the budget resets on ${reset}, or until you raise it. Nothing is dropped: messages are stored and learned from once spending resumes.`,
        ],
        button: { label: "Raise the budget", url: budgetPage },
      },
    }[kind];
    const { subject, ...email } = content;
    return { subject, ...renderEmail(site, { ...email, footnote }) };
  }
}
