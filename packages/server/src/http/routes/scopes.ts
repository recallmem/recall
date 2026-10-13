import type { Context } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { metadata, scopeName } from "../../core/schemas.js";
import {
  addSessionsToScope,
  getOrCreateScope,
  getScope,
  getScopeStatus,
  listScopeSessions,
  listScopes,
  removeSessionFromScope,
} from "../../core/scopes.js";
import { unauthorized } from "../../lib/errors.js";
import type { App } from "../app.js";
import { type AppEnv, guard, wsOf } from "../auth.js";
import { CREATED_KEY_TYPES, readPaging } from "../pagination.js";
import { parseBody } from "../validate.js";

const ScopeCreate = z.object({ id: scopeName, metadata: metadata.nullish() });
const ScopeSessionsAdd = z.object({ session_ids: z.array(z.string().min(1)).min(1).max(100) });

/**
 * All scope routes need a workspace or admin token. The guard already denies
 * peer and session tokens on routes without a matching path parameter; the
 * explicit check also covers the one route that has a `{session_id}`.
 */
const workspaceLevel = (c: Context<AppEnv>) => {
  const { admin, claims } = c.get("auth");
  if (!admin && (claims.s || claims.p)) throw unauthorized();
};

export function register(app: App, ctx: AppContext): void {
  app.post("/v3/workspaces/:workspace_id/scopes", guard(ctx), async (c) => {
    const body = await parseBody(c, ScopeCreate);
    const { scope, created } = await getOrCreateScope(ctx, wsOf(c), body);
    return c.json(scope, created ? 201 : 200);
  });

  app.post("/v3/workspaces/:workspace_id/scopes/list", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const paging = readPaging(c, {
      fingerprint: ["scopes", workspace],
      keyTypes: CREATED_KEY_TYPES,
    });
    return c.json(await listScopes(ctx, workspace, paging));
  });

  app.get("/v3/workspaces/:workspace_id/scopes/:scope_id", guard(ctx), async (c) => {
    return c.json(await getScope(ctx, wsOf(c), c.req.param("scope_id")));
  });

  app.post("/v3/workspaces/:workspace_id/scopes/:scope_id/sessions", guard(ctx), async (c) => {
    const body = await parseBody(c, ScopeSessionsAdd);
    await addSessionsToScope(ctx, wsOf(c), c.req.param("scope_id"), body.session_ids);
    return c.body(null, 204);
  });

  app.delete(
    "/v3/workspaces/:workspace_id/scopes/:scope_id/sessions/:session_id",
    guard(ctx),
    async (c) => {
      workspaceLevel(c);
      await removeSessionFromScope(
        ctx,
        wsOf(c),
        c.req.param("scope_id"),
        c.req.param("session_id"),
      );
      return c.body(null, 204);
    },
  );

  app.post("/v3/workspaces/:workspace_id/scopes/:scope_id/sessions/list", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const scope = c.req.param("scope_id");
    const paging = readPaging(c, {
      fingerprint: ["scope-sessions", workspace, scope],
      keyTypes: CREATED_KEY_TYPES,
    });
    return c.json(await listScopeSessions(ctx, workspace, scope, paging));
  });

  app.get("/v3/workspaces/:workspace_id/scopes/:scope_id/status", guard(ctx), async (c) => {
    return c.json(await getScopeStatus(ctx, wsOf(c), c.req.param("scope_id")));
  });
}
