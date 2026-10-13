import { z } from "zod";
import type { AppContext } from "../../context.js";
import {
  deletePeer,
  getOrCreatePeer,
  getPeer,
  getPeerCard,
  listPeerSessions,
  listPeers,
  setPeerCard,
  updatePeer,
} from "../../core/peers.js";
import { metadata, newName } from "../../core/schemas.js";
import { unauthorized } from "../../lib/errors.js";
import { answerCache } from "../../recall/cache.js";
import type { App } from "../app.js";
import { guard, wsOf } from "../auth.js";
import { FiltersBody, optionalBody } from "../common.js";
import { CREATED_KEY_TYPES, readPaging } from "../pagination.js";
import { parseBody } from "../validate.js";

const config = z.record(z.string(), z.unknown());

const PeerCreate = z.object({
  id: newName,
  metadata: metadata.nullish(),
  configuration: config.nullish(),
});

const PeerUpdate = z.object({
  metadata: metadata.nullish(),
  configuration: config.nullish(),
});

const PeerGet = z.object({
  filters: z.record(z.string(), z.unknown()).nullish(),
  kind: z.enum(["scope", "all"]).nullish(),
});

const PeerCardSet = z.object({
  // Bounded on purpose: the reference accepts unbounded cards.
  peer_card: z.array(z.string().max(4000)).max(500),
});

const targetOf = (c: { req: { query(name: string): string | undefined } }) =>
  c.req.query("target") || undefined;

export function register(app: App, ctx: AppContext): void {
  app.post("/v3/workspaces/:workspace_id/peers/list", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const body = (await optionalBody(c, PeerGet)) ?? {};
    const paging = readPaging(c, {
      fingerprint: ["peers", workspace, body.kind ?? null, body.filters ?? null],
      keyTypes: CREATED_KEY_TYPES,
    });
    return c.json(await listPeers(ctx, workspace, paging, body));
  });

  // Self-authorizing: the peer id is in the body.
  app.post(
    "/v3/workspaces/:workspace_id/peers",
    guard(ctx, { selfAuthorizing: true }),
    async (c) => {
      const workspace = wsOf(c);
      const body = await parseBody(c, PeerCreate);
      const { admin, claims } = c.get("auth");
      if (
        !admin &&
        (claims.w !== workspace.name || claims.s || (claims.p && claims.p !== body.id))
      ) {
        throw unauthorized("Unauthorized access to resource");
      }
      const { peer, created } = await getOrCreatePeer(ctx, workspace, body);
      return c.json(peer, created ? 201 : 200);
    },
  );

  // Recall extension: a read with no side effects (POST /peers creates on a typo).
  app.get("/v3/workspaces/:workspace_id/peers/:peer_id", guard(ctx), async (c) => {
    return c.json(await getPeer(ctx, wsOf(c), c.req.param("peer_id")));
  });

  // Recall extension: erase a peer and what was learned from and about it (workspace or admin token).
  app.delete("/v3/workspaces/:workspace_id/peers/:peer_id", guard(ctx), async (c) => {
    const { admin, claims } = c.get("auth");
    if (!admin && (claims.p || claims.s)) throw unauthorized();
    const result = await deletePeer(ctx, wsOf(c), c.req.param("peer_id"));
    // Cached answers may quote the peer; they are cheap to recompute.
    answerCache(ctx).clear();
    return c.json(result);
  });

  app.put("/v3/workspaces/:workspace_id/peers/:peer_id", guard(ctx), async (c) => {
    const body = await parseBody(c, PeerUpdate);
    return c.json(await updatePeer(ctx, wsOf(c), c.req.param("peer_id"), body));
  });

  app.post("/v3/workspaces/:workspace_id/peers/:peer_id/sessions", guard(ctx), async (c) => {
    const workspace = wsOf(c);
    const peer = c.req.param("peer_id");
    const body = await optionalBody(c, FiltersBody);
    const paging = readPaging(c, {
      fingerprint: ["peer-sessions", workspace, peer, body?.filters ?? null],
      keyTypes: CREATED_KEY_TYPES,
    });
    return c.json(await listPeerSessions(ctx, workspace, peer, paging, body?.filters));
  });

  app.get("/v3/workspaces/:workspace_id/peers/:peer_id/card", guard(ctx), async (c) => {
    const card = await getPeerCard(ctx, wsOf(c), c.req.param("peer_id"), targetOf(c));
    return c.json({ peer_card: card });
  });

  app.put("/v3/workspaces/:workspace_id/peers/:peer_id/card", guard(ctx), async (c) => {
    const body = await parseBody(c, PeerCardSet);
    const card = await setPeerCard(
      ctx,
      wsOf(c),
      c.req.param("peer_id"),
      targetOf(c),
      body.peer_card,
    );
    return c.json({ peer_card: card });
  });
}
