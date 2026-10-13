import type { AppContext } from "../context.js";
import { type AccountOut, setAccountSuspension } from "./accounts.js";

/**
 * Operator suspension of an account, from the console or the admin API. The flag
 * lives on the account row; credentials are checked against it where they are
 * resolved (ApiKeyVerifier.verify, OAuthTokenVerifier.verify, loadSession), so
 * this process's cached keys and tokens of the account are dropped here and other
 * processes see the change within RECALL_KEY_CACHE_TTL_MS.
 */
export async function suspendAccount(
  ctx: AppContext,
  accountId: string,
  reason: string,
): Promise<AccountOut> {
  const account = await setAccountSuspension(ctx.db, accountId, reason);
  forget(ctx, accountId);
  return account;
}

export async function unsuspendAccount(ctx: AppContext, accountId: string): Promise<AccountOut> {
  const account = await setAccountSuspension(ctx.db, accountId, null);
  forget(ctx, accountId);
  return account;
}

function forget(ctx: AppContext, accountId: string): void {
  ctx.tenancy.keys.forgetAccount(accountId);
  ctx.tenancy.oauth.forgetAccount(accountId);
}
