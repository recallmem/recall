import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AppContext } from "../context.js";
import type { Db } from "../db/client.js";
import { rows } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { countTokens } from "../lib/tokens.js";
import { signalEnqueued } from "../queue/events.js";
import type { ClaimedJob, JobOutcome } from "../queue/types.js";
import { DUPLICATE_DISTANCE, lockCollections, supersededValues } from "../reasoner/apply.js";
import { applyCardEdits, cardKey, normalizeCardEntry, supportDate } from "../reasoner/cards.js";
import { type EffectiveConfig, resolveConfig } from "../reasoner/config.js";
import { cleanText, isoDay, normKey, parseVec, textArray, vec } from "../reasoner/util.js";
import { clusterBySimilarity, packClusters } from "./cluster.js";
import "./offline.js";

/**
 * Dreams: bounded consolidation of one collection (observer -> observed).
 *
 * Knowledge updates are already handled at ingest, so a dream is a cleanup
 * and generalisation pass, not an open-ended agent loop:
 *   1. take the facts that changed since the last dream plus their nearest
 *      neighbours (exact scan inside the collection),
 *   2. cluster them deterministically by embedding similarity and pack the
 *      clusters into at most MAX_CALLS call-sized groups under a token budget,
 *   3. make one structured call per group that returns merges, missed
 *      supersessions, inductive generalisations (with source ids),
 *      contradictions and peer-card edits,
 *   4. apply each group's result in one transaction.
 */

export const DREAM_LIMITS = {
  /** Facts changed since the last dream that seed a dream. */
  maxCandidates: 120,
  /** Nearest neighbours fetched per candidate. */
  neighbours: 3,
  /** Hard cap on facts considered by one dream. */
  maxFacts: 200,
  /** Cosine similarity that links two facts into one cluster. */
  linkSimilarity: 0.5,
  maxClusterSize: 40,
  /** Structured calls per dream. */
  maxCalls: 3,
  /** Fact-listing tokens per call and per dream (the fixed prompt comes on top). */
  maxTokensPerCall: 2500,
  maxTokensPerDream: 7000,
  /** Distance under which a new inductive/contradiction conclusion repeats an existing one. */
  duplicateDistance: 0.08,
};

type Tx = Pick<Db, "execute">;
export type DreamType = "omni" | "card_refresh";

export const DREAM_SYSTEM = `You consolidate long-term memory about one peer (a person, agent, bot or service; refer to it by its id).

Input: the peer's current CARD, then FACTS grouped into clusters of related items, one per line: D<n> [date level xN] text. The date is when the fact was learned; xN = how many times it was learned.

Return JSON:
merge: sets of facts that state the same thing: {ids, content}; content is one sentence keeping every detail of the set. Only true duplicates.
supersede: {old, new, keep} when "new" is a later value of the same attribute or a changed, cancelled or completed plan, and "old" is no longer true. The later date wins: never close a newer fact in favour of an older one. keep: when "old" bundles several details and only some changed, each detail of "old" that still holds, as its own sentence about the peer (old "sam uses pnpm and tabs", new "sam switched to spaces": keep ["sam uses pnpm"]); otherwise [].
inductive: generalisations backed by at least two facts: {content, sources, confidence}; a pattern, habit, preference or trait, not a restatement of one fact; confidence "low" for 2 sources, "medium" for 3-4, "high" for 5 or more.
contradictions: facts that cannot all be true and are not explained by change over time: {content, sources}; content describes the conflict.
card: {add, remove} edits to the CARD for stable identity facts likely to hold for months; entries start with IDENTITY:, ATTRIBUTE:, RELATIONSHIP: or INSTRUCTION:, use "PREFIX: Label: value", stay under 200 characters, one entry per attribute (to change a value, add it under the existing label); remove entries the facts contradict. Values come from the newest facts: never bring back a value a later fact replaced.
Cite only D handles shown. Empty lists are normal; add nothing you are unsure of.`;

export const DreamOut = z.object({
  merge: z.array(z.object({ ids: z.array(z.string()), content: z.string() })),
  supersede: z.array(z.object({ old: z.string(), new: z.string(), keep: z.array(z.string()) })),
  inductive: z.array(
    z.object({
      content: z.string(),
      sources: z.array(z.string()),
      confidence: z.enum(["low", "medium", "high"]),
    }),
  ),
  contradictions: z.array(z.object({ content: z.string(), sources: z.array(z.string()) })),
  card: z.object({ add: z.array(z.string()), remove: z.array(z.string()) }),
});
export type DreamOut = z.infer<typeof DreamOut>;

export const CARD_REFRESH_SYSTEM = `You maintain the profile card of one peer (a person, agent, bot or service): a short list of stable identity facts likely to hold for months. Entries start with IDENTITY:, ATTRIBUTE:, RELATIONSHIP: or INSTRUCTION:, use "PREFIX: Label: value", stay under 200 characters, one fact each, one entry per attribute, at most 40. Only what the peer stated or accepted about itself; no guesses, moods or one-off events.

Input: the current CARD (may be absent) and the peer's FACTS, each with the date it was learned. When facts disagree, the newer one holds. Return JSON {card}: the complete updated card.`;

export const CardRefreshOut = z.object({ card: z.array(z.string()) });

const CONFIDENCE = { low: 0.5, medium: 0.7, high: 0.85 } as const;

// ---------------------------------------------------------------- scheduling

const dreamKey = (observerId: string, observedId: string) => `dream:${observerId}:${observedId}`;

/**
 * Enqueues a dream. Automatic dreams push an already pending one later (each
 * new batch resets the idle clock); manual ones run now, are not delayed by
 * later activity, and are skipped while the same dream is running.
 */
export async function enqueueDream(
  tx: Tx,
  d: {
    workspaceId: string;
    workKey: string;
    type: DreamType;
    manual: boolean;
    runAfter: Date;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  if (d.manual) {
    const running = await rows<{ id: number }>(
      tx,
      sql`SELECT id FROM jobs WHERE work_key = ${d.workKey} AND status = 'running' LIMIT 1`,
    );
    if (running.length) return false;
  }
  const payload = JSON.stringify({ ...d.payload, type: d.type, manual: d.manual });
  await tx.execute(
    sql`INSERT INTO jobs (kind, work_key, workspace_id, payload, run_after)
        VALUES ('dream', ${d.workKey}, ${d.workspaceId}, ${payload}::jsonb, ${d.runAfter})
        ON CONFLICT (work_key) WHERE status = 'pending' AND kind IN ('reason', 'summarize', 'dream')
        DO UPDATE SET
          payload = EXCLUDED.payload || jobs.payload || jsonb_build_object(
            'type', CASE WHEN jobs.payload->>'type' = 'omni' OR EXCLUDED.payload->>'type' = 'omni'
                         THEN 'omni' ELSE 'card_refresh' END,
            'manual', COALESCE((jobs.payload->>'manual')::boolean, false)
                      OR COALESCE((EXCLUDED.payload->>'manual')::boolean, false),
            'rebuild', COALESCE((jobs.payload->>'rebuild')::boolean, false)
                       OR COALESCE((EXCLUDED.payload->>'rebuild')::boolean, false)),
          run_after = CASE
            WHEN (EXCLUDED.payload->>'manual')::boolean THEN LEAST(jobs.run_after, EXCLUDED.run_after)
            WHEN (jobs.payload->>'manual')::boolean THEN jobs.run_after
            ELSE GREATEST(jobs.run_after, EXCLUDED.run_after) END`,
  );
  signalEnqueued();
  return true;
}

/** Called by the reasoner (in its transaction) for collections it just changed. */
export async function scheduleDreamsIfDue(
  tx: Tx,
  config: Config,
  workspaceId: string,
  cfg: EffectiveConfig,
  collectionIds: string[],
): Promise<void> {
  if (!config.features.dreams || !cfg.dream.enabled || !collectionIds.length) return;
  const due = await rows<{ observer_id: string; observed_id: string }>(
    tx,
    sql`SELECT observer_id, observed_id FROM collections
        WHERE id = ANY(${textArray(collectionIds)}) AND new_since_dream >= ${config.dreams.minNewConclusions}
          AND (last_dream_at IS NULL OR last_dream_at <= now() - make_interval(secs => ${config.dreams.minIntervalMs / 1000}))`,
  );
  for (const c of due) {
    await enqueueDream(tx, {
      workspaceId,
      workKey: dreamKey(c.observer_id, c.observed_id),
      type: "omni",
      manual: false,
      runAfter: new Date(Date.now() + config.dreams.idleMs),
      payload: { observer_id: c.observer_id, observed_id: c.observed_id },
    });
  }
}

/** POST /schedule_dream. Peers are resolved by name; unknown peers make a no-op dream. */
export async function scheduleManualDream(
  ctx: AppContext,
  w: {
    workspaceId: string;
    observer: string;
    observed: string;
    type: DreamType;
    sessionName: string | null;
    rebuild: boolean;
  },
): Promise<void> {
  const peers = await rows<{ id: string; name: string }>(
    ctx.db,
    sql`SELECT id, name FROM peers WHERE workspace_id = ${w.workspaceId}
          AND name = ANY(${textArray([w.observer, w.observed])})`,
  );
  const observer = peers.find((p) => p.name === w.observer);
  const observed = peers.find((p) => p.name === w.observed);
  const workKey =
    observer && observed
      ? dreamKey(observer.id, observed.id)
      : `dream:${w.workspaceId}:${w.observer}:${w.observed}`;
  await enqueueDream(ctx.db, {
    workspaceId: w.workspaceId,
    workKey,
    type: w.type,
    manual: true,
    runAfter: new Date(),
    payload: {
      observer_id: observer?.id ?? null,
      observed_id: observed?.id ?? null,
      observer: w.observer,
      observed: w.observed,
      session: w.sessionName,
      rebuild: w.rebuild,
    },
  });
}

// ---------------------------------------------------------------- the job

/** The least time between two requested (schedule_dream) dreams of one collection. */
const MANUAL_DREAM_GAP_MS = 10 * 60_000;

interface CollectionState {
  id: string;
  workspace_id: string;
  observer_id: string;
  observed_id: string;
  observed_name: string;
  peer_card: string[];
  new_since_dream: number;
  last_dream_at: Date | string | null;
  last_activity: Date | string | null;
  wconf: Record<string, unknown>;
}

export interface FactRow {
  id: string;
  content: string;
  level: string;
  times_derived: number;
  valid_from: Date | string | null;
  created_at: Date | string;
  confidence: number;
  importance: number;
  message_ids: string[];
  source_ids: string[];
  session_id: string | null;
  category: string | null;
  embedding: string | number[] | null;
}

const FACT_COLUMNS = sql`c.id, c.content, c.level, c.times_derived, c.valid_from, c.created_at, c.confidence,
  c.importance, c.message_ids, c.source_ids, c.session_id, c.category, c.embedding::text AS embedding`;

/** When a fact became true, as far as memory knows. */
const since = (f: Pick<FactRow, "valid_from" | "created_at">) =>
  new Date(f.valid_from ?? f.created_at);
const CURRENT = sql`c.deleted_at IS NULL AND c.valid_to IS NULL`;

async function loadCollection(ctx: AppContext, job: ClaimedJob): Promise<CollectionState | null> {
  const p = job.payload;
  const where: SQL =
    p.observer_id && p.observed_id
      ? sql`col.observer_id = ${String(p.observer_id)} AND col.observed_id = ${String(p.observed_id)}`
      : sql`col.workspace_id = ${job.workspaceId} AND obs.name = ${String(p.observer ?? "")} AND obd.name = ${String(p.observed ?? "")}`;
  const [c] = await rows<CollectionState>(
    ctx.db,
    sql`SELECT col.id, col.workspace_id, col.observer_id, col.observed_id, obd.name AS observed_name, col.peer_card,
               col.new_since_dream, col.last_dream_at, w.configuration AS wconf,
               (SELECT max(c.updated_at) FROM conclusions c WHERE c.collection_id = col.id) AS last_activity
        FROM collections col
        JOIN peers obs ON obs.id = col.observer_id
        JOIN peers obd ON obd.id = col.observed_id
        JOIN workspaces w ON w.id = col.workspace_id
        WHERE ${where}`,
  );
  return c ?? null;
}

async function sessionConfig(ctx: AppContext, sessionName: unknown, workspaceId: string) {
  if (typeof sessionName !== "string" || !sessionName) return {};
  const [s] = await rows<{ configuration: Record<string, unknown> }>(
    ctx.db,
    sql`SELECT configuration FROM sessions WHERE workspace_id = ${workspaceId} AND name = ${sessionName}`,
  );
  return s?.configuration ?? {};
}

export async function handleConsolidate(ctx: AppContext, job: ClaimedJob): Promise<JobOutcome> {
  if (!ctx.config.features.dreams) return;
  const col = await loadCollection(ctx, job);
  if (!col) return;
  const manual = job.payload.manual === true;
  const cfg = resolveConfig([
    col.wconf,
    await sessionConfig(ctx, job.payload.session, col.workspace_id),
  ]);
  if (!cfg.dream.enabled) return;

  if (!manual) {
    const limits = ctx.config.dreams;
    if (col.new_since_dream < limits.minNewConclusions) return;
    const now = Date.now();
    const last = col.last_dream_at ? new Date(col.last_dream_at).getTime() : null;
    if (last !== null && now - last < limits.minIntervalMs)
      return { rescheduleAt: new Date(last + limits.minIntervalMs) };
    const activity = col.last_activity ? new Date(col.last_activity).getTime() : 0;
    if (now - activity < limits.idleMs) return { rescheduleAt: new Date(activity + limits.idleMs) };
  }

  const type: DreamType = job.payload.type === "card_refresh" ? "card_refresh" : "omni";
  // A requested dream is free, so it may not run back to back: at most one of each type per
  // collection every MANUAL_DREAM_GAP_MS, and an omni dream only when facts changed since the last.
  if (manual) {
    const [recent] = await rows<{ id: number }>(
      ctx.db,
      sql`SELECT id FROM jobs WHERE work_key = ${job.workKey} AND id <> ${job.id} AND status = 'done'
            AND payload->>'manual' = 'true' AND payload->>'type' = ${type} AND NOT payload ? 'skipped'
            AND finished_at > now() - make_interval(secs => ${MANUAL_DREAM_GAP_MS / 1000})
          LIMIT 1`,
    );
    if (recent) return { payload: { skipped: "dreamed recently" } };
    if (type === "omni" && col.last_dream_at && col.new_since_dream <= 0)
      return { payload: { skipped: "nothing new since the last dream" } };
  }
  if (type === "card_refresh") {
    if (cfg.peerCard.create) await refreshCard(ctx, col, cfg, job.payload.rebuild === true);
    return;
  }
  const stats = await dream(ctx, col, cfg);
  return { payload: { result: stats } };
}

interface DreamStats {
  facts: number;
  calls: number;
  merged: number;
  superseded: number;
  /** Details of a closed fact that still held, stored as facts of their own. */
  split: number;
  inductive: number;
  contradictions: number;
  cardChanged: boolean;
}

async function dream(
  ctx: AppContext,
  col: CollectionState,
  cfg: EffectiveConfig,
): Promise<DreamStats> {
  const L = DREAM_LIMITS;
  const lastDream = col.last_dream_at ? new Date(col.last_dream_at) : new Date(0);
  const candidates = await rows<FactRow>(
    ctx.db,
    sql`SELECT ${FACT_COLUMNS} FROM conclusions c
        WHERE c.collection_id = ${col.id} AND ${CURRENT} AND c.embedding IS NOT NULL
          AND (c.created_at > ${lastDream} OR c.updated_at > ${lastDream})
        ORDER BY c.created_at DESC, c.id LIMIT ${L.maxCandidates}`,
  );
  const stats: DreamStats = {
    facts: 0,
    calls: 0,
    merged: 0,
    superseded: 0,
    split: 0,
    inductive: 0,
    contradictions: 0,
    cardChanged: false,
  };
  if (candidates.length) {
    const ids = candidates.map((c) => c.id);
    const neighbours = await rows<FactRow>(
      ctx.db,
      sql`SELECT DISTINCT ON (x.id) x.* FROM conclusions q
          CROSS JOIN LATERAL (
            SELECT ${FACT_COLUMNS}, (c.embedding <=> q.embedding) + 0 AS d FROM conclusions c
            WHERE c.collection_id = ${col.id} AND ${CURRENT} AND c.embedding IS NOT NULL
              AND c.id <> ALL(${textArray(ids)})
            ORDER BY d LIMIT ${L.neighbours}) x
          WHERE q.id = ANY(${textArray(ids)})
          ORDER BY x.id`,
    );
    const facts = [
      ...candidates,
      ...neighbours.slice(0, Math.max(0, L.maxFacts - candidates.length)),
    ].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
        a.id.localeCompare(b.id),
    );
    stats.facts = facts.length;
    const lines = facts.map(
      (f, i) =>
        `D${i + 1} [${isoDay(new Date(f.valid_from ?? f.created_at))} ${f.level} x${f.times_derived}] ${f.content}`,
    );
    const clusters = clusterBySimilarity(
      facts.map((f) => parseVec(f.embedding) ?? []),
      { threshold: L.linkSimilarity, maxSize: L.maxClusterSize },
    );
    const lineTokens = lines.map((l) => countTokens(l) + 1);
    const groups = packClusters(clusters, (i) => lineTokens[i]!, {
      maxTokensPerCall: L.maxTokensPerCall,
      maxCalls: L.maxCalls,
      maxTotalTokens: L.maxTokensPerDream,
    }).filter((g) => g.flat().length >= 2);
    for (const group of groups) {
      const card = await currentCard(ctx, col.id);
      const listing = group.map((cluster) => cluster.map((i) => lines[i]).join("\n")).join("\n\n");
      const handles = new Map(group.flat().map((i) => [`D${i + 1}`, facts[i]!]));
      const context = [
        `PEER: ${col.observed_name}`,
        cfg.peerCard.create
          ? `CARD: ${card.length ? card.join(" | ") : "(empty)"}`
          : "CARD: not used, return empty edits",
        cfg.dream.instructions ? `APPLICATION INSTRUCTIONS:\n${cfg.dream.instructions}` : "",
        cfg.peerCard.create && cfg.peerCard.instructions
          ? `APPLICATION INSTRUCTIONS FOR CARDS:\n${cfg.peerCard.instructions}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      const { data } = await ctx.llm.structured(
        {
          task: "dream",
          workspaceId: col.workspace_id,
          system: DREAM_SYSTEM,
          context,
          messages: [{ role: "user", content: `FACTS\n${listing}` }],
          effort: "low",
          maxTokens: Math.min(3000, 300 + 25 * handles.size),
        },
        DreamOut,
        "memory_consolidation",
      );
      stats.calls++;
      await applyDream(ctx, col, cfg, handles, data, stats);
    }
  }
  await ctx.db.execute(
    sql`UPDATE collections SET last_dream_at = now(), new_since_dream = 0, version = version + 1 WHERE id = ${col.id}`,
  );
  return stats;
}

async function currentCard(ctx: AppContext, collectionId: string): Promise<string[]> {
  const [r] = await rows<{ peer_card: string[] }>(
    ctx.db,
    sql`SELECT peer_card FROM collections WHERE id = ${collectionId}`,
  );
  return Array.isArray(r?.peer_card) ? r.peer_card : [];
}

async function applyDream(
  ctx: AppContext,
  col: CollectionState,
  cfg: EffectiveConfig,
  handles: Map<string, FactRow>,
  out: DreamOut,
  stats: DreamStats,
): Promise<void> {
  const resolve = (hs: string[]) =>
    [...new Set(hs.map((h) => h.trim()))].map((h) => handles.get(h)).filter((f) => f !== undefined);
  const merges = out.merge
    .map((m) => ({ facts: resolve(m.ids), content: cleanText(m.content) }))
    .filter((m) => m.facts.length >= 2);
  const inductive = out.inductive
    .map((x) => ({
      facts: resolve(x.sources),
      content: cleanText(x.content),
      confidence: CONFIDENCE[x.confidence],
    }))
    .filter((x) => x.facts.length >= 2 && x.content.length >= 3);
  const contradictions = out.contradictions
    .map((x) => ({ facts: resolve(x.sources), content: cleanText(x.content) }))
    .filter((x) => x.facts.length >= 2 && x.content.length >= 3);
  // The fact with the later date stays current whatever order the model gave. The details the
  // closed fact bundled that still hold (`keep`) become facts of their own, so closing
  // "pnpm, tabs and strict mode" for "spaces" leaves pnpm and strict mode in memory; they are
  // taken only when the model closed the fact it described.
  const supersedes = out.supersede.flatMap((s) => {
    const [oldF, newF] = [handles.get(s.old.trim()), handles.get(s.new.trim())];
    if (!oldF || !newF || oldF.id === newF.id) return [];
    const [older, newer] = since(oldF) <= since(newF) ? [oldF, newF] : [newF, oldF];
    const keep =
      older === oldF
        ? [...new Set((s.keep ?? []).map((k) => cleanText(k)))]
            .filter((k) => k.length >= 3 && normKey(k) !== normKey(oldF.content))
            .slice(0, 8)
        : [];
    return [{ older, newer, keep }];
  });

  // One embedding batch for every new text.
  const texts = [
    ...merges.map((m) => m.content),
    ...inductive.map((x) => x.content),
    ...contradictions.map((x) => x.content),
    ...supersedes.flatMap((s) => s.keep),
  ];
  const vectors = texts.length ? await ctx.embeddings.embed(texts, col.workspace_id) : [];
  let v = 0;
  let k = merges.length + inductive.length + contradictions.length;
  const consumed = new Set<string>();
  const survivorOf = new Map<string, FactRow>();

  await ctx.db.transaction(async (tx) => {
    await lockCollections(tx, [col.id]);
    for (const m of merges) {
      const vector = vectors[v++]!;
      const live = await currentIds(
        tx,
        m.facts.map((f) => f.id),
      );
      const facts = m.facts.filter((f) => live.has(f.id) && !consumed.has(f.id));
      if (facts.length < 2) continue;
      facts.sort(
        (a, b) =>
          b.times_derived - a.times_derived ||
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      const [survivor, ...rest] = facts as [FactRow, ...FactRow[]];
      const changed = m.content && normKey(m.content) !== normKey(survivor.content);
      const validFrom = minDate(facts.map((f) => f.valid_from));
      await tx.execute(
        sql`UPDATE conclusions SET
              content = ${changed ? m.content : survivor.content},
              embedding = ${changed ? vec(vector) : sql`embedding`},
              level = ${facts.some((f) => f.level === "explicit") ? "explicit" : survivor.level},
              times_derived = ${facts.reduce((n, f) => n + f.times_derived, 0)},
              message_ids = ${textArray([...new Set(facts.flatMap((f) => f.message_ids ?? []))])},
              source_ids = ${textArray([...new Set(facts.flatMap((f) => f.source_ids ?? []))])},
              confidence = ${Math.max(...facts.map((f) => f.confidence))}::real,
              importance = ${Math.max(...facts.map((f) => f.importance))}::real,
              valid_from = ${validFrom}::timestamptz, updated_at = now()
            WHERE id = ${survivor.id}`,
      );
      await tx.execute(
        sql`UPDATE conclusions SET deleted_at = now(), superseded_by = ${survivor.id}, updated_at = now(),
              internal = internal || ${JSON.stringify({ merged_into: survivor.id })}::jsonb
            WHERE id = ANY(${textArray(rest.map((f) => f.id))})`,
      );
      // History that a merged fact had replaced now names the survivor (the API's `superseded_by`).
      await tx.execute(
        sql`UPDATE conclusions SET superseded_by = ${survivor.id}
            WHERE collection_id = ${col.id} AND deleted_at IS NULL
              AND superseded_by = ANY(${textArray(rest.map((f) => f.id))})`,
      );
      for (const f of rest) {
        consumed.add(f.id);
        survivorOf.set(f.id, survivor);
      }
      stats.merged += rest.length;
    }

    for (const { older, newer, keep } of supersedes) {
      const keepVectors = keep.map(() => vectors[k++]!);
      if (consumed.has(older.id) || consumed.has(newer.id)) continue;
      const done = await rows<{ id: string }>(
        tx,
        sql`UPDATE conclusions SET valid_to = GREATEST(COALESCE(valid_from, created_at), ${since(newer)}::timestamptz),
              superseded_by = ${newer.id}, updated_at = now()
            WHERE id = ${older.id} AND deleted_at IS NULL AND valid_to IS NULL RETURNING id`,
      );
      if (!done.length) continue;
      consumed.add(older.id);
      stats.superseded++;
      for (const [i, content] of keep.entries()) {
        const vector = keepVectors[i]!;
        // Already in memory on its own (or now part of the new fact): nothing to split off.
        const [near] = await rows<{ d: number }>(
          tx,
          sql`SELECT (c.embedding <=> ${vec(vector)}) + 0 AS d FROM conclusions c
              WHERE c.collection_id = ${col.id} AND ${CURRENT} AND c.embedding IS NOT NULL
              ORDER BY 1 LIMIT 1`,
        );
        if (near && Number(near.d) <= DUPLICATE_DISTANCE) continue;
        await tx.execute(
          sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content,
                level, category, confidence, importance, times_derived, message_ids, source_ids, valid_from,
                embedding, embedding_model, internal)
              VALUES (${newId()}, ${col.workspace_id}, ${col.id}, ${col.observer_id}, ${col.observed_id},
                ${older.session_id}, ${content}, ${older.level}, ${older.category}, ${older.confidence}::real,
                ${older.importance}::real, ${older.times_derived}, ${textArray(older.message_ids ?? [])},
                ${textArray(older.source_ids ?? [])}, ${since(older)}::timestamptz, ${vec(vector)},
                ${ctx.embeddings.ref}, ${JSON.stringify({ key: newId(), split_from: older.id })}::jsonb)`,
        );
        stats.split++;
      }
    }

    const derived = [
      ...inductive.map((x) => ({ ...x, level: "inductive" as const })),
      ...contradictions.map((x) => ({ ...x, level: "contradiction" as const, confidence: 0.8 })),
    ];
    for (const raw of derived) {
      const vector = vectors[v++]!;
      // Cite the survivor of a merge, never the row merged away.
      const d = {
        ...raw,
        facts: [
          ...new Map(
            raw.facts.map((f) => survivorOf.get(f.id) ?? f).map((f) => [f.id, f]),
          ).values(),
        ],
      };
      if (d.facts.length < 2) continue;
      const [near] = await rows<{ id: string; d: number }>(
        tx,
        sql`SELECT c.id, (c.embedding <=> ${vec(vector)}) + 0 AS d FROM conclusions c
            WHERE c.collection_id = ${col.id} AND ${CURRENT} AND c.level = ${d.level} AND c.embedding IS NOT NULL
            ORDER BY 2 LIMIT 1`,
      );
      const sourceIds = d.facts.map((f) => f.id);
      if (near && Number(near.d) <= DREAM_LIMITS.duplicateDistance) {
        await tx.execute(
          sql`UPDATE conclusions SET times_derived = times_derived + 1, updated_at = now(),
                source_ids = ARRAY(SELECT DISTINCT unnest(source_ids || ${textArray(sourceIds)}))
              WHERE id = ${near.id}`,
        );
        continue;
      }
      const messageIds = [...new Set(d.facts.flatMap((f) => f.message_ids ?? []))].slice(0, 50);
      await tx.execute(
        sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content, level,
              category, confidence, importance, source_ids, message_ids, valid_from, embedding, embedding_model, internal)
            VALUES (${newId()}, ${col.workspace_id}, ${col.id}, ${col.observer_id}, ${col.observed_id}, NULL, ${d.content},
              ${d.level}, ${d.level === "inductive" ? "pattern" : "conflict"}, ${d.confidence}::real,
              ${Math.max(...d.facts.map((f) => f.importance))}::real, ${textArray(sourceIds)}, ${textArray(messageIds)},
              ${maxDate(d.facts.map((f) => f.valid_from ?? f.created_at))}::timestamptz, ${vec(vector)},
              ${ctx.embeddings.ref}, ${JSON.stringify({ key: newId(), dream: true })}::jsonb)`,
      );
      if (d.level === "inductive") stats.inductive++;
      else stats.contradictions++;
    }

    if (cfg.peerCard.create && (out.card.add.length || out.card.remove.length)) {
      const [r] = await rows<{ peer_card: string[]; card_dates: Record<string, string> | null }>(
        tx,
        sql`SELECT peer_card, card_dates FROM collections WHERE id = ${col.id}`,
      );
      const current = Array.isArray(r?.peer_card) ? r.peer_card : [];
      // An entry rests on the newest still-current fact that names its value. Entries learned
      // before cards were dated get that date now, so the comparison below covers them too.
      const facts = [...handles.values()]
        .filter((f) => !consumed.has(f.id))
        .map((f) => ({ content: f.content, at: since(f) }));
      const dates = { ...(r?.card_dates ?? {}) };
      for (const e of current) {
        const at = dates[cardKey(e)] ? null : supportDate(e, facts);
        if (at) dates[cardKey(e)] = at.toISOString();
      }
      const newest = facts.reduce<Date | null>((m, f) => (!m || f.at > m ? f.at : m), null);
      const removing = new Set(out.card.remove);
      const stale = await supersededValues(tx, col.id, out.card.add);
      // A value replaces an entry only when newer facts back it than the entry (a tie keeps
      // the entry), and a value only closed facts hold is not put back.
      const { card, changed, datesChanged } = applyCardEdits(
        current,
        out.card.add.filter((a) => !stale.has(a)),
        out.card.remove,
        {
          asOf: (e) => (removing.has(e) ? newest : supportDate(e, facts)),
          dates,
          ties: "keep",
        },
      );
      if (changed || datesChanged) {
        await tx.execute(
          sql`UPDATE collections SET peer_card = ${JSON.stringify(card)}::jsonb, card_dates = ${JSON.stringify(dates)}::jsonb,
                card_updated_at = ${changed ? sql`now()` : sql`card_updated_at`}
              WHERE id = ${col.id}`,
        );
        stats.cardChanged = changed;
      }
    }
    await tx.execute(sql`UPDATE collections SET version = version + 1 WHERE id = ${col.id}`);
  });
}

async function currentIds(tx: Tx, ids: string[]): Promise<Set<string>> {
  const found = await rows<{ id: string }>(
    tx,
    sql`SELECT id FROM conclusions WHERE id = ANY(${textArray(ids)}) AND deleted_at IS NULL AND valid_to IS NULL`,
  );
  return new Set(found.map((r) => r.id));
}

const minDate = (ds: (Date | string | null)[]) => {
  const t = ds.filter((d) => d != null).map((d) => new Date(d!).getTime());
  return t.length ? new Date(Math.min(...t)) : null;
};
const maxDate = (ds: (Date | string)[]) =>
  new Date(Math.max(...ds.map((d) => new Date(d).getTime())));

/** `card_refresh`: one call that rewrites the card from the collection's strongest facts. */
async function refreshCard(
  ctx: AppContext,
  col: CollectionState,
  cfg: EffectiveConfig,
  rebuild: boolean,
): Promise<void> {
  const facts = await rows<{
    content: string;
    valid_from: Date | string | null;
    created_at: Date | string;
  }>(
    ctx.db,
    sql`SELECT c.content, c.valid_from, c.created_at FROM conclusions c WHERE c.collection_id = ${col.id} AND ${CURRENT}
          AND c.level IN ('explicit', 'deductive')
        ORDER BY (c.category IN ('identity', 'relationship', 'instruction')) DESC, c.importance DESC,
                 c.times_derived DESC, c.created_at DESC
        LIMIT 60`,
  );
  if (!facts.length && rebuild) return;
  const card = rebuild ? [] : await currentCard(ctx, col.id);
  const { data } = await ctx.llm.structured(
    {
      task: "card",
      workspaceId: col.workspace_id,
      system: CARD_REFRESH_SYSTEM,
      context: [
        `PEER: ${col.observed_name}`,
        rebuild
          ? "CARD: (rebuild from the facts only)"
          : `CARD: ${card.length ? card.join(" | ") : "(empty)"}`,
        cfg.peerCard.instructions
          ? `APPLICATION INSTRUCTIONS FOR CARDS:\n${cfg.peerCard.instructions}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      messages: [
        {
          role: "user",
          content: `FACTS\n${facts.map((f) => `- [${isoDay(since(f))}] ${f.content}`).join("\n")}`,
        },
      ],
      effort: "low",
      maxTokens: 1200,
    },
    CardRefreshOut,
    "peer_card",
  );
  const entries = data.card.map((e) => normalizeCardEntry(e) ?? "").filter(Boolean);
  const stale = await supersededValues(ctx.db, col.id, entries);
  const next = applyCardEdits(
    [],
    entries.filter((e) => !stale.has(e)),
    [],
  ).card;
  if (!next.length && card.length) return; // nothing valid: keep the existing card
  // Each entry is dated by the newest fact that names its value.
  const dated = facts.map((f) => ({ content: f.content, at: since(f) }));
  const dates: Record<string, string> = {};
  for (const e of next) {
    const at = supportDate(e, dated);
    if (at) dates[cardKey(e)] = at.toISOString();
  }
  await ctx.db.execute(
    sql`UPDATE collections SET peer_card = ${JSON.stringify(next)}::jsonb, card_dates = ${JSON.stringify(dates)}::jsonb,
          card_updated_at = now(), version = version + 1
        WHERE id = ${col.id}`,
  );
}
