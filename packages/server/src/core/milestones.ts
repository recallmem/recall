import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * First-time marks on an account for the operator's activation funnel (src/core/funnel.ts,
 * 0018_activation_funnel.sql): when it first stored a message and first connected an app over
 * OAuth. Other tables cannot give these back (messages can be deleted and carry a client-set
 * created_at; OAuth grants are purged once they lapse). Each mark is a time only and is set once,
 * in the transaction that stores the messages or creates the grant.
 *
 * Setting a mark is one conditional UPDATE that matches no row once the mark is set, so it takes
 * no lock after the first time. Accounts known to be marked are remembered per database handle,
 * so the message path skips even that statement after the first batch.
 */

type Executor = Pick<Db, "execute">;

/** Accounts whose first-message mark is known to be set, per database handle. */
const messageMarked = new WeakMap<object, Set<string>>();
/** Bounds the memory of a long-running process; forgetting only costs one cheap statement. */
const MAX_REMEMBERED = 50_000;

/** True when `accountId`'s first-message mark is known to be set (nothing to do). */
export function firstMessageKnown(db: object, accountId: string): boolean {
  return messageMarked.get(db)?.has(accountId) ?? false;
}

/** Remembers that `accountId`'s first-message mark is set; call after the transaction commits. */
export function rememberFirstMessage(db: object, accountId: string): void {
  let set = messageMarked.get(db);
  if (!set) {
    set = new Set();
    messageMarked.set(db, set);
  }
  if (set.size >= MAX_REMEMBERED) set.clear();
  set.add(accountId);
}

/** Sets the account's first-message time unless it is set already (in the caller's transaction). */
export async function markFirstMessage(tx: Executor, accountId: string): Promise<void> {
  await tx.execute(
    sql`UPDATE accounts SET first_message_at = now()
        WHERE id = ${accountId} AND first_message_at IS NULL`,
  );
}

/** Sets the account's first-app time unless it is set already (in the caller's transaction). */
export async function markFirstApp(tx: Executor, accountId: string): Promise<void> {
  await tx.execute(
    sql`UPDATE accounts SET first_app_at = now() WHERE id = ${accountId} AND first_app_at IS NULL`,
  );
}
