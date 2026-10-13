import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rows } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { countTokens } from "../lib/tokens.js";

/**
 * Session summaries (contract 4): at most one current `short` and one current
 * `long` row per session, each cumulative up to `end_seq`, plus append-only
 * `block` rows (a synopsis of one processed window, written once).
 *
 * - short: rewritten by an LLM from the previous short summary plus new
 *   messages, normally inside the reasoner's extraction call (no extra call).
 * - long: assembled from the previous long summary plus the block synopses
 *   since its end, condensed by an LLM only when it outgrows its budget.
 */

export type SummaryKind = "block" | "short" | "long";

export interface SummaryRow {
  id: string;
  kind: SummaryKind;
  startSeq: number;
  endSeq: number;
  lastMessageId: string;
  content: string;
  tokenCount: number;
  createdAt: Date;
}

type Tx = Pick<Db, "execute">;

interface RawRow {
  id: string;
  kind: SummaryKind;
  start_seq: number | string;
  end_seq: number | string;
  last_message_id: string;
  content: string;
  token_count: number;
  created_at: Date | string;
}

const toRow = (r: RawRow): SummaryRow => ({
  id: r.id,
  kind: r.kind,
  startSeq: Number(r.start_seq),
  endSeq: Number(r.end_seq),
  lastMessageId: r.last_message_id,
  content: r.content,
  tokenCount: r.token_count,
  createdAt: new Date(r.created_at),
});

export async function loadSummaries(
  db: Tx,
  sessionId: string,
): Promise<{ short: SummaryRow | null; long: SummaryRow | null }> {
  const found = await rows<RawRow>(
    db,
    sql`SELECT DISTINCT ON (kind) id, kind, start_seq, end_seq, last_message_id, content, token_count, created_at
        FROM summary_blocks WHERE session_id = ${sessionId} AND kind IN ('short', 'long')
        ORDER BY kind, end_seq DESC, created_at DESC`,
  );
  const byKind = new Map(found.map((r) => [r.kind, toRow(r)]));
  return { short: byKind.get("short") ?? null, long: byKind.get("long") ?? null };
}

export async function loadBlocksAfter(
  db: Tx,
  sessionId: string,
  afterSeq: number,
): Promise<SummaryRow[]> {
  const found = await rows<RawRow>(
    db,
    sql`SELECT id, kind, start_seq, end_seq, last_message_id, content, token_count, created_at
        FROM summary_blocks WHERE session_id = ${sessionId} AND kind = 'block' AND end_seq > ${afterSeq}
        ORDER BY start_seq, end_seq`,
  );
  return found.map(toRow);
}

/** What a summary writer's inputs looked like when it started reading them. */
export interface SummaryInputMark {
  maxSeq: number;
  count: number;
}

/**
 * Taken before a summary writer reads its inputs (previous summaries, blocks, messages). Messages
 * only disappear when a peer is erased, which also drops the session's summaries and queues a
 * rebuild, so a drop in this count means the inputs may quote erased text.
 */
export async function markSummaryInputs(db: Tx, sessionId: string): Promise<SummaryInputMark> {
  const [r] = await rows<{ max_seq: number | string | null; n: number | string }>(
    db,
    sql`SELECT max(seq_in_session) AS max_seq, count(*) AS n FROM messages WHERE session_id = ${sessionId}`,
  );
  return { maxSeq: Number(r?.max_seq ?? 0), count: Number(r?.n ?? 0) };
}

/**
 * Call holding `lockSessionSummaries`, right before writing: false when messages read through
 * `mark` were erased meanwhile, so the summary must not be written (the erasure queued a rebuild).
 */
export async function summaryInputsIntact(
  tx: Tx,
  sessionId: string,
  mark: SummaryInputMark,
): Promise<boolean> {
  const [r] = await rows<{ n: number | string }>(
    tx,
    sql`SELECT count(*) AS n FROM messages WHERE session_id = ${sessionId} AND seq_in_session <= ${mark.maxSeq}`,
  );
  return Number(r?.n ?? 0) === mark.count;
}

/** Serialises summary writers of one session (reasoner and summarize job may overlap). */
export async function lockSessionSummaries(tx: Tx, sessionId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`summary:${sessionId}`}))`);
}

/**
 * Replaces the current short/long summary if the new one covers more of the
 * session. Call inside a transaction holding `lockSessionSummaries`.
 */
export async function writeSummary(
  tx: Tx,
  s: {
    workspaceId: string;
    sessionId: string;
    kind: "short" | "long";
    endSeq: number;
    lastMessageId: string;
    content: string;
  },
): Promise<boolean> {
  const content = s.content.trim();
  if (!content) return false;
  const [current] = await rows<{ end_seq: number | string }>(
    tx,
    sql`SELECT max(end_seq) AS end_seq FROM summary_blocks WHERE session_id = ${s.sessionId} AND kind = ${s.kind}`,
  );
  if (current?.end_seq != null && Number(current.end_seq) >= s.endSeq) return false;
  await tx.execute(
    sql`DELETE FROM summary_blocks WHERE session_id = ${s.sessionId} AND kind = ${s.kind}`,
  );
  await tx.execute(
    sql`INSERT INTO summary_blocks (id, workspace_id, session_id, kind, start_seq, end_seq, last_message_id, content, token_count)
        VALUES (${newId()}, ${s.workspaceId}, ${s.sessionId}, ${s.kind}, 1, ${s.endSeq}, ${s.lastMessageId},
                ${content}, ${countTokens(content)})`,
  );
  return true;
}

export async function writeBlock(
  tx: Tx,
  b: {
    workspaceId: string;
    sessionId: string;
    startSeq: number;
    endSeq: number;
    lastMessageId: string;
    content: string;
  },
): Promise<void> {
  const content = b.content.trim();
  if (!content) return;
  await tx.execute(
    sql`INSERT INTO summary_blocks (id, workspace_id, session_id, kind, start_seq, end_seq, last_message_id, content, token_count)
        VALUES (${newId()}, ${b.workspaceId}, ${b.sessionId}, 'block', ${b.startSeq}, ${b.endSeq}, ${b.lastMessageId},
                ${content}, ${countTokens(content)})`,
  );
}

/** True when a multiple of `every` lies in (coveredEnd, newEnd]. */
export function crossesBoundary(every: number, coveredEnd: number, newEnd: number): boolean {
  return Math.floor(newEnd / every) > Math.floor(coveredEnd / every);
}

/** Last boundary (multiple of `every`) at or before `seq`. */
export const lastBoundary = (every: number, seq: number): number => Math.floor(seq / every) * every;
