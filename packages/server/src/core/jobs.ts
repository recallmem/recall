import { type SQL, sql } from "drizzle-orm";
import { scheduleManualDream } from "../consolidate/index.js";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { lockCollections, NORMALIZED } from "../reasoner/apply.js";
import { textArray } from "../reasoner/util.js";
import { recordEvents } from "./history.js";
import { setBackfillStatus } from "./scopes.js";

/** Payload-carrying job row as the worker hands it to a handler. */
export interface JobRow {
  id: number;
  kind: string;
  workKey: string;
  workspaceId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Rows deleted per statement. Big tenants are removed in many short
 * statements instead of one giant transaction (long locks, WAL spikes).
 */
const DELETE_BATCH = 2000;

/** Runs a `DELETE ... RETURNING 1`-style batch until it removes nothing more. */
async function deleteInBatches(ctx: AppContext, batch: (limit: number) => SQL): Promise<number> {
  let total = 0;
  for (;;) {
    const [res] = await rows<{ n: number }>(
      ctx.db,
      sql`WITH d AS (${batch(DELETE_BATCH)}) SELECT count(*)::int AS n FROM d`,
    );
    const n = Number(res?.n ?? 0);
    total += n;
    if (n < DELETE_BATCH) return total;
  }
}

const requireString = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`job is missing ${what}`);
  return value;
};

/**
 * Hard-deletes a session that the API already marked inactive: its pending
 * work, messages, the conclusions filed under it, memberships and summaries.
 * Conclusions that are not tied to the session, and peer cards, are kept.
 * Safe to re-run after a crash: every step is a no-op once its rows are gone.
 */
export async function handleDeleteSession(ctx: AppContext, job: JobRow): Promise<void> {
  const sessionId = requireString(job.sessionId, "sessionId");
  await ctx.db.execute(
    sql`DELETE FROM jobs WHERE session_id = ${sessionId} AND status = 'pending' AND id <> ${job.id}
        AND kind IN ('reason', 'summarize', 'dream', 'embed')`,
  );
  const touched = await rows<{ collection_id: string }>(
    ctx.db,
    sql`SELECT DISTINCT collection_id FROM conclusions WHERE session_id = ${sessionId}`,
  );
  await deleteInBatches(
    ctx,
    (limit) =>
      sql`DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE session_id = ${sessionId} LIMIT ${limit}) RETURNING 1`,
  );
  await deleteInBatches(
    ctx,
    (limit) =>
      sql`DELETE FROM conclusions WHERE id IN (SELECT id FROM conclusions WHERE session_id = ${sessionId} LIMIT ${limit}) RETURNING 1`,
  );
  await ctx.db.transaction(async (tx) => {
    if (touched.length > 0) {
      await tx.execute(
        sql`UPDATE collections SET version = version + 1
            WHERE id IN (${sql.join(
              touched.map((t) => sql`${t.collection_id}`),
              sql`, `,
            )})`,
      );
    }
    // Cascades to memberships and summary blocks.
    await tx.execute(sql`DELETE FROM sessions WHERE id = ${sessionId}`);
  });
}

/**
 * Hard-deletes a workspace and everything in it. The API only queues this when
 * no session is active. Large tables are emptied in batches first; the final
 * workspace delete cascades through the small remainder.
 */
export async function handleDeleteWorkspace(ctx: AppContext, job: JobRow): Promise<void> {
  const wsId = requireString(job.workspaceId, "workspaceId");
  await ctx.db.execute(
    sql`DELETE FROM jobs WHERE workspace_id = ${wsId} AND status = 'pending' AND id <> ${job.id}`,
  );
  await deleteInBatches(
    ctx,
    (limit) =>
      sql`DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE workspace_id = ${wsId} LIMIT ${limit}) RETURNING 1`,
  );
  await deleteInBatches(
    ctx,
    (limit) =>
      sql`DELETE FROM conclusions WHERE id IN (SELECT id FROM conclusions WHERE workspace_id = ${wsId} LIMIT ${limit}) RETURNING 1`,
  );
  // Usage rows hold no content; they are detached rather than deleted so the account's
  // month-to-date spend (budget caps) survives the workspace. Account deletion removes them.
  await deleteInBatches(
    ctx,
    (limit) =>
      sql`UPDATE llm_usage SET workspace_id = NULL WHERE id IN (SELECT id FROM llm_usage WHERE workspace_id = ${wsId} LIMIT ${limit}) RETURNING 1`,
  );
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM jobs WHERE workspace_id = ${wsId} AND id <> ${job.id}`);
    await tx.execute(sql`DELETE FROM workspaces WHERE id = ${wsId}`);
  });
}

/**
 * Copies a session's existing explicit conclusions into the scope's
 * collections (scope -> author), so a session added to a scope after it has
 * messages still contributes. Re-runs are idempotent: a conclusion already
 * present in the scope for that session is not copied again. Embeddings and
 * validity windows are copied as they are; no LLM call is needed.
 *
 * A current fact the scope already holds as a current fact (same text, ignoring
 * case and spacing, as the reasoner compares) is not copied a second time: the
 * scope's fact is reinforced instead, as the reasoner does when another session
 * says it again (`times_derived` + 1, the source's messages added), once: it
 * records the source in `internal.scope_merged`. Copied history that the source
 * fact replaced points at the scope's fact.
 */
export async function handleScopeBackfill(ctx: AppContext, job: JobRow): Promise<void> {
  const scopePeerId = requireString(job.payload.scopePeerId, "payload.scopePeerId");
  const sessionId = requireString(job.sessionId, "sessionId");
  const sessionName = requireString(job.payload.session, "payload.session");
  try {
    const copied = await ctx.db.transaction(async (tx) => {
      const [member] = await rows<{ ok: number }>(
        tx,
        sql`SELECT 1 AS ok FROM session_peers sp JOIN sessions s ON s.id = sp.session_id
            WHERE sp.session_id = ${sessionId} AND sp.peer_id = ${scopePeerId} AND sp.left_at IS NULL AND s.is_active`,
      );
      if (!member) return null; // removed (or deleted) before the backfill ran: nothing to contribute
      // One source row per fact (the reasoner files a fact under each observer), and per
      // state: a fact that was closed and later said again is copied as history and as current.
      const text = NORMALIZED(sql`c.content`);
      const source = sql`
        FROM (SELECT DISTINCT ON (c.observed_id, ${text}, c.valid_to IS NULL) c.*
              FROM conclusions c JOIN peers obs ON obs.id = c.observer_id
              WHERE c.session_id = ${sessionId} AND c.level = 'explicit' AND c.deleted_at IS NULL AND NOT obs.is_scope
              ORDER BY c.observed_id, ${text}, c.valid_to IS NULL, c.created_at, c.id) c`;
      const targets = await rows<{ observed_id: string; workspace_id: string }>(
        tx,
        sql`SELECT DISTINCT c.observed_id, c.workspace_id ${source}`,
      );
      for (const t of targets) {
        await tx.execute(
          sql`INSERT INTO collections (id, workspace_id, observer_id, observed_id)
              VALUES (${newId()}, ${t.workspace_id}, ${scopePeerId}, ${t.observed_id})
              ON CONFLICT (observer_id, observed_id) DO NOTHING`,
        );
      }
      if (targets.length) {
        const dst = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM collections WHERE observer_id = ${scopePeerId}
                AND observed_id = ANY(${textArray(targets.map((t) => t.observed_id))})`,
        );
        // As the reasoner does, so neither adds a fact the other is adding.
        await lockCollections(
          tx,
          dst.map((d) => d.id),
        );
      }
      const merged = (x: string, id: SQL) =>
        sql`COALESCE(${sql.raw(x)}.internal -> 'scope_merged', '[]'::jsonb) @> jsonb_build_array(${id})`;
      // Already in the scope from this session (an earlier run, or the reasoner while the session
      // was a member), or already merged into one of its facts: nothing to add, even when that
      // fact has stopped holding since.
      const present = sql`(EXISTS (SELECT 1 FROM conclusions x
                                   WHERE x.collection_id = dst.id AND x.deleted_at IS NULL
                                     AND ((x.session_id = ${sessionId} AND ${NORMALIZED(sql`x.content`)} = ${text})
                                          OR ${merged("x", sql`c.id`)})))`;
      const sameCurrent = (x: string) =>
        sql`${sql.raw(x)}.collection_id = dst.id AND ${sql.raw(x)}.deleted_at IS NULL
            AND ${sql.raw(x)}.valid_to IS NULL AND ${NORMALIZED(sql.raw(`${x}.content`))} = ${text}`;
      const reinforced = await rows<{ collection_id: string }>(
        tx,
        sql`WITH hit AS (
              SELECT DISTINCT ON (x.id) x.id AS target, c.id AS source, c.message_ids
              ${source}
              JOIN collections dst ON dst.observer_id = ${scopePeerId} AND dst.observed_id = c.observed_id
              JOIN conclusions x ON ${sameCurrent("x")}
              WHERE c.valid_to IS NULL AND NOT ${present}
                AND x.id = (SELECT y.id FROM conclusions y WHERE ${sameCurrent("y")} ORDER BY y.created_at, y.id LIMIT 1)
              ORDER BY x.id, c.created_at, c.id)
            UPDATE conclusions t SET times_derived = t.times_derived + 1,
                   message_ids = ARRAY(SELECT DISTINCT unnest(t.message_ids || hit.message_ids)),
                   internal = jsonb_set(t.internal, '{scope_merged}',
                     COALESCE(t.internal -> 'scope_merged', '[]'::jsonb) || jsonb_build_array(hit.source)),
                   updated_at = now()
            FROM hit WHERE t.id = hit.target
            RETURNING t.collection_id`,
      );
      const inserted = await rows<{
        collection_id: string;
        workspace_id: string;
        id: string;
        source_id: string;
      }>(
        tx,
        sql`WITH ins AS (
              INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content, level,
                                       category, confidence, importance, times_derived, source_ids, message_ids,
                                       valid_from, valid_to, event_start, event_end, event_precision, tags,
                                       embedding, embedding_model, internal)
              SELECT substr(translate(rtrim(encode(decode(md5(random()::text || clock_timestamp()::text || c.id), 'hex'), 'base64'), '='), '+/', '_-'), 1, 21),
                     c.workspace_id, dst.id, ${scopePeerId}, c.observed_id, c.session_id, c.content, 'explicit',
                     c.category, c.confidence, c.importance, c.times_derived, '{}', c.message_ids,
                     c.valid_from, c.valid_to, c.event_start, c.event_end, c.event_precision, c.tags, c.embedding,
                     c.embedding_model,
                     jsonb_build_object('scope_copy_of', c.id, 'key', COALESCE(c.internal ->> 'key', c.id))
              ${source}
              JOIN collections dst ON dst.observer_id = ${scopePeerId} AND dst.observed_id = c.observed_id
              WHERE NOT ${present}
                AND NOT (c.valid_to IS NULL AND EXISTS (SELECT 1 FROM conclusions x WHERE ${sameCurrent("x")}))
              RETURNING id, workspace_id, collection_id, internal ->> 'scope_copy_of' AS source_id)
            SELECT id, workspace_id, collection_id, source_id FROM ins`,
      );
      await recordEvents(
        tx,
        inserted.map((r) => ({
          workspaceId: r.workspace_id,
          collectionId: r.collection_id,
          conclusionId: r.id,
          action: "created" as const,
          actor: "system" as const,
          reason: "copied into the scope",
          sources: [r.source_id],
        })),
      );
      if (inserted.length > 0) {
        // Re-point supersession links at the scope's fact for the replacement: its copy, or
        // the fact it was merged into.
        await tx.execute(
          sql`UPDATE conclusions n SET superseded_by = (
                SELECT m.id FROM conclusions src
                JOIN conclusions m ON m.collection_id = n.collection_id AND m.deleted_at IS NULL
                  AND (m.internal ->> 'scope_copy_of' = src.superseded_by
                       OR ${merged("m", sql`src.superseded_by`)})
                WHERE src.id = n.internal ->> 'scope_copy_of' AND src.superseded_by IS NOT NULL
                ORDER BY m.created_at, m.id LIMIT 1)
              WHERE n.id = ANY(${textArray(inserted.map((r) => r.id))}) AND n.superseded_by IS NULL`,
        );
      }
      // Every change to a collection bumps its version (recall caches key on it).
      const perCollection = new Map<string, number>();
      for (const r of reinforced) perCollection.set(r.collection_id, 0);
      for (const r of inserted)
        perCollection.set(r.collection_id, (perCollection.get(r.collection_id) ?? 0) + 1);
      if (perCollection.size > 0) {
        await tx.execute(
          sql`UPDATE collections SET version = version + 1, new_since_dream = new_since_dream + v.n
              FROM (VALUES ${sql.join(
                [...perCollection].map(([id, n]) => sql`(${id}::text, ${n}::int)`),
                sql`, `,
              )}) AS v(id, n)
              WHERE collections.id = v.id`,
        );
      }
      await setBackfillStatus(tx, scopePeerId, {
        [sessionName]: { state: "completed", docs_copied: inserted.length },
      });
      return inserted.length;
    });
    ctx.log.debug({ scopePeerId, sessionId, copied }, "scope backfill finished");
  } catch (err) {
    await setBackfillStatus(ctx.db, scopePeerId, { [sessionName]: { state: "failed" } }).catch(
      () => undefined,
    );
    throw err;
  }
}

/**
 * Fail-closed reconciliation after a session leaves a scope: every scope
 * conclusion filed under that session is soft-deleted, along with any
 * conclusion that (transitively) cites one, and the scope's peer cards are
 * cleared because they may embed facts from the removed session. A card
 * refresh is then queued to rebuild each cleared card from what remains.
 */
export async function handleScopeRemoval(ctx: AppContext, job: JobRow): Promise<void> {
  const scopePeerId = requireString(job.payload.scopePeerId, "payload.scopePeerId");
  const sessionId = requireString(job.sessionId, "sessionId");
  const cleared = await ctx.db.transaction(async (tx) => {
    // A session that has since rejoined the scope keeps contributing.
    const [rejoined] = await rows<{ ok: number }>(
      tx,
      sql`SELECT 1 AS ok FROM session_peers WHERE session_id = ${sessionId} AND peer_id = ${scopePeerId} AND left_at IS NULL`,
    );
    if (rejoined) return [];
    const removed = await rows<{ collection_id: string }>(
      tx,
      sql`WITH RECURSIVE gone(id) AS (
            SELECT id FROM conclusions
            WHERE observer_id = ${scopePeerId} AND session_id = ${sessionId} AND deleted_at IS NULL
            UNION
            SELECT d.id FROM conclusions d JOIN gone g ON d.source_ids @> ARRAY[g.id]
            WHERE d.observer_id = ${scopePeerId} AND d.deleted_at IS NULL)
          UPDATE conclusions c SET deleted_at = now(), updated_at = now()
          FROM gone WHERE c.id = gone.id AND c.deleted_at IS NULL
          RETURNING c.collection_id`,
    );
    const affected = [...new Set(removed.map((r) => r.collection_id))];
    if (affected.length > 0) {
      await tx.execute(
        sql`UPDATE collections SET version = version + 1
            WHERE id IN (${sql.join(
              affected.map((id) => sql`${id}`),
              sql`, `,
            )})`,
      );
    }
    return rows<{ workspace_id: string; observer_name: string; observed_name: string }>(
      tx,
      sql`WITH cleared AS (
            UPDATE collections SET peer_card = '[]'::jsonb, card_updated_at = NULL, version = version + 1
            WHERE observer_id = ${scopePeerId} AND peer_card <> '[]'::jsonb
            RETURNING workspace_id, observer_id, observed_id)
          SELECT c.workspace_id, obs.name AS observer_name, obd.name AS observed_name
          FROM cleared c JOIN peers obs ON obs.id = c.observer_id JOIN peers obd ON obd.id = c.observed_id`,
    );
  });
  if (!ctx.config.features.dreams) return;
  for (const card of cleared) {
    await scheduleManualDream(ctx, {
      workspaceId: card.workspace_id,
      observer: card.observer_name,
      observed: card.observed_name,
      type: "card_refresh",
      sessionName: null,
      rebuild: true,
    });
  }
}
