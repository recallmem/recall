import { z } from "zod";
import type { AppContext } from "../../context.js";
import { createApiKey } from "../../core/apikeys.js";
import { mintKey } from "../../core/keys.js";
import { datetimeInput } from "../../core/schemas.js";
import { unauthorized, unprocessable } from "../../lib/errors.js";
import type { App } from "../app.js";
import { type AuthState, guard } from "../auth.js";
import { parseQuery } from "../validate.js";

const KeyQuery = z.looseObject({
  workspace_id: z.string().optional(),
  peer_id: z.string().optional(),
  session_id: z.string().optional(),
  expires_at: datetimeInput.optional(),
});

type KeyQuery = z.infer<typeof KeyQuery>;

/**
 * POST /v3/keys for one caller. A Honcho JWT (or an open server) mints a JWT, as
 * Honcho does; in hosted mode an account-admin API key mints a scoped API key
 * of its own account, so Honcho SDKs' key minting keeps working. Admin keys are
 * never minted. Any other credential (a dashboard session, an OAuth token, or
 * whatever is added later) is refused: a JWT is signed with the server's secret
 * and names the default account, so minting one for such a caller would hand
 * it a key outside its own account.
 */
export async function mintForCaller(
  ctx: AppContext,
  auth: AuthState,
  q: KeyQuery,
): Promise<{ key: string }> {
  if (auth.via === "jwt" || auth.via === "open") return mintKey(ctx, q);
  if (auth.via !== "api_key") throw unauthorized("This credential cannot create keys");
  const workspace = q.workspace_id || undefined;
  const peer = q.peer_id || undefined;
  const session = q.session_id || undefined;
  if (!workspace && !peer && !session) {
    throw unprocessable("At least one of workspace_id, peer_id, or session_id must be provided");
  }
  const { key } = await createApiKey(ctx.db, {
    accountId: auth.account,
    name: "minted via POST /v3/keys",
    mode: auth.keyMode ?? "live",
    workspace,
    peer,
    session,
    expiresAt: q.expires_at ?? null,
    mintedBy: auth.keyId ?? null,
  });
  return { key };
}

export function register(app: App, ctx: AppContext): void {
  app.post("/v3/keys", guard(ctx, { admin: true }), async (c) =>
    c.json(await mintForCaller(ctx, c.get("auth"), parseQuery(c, KeyQuery))),
  );
}
