import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { type Db, rows } from "../db/client.js";
import { compileFilters } from "../http/filters.js";
import { createdAtKeys, type Page, type Paging, paginate } from "../http/pagination.js";
import {
  PEER_COLS,
  type PeerRow,
  peerOut,
  SESSION_COLS,
  type SessionRow,
  sessionOut,
} from "../http/serialize.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../queue/enqueue.js";
import { lockSessionSummaries } from "../summaries/store.js";
import type { Obj } from "./configuration.js";
import { cardDiff, recordEvents } from "./history.js";
import { newName } from "./schemas.js";
import { type WsKey, wsIs } from "./tenancy.js";
import { ensureWorkspace } from "./workspaces.js";

type Executor = Pick<Db, "execute">;

export interface PeerRef {
  id: string;
  name: string;
  isScope: boolean;
  configuration: Obj;
}

const FROM_PEER = sql`FROM peers p JOIN workspaces w ON w.id = p.workspace_id`;

const nameList = (names: string[]) =>
  sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  );

export function scopeError(name: string) {
  return unprocessable(`Peer '${name}' is a scope. Use the scopes routes to manage scopes.`);
}

/** Throws a 422 when `name` is not acceptable as the name of a new peer. */
export function assertNewPeerName(name: string): void {
  const parsed = newName.safeParse(name);
  if (!parsed.success) {
    throw unprocessable(
      `Invalid peer id '${name}': ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
}

interface PeerLookup {
  id: string;
  name: string;
  is_scope: boolean;
  configuration: Obj | null;
}

const toRef = (r: PeerLookup): PeerRef => ({
  id: r.id,
  name: r.name,
  isScope: r.is_scope,
  configuration: r.configuration ?? {},
});

export async function findPeers(
  db: Executor,
  wsId: string,
  names: string[],
): Promise<Map<string, PeerRef>> {
  if (names.length === 0) return new Map();
  const found = await rows<PeerLookup>(
    db,
    sql`SELECT id, name, is_scope, configuration FROM peers
        WHERE workspace_id = ${wsId} AND name IN (${nameList(names)})`,
  );
  return new Map(found.map((r) => [r.name, toRef(r)]));
}

export async function findPeer(
  db: Executor,
  wsId: string,
  name: string,
): Promise<PeerRef | undefined> {
  return (await findPeers(db, wsId, [name])).get(name);
}

/**
 * Get-or-creates peers by name in one round trip per phase (no per-peer
 * queries). New names must be valid and unreserved (422); existing scope
 * peers are rejected unless `allowScopes` is set.
 */
export async function ensurePeers(
  db: Executor,
  wsId: string,
  names: string[],
  opts: { allowScopes?: boolean } = {},
): Promise<Map<string, PeerRef>> {
  const unique = [...new Set(names)];
  const found = await findPeers(db, wsId, unique);
  // Sorted so concurrent requests insert in the same order and cannot deadlock on each other.
  const missing = unique.filter((n) => !found.has(n)).sort();
  for (const name of missing) assertNewPeerName(name);
  if (missing.length > 0) {
    await db.execute(
      sql`INSERT INTO peers (id, workspace_id, name)
          VALUES ${sql.join(
            missing.map((n) => sql`(${newId()}, ${wsId}, ${n})`),
            sql`, `,
          )}
          ON CONFLICT (workspace_id, name) DO NOTHING`,
    );
    for (const [name, ref] of await findPeers(db, wsId, missing)) found.set(name, ref);
  }
  if (!opts.allowScopes) {
    for (const ref of found.values()) if (ref.isScope) throw scopeError(ref.name);
  }
  return found;
}

export async function selectPeerRow(
  db: Executor,
  wsId: string,
  name: string,
): Promise<PeerRow | undefined> {
  const [row] = await rows<PeerRow>(
    db,
    sql`SELECT ${PEER_COLS} ${FROM_PEER} WHERE p.workspace_id = ${wsId} AND p.name = ${name}`,
  );
  return row;
}

/**
 * POST /peers: unlike workspaces and sessions, when the peer exists a provided
 * (non-null) metadata or configuration replaces the stored value wholesale.
 */
export async function getOrCreatePeer(
  ctx: AppContext,
  workspace: WsKey,
  body: { id: string; metadata?: Obj | null; configuration?: Obj | null },
) {
  return ctx.db.transaction(async (tx) => {
    const { row: ws } = await ensureWorkspace(tx, workspace);
    let created = false;
    let peer = await selectPeerRow(tx, ws.internal_id, body.id);
    if (!peer) {
      const inserted = await rows<{ id: string }>(
        tx,
        sql`INSERT INTO peers (id, workspace_id, name, metadata, configuration)
            VALUES (${newId()}, ${ws.internal_id}, ${body.id}, ${JSON.stringify(body.metadata ?? {})}::jsonb,
                    ${JSON.stringify(body.configuration ?? {})}::jsonb)
            ON CONFLICT (workspace_id, name) DO NOTHING RETURNING id`,
      );
      created = inserted.length > 0;
      peer = await selectPeerRow(tx, ws.internal_id, body.id);
    } else if (body.metadata != null || body.configuration != null) {
      await tx.execute(
        sql`UPDATE peers SET
              metadata = COALESCE(${body.metadata == null ? null : JSON.stringify(body.metadata)}::jsonb, metadata),
              configuration = COALESCE(${body.configuration == null ? null : JSON.stringify(body.configuration)}::jsonb, configuration)
            WHERE id = ${peer.internal_id}`,
      );
      peer = await selectPeerRow(tx, ws.internal_id, body.id);
    }
    return { peer: peerOut(peer!), created };
  });
}

/** `GET /peers/{id}` (Recall extension): read without creating; 404 when missing, 422 for a scope. */
export async function getPeer(ctx: AppContext, workspace: WsKey, name: string) {
  const [row] = await rows<PeerRow>(
    ctx.db,
    sql`SELECT ${PEER_COLS} ${FROM_PEER} WHERE ${wsIs(workspace)} AND p.name = ${name}`,
  );
  if (!row) throw notFound(`Peer ${name}`);
  if (row.is_scope) throw scopeError(name);
  return peerOut(row);
}

/**
 * `DELETE /peers/{id}` (Recall extension; Honcho has no way to forget a person): erases the peer,
 * every message it wrote, its memberships, and every collection it observes or is observed in
 * (their conclusions and peer cards, including scopes' memory of it). Summaries of the sessions it
 * wrote in quote it, so they are dropped and rebuilt from the remaining messages. Facts about
 * other peers that merely mention it are kept. Returns what was removed.
 */
export async function deletePeer(ctx: AppContext, workspace: WsKey, name: string) {
  return ctx.db.transaction(async (tx) => {
    const [peer] = await rows<{ id: string; is_scope: boolean; workspace_id: string }>(
      tx,
      sql`SELECT p.id, p.is_scope, p.workspace_id ${FROM_PEER} WHERE ${wsIs(workspace)} AND p.name = ${name}
          FOR UPDATE OF p`,
    );
    if (!peer) throw notFound(`Peer ${name}`);
    if (peer.is_scope) throw scopeError(name);
    const [counts] = await rows<{ messages: number; conclusions: number }>(
      tx,
      sql`SELECT (SELECT count(*)::int FROM messages WHERE peer_id = ${peer.id}) AS messages,
                 (SELECT count(*)::int FROM conclusions
                   WHERE (observer_id = ${peer.id} OR observed_id = ${peer.id}) AND deleted_at IS NULL) AS conclusions`,
    );
    const sessions = await rows<{ session_id: string }>(
      tx,
      sql`SELECT DISTINCT session_id FROM messages WHERE peer_id = ${peer.id}`,
    );
    // Pending dreams of its collections would find nothing; drop them.
    await tx.execute(
      sql`DELETE FROM jobs WHERE workspace_id = ${peer.workspace_id} AND kind = 'dream' AND status = 'pending'
          AND (payload->>'observer_id' = ${peer.id} OR payload->>'observed_id' = ${peer.id})`,
    );
    // Messages, memberships, collections and their conclusions go with the peer (ON DELETE CASCADE).
    await tx.execute(sql`DELETE FROM peers WHERE id = ${peer.id}`);
    for (const { session_id } of sessions) {
      // Waits for a summary write in flight, so its result is dropped here, not left behind.
      await lockSessionSummaries(tx, session_id);
      await tx.execute(sql`DELETE FROM summary_blocks WHERE session_id = ${session_id}`);
      await enqueue(tx, {
        kind: "summarize",
        workKey: `summarize:${session_id}`,
        workspaceId: peer.workspace_id,
        sessionId: session_id,
      });
    }
    return {
      peer_id: name,
      deleted: true,
      messages_deleted: Number(counts?.messages ?? 0),
      conclusions_deleted: Number(counts?.conclusions ?? 0),
      sessions_affected: sessions.length,
    };
  });
}

/** PUT /peers/{id}: creates the peer if missing; configuration replaces wholesale (no merge). */
export async function updatePeer(
  ctx: AppContext,
  workspace: WsKey,
  name: string,
  body: { metadata?: Obj | null; configuration?: Obj | null },
) {
  return ctx.db.transaction(async (tx) => {
    const { row: ws } = await ensureWorkspace(tx, workspace);
    let peer = await selectPeerRow(tx, ws.internal_id, name);
    if (!peer) {
      assertNewPeerName(name);
      await tx.execute(
        sql`INSERT INTO peers (id, workspace_id, name) VALUES (${newId()}, ${ws.internal_id}, ${name})
            ON CONFLICT (workspace_id, name) DO NOTHING`,
      );
      peer = await selectPeerRow(tx, ws.internal_id, name);
    }
    if (peer!.is_scope) throw scopeError(name);
    if (body.metadata != null || body.configuration != null) {
      await tx.execute(
        sql`UPDATE peers SET
              metadata = COALESCE(${body.metadata == null ? null : JSON.stringify(body.metadata)}::jsonb, metadata),
              configuration = COALESCE(${body.configuration == null ? null : JSON.stringify(body.configuration)}::jsonb, configuration)
            WHERE id = ${peer!.internal_id}`,
      );
      peer = await selectPeerRow(tx, ws.internal_id, name);
    }
    return peerOut(peer!);
  });
}

export async function listPeers(
  ctx: AppContext,
  workspace: WsKey,
  paging: Paging,
  body: { filters?: Record<string, unknown> | null; kind?: "scope" | "all" | null },
): Promise<Page<ReturnType<typeof peerOut>>> {
  const kind = body.kind ?? null;
  const where: (SQL | undefined)[] = [
    sql`${wsIs(workspace)}`,
    kind === "scope" ? sql`p.is_scope` : kind === "all" ? undefined : sql`NOT p.is_scope`,
    compileFilters("peers", body.filters),
  ];
  return paginate(ctx.db, paging, {
    select: PEER_COLS,
    from: FROM_PEER,
    where,
    keys: createdAtKeys(sql`p.created_at`, sql`p.id`),
    map: (r) => peerOut(r as unknown as PeerRow),
  });
}

/** Sessions a peer has a membership row for, including departed memberships and sessions pending deletion. */
export async function listPeerSessions(
  ctx: AppContext,
  workspace: WsKey,
  peer: string,
  paging: Paging,
  filters: Record<string, unknown> | null | undefined,
): Promise<Page<ReturnType<typeof sessionOut>>> {
  const where: (SQL | undefined)[] = [
    sql`${wsIs(workspace)}`,
    sql`EXISTS (SELECT 1 FROM session_peers sp JOIN peers pp ON pp.id = sp.peer_id
                WHERE sp.session_id = s.id AND pp.name = ${peer} AND pp.workspace_id = s.workspace_id)`,
    compileFilters("sessions", filters),
  ];
  return paginate(ctx.db, paging, {
    select: SESSION_COLS,
    from: sql`FROM sessions s JOIN workspaces w ON w.id = s.workspace_id`,
    where,
    keys: createdAtKeys(sql`s.created_at`, sql`s.id`),
    map: (r) => sessionOut(r as unknown as SessionRow),
  });
}

// ---------------------------------------------------------------------------
// Collections and peer cards

/** Get-or-creates several collections in one statement. Keys are `${observerId}\u0000${observedId}`. */
export async function ensureCollections(
  db: Executor,
  wsId: string,
  pairs: { observerId: string; observedId: string }[],
): Promise<Map<string, string>> {
  const unique = [
    ...new Map(pairs.map((p) => [`${p.observerId}\u0000${p.observedId}`, p])).values(),
  ];
  if (unique.length === 0) return new Map();
  const found = await rows<{ id: string; observer_id: string; observed_id: string }>(
    db,
    sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id)
        VALUES ${sql.join(
          unique.map((p) => sql`(${newId()}, ${wsId}, ${p.observerId}, ${p.observedId})`),
          sql`, `,
        )}
        ON CONFLICT (observer_id, observed_id) DO UPDATE SET observer_id = EXCLUDED.observer_id
        RETURNING id, observer_id, observed_id`,
  );
  return new Map(found.map((r) => [`${r.observer_id}\u0000${r.observed_id}`, r.id]));
}

export async function getPeerCard(
  ctx: AppContext,
  workspace: WsKey,
  peerName: string,
  target: string | undefined,
): Promise<string[] | null> {
  const [peer] = await rows<{ id: string; workspace_id: string }>(
    ctx.db,
    sql`SELECT p.id, p.workspace_id ${FROM_PEER} WHERE ${wsIs(workspace)} AND p.name = ${peerName}`,
  );
  if (!peer) throw notFound(`Peer ${peerName}`);
  let observedId = peer.id;
  if (target && target !== peerName) {
    const found = await findPeer(ctx.db, peer.workspace_id, target);
    if (!found) return null;
    observedId = found.id;
  }
  const [card] = await rows<{ peer_card: string[]; card_updated_at: Date | null }>(
    ctx.db,
    sql`SELECT peer_card, card_updated_at FROM collections
        WHERE observer_id = ${peer.id} AND observed_id = ${observedId}`,
  );
  if (!card) return null;
  const entries = Array.isArray(card.peer_card) ? card.peer_card : [];
  return entries.length === 0 && !card.card_updated_at ? null : entries;
}

/** Replaces the card wholesale. Creates the workspace and observer (and the target peer, which the collection needs). */
export async function setPeerCard(
  ctx: AppContext,
  workspace: WsKey,
  peerName: string,
  target: string | undefined,
  card: string[],
  by: { actor: "api" | "dashboard"; ref?: string | null; reason?: string } = { actor: "api" },
): Promise<string[]> {
  return ctx.db.transaction(async (tx) => {
    const { row: ws } = await ensureWorkspace(tx, workspace);
    const names = target && target !== peerName ? [peerName, target] : [peerName];
    const peers = await ensurePeers(tx, ws.internal_id, names);
    const observer = peers.get(peerName)!;
    const observed = peers.get(target && target !== peerName ? target : peerName)!;
    const [was] = await rows<{ peer_card: string[] }>(
      tx,
      sql`SELECT peer_card FROM collections WHERE observer_id = ${observer.id} AND observed_id = ${observed.id}
          FOR UPDATE`,
    );
    const [col] = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id, peer_card, card_updated_at, version)
          VALUES (${newId()}, ${ws.internal_id}, ${observer.id}, ${observed.id}, ${JSON.stringify(card)}::jsonb, now(), 1)
          ON CONFLICT (observer_id, observed_id) DO UPDATE SET
            peer_card = EXCLUDED.peer_card, card_updated_at = now(), card_blocked = NULL,
            version = collections.version + 1
          RETURNING id`,
    );
    const diff = cardDiff(Array.isArray(was?.peer_card) ? was.peer_card : [], card);
    if (col && (diff.added.length || diff.removed.length))
      await recordEvents(tx, [
        {
          workspaceId: ws.internal_id,
          collectionId: col.id,
          conclusionId: null,
          action: "card",
          actor: by.actor,
          actorRef: by.ref ?? null,
          reason: by.reason ?? "set the card",
          before: diff.removed,
          after: diff.added,
        },
      ]);
    return card;
  });
}
