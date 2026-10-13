import type { AppContext } from "../context.js";
import { signToken } from "../http/auth.js";
import { ApiError, unprocessable } from "../lib/errors.js";

/**
 * Mints a scoped HS256 JWT (spec 01 section 3.9.1). Tokens are stateless and
 * the named resources are not checked for existence. Admin keys are never minted.
 */
export function mintKey(
  ctx: AppContext,
  q: { workspace_id?: string; peer_id?: string; session_id?: string; expires_at?: Date },
): { key: string } {
  if (!ctx.config.auth.enabled || !ctx.config.auth.secret)
    throw new ApiError(405, "Feature is disabled");
  const workspace = q.workspace_id || undefined;
  const peer = q.peer_id || undefined;
  const session = q.session_id || undefined;
  if (!workspace && !peer && !session) {
    throw unprocessable("At least one of workspace_id, peer_id, or session_id must be provided");
  }
  if ((peer || session) && !workspace) {
    throw unprocessable("workspace_id is required when scoping a key to a peer or session");
  }
  const key = signToken(
    {
      t: new Date().toISOString(),
      ...(q.expires_at ? { exp: Math.floor(q.expires_at.getTime() / 1000) } : {}),
      ...(workspace ? { w: workspace } : {}),
      ...(peer ? { p: peer } : {}),
      ...(session ? { s: session } : {}),
    },
    ctx.config.auth.secret,
  );
  return { key };
}
