import { sql } from "drizzle-orm";
import { type Db, rows } from "../db/client.js";

/**
 * Limits on the welcome credit that hosted sign-up grants, against farming it
 * with throwaway addresses. Every grant is recorded in `signup_credit_grants`
 * (keyed hashes of the client network and of the normalised email address,
 * amount, time; no account, no address) and three limits are counted from it:
 *
 * - per email address: one grant a year, also after the account was deleted;
 * - per network: at most `perIp` grants for one client network within 30 days;
 * - per day: at most `dailyCapMicros` of grants in total in the current UTC day.
 *
 * The caller is the sign-up transaction: the checks and the recording run in it,
 * under an advisory lock, so concurrent sign-ups cannot all pass the same check.
 * A limit of 0 switches that limit off.
 */

type Executor = Pick<Db, "execute">;

/** Why a new account got no welcome credit. */
export type SignupCreditSkip = "email_limit" | "ip_limit" | "daily_cap";

/** Days a grant counts against its network. */
export const SIGNUP_IP_WINDOW_DAYS = 30;
/** Network-only rows older than this are of no use to any limit and are purged. */
const RETENTION = sql`interval '35 days'`;
/** How long an email address's grant keeps it from another one. */
const EMAIL_RETENTION = sql`interval '365 days'`;

/**
 * An email address as one mailbox: lower case, without a "+tag", and for Gmail without dots
 * (which Gmail ignores), so aliases of one inbox count as one address.
 */
export function mailboxKey(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email.trim().toLowerCase();
  let local = email.slice(0, at).trim().toLowerCase();
  let domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  local = local.split("+")[0]!;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

export interface SignupCreditLimits {
  /** Keyed hash of the client network; null when the address is unknown. */
  ipHash: string | null;
  /** Keyed hash of the normalised email address. */
  emailHash?: string | null;
  perIp: number;
  dailyCapMicros: number;
}

/**
 * Takes the sign-up credit lock (held until the transaction ends) and returns
 * the reason the credit must be withheld, or null when it may be granted. An
 * unknown network is never counted as a network of its own: only the daily cap
 * applies to it.
 */
export async function signupCreditSkipReason(
  tx: Executor,
  limits: SignupCreditLimits,
): Promise<SignupCreditSkip | null> {
  // One global lock: the daily cap spans every sign-up. Taken last in the
  // sign-up transaction, so it is held only briefly.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('recall:signup-credit'))`);
  if (limits.emailHash) {
    const [r] = await rows<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM signup_credit_grants
          WHERE email_hash = ${limits.emailHash} AND created_at > now() - ${EMAIL_RETENTION}`,
    );
    if ((r?.n ?? 0) > 0) return "email_limit";
  }
  if (limits.perIp > 0 && limits.ipHash) {
    const [r] = await rows<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM signup_credit_grants
          WHERE ip_hash = ${limits.ipHash}
            AND created_at > now() - ${sql.raw(`interval '${SIGNUP_IP_WINDOW_DAYS} days'`)}`,
    );
    if ((r?.n ?? 0) >= limits.perIp) return "ip_limit";
  }
  if (limits.dailyCapMicros > 0) {
    const [r] = await rows<{ micros: string | number }>(
      tx,
      sql`SELECT COALESCE(sum(amount_micros), 0) AS micros FROM signup_credit_grants
          WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    if (Number(r?.micros ?? 0) >= limits.dailyCapMicros) return "daily_cap";
  }
  return null;
}

/** Records a granted welcome credit (in the transaction that granted it). */
export async function recordSignupGrant(
  tx: Executor,
  ipHash: string | null,
  amountMicros: number,
  emailHash: string | null = null,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO signup_credit_grants (ip_hash, email_hash, amount_micros)
        VALUES (${ipHash}, ${emailHash}, ${amountMicros})`,
  );
}

/** Housekeeping: grants too old to count towards either limit. */
export async function purgeSignupGrants(db: Executor): Promise<void> {
  await db.execute(
    sql`DELETE FROM signup_credit_grants
        WHERE created_at < now() - ${RETENTION}
          AND (email_hash IS NULL OR created_at < now() - ${EMAIL_RETENTION})`,
  );
}
