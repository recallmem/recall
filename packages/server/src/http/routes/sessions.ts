import { z } from "zod";
import type { AppContext } from "../../context.js";
import {
  configuration,
  metadata,
  newName,
  peersMap,
  scopeName,
  sessionPeerConfig,
} from "../../core/schemas.js";
import {
  addSessionPeers,
  cloneSession,
  deleteSession,
  getMemberConfig,
  getOrCreateSession,
  getSession,
  listSessionPeers,
  listSessions,
  peekSession,
  removeSessionPeers,
  setMemberConfig,
  setSessionPeers,
  updateSession,
} from "../../core/sessions.js";
import { unauthorized } from "../../lib/errors.js";
import type { App } from "../app.js";
import { guard, wsOf } from "../auth.js";
import { FiltersBody, optionalBody } from "../common.js";
import { CREATED_KEY_TYPES, readPaging } from "../pagination.js";
import { parseBody } from "../validate.js";

const SessionCreate = z.object({
  id: newName,
  metadata: metadata.nullish(),
  peers: peersMap.nullish(),
  configuration: configuration.nullish(),
  scopes: z.array(scopeName).max(100).nullish(),
});

const SessionUpdate = z.object({
  metadata: metadata.nullish(),
  configuration: configuration.nullish(),
});

export function register(app: App, ctx: AppContext): void {
  app.post("/v3/workspaces/:workspace_id/sessions/list", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const body = await optionalBody(c, FiltersBody);
    const paging = readPaging(c, {
      fingerprint: ["sessions", workspace, body?.filters ?? null],
      keyTypes: CREATED_KEY_TYPES,
    });
    return c.json(await listSessions(ctx, workspace, paging, body?.filters));
  });

  // Self-authorizing: the session id is in the body, so the handler compares claims with it.
  app.post(
    "/v3/workspaces/:workspace_id/sessions",
    guard(ctx, { selfAuthorizing: true }),
    async (c) => {
      const workspace = wsOf(c);
      const body = await parseBody(c, SessionCreate);
      const { admin, claims } = c.get("auth");
      if (!admin) {
        if (claims.w !== workspace.name) throw unauthorized("Unauthorized access to resource");
        const hasScopes = (body.scopes?.length ?? 0) > 0;
        if (claims.s) {
          if (claims.s !== body.id) throw unauthorized("Unauthorized access to resource");
          if (hasScopes) throw unauthorized("Scope membership requires a workspace-level key");
        } else if (claims.p) {
          if (hasScopes) throw unauthorized("Scope membership requires a workspace-level key");
          if (Object.keys(body.peers ?? {}).some((peer) => peer !== claims.p)) {
            throw unauthorized("Unauthorized access to resource");
          }
          const existing = await peekSession(ctx.db, workspace, body.id, claims.p);
          if (existing.exists) {
            if (!existing.activeMember) throw unauthorized();
            if (body.metadata != null || body.configuration != null) {
              throw unauthorized("Peer-scoped keys cannot modify an existing session");
            }
          }
        }
      }
      const { session, created } = await getOrCreateSession(ctx, workspace, body);
      return c.json(session, created ? 201 : 200);
    },
  );

  // Recall extension: a read with no side effects (POST /sessions creates on a typo). Member-read.
  app.get(
    "/v3/workspaces/:workspace_id/sessions/:session_id",
    guard(ctx, { memberRead: true }),
    async (c) => c.json(await getSession(ctx, wsOf(c), c.req.param("session_id"))),
  );

  app.put("/v3/workspaces/:workspace_id/sessions/:session_id", guard(ctx), async (c) => {
    const body = await parseBody(c, SessionUpdate);
    return c.json(await updateSession(ctx, wsOf(c), c.req.param("session_id"), body));
  });

  app.delete("/v3/workspaces/:workspace_id/sessions/:session_id", guard(ctx), async (c) => {
    await deleteSession(ctx, wsOf(c), c.req.param("session_id"));
    return c.json({ message: "Session deleted successfully" }, 202);
  });

  app.post("/v3/workspaces/:workspace_id/sessions/:session_id/clone", guard(ctx), async (c) => {
    const messageId = c.req.query("message_id") || undefined;
    const session = await cloneSession(ctx, wsOf(c), c.req.param("session_id"), messageId);
    return c.json(session, 201);
  });

  // --- membership ---------------------------------------------------------

  app.post("/v3/workspaces/:workspace_id/sessions/:session_id/peers", guard(ctx), async (c) => {
    const peers = await parseBody(c, peersMap);
    return c.json(await addSessionPeers(ctx, wsOf(c), c.req.param("session_id"), peers));
  });

  app.put("/v3/workspaces/:workspace_id/sessions/:session_id/peers", guard(ctx), async (c) => {
    const peers = await parseBody(c, peersMap);
    return c.json(await setSessionPeers(ctx, wsOf(c), c.req.param("session_id"), peers));
  });

  app.delete("/v3/workspaces/:workspace_id/sessions/:session_id/peers", guard(ctx), async (c) => {
    const peers = await parseBody(c, z.array(z.string().min(1)));
    return c.json(await removeSessionPeers(ctx, wsOf(c), c.req.param("session_id"), peers));
  });

  app.get(
    "/v3/workspaces/:workspace_id/sessions/:session_id/peers",
    guard(ctx, { memberRead: true }),
    async (c) => {
      const workspace = wsOf(c);
      const session = c.req.param("session_id");
      const paging = readPaging(c, {
        fingerprint: ["session-peers", workspace, session],
        keyTypes: CREATED_KEY_TYPES,
        reverse: false,
      });
      return c.json(await listSessionPeers(ctx, workspace, session, paging));
    },
  );

  app.get(
    "/v3/workspaces/:workspace_id/sessions/:session_id/peers/:peer_id/config",
    guard(ctx, { memberRead: true }),
    async (c) => {
      const workspace = wsOf(c);
      const session = c.req.param("session_id");
      const peer = c.req.param("peer_id");
      const { claims, admin } = c.get("auth");
      // A peer token reads only its own config, and only as an active member of the session.
      if (!admin && !claims.s && claims.p) {
        if (
          claims.p !== peer ||
          !(await peekSession(ctx.db, workspace, session, claims.p)).activeMember
        ) {
          throw unauthorized();
        }
      }
      return c.json(await getMemberConfig(ctx, workspace, session, peer));
    },
  );

  app.put(
    "/v3/workspaces/:workspace_id/sessions/:session_id/peers/:peer_id/config",
    guard(ctx),
    async (c) => {
      const { claims, admin } = c.get("auth");
      // Workspace and session tokens only: a peer token cannot set even its own config.
      if (!admin && !claims.s && claims.p) throw unauthorized();
      const config = await parseBody(c, sessionPeerConfig);
      await setMemberConfig(
        ctx,
        wsOf(c),
        c.req.param("session_id"),
        c.req.param("peer_id"),
        config,
      );
      return c.body(null, 204);
    },
  );
}
