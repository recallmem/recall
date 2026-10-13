import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { type Db, rows } from "../db/client.js";
import { createdAtKeys, type Page, type Paging, paginate } from "../http/pagination.js";
import {
  SCOPE_COLS,
  SCOPE_PREFIX,
  type ScopeRow,
  SESSION_COLS,
  type SessionRow,
  scopeOut,
  sessionOut,
} from "../http/serialize.js";
import { ApiError, conflict } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import type { Obj } from "./configuration.js";
import { upsertMembers } from "./members.js";
import { type WsKey, wsIs } from "./tenancy.js";
import { ensureWorkspace, findWorkspace } from "./workspaces.js";

type Executor = Pick<Db, "execute">;

/** Membership config every scope peer gets in a member session. Scopes never count as observers for the limit. */
export const SCOPE_MEMBER_CONFIG = JSON.stringify({ observe_me: false, observe_others: true });

const missingScope = (id: string, workspace: WsKey) =>
  new ApiError(404, `Scope ${id} not found in workspace ${workspace.name}`);

interface ScopePeer {
  id: string;
  name: string;
  is_scope: boolean;
}

/** Get-or-creates scope peers (`scope.<id>`). A regular peer occupying the name is a 409. */
export async function ensureScopes(
  db: Executor,
  wsId: string,
  wsName: string,
  scopeIds: string[],
): Promise<{ map: Map<string, string>; created: Set<string> }> {
  const unique = [...new Set(scopeIds)];
  const names = unique.map((id) => `${SCOPE_PREFIX}${id}`);
  const list = (values: string[]) =>
    sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    );
  const found = await rows<ScopePeer>(
    db,
    sql`SELECT id, name, is_scope FROM peers WHERE workspace_id = ${wsId} AND name IN (${list(names)})`,
  );
  const byName = new Map(found.map((r) => [r.name, r]));
  for (const row of found) {
    if (!row.is_scope) {
      throw conflict(
        `A peer named '${row.name}' already exists in workspace ${wsName} but is not a scope. Choose a different scope id or rename the peer.`,
      );
    }
  }
  const missing = names.filter((n) => !byName.has(n)).sort();
  const created = new Set<string>();
  if (missing.length > 0) {
    const inserted = await rows<ScopePeer>(
      db,
      sql`INSERT INTO peers (id, workspace_id, name, is_scope, configuration, internal)
          VALUES ${sql.join(
            missing.map(
              (n) =>
                sql`(${newId()}, ${wsId}, ${n}, TRUE, '{"observe_me": false}'::jsonb, '{"kind": "scope", "backfill": {}}'::jsonb)`,
            ),
            sql`, `,
          )}
          ON CONFLICT (workspace_id, name) DO NOTHING
          RETURNING id, name, is_scope`,
    );
    for (const row of inserted) {
      byName.set(row.name, row);
      created.add(row.name.slice(SCOPE_PREFIX.length));
    }
    const raced = missing.filter((n) => !byName.has(n));
    if (raced.length > 0) {
      const again = await rows<ScopePeer>(
        db,
        sql`SELECT id, name, is_scope FROM peers WHERE workspace_id = ${wsId} AND name IN (${list(raced)})`,
      );
      for (const row of again) {
        if (!row.is_scope)
          throw conflict(
            `A peer named '${row.name}' already exists in workspace ${wsName} but is not a scope.`,
          );
        byName.set(row.name, row);
      }
    }
  }
  const map = new Map<string, string>();
  for (const id of unique) {
    const row = byName.get(`${SCOPE_PREFIX}${id}`);
    if (!row) throw conflict(`Scope ${id} could not be created; retry the request`);
    map.set(id, row.id);
  }
  return { map, created };
}

async function selectScope(
  db: Executor,
  wsName: WsKey,
  scopeId: string,
): Promise<(ScopeRow & { workspace_id: string }) | undefined> {
  const [row] = await rows<ScopeRow & { workspace_id: string }>(
    db,
    sql`SELECT ${SCOPE_COLS}, p.workspace_id FROM peers p JOIN workspaces w ON w.id = p.workspace_id
        WHERE ${wsIs(wsName)} AND p.name = ${`${SCOPE_PREFIX}${scopeId}`} AND p.is_scope`,
  );
  return row;
}

async function requireScope(db: Executor, wsName: WsKey, scopeId: string) {
  const scope = await selectScope(db, wsName, scopeId);
  if (!scope) throw missingScope(scopeId, wsName);
  return scope;
}

export async function getOrCreateScope(
  ctx: AppContext,
  workspace: WsKey,
  body: { id: string; metadata?: Obj | null },
) {
  return ctx.db.transaction(async (tx) => {
    const { row: ws } = await ensureWorkspace(tx, workspace);
    const { created } = await ensureScopes(tx, ws.internal_id, workspace.name, [body.id]);
    const isNew = created.has(body.id);
    if (body.metadata != null) {
      await tx.execute(
        sql`UPDATE peers SET metadata = ${JSON.stringify(body.metadata)}::jsonb
            WHERE workspace_id = ${ws.internal_id} AND name = ${`${SCOPE_PREFIX}${body.id}`}`,
      );
    }
    const scope = await selectScope(tx, workspace, body.id);
    return { scope: scopeOut(scope!), created: isNew };
  });
}

export async function getScope(ctx: AppContext, workspace: WsKey, id: string) {
  return scopeOut(await requireScope(ctx.db, workspace, id));
}

export async function listScopes(
  ctx: AppContext,
  workspace: WsKey,
  paging: Paging,
): Promise<Page<ReturnType<typeof scopeOut>>> {
  return paginate(ctx.db, paging, {
    select: SCOPE_COLS,
    from: sql`FROM peers p JOIN workspaces w ON w.id = p.workspace_id`,
    where: [sql`${wsIs(workspace)}`, sql`p.is_scope`],
    keys: createdAtKeys(sql`p.created_at`, sql`p.id`),
    map: (r) => scopeOut(r as unknown as ScopeRow),
  });
}

/** Records backfill state for sessions on the scope peer's private metadata, in one statement. */
export async function setBackfillStatus(
  db: Executor,
  scopePeerId: string,
  updates: Record<string, { state: "pending" | "completed" | "failed"; docs_copied?: number }>,
): Promise<void> {
  const at = new Date().toISOString();
  const patch = Object.fromEntries(
    Object.entries(updates).map(([k, v]) => [k, { ...v, updated_at: at }]),
  );
  await db.execute(
    sql`UPDATE peers SET internal = jsonb_set(internal, '{backfill}',
          COALESCE(internal -> 'backfill', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true)
        WHERE id = ${scopePeerId}`,
  );
}

async function clearBackfillStatus(
  db: Executor,
  scopePeerId: string,
  sessionName: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE peers SET internal = jsonb_set(internal, '{backfill}', COALESCE(internal -> 'backfill', '{}'::jsonb) - ${sessionName}::text, true)
        WHERE id = ${scopePeerId}`,
  );
}

interface NewJobRow {
  kind: "scope_backfill" | "scope_removal";
  workKey: string;
  workspaceId: string;
  sessionId: string;
  payload: Obj;
}

/** Inserts several jobs in a single statement (these kinds never coalesce). */
async function insertJobs(db: Executor, jobs: NewJobRow[]): Promise<void> {
  if (jobs.length === 0) return;
  await db.execute(
    sql`INSERT INTO jobs (kind, work_key, workspace_id, session_id, payload)
        VALUES ${sql.join(
          jobs.map(
            (j) =>
              sql`(${j.kind}, ${j.workKey}, ${j.workspaceId}, ${j.sessionId}, ${JSON.stringify(j.payload)}::jsonb)`,
          ),
          sql`, `,
        )}`,
  );
}

/**
 * Makes the session a member of each scope and, when it already has
 * messages, queues a backfill per scope. Used by session create (`scopes`) and
 * by the scope routes; runs inside the caller's transaction.
 */
export async function attachSessionToScopes(
  tx: Executor,
  ws: { internal_id: string; name: string },
  session: { id: string; name: string },
  scopes: Map<string, string>,
): Promise<void> {
  if (scopes.size === 0) return;
  await upsertMembers(
    tx,
    ws.internal_id,
    session.id,
    [...scopes.values()].map((peerId) => ({ peerId, config: SCOPE_MEMBER_CONFIG })),
    "add",
  );
  const [has] = await rows<{ yes: boolean }>(
    tx,
    sql`SELECT EXISTS (SELECT 1 FROM messages WHERE session_id = ${session.id}) AS yes`,
  );
  if (!has?.yes) return;
  await insertJobs(
    tx,
    [...scopes].map(([scopeId, peerId]) => ({
      kind: "scope_backfill" as const,
      workKey: `scope_backfill:${peerId}:${session.id}`,
      workspaceId: ws.internal_id,
      sessionId: session.id,
      payload: { scope: scopeId, scopePeerId: peerId, session: session.name },
    })),
  );
  for (const [, peerId] of scopes)
    await setBackfillStatus(tx, peerId, { [session.name]: { state: "pending" } });
}

export async function addSessionsToScope(
  ctx: AppContext,
  workspace: WsKey,
  scopeId: string,
  sessionNames: string[],
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const scope = await requireScope(tx, workspace, scopeId);
    const unique = [...new Set(sessionNames)];
    const list = sql.join(
      unique.map((n) => sql`${n}`),
      sql`, `,
    );
    const found = await rows<{ id: string; name: string; has_messages: boolean }>(
      tx,
      sql`SELECT s.id, s.name, EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id) AS has_messages
          FROM sessions s WHERE s.workspace_id = ${scope.workspace_id} AND s.is_active AND s.name IN (${list})`,
    );
    const known = new Set(found.map((r) => r.name));
    const missing = unique.filter((n) => !known.has(n));
    if (missing.length > 0) {
      throw new ApiError(
        404,
        `Session(s) [${missing.map((n) => `'${n}'`).join(", ")}] not found in workspace ${workspace.name}`,
      );
    }
    await tx.execute(
      sql`INSERT INTO session_peers (workspace_id, session_id, peer_id, configuration, joined_at, left_at)
          VALUES ${sql.join(
            found.map(
              (s) =>
                sql`(${scope.workspace_id}, ${s.id}, ${scope.internal_id}, ${SCOPE_MEMBER_CONFIG}::jsonb, clock_timestamp(), NULL)`,
            ),
            sql`, `,
          )}
          ON CONFLICT (session_id, peer_id) DO UPDATE SET
            configuration = EXCLUDED.configuration, joined_at = clock_timestamp(), left_at = NULL
            WHERE session_peers.left_at IS NOT NULL`,
    );
    const withMessages = found.filter((s) => s.has_messages);
    await insertJobs(
      tx,
      withMessages.map((s) => ({
        kind: "scope_backfill" as const,
        workKey: `scope_backfill:${scope.internal_id}:${s.id}`,
        workspaceId: scope.workspace_id,
        sessionId: s.id,
        payload: { scope: scopeId, scopePeerId: scope.internal_id, session: s.name },
      })),
    );
    if (withMessages.length > 0) {
      await setBackfillStatus(
        tx,
        scope.internal_id,
        Object.fromEntries(withMessages.map((s) => [s.name, { state: "pending" as const }])),
      );
    }
  });
}

export async function removeSessionFromScope(
  ctx: AppContext,
  workspace: WsKey,
  scopeId: string,
  sessionName: string,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const scope = await requireScope(tx, workspace, scopeId);
    const [session] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM sessions WHERE workspace_id = ${scope.workspace_id} AND name = ${sessionName} AND is_active`,
    );
    if (!session)
      throw new ApiError(404, `Session ${sessionName} not found in workspace ${workspace.name}`);
    await tx.execute(
      sql`UPDATE session_peers SET left_at = now()
          WHERE session_id = ${session.id} AND peer_id = ${scope.internal_id} AND left_at IS NULL`,
    );
    await clearBackfillStatus(tx, scope.internal_id, sessionName);
    await insertJobs(tx, [
      {
        kind: "scope_removal",
        workKey: `scope_removal:${scope.internal_id}:${session.id}`,
        workspaceId: scope.workspace_id,
        sessionId: session.id,
        payload: { scope: scopeId, scopePeerId: scope.internal_id, session: sessionName },
      },
    ]);
  });
}

export async function listScopeSessions(
  ctx: AppContext,
  workspace: WsKey,
  scopeId: string,
  paging: Paging,
): Promise<Page<ReturnType<typeof sessionOut>>> {
  const scope = await requireScope(ctx.db, workspace, scopeId);
  const where: (SQL | undefined)[] = [
    sql`sp.peer_id = ${scope.internal_id}`,
    sql`sp.left_at IS NULL`,
    sql`s.is_active`,
  ];
  return paginate(ctx.db, paging, {
    select: SESSION_COLS,
    from: sql`FROM session_peers sp JOIN sessions s ON s.id = sp.session_id JOIN workspaces w ON w.id = s.workspace_id`,
    where,
    // Sessions added in one request share joined_at; fall back to creation order, not the random id.
    keys: [
      { expr: sql`sp.joined_at`, type: "timestamptz" },
      ...createdAtKeys(sql`s.created_at`, sql`s.id`),
    ],
    map: (r) => sessionOut(r as unknown as SessionRow),
  });
}

export async function getScopeStatus(ctx: AppContext, workspace: WsKey, scopeId: string) {
  const scope = await requireScope(ctx.db, workspace, scopeId);
  const backfill = (scope.internal as Obj | null | undefined)?.backfill;
  return { backfill_status: backfill && typeof backfill === "object" ? backfill : {} };
}

/**
 * Sessions that currently contribute to each scope: active sessions with an
 * active scope membership. Removed sessions are never included (Honcho keeps
 * them reachable). Single query, whatever the number of scopes.
 */
export async function resolveScopeSessions(
  db: Executor,
  workspace: WsKey,
  scopeIds: string[],
): Promise<{ missing: string[]; sessions: { id: string; name: string; scope: string }[] }> {
  const unique = [...new Set(scopeIds)];
  if (unique.length === 0) return { missing: [], sessions: [] };
  const names = sql.join(
    unique.map((id) => sql`${`${SCOPE_PREFIX}${id}`}`),
    sql`, `,
  );
  const ws = await findWorkspace(db, workspace);
  if (!ws) return { missing: unique, sessions: [] };
  const found = await rows<{
    scope_name: string;
    session_id: string | null;
    session_name: string | null;
  }>(
    db,
    sql`SELECT p.name AS scope_name, s.id AS session_id, s.name AS session_name
        FROM peers p
        LEFT JOIN session_peers sp ON sp.peer_id = p.id AND sp.left_at IS NULL
        LEFT JOIN sessions s ON s.id = sp.session_id AND s.is_active
        WHERE p.workspace_id = ${ws.internal_id} AND p.is_scope AND p.name IN (${names})`,
  );
  const present = new Set(found.map((r) => r.scope_name.slice(SCOPE_PREFIX.length)));
  return {
    missing: unique.filter((id) => !present.has(id)),
    sessions: found
      .filter((r) => r.session_id && r.session_name)
      .map((r) => ({
        id: r.session_id!,
        name: r.session_name!,
        scope: r.scope_name.slice(SCOPE_PREFIX.length),
      })),
  };
}
