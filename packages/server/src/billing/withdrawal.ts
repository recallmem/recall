import { sql } from "drizzle-orm";
import { type Db, rows } from "../db/client.js";

type Executor = Pick<Db, "execute">;

/**
 * What is left of each top-up, for a consumer who withdraws (terms sections 9 and 10): usage
 * counts first against free credit (welcome credit and operator grants), then against top-ups in
 * the order they were bought. A withdrawal refunds the unused share of that top-up's payment,
 * VAT included; refunding that share of the Stripe charge takes back the same share of credit
 * (`charge.refunded`), so the balance stays right.
 */
export interface TopupStatus {
  /** Ledger entry id. */
  id: number;
  kind: "topup" | "auto_topup";
  at: string;
  creditMicros: number;
  refundedMicros: number;
  unusedMicros: number;
  /** Unused share of what was paid for it, 0..1: refund this share of the charge. */
  refundShare: number;
  /** The consumer withdrawal period ends at the end of this day (14 days after the purchase). */
  withdrawUntil: string;
  paymentIntent: string | null;
  invoice: string | null;
}

const WITHDRAWAL_DAYS = 14;

export async function topupStatus(db: Executor, accountId: string): Promise<TopupStatus[]> {
  const [used] = await rows<{ micros: string | number }>(
    db,
    sql`SELECT COALESCE(-sum(amount_micros), 0) AS micros FROM credit_ledger
        WHERE account_id = ${accountId} AND amount_micros < 0 AND kind <> 'refund'`,
  );
  const credits = await rows<{
    id: string | number;
    kind: string;
    amount_micros: string | number;
    detail: Record<string, unknown> | null;
    created_at: Date | string;
  }>(
    db,
    sql`SELECT id, kind, amount_micros, detail, created_at FROM credit_ledger
        WHERE account_id = ${accountId}
          AND (kind IN ('topup', 'auto_topup', 'refund') OR (kind IN ('signup_credit', 'grant') AND amount_micros > 0))
        ORDER BY id`,
  );
  const refundedByPi = new Map<string, number>();
  let free = 0;
  // A refund recorded before refunds carried their payment intent cannot be tied to a top-up; it
  // counts as usage, which can make an earlier top-up look used. Check those by hand in Stripe.
  let unmatchedRefunds = 0;
  for (const c of credits) {
    const micros = Number(c.amount_micros);
    if (c.kind === "signup_credit" || c.kind === "grant") free += micros;
    if (c.kind === "refund") {
      const pi = typeof c.detail?.payment_intent === "string" ? c.detail.payment_intent : null;
      if (pi) refundedByPi.set(pi, (refundedByPi.get(pi) ?? 0) - micros);
      else unmatchedRefunds -= micros;
    }
  }
  let usage = Math.max(0, Number(used?.micros ?? 0) + unmatchedRefunds - free);
  const out: TopupStatus[] = [];
  for (const c of credits) {
    if (c.kind !== "topup" && c.kind !== "auto_topup") continue;
    const credit = Number(c.amount_micros);
    const pi = typeof c.detail?.payment_intent === "string" ? c.detail.payment_intent : null;
    const refunded = Math.min(credit, pi ? (refundedByPi.get(pi) ?? 0) : 0);
    const available = credit - refunded;
    const consumed = Math.min(available, usage);
    usage -= consumed;
    const unused = available - consumed;
    const at = new Date(c.created_at);
    const until = new Date(at.getTime() + WITHDRAWAL_DAYS * 86_400_000);
    out.push({
      id: Number(c.id),
      kind: c.kind,
      at: at.toISOString(),
      creditMicros: credit,
      refundedMicros: refunded,
      unusedMicros: unused,
      refundShare: credit > 0 ? unused / credit : 0,
      withdrawUntil: until.toISOString().slice(0, 10),
      paymentIntent: pi,
      invoice: typeof c.detail?.invoice === "string" ? c.detail.invoice : null,
    });
  }
  return out;
}
