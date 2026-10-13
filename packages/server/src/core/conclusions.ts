import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { compileFilters } from "../http/filters.js";
import { createdAtKeys, type Page, type Paging, paginate } from "../http/pagination.js";
import { CONCLUSION_COLS, type ConclusionRow, conclusionOut } from "../http/serialize.js";
import { ApiError, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { countTokens } from "../lib/tokens.js";
import { LlmError } from "../llm/types.js";
import { ensureCollections, lockCollections, NORMALIZED, sameText } from "../reasoner/apply.js";
import { textArray } from "../reasoner/util.js";
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
  opts: { ignore?: readonly string[] } = {},
): Promise<{ conclusion: ConclusionOut; existing: boolean }[]> {
  for (const item of items) {
    const tokens = countTokens(item.content);
    if (tokens > EMBED_MAX_TOKENS) {
      throw unprocessable(
        `Content exceeds maximum embedding token limit of ${EMBED_MAX_TOKENS} (got ${tokens} tokens)`,
      );
    }
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

    if (reinforced.length) {
      await tx.execute(
        sql`UPDATE conclusions SET times_derived = times_derived + 1, updated_at = now()
            WHERE id = ANY(${textArray(reinforced)})`,
      );
    }
    if (fresh.length) {
      await tx.execute(
        sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content,
                                     level, times_derived, valid_from, embedding, embedding_model)
            VALUES ${sql.join(
              fresh.map((r) => {
                const id = factOf.get(groupOf.get(r.index)!)!.id;
                return sql`(${id}, ${ws.internal_id}, ${r.collection.id}, ${r.collection.observer_id},
                     ${r.collection.observed_id}, ${r.item.session_id ? sessionIds.get(r.item.session_id)! : null},
                     ${r.item.content}, 'explicit', 1, now(), ${vectorLiteral(vectors[r.index]!)}::vector,
                     ${ctx.embeddings.ref})`;
              }),
              sql`, `,
            )}`,
      );
    }
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
): Promise<Page<ReturnType<typeof conclusionOut>>> {
  const where: (SQL | undefined)[] = [
    sql`${wsIs(workspace)}`,
    sql`c.deleted_at IS NULL`,
    compileFilters("conclusions", filters),
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
  const found = await rows<ConclusionRow>(
    ctx.db,
    sql`SELECT ${CONCLUSION_COLS} ${FROM_CONCLUSION} WHERE ${where}
        ORDER BY c.embedding <=> ${literal}, c.id LIMIT ${body.top_k}`,
  );
  return found.map(conclusionOut);
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
