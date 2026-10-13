import { sql } from "drizzle-orm";
import { type Db, rows } from "../db/client.js";
import { badRequest } from "../lib/errors.js";

type Executor = Pick<Db, "execute">;

/** Active non-scope members with `observe_others = true` allowed per session. */
export const MAX_OBSERVERS = 10;

export interface MemberConfig {
  observe_me?: boolean | null;
  observe_others?: boolean | null;
}

/** Membership config as stored by the add/set routes: both keys present, null when unset. */
export const memberConfigJson = (cfg: MemberConfig): string =>
  JSON.stringify({
    observe_me: cfg.observe_me ?? null,
    observe_others: cfg.observe_others ?? null,
  });

export function observerLimitError(session: string, count: number) {
  return badRequest(
    `Cannot create session ${session} with ${count} observers. Maximum allowed is ${MAX_OBSERVERS} observers per session. Observers are peers with 'observe_others' set to true.`,
  );
}

/** Number of active, non-scope members that observe the others. */
export async function countObservers(db: Executor, sessionId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM session_peers sp JOIN peers p ON p.id = sp.peer_id
        WHERE sp.session_id = ${sessionId} AND sp.left_at IS NULL AND NOT p.is_scope
          AND sp.configuration ->> 'observe_others' = 'true'`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Upserts memberships in one statement. `add` keeps the config of members that
 * are already active and rejoins departed ones with the new config; `set`
 * overwrites the config of every listed peer (active members keep `joined_at`).
 * Members added together get increasing `joined_at` values, so they list in request order.
 */
export async function upsertMembers(
  db: Executor,
  wsId: string,
  sessionId: string,
  entries: { peerId: string; config: string }[],
  mode: "add" | "set",
): Promise<void> {
  if (entries.length === 0) return;
  const values = sql.join(
    entries.map(
      (e, i) =>
        sql`(${wsId}::text, ${sessionId}::text, ${e.peerId}::text, ${e.config}::text, ${i}::int)`,
    ),
    sql`, `,
  );
  const guard = mode === "add" ? sql`WHERE session_peers.left_at IS NOT NULL` : sql``;
  // One clock reading per statement plus the request position keeps members listing in request order.
  await db.execute(
    sql`INSERT INTO session_peers (workspace_id, session_id, peer_id, configuration, joined_at, left_at)
        SELECT v.ws, v.sid, v.pid, v.cfg::jsonb, t.base + v.ord * interval '1 microsecond', NULL
        FROM (VALUES ${values}) AS v(ws, sid, pid, cfg, ord)
        CROSS JOIN (SELECT clock_timestamp() AS base) t
        ORDER BY v.pid
        ON CONFLICT (session_id, peer_id) DO UPDATE SET
          configuration = EXCLUDED.configuration,
          joined_at = CASE WHEN session_peers.left_at IS NULL THEN session_peers.joined_at ELSE EXCLUDED.joined_at END,
          left_at = NULL
        ${guard}`,
  );
}

/** Soft-removes active non-scope members that are not in `keepPeerIds`. */
export async function leaveMembersExcept(
  db: Executor,
  sessionId: string,
  keepPeerIds: string[],
): Promise<void> {
  const keep = keepPeerIds.length
    ? sql`AND p.id NOT IN (${sql.join(
        keepPeerIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  await db.execute(
    sql`UPDATE session_peers sp SET left_at = now() FROM peers p
        WHERE sp.peer_id = p.id AND sp.session_id = ${sessionId} AND sp.left_at IS NULL
          AND NOT p.is_scope ${keep}`,
  );
}

export async function leaveMembers(
  db: Executor,
  sessionId: string,
  peerIds: string[],
): Promise<void> {
  if (peerIds.length === 0) return;
  await db.execute(
    sql`UPDATE session_peers SET left_at = now()
        WHERE session_id = ${sessionId} AND left_at IS NULL
          AND peer_id IN (${sql.join(
            peerIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
  );
}
