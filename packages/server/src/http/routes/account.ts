import { z } from "zod";
import type { AppContext } from "../../context.js";
import { accountUsage, getAccount } from "../../core/accounts.js";
import { datetimeInput } from "../../core/schemas.js";
import type { App } from "../app.js";
import { guard } from "../auth.js";
import { customerUsage } from "../redact.js";
import { parseQuery } from "../validate.js";

/**
 * Account-level routes for customers (Recall extensions), account-admin keys only:
 *
 *   GET /v3/usage     model calls and tokens across all workspaces of the caller's account,
 *                     by workspace and by task, plus the monthly budget status; provider cost
 *                     on a self-hosted server, and on a billed account of the hosted service
 *                     what it was charged (`billed`, also per workspace) with the billable units
 *                     (default period: the current UTC month; `since`/`until` override)
 *   GET /v3/account   the account itself, including its webhook signing secret
 */

const UsageQuery = z.object({
  since: datetimeInput.optional(),
  until: datetimeInput.optional(),
});

export function register(app: App, ctx: AppContext): void {
  app.get("/v3/usage", guard(ctx, { admin: true }), async (c) => {
    const q = parseQuery(c, UsageQuery);
    await ctx.usage.flush();
    return c.json(customerUsage(ctx, await accountUsage(ctx.db, c.get("auth").account, q)));
  });

  // Customer-facing fields only: the operator's notes on the account stay on /admin/v1.
  app.get("/v3/account", guard(ctx, { admin: true }), async (c) =>
    c.json(await getAccount(ctx.db, c.get("auth").account, { secrets: true, customer: true })),
  );
}
