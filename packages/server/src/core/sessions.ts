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
  type WorkspaceRow,
} from "../http/serialize.js";
import { badRequest, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../queue/enqueue.js";
import { scheduleMessageProcessing } from "../reasoner/schedule.js";
import { dropNulls, mergeConfiguration, type Obj } from "./configuration.js";
import {
  countObservers,
  leaveMembers,
  leaveMembersExcept,
  MAX_OBSERVERS,
  type MemberConfig,
  memberConfigJson,
  observerLimitError,
  upsertMembers,
} from "./members.js";
import { ensurePeers, findPeer, scopeError } from "./peers.js";
import { attachSessionToScopes, ensureScopes } from "./scopes.js";
import { type WsKey, wsIs } from "./tenancy.js";
import { ensureWorkspace } from "./workspaces.js";

type Executor = Pick<Db, "execute">;

const FROM_SESSION = sql`FROM sessions s JOIN workspaces w ON w.id = s.workspace_id`;

export async function selectSessionRow(
  db: Executor,
  wsId: string,
  name: string,
): Promise<SessionRow | undefined> {
  const [row] = await rows<SessionRow>(
    db,
    sql`SELECT ${SESSION_COLS} ${FROM_SESSION} WHERE s.workspace_id = ${wsId} AND s.name = ${name}`,
  );
  return row;
}

/** Active session by names, or undefined (inactive sessions count as missing). */
export async function findActiveSession(db: Executor, workspace: WsKey, name: string) {
  const [row] = await rows<SessionRow>(
    db,
    sql`SELECT ${SESSION_COLS} ${FROM_SESSION} WHERE ${wsIs(workspace)} AND s.name = ${name} AND s.is_active`,
  );
  return row;
}

export async function requireActiveSession(db: Executor, workspace: WsKey, name: string) {
  const row = await findActiveSession(db, workspace, name);
  if (!row) throw notFound(`Session ${name}`);
  return row;
}

/** What a peer-scoped token needs to know about an existing session before it may touch it. */
export async function peekSession(
  db: Executor,
  workspace: WsKey,
  session: string,
  peer: string,
): Promise<{ exists: boolean; activeMember: boolean }> {
  const [row] = await rows<{ member: boolean }>(
    db,
    sql`SELECT EXISTS (SELECT 1 FROM session_peers sp JOIN peers p ON p.id = sp.peer_id
                       WHERE sp.session_id = s.id AND p.name = ${peer} AND sp.left_at IS NULL) AS member
        ${FROM_SESSION} WHERE ${wsIs(workspace)} AND s.name = ${session} AND s.is_active`,
  );
  return { exists: !!row, activeMember: !!row?.member };
}

export interface UpsertSessionArgs {
  name: string;
  metadata?: Obj | null;
  configuration?: Obj | null;
  peers?: Record<string, MemberConfig> | null;
  scopes?: string[] | null;
  /** "add": existing active members keep their config. "set": the map replaces the regular membership. */
  peerMode?: "add" | "set";
  /** Fail with 404 instead of creating the session. */
  requireExisting?: boolean;
}

/**
 * The single get-or-create/upsert path for sessions: used by POST /sessions,
 * PUT /sessions/{id}, add/set peers and message creation. Runs inside the
 * caller's transaction.
 */
export async function upsertSession(
  tx: Db,
  ws: WorkspaceRow,
  args: UpsertSessionArgs,
): Promise<{ session: SessionRow; created: boolean }> {
  const peerEntries = Object.entries(args.peers ?? {});
  const requestedObservers = peerEntries.filter(([, cfg]) => cfg.observe_others === true).length;
  if (requestedObservers > MAX_OBSERVERS) throw observerLimitError(args.name, requestedObservers);

  let session = await selectSessionRow(tx, ws.internal_id, args.name);
  let created = false;
  if (!session) {
    if (args.requireExisting) throw notFound(`Session ${args.name}`);
    const inserted = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO sessions (id, workspace_id, name, metadata, configuration)
          VALUES (${newId()}, ${ws.internal_id}, ${args.name}, ${JSON.stringify(args.metadata ?? {})}::jsonb,
                  ${JSON.stringify(dropNulls(args.configuration ?? {}))}::jsonb)
          ON CONFLICT (workspace_id, name) DO NOTHING RETURNING id`,
    );
    created = inserted.length > 0;
    session = await selectSessionRow(tx, ws.internal_id, args.name);
  }
  if (!session?.is_active) throw notFound(`Session ${args.name}`);

  if (!created && (args.metadata != null || args.configuration != null)) {
    let configuration: Obj | undefined;
    if (args.configuration != null) {
      const [locked] = await rows<{ configuration: Obj }>(
        tx,
        sql`SELECT configuration FROM sessions WHERE id = ${session.internal_id} FOR UPDATE`,
      );
      configuration = mergeConfiguration(locked?.configuration, args.configuration);
    }
    await tx.execute(
      sql`UPDATE sessions SET
            metadata = COALESCE(${args.metadata == null ? null : JSON.stringify(args.metadata)}::jsonb, metadata),
            configuration = COALESCE(${configuration === undefined ? null : JSON.stringify(configuration)}::jsonb, configuration)
          WHERE id = ${session.internal_id}`,
    );
  }

  const mode = args.peerMode ?? "add";
  if (peerEntries.length > 0 || (mode === "set" && args.peers)) {
    const refs = await ensurePeers(
      tx,
      ws.internal_id,
      peerEntries.map(([name]) => name),
    );
    if (mode === "set") {
      await leaveMembersExcept(
        tx,
        session.internal_id,
        peerEntries.map(([name]) => refs.get(name)!.id),
      );
    }
    await upsertMembers(
      tx,
      ws.internal_id,
      session.internal_id,
      peerEntries.map(([name, cfg]) => ({
        peerId: refs.get(name)!.id,
        config: memberConfigJson(cfg),
      })),
      mode,
    );
    const observers = await countObservers(tx, session.internal_id);
    if (observers > MAX_OBSERVERS) throw observerLimitError(args.name, observers);
  }

  if (args.scopes && args.scopes.length > 0) {
    const { map } = await ensureScopes(tx, ws.internal_id, ws.name, args.scopes);
    await attachSessionToScopes(
      tx,
      { internal_id: ws.internal_id, name: ws.name },
      { id: session.internal_id, name: args.name },
      map,
    );
  }

  const fresh = (await selectSessionRow(tx, ws.internal_id, args.name))!;
  return { session: fresh, created };
}

export async function getOrCreateSession(
  ctx: AppContext,
  workspace: WsKey,
  body: Omit<UpsertSessionArgs, "name"> & { id: string },
) {
  return ctx.db.transaction(async (tx) => {
    const { row: ws } = await ensureWorkspace(tx, workspace);
    const { id, ...rest } = body;
    const { session, created } = await upsertSession(tx, ws, { name: id, ...rest });
    return { session: sessionOut(session), created };
  });
}

/** `GET /sessions/{id}` (Recall extension): read without creating; 404 when missing or being deleted. */
export async function getSession(ctx: AppContext, workspace: WsKey, name: string) {
  return sessionOut(await requireActiveSession(ctx.db, workspace, name));
}

export async function updateSession(
  ctx: AppContext,
  workspace: WsKey,
  name: string,
  body: { metadata?: Obj | null; configuration?: Obj | null },
) {
  return (await getOrCreateSession(ctx, workspace, { id: name, ...body })).session;
}

export async function listSessions(
  ctx: AppContext,
  workspace: WsKey,
  paging: Paging,
  filters: Record<string, unknown> | null | undefined,
): Promise<Page<ReturnType<typeof sessionOut>>> {
  const where: (SQL | undefined)[] = [
    sql`${wsIs(workspace)}`,
    sql`s.is_active`,
    compileFilters("sessions", filters),
  ];
  return paginate(ctx.db, paging, {
    select: SESSION_COLS,
    from: FROM_SESSION,
    where,
    keys: createdAtKeys(sql`s.created_at`, sql`s.id`),
    map: (r) => sessionOut(r as unknown as SessionRow),
  });
}

/** Marks the session inactive right away and queues the hard delete. */
export async function deleteSession(
  ctx: AppContext,
  workspace: WsKey,
  name: string,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await rows<{ id: string; workspace_id: string }>(
      tx,
      sql`UPDATE sessions s SET is_active = FALSE FROM workspaces w
          WHERE w.id = s.workspace_id AND ${wsIs(workspace)} AND s.name = ${name} AND s.is_active
          RETURNING s.id, s.workspace_id`,
    );
    if (!row) throw notFound(`Session ${name}`);
    await enqueue(tx, {
      kind: "delete_session",
      workKey: `delete_session:${row.id}`,
      workspaceId: row.workspace_id,
      sessionId: row.id,
      payload: { session: name },
    });
  });
}

/**
 * Copies the session (optionally up to and including `messageId`) into a new
 * session with a generated id. Messages keep content, author, metadata, token
 * count and sequence numbers; they get new ids and the time of cloning, and
 * are marked as already reasoned (a clone never re-derives conclusions).
 * Embeddings are copied, so the clone is searchable right away. Memberships
 * are copied with their `left_at`, so departed members do not regain access,
 * and scope memberships are not copied.
 */
export async function cloneSession(
  ctx: AppContext,
  workspace: WsKey,
  name: string,
  messageId?: string,
) {
  return ctx.db.transaction(async (tx) => {
    const [src] = await rows<{
      id: string;
      workspace_id: string;
      metadata: Obj;
      configuration: Obj;
    }>(
      tx,
      sql`SELECT s.id, s.workspace_id, s.metadata, s.configuration ${FROM_SESSION}
          WHERE ${wsIs(workspace)} AND s.name = ${name} AND s.is_active`,
    );
    if (!src) throw notFound("Original session");
    let cut: number | null = null;
    if (messageId) {
      const [m] = await rows<{ seq_in_session: number | string }>(
        tx,
        sql`SELECT seq_in_session FROM messages WHERE id = ${messageId} AND session_id = ${src.id}`,
      );
      if (!m) throw notFound("Session");
      cut = Number(m.seq_in_session);
    }
    const cloneName = newId();
    const cloneId = newId();
    await tx.execute(
      sql`INSERT INTO sessions (id, workspace_id, name, metadata, configuration)
          VALUES (${cloneId}, ${src.workspace_id}, ${cloneName}, ${JSON.stringify(src.metadata ?? {})}::jsonb,
                  ${JSON.stringify(src.configuration ?? {})}::jsonb)`,
    );
    const cutSql = cut === null ? sql`NULL::bigint` : sql`${String(cut)}::bigint`;
    await tx.execute(
      sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, metadata, internal,
                                token_count, embedding, embedding_model, reasoned_at, created_at)
          SELECT substr(translate(rtrim(encode(decode(md5(random()::text || clock_timestamp()::text || m.seq::text), 'hex'), 'base64'), '='), '+/', '_-'), 1, 21),
                 m.workspace_id, ${cloneId}, m.peer_id, m.seq_in_session, m.content, m.metadata,
                 '{"observers": [], "reasoning": false, "instructions": null}'::jsonb,
                 m.token_count, m.embedding, m.embedding_model,
                 CASE WHEN m.embedding IS NULL THEN NULL ELSE now() END, now()
          FROM messages m
          WHERE m.session_id = ${src.id} AND (${cutSql} IS NULL OR m.seq_in_session <= ${cutSql})
          ORDER BY m.seq`,
    );
    await tx.execute(
      sql`UPDATE sessions SET next_seq = COALESCE((SELECT max(seq_in_session) FROM messages WHERE session_id = ${cloneId}), 0) + 1
          WHERE id = ${cloneId}`,
    );
    // Messages the source had not embedded yet are picked up by the worker, which only embeds them
    // (cloned messages carry reasoning: false).
    const [pending] = await rows<{ tokens: number | string | null }>(
      tx,
      sql`SELECT sum(token_count) AS tokens FROM messages WHERE session_id = ${cloneId} AND reasoned_at IS NULL`,
    );
    if (pending?.tokens != null) {
      await scheduleMessageProcessing(tx, {
        workspaceId: src.workspace_id,
        sessionId: cloneId,
        newTokens: Number(pending.tokens),
      });
    }
    await tx.execute(
      sql`INSERT INTO session_peers (workspace_id, session_id, peer_id, configuration, joined_at, left_at)
          SELECT sp.workspace_id, ${cloneId}, sp.peer_id, sp.configuration, now(), sp.left_at
          FROM session_peers sp JOIN peers p ON p.id = sp.peer_id
          WHERE sp.session_id = ${src.id} AND NOT p.is_scope`,
    );
    return sessionOut((await selectSessionRow(tx, src.workspace_id, cloneName))!);
  });
}

// ---------------------------------------------------------------------------
// Membership

export async function addSessionPeers(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  peers: Record<string, MemberConfig>,
) {
  return (await getOrCreateSession(ctx, workspace, { id: session, peers, peerMode: "add" }))
    .session;
}

export async function setSessionPeers(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  peers: Record<string, MemberConfig>,
) {
  return ctx.db.transaction(async (tx) => {
    const { row: ws } = await ensureWorkspace(tx, workspace);
    const { session: row } = await upsertSession(tx, ws, {
      name: session,
      peers,
      peerMode: "set",
      requireExisting: true,
    });
    return sessionOut(row);
  });
}

export async function removeSessionPeers(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  peerNames: string[],
) {
  return ctx.db.transaction(async (tx) => {
    const row = await requireActiveSession(tx, workspace, session);
    const unique = [...new Set(peerNames)];
    if (unique.length > 0) {
      const list = sql.join(
        unique.map((n) => sql`${n}`),
        sql`, `,
      );
      const found = await rows<{ id: string; name: string; is_scope: boolean }>(
        tx,
        sql`SELECT p.id, p.name, p.is_scope FROM peers p JOIN sessions s ON s.workspace_id = p.workspace_id
            WHERE s.id = ${row.internal_id} AND p.name IN (${list})`,
      );
      for (const peer of found) if (peer.is_scope) throw scopeError(peer.name);
      for (const name of unique) {
        if (name.startsWith("scope.") && !found.some((f) => f.name === name))
          throw scopeError(name);
      }
      await leaveMembers(
        tx,
        row.internal_id,
        found.map((f) => f.id),
      );
    }
    return sessionOut(row);
  });
}

/** Active, non-scope members ordered by join time. */
export async function listSessionPeers(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  paging: Paging,
): Promise<Page<ReturnType<typeof peerOut>>> {
  return paginate(ctx.db, paging, {
    select: PEER_COLS,
    from: sql`FROM session_peers sp
              JOIN sessions s ON s.id = sp.session_id
              JOIN peers p ON p.id = sp.peer_id
              JOIN workspaces w ON w.id = s.workspace_id`,
    where: [
      sql`${wsIs(workspace)}`,
      sql`s.name = ${session}`,
      sql`s.is_active`,
      sql`sp.left_at IS NULL`,
      sql`NOT p.is_scope`,
    ],
    keys: createdAtKeys(sql`sp.joined_at`, sql`p.id`),
    map: (r) => peerOut(r as unknown as PeerRow),
  });
}

export async function getMemberConfig(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  peerName: string,
) {
  const [row] = await rows<{
    peer_id: string | null;
    is_scope: boolean | null;
    configuration: MemberConfig | null;
    has_membership: boolean;
  }>(
    ctx.db,
    sql`SELECT p.id AS peer_id, p.is_scope, sp.configuration, (sp.session_id IS NOT NULL) AS has_membership
        FROM workspaces w
        JOIN peers p ON p.workspace_id = w.id AND p.name = ${peerName}
        LEFT JOIN sessions s ON s.workspace_id = w.id AND s.name = ${session} AND s.is_active
        LEFT JOIN session_peers sp ON sp.session_id = s.id AND sp.peer_id = p.id
        WHERE ${wsIs(workspace)}`,
  );
  if (!row) throw notFound(`Peer ${peerName}`);
  if (row.is_scope) throw scopeError(peerName);
  if (!row.has_membership) throw notFound(`Peer ${peerName} in session ${session}`);
  return {
    observe_me: row.configuration?.observe_me ?? null,
    observe_others: row.configuration?.observe_others ?? null,
  };
}

/** Merges non-null fields into the membership config; creates the membership if there is none. */
export async function setMemberConfig(
  ctx: AppContext,
  workspace: WsKey,
  session: string,
  peerName: string,
  config: MemberConfig,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await requireActiveSession(tx, workspace, session);
    const [ws] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM workspaces w WHERE ${wsIs(workspace)}`,
    );
    const peer = await findPeer(tx, ws!.id, peerName);
    if (!peer) throw notFound(`Peer ${peerName}`);
    if (peer.isScope) throw scopeError(peerName);
    const patch = Object.fromEntries(
      Object.entries({
        observe_me: config.observe_me,
        observe_others: config.observe_others,
      }).filter(([, v]) => v !== null && v !== undefined),
    );
    await tx.execute(
      sql`INSERT INTO session_peers (workspace_id, session_id, peer_id, configuration, joined_at, left_at)
          VALUES (${ws!.id}, ${row.internal_id}, ${peer.id}, ${JSON.stringify(patch)}::jsonb, clock_timestamp(), NULL)
          ON CONFLICT (session_id, peer_id) DO UPDATE SET
            configuration = session_peers.configuration || EXCLUDED.configuration`,
    );
    if (patch.observe_others === true) {
      const observers = await countObservers(tx, row.internal_id);
      if (observers > MAX_OBSERVERS) {
        throw badRequest(
          `Cannot enable observe_others for ${peerName}: session ${session} would have ${observers} observers. Maximum allowed is ${MAX_OBSERVERS}.`,
        );
      }
    }
  });
}
