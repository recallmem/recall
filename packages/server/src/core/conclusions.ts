import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { compileFilters } from "../http/filters.js";
import { createdAtKeys, type Page, type Paging, paginate } from "../http/pagination.js";
import { CONCLUSION_COLS, type ConclusionRow, conclusionOut } from "../http/serialize.js";
import {
  ApiError,
  notFound,
  outOfCreditMessage,
  paymentRequired,
  unprocessable,
} from "../lib/errors.js";
import { eventTime, parseEventDate } from "../lib/event-time.js";
import { newId } from "../lib/ids.js";
import { normalizeTags } from "../lib/tags.js";
import { countTokens } from "../lib/tokens.js";
import { LlmError } from "../llm/types.js";
import { ensureCollections, lockCollections, NORMALIZED, sameText } from "../reasoner/apply.js";
import { textArray } from "../reasoner/util.js";
import { factEvents, type MemoryEvent, recordEvents } from "./history.js";
import { findPeers } from "./peers.js";
import { type WsKey, wsIs } from "./tenancy.js";
import { findWorkspace } from "./workspaces.js";

/** Largest input the embedding model accepts, in o200k tokens. */
export const EMBED_MAX_TOKENS = 8192;

const FROM_CONCLUSION = sql`FROM conclusions c
  JOIN workspaces w ON w.id = c.workspace_id
  JOIN peers obs ON obs.id = c.observer_id
  JOIN peers obd ON obd.id = c.observed_id
  LEFT JOIN sessions s ON s.id = c.session_id`;

export interface NewConclusion {
  content: string;
  observer_id: string;
  observed_id: string;
  session_id?: string | null;
  /** When what the fact describes happened or began: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  event_start?: string | null;
  /** The last day of a span, in the same forms. */
  event_end?: string | null;
  /** What the fact is about; stored lowercase and singular. */
  tags?: string[] | null;
  /** Set by a person: the reasoner and dreams never close, merge or rewrite it. */
  pinned?: boolean | null;
  /** When the fact stops holding (ISO 8601). */
  expires_at?: string | null;
}

/** Who stores facts through `storeConclusions`, for the change log. */
export interface StoredBy {
  actor: "api" | "dashboard" | "system";
  ref?: string | null;
  reason?: string;
}

const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;

async function embed(ctx: AppContext, texts: string[], workspaceId: string): Promise<number[][]> {
  try {
    return await ctx.embeddings.embed(texts, workspaceId);
  } catch (err) {
    if (err instanceof LlmError) {
      ctx.log.error({ err }, "embedding failed");
      throw new ApiError(503, "Upstream language model provider is unavailable");
    }
    throw err;
  }
}

/** Embedding tokens an account may spend in an hour before it can add no more facts itself. */
export const EXPLICIT_EMBED_TOKENS_PER_HOUR = 2_000_000;

/**
 * Facts added through the API are embedded at once and are not billed per token, so on a billed
 * account they need credit (like chat), and an account's embedding in the last hour is capped.
 */
async function guardEmbedding(ctx: AppContext, workspace: WsKey, items: NewConclusion[]) {
  const block = await ctx.tenancy.budget.blocked(workspace.account);
  if (block === "credit") throw paymentRequired(outOfCreditMessage(ctx.config.server.publicUrl));
  if (block) throw paymentRequired();
  if (!ctx.config.tenancy.hosted) return;
  const adding = items.reduce((n, i) => n + countTokens(i.content), 0);
  const [r] = await rows<{ tokens: string | number }>(
    ctx.db,
    sql`SELECT COALESCE(sum(u.input_tokens), 0) AS tokens FROM llm_usage u
        JOIN workspaces w ON w.id = u.workspace_id
        WHERE w.account_id = ${workspace.account} AND u.task = 'embedding'
          AND u.created_at > now() - interval '1 hour'`,
  );
  if (Number(r?.tokens ?? 0) + adding > EXPLICIT_EMBED_TOKENS_PER_HOUR)
    throw new ApiError(429, "Too many facts added in the last hour. Try again later.");
}

export type ConclusionOut = ReturnType<typeof conclusionOut>;

/** Creates explicit conclusions (POST /conclusions); see `storeConclusions`. */
export async function createConclusions(
  ctx: AppContext,
  workspace: WsKey,
  items: NewConclusion[],
): Promise<ConclusionOut[]> {
  return (await storeConclusions(ctx, workspace, items)).map((s) => s.conclusion);
}

/**
 * Saves explicit conclusions, in input order. Embeds synchronously, then writes everything in
 * one transaction. An item whose text matches a fact that is current in the same (observer,
 * observed) collection, ignoring case and spacing, is not saved again: that fact is reinforced
 * (`times_derived` + 1, as the reasoner does when it learns a fact again) and returned, with
 * `existing: true`. Identical items in one call are saved once. `ignore` names facts that do
 * not count as a match (a correction that only changes the case of the fact it replaces).
 */
export async function storeConclusions(
  ctx: AppContext,
  workspace: WsKey,
  items: NewConclusion[],
  opts: { ignore?: readonly string[]; by?: StoredBy } = {},
): Promise<{ conclusion: ConclusionOut; existing: boolean }[]> {
  const by: StoredBy = opts.by ?? { actor: "api" };
  const tokenCounts = items.map((i) => countTokens(i.content));
  for (const tokens of tokenCounts) {
    if (tokens > EMBED_MAX_TOKENS) {
      throw unprocessable(
        `Content exceeds maximum embedding token limit of ${EMBED_MAX_TOKENS} (got ${tokens} tokens)`,
      );
    }
  }
  const events = items.map((i) => eventTime(i.event_start, i.event_end));
  for (const [n, item] of items.entries()) {
    if (item.event_start && !events[n])
      throw unprocessable(`Invalid event_start: ${item.event_start}`);
    if (item.event_end && !parseEventDate(item.event_end))
      throw unprocessable(`Invalid event_end: ${item.event_end}`);
  }
  const ws = await findWorkspace(ctx.db, workspace);
  if (!ws) throw notFound(`Workspace ${workspace.name}`);

  const peerNames = [...new Set(items.flatMap((i) => [i.observer_id, i.observed_id]))];
  const peers = await findPeers(ctx.db, ws.internal_id, peerNames);
  for (const item of items) {
    if (!peers.has(item.observer_id)) throw notFound(`Peer ${item.observer_id}`);
    const observed = peers.get(item.observed_id);
    if (!observed) throw notFound(`Peer ${item.observed_id}`);
    if (observed.isScope) {
      throw unprocessable(
        `No representation is formed of a scope: '${item.observed_id}' cannot be an observed peer`,
      );
    }
  }
  const sessionNames = [...new Set(items.map((i) => i.session_id).filter((s): s is string => !!s))];
  const sessionIds = new Map<string, string>();
  if (sessionNames.length > 0) {
    const found = await rows<{ id: string; name: string }>(
      ctx.db,
      sql`SELECT id, name FROM sessions
          WHERE workspace_id = ${ws.internal_id} AND is_active AND name IN (${sql.join(
            sessionNames.map((n) => sql`${n}`),
            sql`, `,
          )})`,
    );
    for (const s of found) sessionIds.set(s.name, s.id);
    for (const name of sessionNames) if (!sessionIds.has(name)) throw notFound(`Session ${name}`);
  }

  await guardEmbedding(ctx, workspace, items);
  const vectors = await embed(
    ctx,
    items.map((i) => i.content),
    ws.internal_id,
  );

  const ignore = new Set(opts.ignore ?? []);
  return ctx.db.transaction(async (tx) => {
    const collections = await ensureCollections(
      tx,
      ws.internal_id,
      items.map((i) => ({
        observer: peers.get(i.observer_id)!.id,
        observed: peers.get(i.observed_id)!.id,
      })),
    );
    // Taken before reading what the collections hold, in the order every fact writer uses
    // (advisory lock, then the collection row), so the reasoner cannot add the same fact
    // meanwhile and the two never wait on each other.
    await lockCollections(
      tx,
      [...collections.values()].map((c) => c.id),
    );
    const resolved = items.map((item, index) => ({
      item,
      index,
      collection: collections.get(
        `${peers.get(item.observer_id)!.id}|${peers.get(item.observed_id)!.id}`,
      )!,
    }));

    // Identical items of the call share one fact: grouped by collection and normalized text.
    const keys = await rows<{ i: number; k: string }>(
      tx,
      sql`SELECT (q.o - 1)::int AS i, ${NORMALIZED(sql`q.t`)} AS k
          FROM unnest(${textArray(items.map((i) => i.content))}) WITH ORDINALITY AS q(t, o)`,
    );
    const groupOf = new Map<number, string>();
    for (const r of keys)
      groupOf.set(Number(r.i), `${resolved[Number(r.i)]!.collection.id}\u0000${r.k}`);
    const same = new Map<string, string>();
    for (const r of await sameText(
      tx,
      [...new Set(resolved.map((r) => r.collection.id))],
      items.map((i) => i.content),
    )) {
      const key = `${r.collection_id}\u0000${r.raw}`;
      if (!ignore.has(r.id) && !same.has(key)) same.set(key, r.id);
    }

    const factOf = new Map<string, { id: string; existing: boolean }>();
    const fresh: typeof resolved = [];
    const reinforced: string[] = [];
    for (const r of resolved) {
      const group = groupOf.get(r.index)!;
      if (factOf.has(group)) continue;
      const found = same.get(`${r.collection.id}\u0000${r.item.content}`);
      if (found) {
        factOf.set(group, { id: found, existing: true });
        reinforced.push(found);
      } else {
        factOf.set(group, { id: newId(), existing: false });
        fresh.push(r);
      }
    }

    const changes: MemoryEvent[] = [];
    const logBase = (r: (typeof resolved)[number]) => ({
      workspaceId: ws.internal_id,
      collectionId: r.collection.id,
      actor: by.actor,
      actorRef: by.ref ?? null,
    });
    for (const r of resolved) {
      const fact = factOf.get(groupOf.get(r.index)!)!;
      if (
        fact.existing &&
        reinforced.includes(fact.id) &&
        !changes.some((e) => e.conclusionId === fact.id)
      )
        changes.push({
          ...logBase(r),
          conclusionId: fact.id,
          action: "reinforced",
          reason: by.reason ?? "said again",
        });
    }
    if (reinforced.length) {
      await tx.execute(
        sql`UPDATE conclusions SET times_derived = times_derived + 1, updated_at = now()
            WHERE id = ANY(${textArray(reinforced)})`,
      );
    }
    // A restated fact that had no event time takes the one this call gives; asked to pin, it is.
    for (const r of resolved) {
      const fact = factOf.get(groupOf.get(r.index)!)!;
      if (!fact.existing || !r.item.pinned) continue;
      const pinned = await rows<{ id: string }>(
        tx,
        sql`UPDATE conclusions SET pinned = true WHERE id = ${fact.id} AND NOT pinned RETURNING id`,
      );
      if (pinned.length)
        changes.push({
          ...logBase(r),
          conclusionId: fact.id,
          action: "pinned",
          reason: by.reason ?? "pinned",
        });
    }
    for (const r of resolved) {
      const event = events[r.index];
      const fact = factOf.get(groupOf.get(r.index)!)!;
      if (!event || !fact.existing) continue;
      await tx.execute(
        sql`UPDATE conclusions SET event_start = ${event.start}::timestamptz, event_end = ${event.end}::timestamptz,
              event_precision = ${event.precision}
            WHERE id = ${fact.id} AND event_start IS NULL`,
      );
    }
    if (fresh.length) {
      await tx.execute(
        sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content,
                                     level, times_derived, valid_from, event_start, event_end, event_precision,
                                     tags, pinned, expires_at, embedding, embedding_model)
            VALUES ${sql.join(
              fresh.map((r) => {
                const id = factOf.get(groupOf.get(r.index)!)!.id;
                const event = events[r.index];
                return sql`(${id}, ${ws.internal_id}, ${r.collection.id}, ${r.collection.observer_id},
                     ${r.collection.observed_id}, ${r.item.session_id ? sessionIds.get(r.item.session_id)! : null},
                     ${r.item.content}, 'explicit', 1, now(), ${event?.start ?? null}::timestamptz,
                     ${event?.end ?? null}::timestamptz, ${event?.precision ?? null},
                     ${textArray(normalizeTags(r.item.tags))}, ${r.item.pinned === true},
                     ${r.item.expires_at ? new Date(r.item.expires_at) : null}::timestamptz,
                     ${vectorLiteral(vectors[r.index]!)}::vector,
                     ${ctx.embeddings.ref})`;
              }),
              sql`, `,
            )}`,
      );
    }
    for (const r of fresh)
      changes.push({
        ...logBase(r),
        conclusionId: factOf.get(groupOf.get(r.index)!)!.id,
        action: "created",
        reason: by.reason ?? "added directly",
        after: r.item.pinned ? { pinned: true } : undefined,
      });
    await recordEvents(tx, changes);
    // Every change to a collection bumps its version (recall caches key on it).
    const perCollection = new Map<string, number>();
    for (const r of resolved) perCollection.set(r.collection.id, 0);
    for (const r of fresh)
      perCollection.set(r.collection.id, perCollection.get(r.collection.id)! + 1);
    await tx.execute(
      sql`UPDATE collections SET version = version + 1, new_since_dream = new_since_dream + v.n
          FROM (VALUES ${sql.join(
            [...perCollection].map(([id, n]) => sql`(${id}::text, ${n}::int)`),
            sql`, `,
          )}) AS v(id, n)
          WHERE collections.id = v.id`,
    );

    // Every item was embedded, so every item is charged as stored, once for this call.
    await ctx.billing.debitStore(tx, {
      workspaceId: ws.internal_id,
      source: "conclusions",
      keyIds: [newId()],
      tokenCounts,
    });

    const ids = [...new Set([...factOf.values()].map((f) => f.id))];
    const saved = await rows<ConclusionRow>(
      tx,
      sql`SELECT ${CONCLUSION_COLS} ${FROM_CONCLUSION} WHERE c.id = ANY(${textArray(ids)})`,
    );
    const byId = new Map(saved.map((r) => [r.id, conclusionOut(r)]));
    return resolved.map((r) => {
      const fact = factOf.get(groupOf.get(r.index)!)!;
      return { conclusion: byId.get(fact.id)!, existing: fact.existing };
    });
  });
}

export async function listConclusions(
  ctx: AppContext,
  workspace: WsKey,
  paging: Paging,
  filters: Record<string, unknown> | null | undefined,
  asOf: Date | null = null,
): Promise<Page<ReturnType<typeof conclusionOut>>> {
  const where: (SQL | undefined)[] = [
    sql`${wsIs(workspace)}`,
    sql`c.deleted_at IS NULL`,
    compileFilters("conclusions", filters),
    // What held on that date, as memory knows it now: begun by then and not yet replaced.
    asOf == null
      ? undefined
      : sql`COALESCE(c.valid_from, c.created_at) <= ${asOf}::timestamptz
        AND (c.valid_to IS NULL OR c.valid_to > ${asOf}::timestamptz)`,
  ];
  return paginate(ctx.db, paging, {
    select: CONCLUSION_COLS,
    from: FROM_CONCLUSION,
    where,
    keys: createdAtKeys(sql`c.created_at`, sql`c.id`),
    natural: "desc",
    map: (r) => conclusionOut(r as unknown as ConclusionRow),
  });
}

const pick = (filters: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys)
    if (typeof filters[key] === "string" && filters[key]) return filters[key] as string;
  return undefined;
};

/** Semantic search inside one (observer, observed) collection. */
export async function queryConclusions(
  ctx: AppContext,
  workspace: WsKey,
  body: {
    query: string;
    top_k: number;
    distance?: number | null;
    filters?: Record<string, unknown> | null;
    explain?: boolean;
  },
) {
  const filters = body.filters ?? {};
  const observer = pick(filters, "observer_id", "observer");
  const observed = pick(filters, "observed_id", "observed");
  if (!observer || !observed) {
    throw unprocessable(
      'observer and observed must be specified for semantic search. Provide filters={"observer_id": "...", "observed_id": "..."}',
    );
  }
  const tokens = countTokens(body.query);
  if (tokens > EMBED_MAX_TOKENS)
    throw unprocessable(`Query exceeds maximum token limit of ${EMBED_MAX_TOKENS}.`);

  const [collection] = await rows<{ id: string; workspace_id: string }>(
    ctx.db,
    sql`SELECT col.id, col.workspace_id FROM collections col
        JOIN workspaces w ON w.id = col.workspace_id
        JOIN peers obs ON obs.id = col.observer_id
        JOIN peers obd ON obd.id = col.observed_id
        WHERE ${wsIs(workspace)} AND obs.name = ${observer} AND obd.name = ${observed}`,
  );
  if (!collection) return [];

  const rest = Object.fromEntries(
    Object.entries(filters).filter(
      ([k]) => !["observer_id", "observer", "observed_id", "observed"].includes(k),
    ),
  );
  const [vector] = await embed(ctx, [body.query], collection.workspace_id);
  const literal = sql`${vectorLiteral(vector!)}::vector`;
  const conds: (SQL | undefined)[] = [
    sql`c.collection_id = ${collection.id}`,
    sql`c.deleted_at IS NULL`,
    sql`c.embedding IS NOT NULL`,
    body.distance != null ? sql`(c.embedding <=> ${literal}) <= ${body.distance}` : undefined,
    compileFilters("conclusions", rest),
  ];
  const where = sql.join(
    conds.filter((c): c is SQL => c !== undefined).map((c) => sql`(${c})`),
    sql` AND `,
  );
  const found = await rows<ConclusionRow & { dist: number | string }>(
    ctx.db,
    sql`SELECT ${CONCLUSION_COLS}, (c.embedding <=> ${literal}) + 0 AS dist ${FROM_CONCLUSION} WHERE ${where}
        ORDER BY dist, c.id LIMIT ${body.top_k}`,
  );
  return found.map((r, i) =>
    body.explain
      ? {
          ...conclusionOut(r),
          explain: { rank: i + 1, distance: Math.round(Number(r.dist) * 1e4) / 1e4 },
        }
      : conclusionOut(r),
  );
}

export async function getConclusion(ctx: AppContext, workspace: WsKey, id: string) {
  const [row] = await rows<ConclusionRow>(
    ctx.db,
    sql`SELECT ${CONCLUSION_COLS} ${FROM_CONCLUSION}
        WHERE ${wsIs(workspace)} AND c.id = ${id} AND c.deleted_at IS NULL`,
  );
  if (!row) throw notFound("Conclusion");
  return conclusionOut(row);
}

/**
 * Pins or unpins a fact. A pinned fact was set by a person: the reasoner and dreams never close,
 * merge or rewrite it, and a statement that disagrees is stored next to it as a conflict.
 */
export async function pinConclusion(
  ctx: AppContext,
  workspace: WsKey,
  id: string,
  pinned: boolean,
  by: StoredBy = { actor: "api" },
) {
  await ctx.db.transaction(async (tx) => {
    const [row] = await rows<{ workspace_id: string; collection_id: string; was: boolean }>(
      tx,
      sql`SELECT c.workspace_id, c.collection_id, c.pinned AS was FROM conclusions c JOIN workspaces w ON w.id = c.workspace_id
          WHERE ${wsIs(workspace)} AND c.id = ${id} AND c.deleted_at IS NULL FOR UPDATE OF c`,
    );
    if (!row) throw notFound("Conclusion");
    if (row.was === pinned) return;
    await tx.execute(
      sql`UPDATE conclusions SET pinned = ${pinned}, updated_at = now() WHERE id = ${id}`,
    );
    await tx.execute(
      sql`UPDATE collections SET version = version + 1 WHERE id = ${row.collection_id}`,
    );
    await recordEvents(tx, [
      {
        workspaceId: row.workspace_id,
        collectionId: row.collection_id,
        conclusionId: id,
        action: pinned ? "pinned" : "unpinned",
        actor: by.actor,
        actorRef: by.ref ?? null,
        reason: by.reason ?? null,
      },
    ]);
  });
  return getConclusion(ctx, workspace, id);
}

/** Sets or clears when a fact stops holding. */
export async function setConclusionExpiry(
  ctx: AppContext,
  workspace: WsKey,
  id: string,
  expiresAt: Date | null,
  by: StoredBy = { actor: "api" },
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await rows<{ workspace_id: string; collection_id: string }>(
      tx,
      sql`UPDATE conclusions c SET expires_at = ${expiresAt}::timestamptz, updated_at = now()
          FROM workspaces w WHERE w.id = c.workspace_id AND ${wsIs(workspace)} AND c.id = ${id}
            AND c.deleted_at IS NULL
          RETURNING c.workspace_id, c.collection_id`,
    );
    if (!row) throw notFound("Conclusion");
    await tx.execute(
      sql`UPDATE collections SET version = version + 1 WHERE id = ${row.collection_id}`,
    );
    await recordEvents(tx, [
      {
        workspaceId: row.workspace_id,
        collectionId: row.collection_id,
        conclusionId: id,
        action: "edited",
        actor: by.actor,
        actorRef: by.ref ?? null,
        reason: expiresAt ? "set when it stops holding" : "cleared its expiry",
        after: { expires_at: expiresAt?.toISOString() ?? null },
      },
    ]);
  });
}

/**
 * A fact's history: the fact, every recorded change to it (oldest first), the facts it replaced
 * and the fact that replaced it. Changes made before the log existed (October 2026) are not in it.
 */
export async function conclusionHistory(ctx: AppContext, workspace: WsKey, id: string) {
  const conclusion = await getConclusion(ctx, workspace, id);
  const [events, replaced] = await Promise.all([
    factEvents(ctx.db, id),
    rows<ConclusionRow>(
      ctx.db,
      sql`SELECT ${CONCLUSION_COLS} ${FROM_CONCLUSION}
          WHERE ${wsIs(workspace)} AND c.superseded_by = ${id} AND c.deleted_at IS NULL
          ORDER BY COALESCE(c.valid_from, c.created_at), c.id LIMIT 50`,
    ),
  ]);
  const by = conclusion.superseded_by
    ? await getConclusion(ctx, workspace, conclusion.superseded_by).catch(() => null)
    : null;
  return { conclusion, events, replaced: replaced.map(conclusionOut), replaced_by: by };
}

/** Soft delete. Bumps the collection version so cached answers are not served from it. */
export async function deleteConclusion(
  ctx: AppContext,
  workspace: WsKey,
  id: string,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    // A deletion someone asked for removes the row (right to erasure); facts the night shift
    // merges are only marked deleted, since they live on in the merged fact.
    const [row] = await rows<{ collection_id: string }>(
      tx,
      sql`DELETE FROM conclusions c USING workspaces w
          WHERE w.id = c.workspace_id AND ${wsIs(workspace)} AND c.id = ${id} AND c.deleted_at IS NULL
          RETURNING c.collection_id`,
    );
    if (!row) throw notFound("Conclusion");
    await tx.execute(
      sql`UPDATE collections SET version = version + 1 WHERE id = ${row.collection_id}`,
    );
  });
}
