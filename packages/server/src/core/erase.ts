import { sql } from "drizzle-orm";
import { getBillingRow } from "../billing/ledger.js";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { deleteAccount } from "./accounts.js";
import { deleteOrphanUsers } from "./users.js";

/**
 * GDPR erasure of an account: all its data (deleteAccount), its sign-in
 * identities that belong to no other account, cached keys and verdicts, and
 * (best effort) its Stripe customer.
 */
export async function eraseAccount(ctx: AppContext, accountId: string): Promise<void> {
  const billing = await getBillingRow(ctx.db, accountId);
  const members = await rows<{ user_id: string }>(
    ctx.db,
    sql`SELECT user_id FROM account_members WHERE account_id = ${accountId}`,
  );
  // Usage still buffered for this account is written first, so it is erased with the rest
  // instead of landing after the delete (llm_usage has no foreign key to cascade through).
  await ctx.usage.flush();
  await deleteAccount(ctx.db, accountId);
  await ctx.db.execute(sql`DELETE FROM llm_usage WHERE account_id = ${accountId}`);
  await deleteOrphanUsers(
    ctx.db,
    members.map((m) => m.user_id),
  );
  ctx.tenancy.keys.forgetAccount(accountId);
  ctx.tenancy.oauth.forgetAccount(accountId);
  ctx.tenancy.budget.invalidate(accountId);
  await ctx.billing.deleteCustomer(billing?.stripe_customer_id ?? null);
}
