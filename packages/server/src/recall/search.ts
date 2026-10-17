import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { type EventTime, eventOf } from "../lib/event-time.js";
import { and, inList, num, rrf, toDate, tsQuery, vecLiteral } from "./util.js";
import { vectorRows } from "./vector.js";

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageRow {
  seq: number;
  id: string;
  content: string;
  metadata: Obj;
  tokenCount: number;
  createdAt: Date;
  seqInSession: number;
  sessionInternal: string;
  peerInternal: string;
  sessionName: string;
  peerName: string;
  workspaceName: string;
}

export interface MessageHit {
  row: MessageRow;
  score: number;
  /** Best cosine distance over the query embeddings, when the message was reached by a vector leg. */
  dist: number | null;
  lexical: boolean;
  /** Its place (1 = first) in the best vector leg and in the full-text leg, when it was in them. */
  vectorRank?: number | null;
  lexicalRank?: number | null;
}

/** Table aliases fixed by the `compileFilters("messages", …)` contract: m, s, p, w. */
export const MSG_FROM = sql`messages m JOIN sessions s ON s.id = m.session_id JOIN peers p ON p.id = m.peer_id JOIN workspaces w ON w.id = m.workspace_id`;
export const MSG_COLS = sql`m.seq, m.id, m.content, m.metadata, m.token_count, m.created_at, m.seq_in_session,
  m.session_id AS session_internal, m.peer_id AS peer_internal, s.name AS session_name, p.name AS peer_name, w.name AS workspace_name`;

export function mapMessage(r: Obj): MessageRow {
  return {
    seq: num(r.seq),
    id: r.id as string,
    content: r.content as string,
    metadata: (r.metadata ?? {}) as Obj,
    tokenCount: num(r.token_count),
    createdAt: toDate(r.created_at as string)!,
    seqInSession: num(r.seq_in_session),
    sessionInternal: r.session_internal as string,
    peerInternal: r.peer_internal as string,
    sessionName: r.session_name as string,
    peerName: r.peer_name as string,
    workspaceName: r.workspace_name as string,
  };
}

/** Relaxed-order index scans may return neighbours slightly out of order; rank positions feed RRF. */
const byDistance = (list: Obj[]): Obj[] => list.sort((a, b) => num(a.dist) - num(b.dist));

export interface MessageSearch {
  workspaceId: string;
  query: string;
  /** Query embeddings (one per query variant); empty degrades to the lexical leg alone. */
  vectors: number[][];
  limit: number;
  /** Extra condition over the aliases m, s, p, w. */
  cond?: SQL | undefined;
}

/**
 * Hybrid message search: one cosine leg per query embedding plus a `simple`
 * full-text leg, each over-fetched to 2x the limit and fused with RRF (k = 60).
 * The lexical leg also sees messages whose embedding is still pending.
 */
export async function searchMessages(ctx: AppContext, p: MessageSearch): Promise<MessageHit[]> {
  const pool = Math.max(p.limit * 2, 6);
  const where = and(sql`m.workspace_id = ${p.workspaceId}`, p.cond);
  const legs: Promise<Obj[]>[] = p.vectors.map((v) => {
    const lit = vecLiteral(v);
    return vectorRows<Obj>(
      ctx,
      sql`SELECT ${MSG_COLS}, m.embedding <=> ${lit}::vector AS dist FROM ${MSG_FROM}
          WHERE ${where} AND m.embedding IS NOT NULL ORDER BY dist LIMIT ${pool}`,
    ).then(byDistance);
  });
  const tsq = tsQuery(p.query);
  const lexIdx = tsq ? legs.length : -1;
  if (tsq) {
    legs.push(
      rows<Obj>(
        ctx.db,
        sql`SELECT ${MSG_COLS}, ts_rank_cd(m.tsv, ${tsq}, 1) AS rank FROM ${MSG_FROM}
            WHERE ${where} AND m.tsv @@ ${tsq} ORDER BY rank DESC, m.seq DESC LIMIT ${pool}`,
      ),
    );
  }
  const results = await Promise.all(legs);
  const byseq = new Map<number, MessageHit>();
  const lists = results.map((list, i) =>
    list.map((r, at) => {
      const row = mapMessage(r);
      const hit = byseq.get(row.seq) ?? { row, score: 0, dist: null, lexical: false };
      if (i === lexIdx) {
        hit.lexical = true;
        hit.lexicalRank = at + 1;
      } else {
        const d = num(r.dist);
        hit.dist = hit.dist == null ? d : Math.min(hit.dist, d);
        hit.vectorRank = Math.min(hit.vectorRank ?? Number.POSITIVE_INFINITY, at + 1);
      }
      byseq.set(row.seq, hit);
      return row.seq;
    }),
  );
  const fused = rrf(lists);
  for (const [seq, score] of fused) byseq.get(seq)!.score = score;
  return [...byseq.values()]
    .sort((a, b) => b.score - a.score || b.row.seq - a.row.seq)
    .slice(0, p.limit);
}

/** Messages by session and per-session sequence range, for snippet expansion. */
export async function messagesAround(
  ctx: AppContext,
  wsId: string,
  anchors: { sessionInternal: string; seqInSession: number }[],
  radius: number,
  cond?: SQL,
): Promise<MessageRow[]> {
  if (!anchors.length) return [];
  const ranges = anchors.map(
    (a) =>
      sql`(m.session_id = ${a.sessionInternal} AND m.seq_in_session BETWEEN ${a.seqInSession - radius} AND ${a.seqInSession + radius})`,
  );
  const r = await rows<Obj>(
    ctx.db,
    sql`SELECT ${MSG_COLS} FROM ${MSG_FROM}
        WHERE m.workspace_id = ${wsId} AND (${sql.join(ranges, sql` OR `)}) AND ${and(cond)}
        ORDER BY m.session_id, m.seq_in_session`,
  );
  return r.map(mapMessage);
}

/** Messages by id, oldest first (the ones `cond` lets through). */
export async function messagesByIds(
  ctx: AppContext,
  wsId: string,
  ids: readonly string[],
  cond?: SQL,
): Promise<MessageRow[]> {
  if (!ids.length) return [];
  const r = await rows<Obj>(
    ctx.db,
    sql`SELECT ${MSG_COLS} FROM ${MSG_FROM}
        WHERE m.workspace_id = ${wsId} AND ${inList(sql`m.id`, ids)} AND ${and(cond)}
        ORDER BY m.seq`,
  );
  return r.map(mapMessage);
}

// ---------------------------------------------------------------------------
// Conclusions
// ---------------------------------------------------------------------------

export type ConclusionLevel = "explicit" | "deductive" | "inductive" | "contradiction";

export interface ConclusionRow {
  id: string;
  content: string;
  level: ConclusionLevel;
  category: string | null;
  confidence: number;
  importance: number;
  timesDerived: number;
  sourceIds: string[];
  messageIds: string[];
  sessionInternal: string | null;
  sessionName: string | null;
  observerInternal: string;
  observedInternal: string;
  observerName: string;
  observedName: string;
  validFrom: Date | null;
  validTo: Date | null;
  supersededBy: string | null;
  /** When what the fact describes happened or began (null when it has no time of its own). */
  event: EventTime | null;
  /** Set by a person; never changed by the reasoner or dreams. */
  pinned: boolean;
  createdAt: Date;
}

export interface ConclusionHit {
  row: ConclusionRow;
  /** Best cosine distance to the query (null without an embedding or a query). */
  dist: number | null;
  lexical: boolean;
  /** RRF score normalised to (0, 1]: 1 means rank 1 in every leg. */
  rel: number;
}

/** Aliases: c (conclusions), obs/obd (observer/observed peers), s (sessions, LEFT JOIN). */
export const CONC_FROM = sql`conclusions c JOIN peers obs ON obs.id = c.observer_id JOIN peers obd ON obd.id = c.observed_id LEFT JOIN sessions s ON s.id = c.session_id`;
export const CONC_COLS = sql`c.id, c.content, c.level, c.category, c.confidence, c.importance, c.times_derived,
  c.source_ids, c.message_ids, c.session_id, s.name AS session_name, c.observer_id, c.observed_id,
  obs.name AS observer_name, obd.name AS observed_name, c.valid_from, c.valid_to, c.superseded_by, c.created_at,
  c.event_start, c.event_end, c.event_precision, c.pinned`;

export function mapConclusion(r: Obj): ConclusionRow {
  return {
    id: r.id as string,
    content: r.content as string,
    level: r.level as ConclusionLevel,
    category: (r.category as string | null) ?? null,
    confidence: num(r.confidence),
    importance: num(r.importance),
    timesDerived: num(r.times_derived),
    sourceIds: (r.source_ids as string[] | null) ?? [],
    messageIds: (r.message_ids as string[] | null) ?? [],
    sessionInternal: (r.session_id as string | null) ?? null,
    sessionName: (r.session_name as string | null) ?? null,
    observerInternal: r.observer_id as string,
    observedInternal: r.observed_id as string,
    observerName: r.observer_name as string,
    observedName: r.observed_name as string,
    validFrom: toDate(r.valid_from as string | null),
    validTo: toDate(r.valid_to as string | null),
    supersededBy: (r.superseded_by as string | null) ?? null,
    event: eventOf(r as Parameters<typeof eventOf>[0]),
    pinned: r.pinned === true,
    createdAt: toDate(r.created_at as string)!,
  };
}

export type FactState = "current" | "superseded" | "all";

export function stateCond(state: FactState): SQL {
  // A fact past its expiry date no longer holds, even before the sweep closes it.
  if (state === "current")
    return sql`c.deleted_at IS NULL AND c.valid_to IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())`;
  if (state === "superseded")
    return sql`c.deleted_at IS NULL AND (c.valid_to IS NOT NULL OR c.expires_at <= now())`;
  return sql`c.deleted_at IS NULL`;
}

/** Which collection(s): one (observer, observed) pair, or every peer's own ("global") collection. */
export function pairCond(wsId: string, observerId: string | null, observedId: string | null): SQL {
  if (observerId && observedId) {
    return sql`c.workspace_id = ${wsId} AND c.observer_id = ${observerId} AND c.observed_id = ${observedId}`;
  }
  return sql`c.workspace_id = ${wsId} AND c.observer_id = c.observed_id`;
}

/**
 * Session allowlist for conclusions. Explicit conclusions must be filed under an
 * allowed session. A derived conclusion is served only when every one of its
 * sources is itself an explicit conclusion of an allowed session, so provenance
 * provably stays inside the allowlist (the reference drops derived levels entirely).
 */
export function allowlistCond(ids: string[]): SQL {
  if (!ids.length) return sql`FALSE`;
  return sql`(c.level = 'explicit' AND ${inList(sql`c.session_id`, ids)})
    OR (c.level <> 'explicit' AND cardinality(c.source_ids) > 0 AND NOT EXISTS (
      SELECT 1 FROM unnest(c.source_ids) AS src(id) LEFT JOIN conclusions sc ON sc.id = src.id
      WHERE sc.id IS NULL OR sc.level <> 'explicit' OR sc.session_id IS NULL OR NOT (${inList(sql`sc.session_id`, ids)})))`;
}

export interface ConclusionSearch {
  workspaceId: string;
  query: string;
  vectors: number[][];
  /** Candidates to keep after fusion. */
  pool: number;
  /** Condition built from pairCond / allowlistCond. */
  cond: SQL;
  state: FactState;
}

/**
 * Hybrid conclusion search: cosine legs plus a `simple` full-text leg over the
 * `tsv` column, fused with RRF. State defaults to current facts; superseded
 * rows are only reached when explicitly asked for.
 */
export async function searchConclusions(
  ctx: AppContext,
  p: ConclusionSearch,
): Promise<ConclusionHit[]> {
  const where = and(p.cond, stateCond(p.state));
  const leg = Math.max(p.pool * 2, 10);
  const first = p.vectors[0] ? vecLiteral(p.vectors[0]) : null;
  const legs: Promise<Obj[]>[] = p.vectors.map((v) => {
    const lit = vecLiteral(v);
    return vectorRows<Obj>(
      ctx,
      sql`SELECT ${CONC_COLS}, c.embedding <=> ${lit}::vector AS dist FROM ${CONC_FROM}
          WHERE ${where} AND c.embedding IS NOT NULL ORDER BY dist LIMIT ${leg}`,
    ).then(byDistance);
  });
  const tsq = tsQuery(p.query);
  const lexIdx = tsq ? legs.length : -1;
  if (tsq) {
    const dist = first ? sql`c.embedding <=> ${first}::vector` : sql`NULL::float8`;
    legs.push(
      rows<Obj>(
        ctx.db,
        sql`SELECT ${CONC_COLS}, ${dist} AS dist FROM ${CONC_FROM}
            WHERE ${where} AND c.tsv @@ ${tsq}
            ORDER BY ts_rank_cd(c.tsv, ${tsq}, 1) DESC, c.created_at DESC LIMIT ${leg}`,
      ),
    );
  }
  const results = await Promise.all(legs);
  const byId = new Map<string, ConclusionHit>();
  const lists = results.map((list, i) =>
    list.map((r) => {
      const row = mapConclusion(r);
      const hit = byId.get(row.id) ?? { row, dist: null, lexical: false, rel: 0 };
      if (i === lexIdx) hit.lexical = true;
      if (r.dist != null) {
        const d = num(r.dist);
        hit.dist = hit.dist == null ? d : Math.min(hit.dist, d);
      }
      byId.set(row.id, hit);
      return row.id;
    }),
  );
  const fused = rrf(lists);
  const max = results.length / 61;
  for (const [id, score] of fused) byId.get(id)!.rel = max ? score / max : 0;
  return [...byId.values()].sort((a, b) => b.rel - a.rel).slice(0, p.pool);
}

/** Newest-first listing used for the recency/importance pool. */
export async function listConclusions(
  ctx: AppContext,
  p: { cond: SQL; state: FactState; order: "recent" | "frequent"; limit: number },
): Promise<ConclusionRow[]> {
  const order =
    p.order === "recent"
      ? sql`c.created_at DESC, c.id`
      : sql`c.times_derived DESC, c.created_at DESC, c.id`;
  const r = await rows<Obj>(
    ctx.db,
    sql`SELECT ${CONC_COLS} FROM ${CONC_FROM} WHERE ${and(p.cond, stateCond(p.state))} ORDER BY ${order} LIMIT ${p.limit}`,
  );
  return r.map(mapConclusion);
}

export async function conclusionsByIds(ctx: AppContext, ids: string[]): Promise<ConclusionRow[]> {
  if (!ids.length) return [];
  const r = await rows<Obj>(
    ctx.db,
    sql`SELECT ${CONC_COLS} FROM ${CONC_FROM} WHERE ${inList(sql`c.id`, ids)}`,
  );
  return r.map(mapConclusion);
}

/** Facts that the given current facts replaced (newest replacement first). */
export async function predecessorsOf(ctx: AppContext, ids: string[]): Promise<ConclusionRow[]> {
  if (!ids.length) return [];
  const r = await rows<Obj>(
    ctx.db,
    sql`SELECT ${CONC_COLS} FROM ${CONC_FROM}
        WHERE c.deleted_at IS NULL AND ${inList(sql`c.superseded_by`, ids)} ORDER BY c.valid_to DESC NULLS LAST`,
  );
  return r.map(mapConclusion);
}

// ---------------------------------------------------------------------------
// Ranking shared by representation and chat
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Query-independent usefulness of a fact in [0, 1]: how important it was judged,
 * how often it was re-derived, and how recent it is (half-life about four months).
 */
export function priorScore(r: ConclusionRow, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - (r.validFrom ?? r.createdAt).getTime()) / DAY_MS);
  const reinforcement = Math.min(1, Math.log2(1 + r.timesDerived) / 3);
  return 0.45 * r.importance + 0.25 * reinforcement + 0.3 * Math.exp(-ageDays / 180);
}

/** The single ranking: relevance to the query (when there is one) first, the prior as a tiebreaker. */
export function rankScore(hit: { row: ConclusionRow; rel: number }, now: Date): number {
  return hit.rel + 0.15 * priorScore(hit.row, now);
}
