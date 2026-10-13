import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { type Db, rows } from "../db/client.js";
import { compileFilters } from "../http/filters.js";
import { createdAtKeys, type Page, type Paging, paginate } from "../http/pagination.js";
import { WORKSPACE_COLS, type WorkspaceRow, workspaceOut } from "../http/serialize.js";
import { conflict, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../queue/enqueue.js";
import { dropNulls, mergeConfiguration, type Obj } from "./configuration.js";
import { type WsKey, wsIs } from "./tenancy.js";

type Executor = Pick<Db, "execute">;

const SELECT_WORKSPACE = sql`SELECT ${WORKSPACE_COLS} FROM workspaces w`;

/**
 * The workspace resolver: (account, name) -> row. Every by-name workspace
 * lookup in the server goes through here or through `wsIs`.
 */
export async function findWorkspace(db: Executor, key: WsKey): Promise<WorkspaceRow | undefined> {
  const [row] = await rows<WorkspaceRow>(db, sql`${SELECT_WORKSPACE} WHERE ${wsIs(key)}`);
  return row;
}

export async function requireWorkspace(db: Executor, key: WsKey): Promise<WorkspaceRow> {
  const row = await findWorkspace(db, key);
  if (!row) throw notFound(`Workspace ${key.name}`);
  return row;
}

/**
 * Get-or-create by name. Concurrent creators converge: the loser of the
 * unique-key race re-reads the winner's row.
 */
export async function ensureWorkspace(
  db: Executor,
  key: WsKey,
  init: { metadata?: Obj; configuration?: Obj } = {},
): Promise<{ row: WorkspaceRow; created: boolean }> {
  const existing = await findWorkspace(db, key);
  if (existing) return { row: existing, created: false };
  const inserted = await rows<WorkspaceRow>(
    db,
    sql`INSERT INTO workspaces (id, account_id, name, metadata, configuration)
        VALUES (${newId()}, ${key.account}, ${key.name}, ${JSON.stringify(init.metadata ?? {})}::jsonb,
                ${JSON.stringify(dropNulls(init.configuration ?? {}))}::jsonb)
        ON CONFLICT (account_id, name) DO NOTHING
        RETURNING id AS internal_id, name, metadata, configuration, created_at`,
  );
  if (inserted[0]) return { row: inserted[0], created: true };
  const winner = await findWorkspace(db, key);
  if (!winner) throw conflict(`Workspace ${key.name} could not be created; retry the request`);
  return { row: winner, created: false };
}

export async function getOrCreateWorkspace(
  ctx: AppContext,
  account: string,
  body: { id: string; metadata?: Obj | null; configuration?: Obj | null },
) {
  const { row, created } = await ensureWorkspace(
    ctx.db,
    { account, name: body.id },
    {
      metadata: body.metadata ?? {},
      configuration: body.configuration ?? {},
    },
  );
  return { workspace: workspaceOut(row), created };
}

/** `GET /workspaces/{id}` (Recall extension): read without creating; 404 when missing. */
export async function getWorkspace(ctx: AppContext, key: WsKey) {
  return workspaceOut(await requireWorkspace(ctx.db, key));
}

/** PUT semantics: upsert; non-null metadata replaces, non-null configuration merges one level deep. */
export async function updateWorkspace(
  ctx: AppContext,
  key: WsKey,
  body: { metadata?: Obj | null; configuration?: Obj | null },
) {
  return ctx.db.transaction(async (tx) => {
    const { row } = await ensureWorkspace(tx, key);
    const [locked] = await rows<{ configuration: Obj }>(
      tx,
      sql`SELECT configuration FROM workspaces WHERE id = ${row.internal_id} FOR UPDATE`,
    );
    const configuration =
      body.configuration != null
        ? mergeConfiguration(locked?.configuration, body.configuration)
        : undefined;
    if (body.metadata == null && configuration === undefined) return workspaceOut(row);
    const [updated] = await rows<WorkspaceRow>(
      tx,
      sql`UPDATE workspaces SET
            metadata = COALESCE(${body.metadata == null ? null : JSON.stringify(body.metadata)}::jsonb, metadata),
            configuration = COALESCE(${configuration === undefined ? null : JSON.stringify(configuration)}::jsonb, configuration)
          WHERE id = ${row.internal_id}
          RETURNING id AS internal_id, name, metadata, configuration, created_at`,
    );
    return workspaceOut(updated!);
  });
}

/** Marks nothing itself: refuses while sessions are active, then queues the hard delete. */
export async function deleteWorkspace(ctx: AppContext, key: WsKey): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const ws = await requireWorkspace(tx, key);
    const [active] = await rows<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM sessions WHERE workspace_id = ${ws.internal_id} AND is_active`,
    );
    if (Number(active?.n ?? 0) > 0) {
      throw conflict(
        `Cannot delete workspace '${key.name}': active session(s) remain. Delete all sessions first.`,
      );
    }
    await enqueue(tx, {
      kind: "delete_workspace",
      workKey: `delete_workspace:${ws.internal_id}`,
      workspaceId: ws.internal_id,
      payload: { workspace: key.name },
    });
  });
}

/** The caller's account's workspaces only. */
export async function listWorkspaces(
  ctx: AppContext,
  account: string,
  paging: Paging,
  filters: Record<string, unknown> | null | undefined,
): Promise<Page<ReturnType<typeof workspaceOut>>> {
  const where: (SQL | undefined)[] = [
    sql`w.account_id = ${account}`,
    compileFilters("workspaces", filters),
  ];
  return paginate(ctx.db, paging, {
    select: WORKSPACE_COLS,
    from: sql`FROM workspaces w`,
    where,
    keys: createdAtKeys(sql`w.created_at`, sql`w.id`),
    map: (r) => workspaceOut(r as unknown as WorkspaceRow),
  });
}
