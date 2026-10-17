import { sql } from "drizzle-orm";
import { scheduleDreamsIfDue } from "../consolidate/index.js";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import type { EventPrecision } from "../lib/event-time.js";
import { truncateTokens } from "../lib/tokens.js";
import { LlmError } from "../llm/types.js";
import { enqueue } from "../queue/enqueue.js";
import { budgetPause, type ClaimedJob, type JobOutcome } from "../queue/types.js";
import { summaryWorkPending, updateLongSummary } from "../summaries/index.js";
import {
  blockDates,
  crossesBoundary,
  loadBlocksAfter,
  loadSummaries,
  lockSessionSummaries,
  markSummaryInputs,
  summaryInputsIntact,
  writeBlock,
  writeSummary,
} from "../summaries/store.js";
import { emitQueueEmpty } from "../webhooks/index.js";
import {
  type ApplyStats,
  applyFacts,
  type KnownRef,
  prepareFacts,
  type TranscriptRef,
  type WindowSpeaker,
} from "./apply.js";
import { embedMessages } from "./embed.js";
import { loadSession, type SessionInfo } from "./session.js";
import "./offline.js";
import { recordEvents } from "../core/history.js";
import {
  EXTRACTION_SYSTEM,
  ExtractionOut,
  extractionMaxTokens,
  formatContext,
  formatTranscript,
  type KnownFact,
  type PromptMessage,
  type SpeakerContext,
} from "./prompt.js";
import { textArray, toDate } from "./util.js";

/**
 * The `reason` job: processes a session's new messages.
 *
 * 1. Embeds every new message (one batched call), so message search is current
 *    even while reasoning waits for a batch.
 * 2. Waits until the session has `batchTokens` of unreasoned text, has been
 *    quiet for `idleMs`, or its oldest unprocessed message arrived `maxDelayMs`
 *    ago (0 = immediately). The queue runs it only when no other session's
 *    unit about the same peer runs or holds older messages (queue/worker.ts),
 *    so facts are learned in message-time order.
 * 3. Splits the backlog into evenly sized windows and makes ONE structured
 *    call per window for all speakers and all observers, with the most similar
 *    known facts about each speaker in context so the model can reinforce or
 *    supersede them. The same call writes the window's summary synopsis and,
 *    when a short-summary boundary is crossed, the updated short summary.
 * 4. Applies everything in one transaction per window and marks the messages.
 */

const TARGET_MESSAGE_MAX_TOKENS = 1500;
const CONTEXT_MESSAGE_MAX_TOKENS = 200;
const LINE_OVERHEAD_TOKENS = 12;
const CONTEXT_FACTS_PER_SPEAKER = 12;
const CONTEXT_ANCHOR_FACTS = 6;
const NEIGHBOURS_PER_MESSAGE = 2;
const PENDING_PAGE = 1000;

interface PendingMessage {
  id: string;
  peerId: string;
  peerName: string;
  seqInSession: number;
  content: string;
  tokenCount: number;
  createdAt: Date;
  observers: string[];
  reasoning: boolean;
  instructions: string | null;
  hasEmbedding: boolean;
}

interface MessageRow {
  id: string;
  peer_id: string;
  peer_name: string;
  seq_in_session: number | string;
  content: string;
  token_count: number;
  created_at: Date | string;
  internal: Record<string, unknown> | null;
  has_embedding: boolean;
}

function toPending(r: MessageRow): PendingMessage {
  const internal = r.internal ?? {};
  const observers = Array.isArray(internal.observers)
    ? (internal.observers as string[])
    : [r.peer_id];
  return {
    id: r.id,
    peerId: r.peer_id,
    peerName: r.peer_name,
    seqInSession: Number(r.seq_in_session),
    content: r.content,
    tokenCount: r.token_count,
    createdAt: toDate(r.created_at),
    observers,
    reasoning: internal.reasoning !== false,
    instructions:
      typeof internal.instructions === "string" && internal.instructions.trim()
        ? internal.instructions
        : null,
    hasEmbedding: r.has_embedding,
  };
}

const MESSAGE_COLUMNS = sql`m.id, m.peer_id, p.name AS peer_name, m.seq_in_session, m.content, m.token_count,
  m.created_at, m.internal, (m.embedding IS NOT NULL) AS has_embedding`;

async function loadPending(ctx: AppContext, sessionId: string): Promise<PendingMessage[]> {
  const found = await rows<MessageRow>(
    ctx.db,
    sql`SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN peers p ON p.id = m.peer_id
        WHERE m.session_id = ${sessionId} AND m.reasoned_at IS NULL
        ORDER BY m.seq_in_session LIMIT ${PENDING_PAGE}`,
  );
  return found.map(toPending);
}

const TRIVIAL =
  /^(?:ok(?:ay)?|k+|thanks?(?: you)?(?: (?:so|very) much)?|thx|ty|cool|nice|great|awesome|perfect|sure|yes|yeah|yep|yup|no|nope|nah|lol|ha(?:ha)+|hehe|hm+|ah|oh|wow|got it|sounds good|alright|all right|right|fine|good|bye|goodbye|see you|hi|hello|hey|good (?:morning|night|evening|afternoon)|cheers|np|no problem|you'?re welcome|welcome)$/i;

/** Acknowledgements and pleasantries carry nothing to remember on their own. */
export function isTrivial(content: string): boolean {
  const t = content
    .trim()
    .toLowerCase()
    .replace(/[\s.!?,;:)(*~-]+$/u, "")
    .replace(/^[\s.!?,;:)(*~-]+/u, "")
    .replace(/\s+/g, " ");
  if (!t) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return TRIVIAL.test(t) || t.split(" ").every((w) => TRIVIAL.test(w));
}

function cutMessage(content: string, tokenCount: number, max: number): string {
  if (tokenCount <= max) return content;
  const head = truncateTokens(content, Math.floor(max * 0.7));
  const tailStart = Math.max(head.length, content.length - Math.floor(max * 0.3 * 4));
  return `${head} […] ${content.slice(tailStart)}`;
}

export async function handleReason(ctx: AppContext, job: ClaimedJob): Promise<JobOutcome> {
  const sessionId = job.sessionId ?? (job.payload.session_id as string | undefined);
  if (!sessionId) return;
  const session = await loadSession(ctx, sessionId);
  if (!session) return;
  const pending = await loadPending(ctx, sessionId);
  if (!pending.length) return;

  const needEmbedding = pending.filter((m) => !m.hasEmbedding && m.content.trim());
  if (needEmbedding.length) {
    await embedMessages(ctx, session.workspaceId, needEmbedding);
    for (const m of needEmbedding) m.hasEmbedding = true;
  }

  const reasoningOn = ctx.config.reasoner.enabled && session.config.reasoning.enabled;
  const isTarget = (m: PendingMessage) => reasoningOn && m.reasoning && m.observers.length > 0;
  const targetTokens = pending.filter(isTarget).reduce((n, m) => n + m.tokenCount, 0);
  if (targetTokens > 0 && job.payload.flush !== true) {
    const due = batchDue(ctx.config.reasoner, job);
    if (targetTokens < ctx.config.reasoner.batchTokens && Date.now() < due) {
      return { rescheduleAt: new Date(due) };
    }
  }

  const touchedPairs = new Map<string, { observerId: string; observedId: string }>();
  let summaryWritten = false;
  for (const window of buildWindows(pending, isTarget, ctx.config.reasoner.windowTokens)) {
    // Credit can run out partway through a backlog: checked before every model call, not only
    // when the job starts, so a job overdraws by at most one window.
    if (await ctx.tenancy.budget.exceededForWorkspace(session.workspaceId, true))
      return budgetPause(ctx);
    const result = await processWindow(ctx, session, window, isTarget);
    for (const t of result.touched.values()) touchedPairs.set(`${t.observerId}|${t.observedId}`, t);
    summaryWritten ||= result.summaryWritten;
  }

  if (session.config.summary.enabled && ctx.config.features.summaries) {
    // Windows without an extraction call (e.g. only acknowledgements) may still owe a summary.
    if (await summaryWorkPending(ctx, session)) {
      await enqueue(ctx.db, {
        kind: "summarize",
        workKey: `summarize:${session.id}`,
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
    }
  }

  const observerPairs = new Map<string, { observerId: string; observedId: string }>();
  for (const m of pending.filter(isTarget)) {
    for (const o of m.observers)
      observerPairs.set(`${o}|${m.peerId}`, { observerId: o, observedId: m.peerId });
  }
  // A backlog larger than one page (e.g. a big import): continue right away.
  if (pending.length === PENDING_PAGE)
    return { rescheduleAt: new Date(), payload: { flush: true } };
  const [left] = await rows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM messages WHERE session_id = ${session.id} AND reasoned_at IS NULL`,
  );
  if (!left?.n) {
    await emitQueueEmpty(ctx, session, "representation", [...observerPairs.values()]);
    if (summaryWritten) await emitQueueEmpty(ctx, session, "summary", []);
  }
  return {
    payload: {
      flush: false,
      messages: pending.length,
      observers: [...new Set([...observerPairs.values()].map((p) => p.observerId))],
      observed: [...new Set([...observerPairs.values()].map((p) => p.observedId))],
      touched_collections: touchedPairs.size,
    },
  };
}

/**
 * When a batch below the token threshold is reasoned: once the session has been quiet for
 * `idleMs` (no message arrived since; arrivals are server times, never the messages' own
 * possibly backdated times), and at the latest `maxDelayMs` after its first message arrived.
 * Messages that keep arriving within the quiet period still share one call.
 */
export function batchDue(
  cfg: { maxDelayMs: number; idleMs: number },
  job: Pick<ClaimedJob, "createdAt" | "payload">,
): number {
  const first = job.createdAt.getTime();
  const arrived = Date.parse(String(job.payload.last_message_at ?? ""));
  const last = Number.isFinite(arrived) ? Math.max(first, arrived) : first;
  return Math.min(first + cfg.maxDelayMs, last + cfg.idleMs);
}

/** Even windows under the configured size: no tiny tail call after a big one. */
function buildWindows(
  messages: PendingMessage[],
  isTarget: (m: PendingMessage) => boolean,
  maxTokens: number,
): PendingMessage[][] {
  const cost = (m: PendingMessage) =>
    Math.min(m.tokenCount, isTarget(m) ? TARGET_MESSAGE_MAX_TOKENS : CONTEXT_MESSAGE_MAX_TOKENS) +
    LINE_OVERHEAD_TOKENS;
  const total = messages.reduce((n, m) => n + cost(m), 0);
  const count = Math.max(1, Math.ceil(total / maxTokens));
  const share = total / count;
  const windows: PendingMessage[][] = [];
  let current: PendingMessage[] = [];
  let used = 0;
  for (const m of messages) {
    const c = cost(m);
    const full = used + c > maxTokens || (used >= share && windows.length < count - 1);
    if (current.length && full) {
      windows.push(current);
      current = [];
      used = 0;
    }
    current.push(m);
    used += c;
  }
  if (current.length) windows.push(current);
  return windows;
}

interface WindowResult {
  touched: ApplyStats["touched"];
  summaryWritten: boolean;
}

/**
 * Marks messages reasoned without a model call, charging for keeping them (they were embedded).
 * They are also tagged unbilled: a summary that later reads them charges for what it reads (see
 * the summarize job).
 */
async function markReasoned(
  ctx: AppContext,
  session: SessionInfo,
  messages: PendingMessage[],
): Promise<void> {
  const ids = messages.map((m) => m.id);
  const kept = messages.filter((m) => m.content.trim());
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE messages SET reasoned_at = now(), internal = internal || '{"unbilled": true}'::jsonb
          WHERE id = ANY(${textArray(ids)})`,
    );
    await ctx.billing.debitStore(tx, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      source: "messages",
      keyIds: kept.map((m) => m.id),
      tokenCounts: kept.map((m) => m.tokenCount),
    });
  });
}

async function previousMessage(
  ctx: AppContext,
  sessionId: string,
  seq: number,
): Promise<PendingMessage | null> {
  const [r] = await rows<MessageRow>(
    ctx.db,
    sql`SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN peers p ON p.id = m.peer_id
        WHERE m.session_id = ${sessionId} AND m.seq_in_session = ${seq - 1}`,
  );
  return r ? toPending(r) : null;
}

/** How far back in its session a message is compared for an exact repeat. */
const REPEAT_LOOKBACK = 500;

const sameWords = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Exact repeats: a message with the same words as an earlier message of the same peer in the
 * session, whose facts every current observer still holds, restates those facts. They are
 * reinforced in code and the message needs no model call. Returns the facts reinforced per
 * collection.
 */
async function reinforceRepeats(
  ctx: AppContext,
  session: SessionInfo,
  msgs: PendingMessage[],
): Promise<{ repeated: Set<string>; touched: WindowResult["touched"] }> {
  const repeated = new Set<string>();
  const touched: WindowResult["touched"] = new Map();
  const candidates = msgs.filter((m) => m.tokenCount >= 4 && m.observers.length);
  if (!candidates.length) return { repeated, touched };
  // The latest earlier message with the same words, per candidate, in one query.
  const found = await rows<{ mid: string; prev: string }>(
    ctx.db,
    sql`SELECT DISTINCT ON (q.mid) q.mid, p.id AS prev
        FROM unnest(${textArray(candidates.map((m) => m.id))}, ${textArray(candidates.map((m) => m.peerId))},
                    ${textArray(candidates.map((m) => String(m.seqInSession)))}::int[],
                    ${textArray(candidates.map((m) => String(m.tokenCount)))}::int[],
                    ${textArray(candidates.map((m) => sameWords(m.content)))}) AS q(mid, pid, seq, tokens, words)
        JOIN messages p ON p.session_id = ${session.id} AND p.peer_id = q.pid AND p.reasoned_at IS NOT NULL
          AND p.seq_in_session < q.seq AND p.seq_in_session >= q.seq - ${REPEAT_LOOKBACK}
          AND p.token_count BETWEEN q.tokens - 8 AND q.tokens + 8
          AND btrim(regexp_replace(lower(p.content), '[[:space:]]+', ' ', 'g')) = q.words
        ORDER BY q.mid, p.seq_in_session DESC`,
  );
  const prevOf = new Map(found.map((r) => [r.mid, r.prev]));
  for (const m of candidates) {
    const prevId = prevOf.get(m.id);
    if (!prevId) continue;
    const prev = { id: prevId };
    const facts = await rows<{
      id: string;
      collection_id: string;
      observer_id: string;
      workspace_id: string;
    }>(
      ctx.db,
      sql`SELECT c.id, c.collection_id, col.observer_id, c.workspace_id FROM conclusions c
          JOIN collections col ON col.id = c.collection_id
          WHERE col.observed_id = ${m.peerId} AND col.observer_id = ANY(${textArray(m.observers)})
            AND c.message_ids @> ${textArray([prev.id])} AND c.deleted_at IS NULL AND c.valid_to IS NULL`,
    );
    const holders = new Set(facts.map((f) => f.observer_id));
    if (!facts.length || m.observers.some((o) => !holders.has(o))) continue;
    await ctx.db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE conclusions SET times_derived = times_derived + 1, updated_at = now(),
              message_ids = ARRAY(SELECT DISTINCT unnest(message_ids || ${textArray([m.id])}))
            WHERE id = ANY(${textArray(facts.map((f) => f.id))})`,
      );
      await recordEvents(
        tx,
        facts.map((f) => ({
          workspaceId: f.workspace_id,
          collectionId: f.collection_id,
          conclusionId: f.id,
          action: "reinforced" as const,
          actor: "reasoner" as const,
          reason: "the same words again",
          sources: [m.id],
        })),
      );
      const colls = [...new Set(facts.map((f) => f.collection_id))];
      await tx.execute(
        sql`UPDATE collections SET version = version + 1 WHERE id = ANY(${textArray(colls)})`,
      );
    });
    repeated.add(m.id);
    for (const f of facts)
      touched.set(f.collection_id, {
        observerId: f.observer_id,
        observedId: m.peerId,
        inserted: 0,
      });
  }
  return { repeated, touched };
}

async function processWindow(
  ctx: AppContext,
  session: SessionInfo,
  window: PendingMessage[],
  isTargetIn: (m: PendingMessage) => boolean,
): Promise<WindowResult> {
  const empty: WindowResult = { touched: new Map(), summaryWritten: false };
  const cfg = session.config;
  const said = window.filter((m) => isTargetIn(m) && !isTrivial(m.content));
  if (!said.length) {
    await markReasoned(ctx, session, window);
    return empty;
  }
  // Exact repeats are settled in code; they stay in the transcript as context only.
  const { repeated, touched: repeatedIn } = await reinforceRepeats(ctx, session, said);
  const isTarget = (m: PendingMessage) => isTargetIn(m) && !repeated.has(m.id);
  const targets = window.filter(isTarget);
  if (!targets.some((m) => !isTrivial(m.content))) {
    await markReasoned(ctx, session, window);
    return { ...empty, touched: repeatedIn };
  }

  // Summaries ride along in the same call when the window continues the current short summary.
  const summariesOn = cfg.summary.enabled && ctx.config.features.summaries;
  const first = window[0]!.seqInSession;
  const last = window.at(-1)!;
  const mark = summariesOn ? await markSummaryInputs(ctx.db, session.id) : null;
  const sums = summariesOn ? await loadSummaries(ctx.db, session.id) : null;
  const shortCovered = sums?.short?.endSeq ?? 0;
  const wantShort =
    !!sums && crossesBoundary(cfg.summary.shortEvery, shortCovered, last.seqInSession);
  const longCovered = sums?.long?.endSeq ?? 0;
  // Windows processed since the last short summary contribute their synopses.
  const earlier = wantShort
    ? (await loadBlocksAfter(ctx.db, session.id, shortCovered))
        .filter((b) => b.startSeq < first)
        .map((b) => b.content)
    : [];

  // Transcript: an earlier message for context when the window opens with a short reply.
  const prev =
    first > 1 && window[0]!.tokenCount <= 40 ? await previousMessage(ctx, session.id, first) : null;
  const lines: (PromptMessage & { ref: TranscriptRef })[] = [];
  if (prev && prev.peerId !== window[0]!.peerId) {
    lines.push({
      index: 0,
      peerName: prev.peerName,
      createdAt: prev.createdAt,
      content: cutMessage(prev.content, prev.tokenCount, CONTEXT_MESSAGE_MAX_TOKENS),
      context: true,
      ref: {
        id: prev.id,
        peerId: prev.peerId,
        createdAt: prev.createdAt,
        target: false,
        observers: [],
      },
    });
  }
  window.forEach((m, i) => {
    const target = isTarget(m);
    lines.push({
      index: i + 1,
      peerName: m.peerName,
      createdAt: m.createdAt,
      content: cutMessage(
        m.content,
        m.tokenCount,
        target ? TARGET_MESSAGE_MAX_TOKENS : CONTEXT_MESSAGE_MAX_TOKENS,
      ),
      context: !target,
      ref: {
        id: m.id,
        peerId: m.peerId,
        createdAt: m.createdAt,
        target,
        observers: target ? m.observers : [],
      },
    });
  });

  // Speakers and the collections their known facts come from.
  const speakers = new Map<string, WindowSpeaker>();
  for (const m of targets) {
    const key = m.peerName.toLowerCase();
    const s = speakers.get(key) ?? {
      peerId: m.peerId,
      name: m.peerName,
      observers: new Set<string>(),
      lastAt: m.createdAt,
    };
    for (const o of m.observers) s.observers.add(o);
    if (!s.lastAt || m.createdAt > s.lastAt) s.lastAt = m.createdAt;
    speakers.set(key, s);
  }
  const cardsOn = cfg.peerCard.create;
  const known = new Map<string, KnownRef>();
  const speakerContexts: SpeakerContext[] = [];
  let handle = 0;
  for (const s of speakers.values()) {
    const ref = await referenceCollection(ctx, s);
    const facts: KnownFact[] = [];
    if (ref) {
      const ids = targets
        .filter((m) => m.peerId === s.peerId && !isTrivial(m.content))
        .map((m) => m.id);
      for (const f of await similarFacts(ctx, ref.id, ids)) {
        const h = `F${++handle}`;
        known.set(h, { id: f.id, key: f.key, observedId: s.peerId });
        facts.push({
          handle: h,
          content: f.content,
          validFrom: f.valid_from ? toDate(f.valid_from) : null,
          event:
            f.event_start && f.event_precision
              ? {
                  start: toDate(f.event_start),
                  end: f.event_end ? toDate(f.event_end) : null,
                  precision: f.event_precision,
                }
              : null,
        });
      }
    }
    speakerContexts.push({ name: s.name, facts, card: cardsOn ? (ref?.peer_card ?? []) : null });
  }

  const instructions = [
    ...new Set(targets.flatMap((m) => (m.instructions ? [m.instructions] : []))),
  ];
  const context = formatContext({
    speakers: speakerContexts,
    instructions,
    synopsis: summariesOn,
    shortSummary: wantShort ? { previous: sums?.short?.content ?? null, earlier } : null,
    summaryInstructions: cfg.summary.instructions,
    cardInstructions: cardsOn ? cfg.peerCard.instructions : null,
  });

  let out: ExtractionOut;
  try {
    const res = await ctx.llm.structured(
      {
        task: "reasoner",
        workspaceId: session.workspaceId,
        system: EXTRACTION_SYSTEM,
        context,
        messages: [{ role: "user", content: formatTranscript(lines) }],
        effort: "low",
        maxTokens: extractionMaxTokens(targets.length, summariesOn, wantShort),
      },
      ExtractionOut,
      "memory_extraction",
    );
    out = res.data;
  } catch (err) {
    // Unusable output on a big window: retry as two smaller ones rather than losing facts.
    if (err instanceof LlmError && err.kind === "invalid_output" && window.length >= 4) {
      const mid = Math.ceil(window.length / 2);
      const a = await processWindow(ctx, session, window.slice(0, mid), isTarget);
      const b = await processWindow(ctx, session, window.slice(mid), isTarget);
      return {
        touched: new Map([...repeatedIn, ...a.touched, ...b.touched]),
        summaryWritten: a.summaryWritten || b.summaryWritten,
      };
    }
    // A small window the model cannot turn into valid output even after its repair attempt
    // would be retried by every later job: it is billed for the calls spent and passed over.
    if (err instanceof LlmError && err.kind === "invalid_output") {
      ctx.log.warn(
        { err, session: session.id, messages: window.length },
        "window skipped: unusable output",
      );
      await ctx.db.transaction(async (tx) => {
        await debitWindow(ctx, tx, session, window, targets);
        await tx.execute(
          sql`UPDATE messages SET reasoned_at = now() WHERE id = ANY(${textArray(window.map((m) => m.id))})`,
        );
      });
      return empty;
    }
    throw err;
  }

  const transcript = new Map(lines.map((l) => [l.index, l.ref]));
  const facts = prepareFacts(out.facts, speakers, transcript, known);
  const needVectors = facts.map((f) => f.content);
  const vectors = needVectors.length
    ? await ctx.embeddings.embed(needVectors, session.workspaceId)
    : [];

  let summaryWritten = false;
  const stats = await ctx.db.transaction(async (tx) => {
    const stats = await applyFacts(tx, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      embeddingModel: ctx.embeddings.ref,
      facts,
      vectors,
      cardEdits: out.cards,
      speakers,
      cardsEnabled: cardsOn,
    });
    if (mark) await lockSessionSummaries(tx, session.id);
    // Skipped when a peer was erased since the summaries were read: they may quote it.
    if (mark && (await summaryInputsIntact(tx, session.id, mark))) {
      if (out.synopsis?.trim()) {
        await writeBlock(tx, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          startSeq: first,
          endSeq: last.seqInSession,
          lastMessageId: last.id,
          content: `${blockDates(window[0]!.createdAt, last.createdAt)}: ${out.synopsis.trim()}`,
        });
      }
      if (wantShort && out.short_summary?.trim()) {
        summaryWritten = await writeSummary(tx, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          kind: "short",
          endSeq: last.seqInSession,
          lastMessageId: last.id,
          content: out.short_summary,
        });
      }
    }
    // Hosted billing: the window's message tokens, debited exactly once with the commit.
    await debitWindow(ctx, tx, session, window, targets);
    await tx.execute(
      sql`UPDATE messages SET reasoned_at = now() WHERE id = ANY(${textArray(window.map((m) => m.id))})`,
    );
    if (stats.touched.size) {
      await scheduleDreamsIfDue(tx, ctx.config, session.workspaceId, cfg, [
        ...stats.touched.keys(),
      ]);
    }
    return stats;
  });

  if (summariesOn && crossesBoundary(cfg.summary.longEvery, longCovered, last.seqInSession)) {
    summaryWritten = (await updateLongSummary(ctx, session)) || summaryWritten;
  }
  ctx.log.debug(
    {
      session: session.id,
      messages: window.length,
      inserted: stats.inserted,
      reinforced: stats.reinforced,
      superseded: stats.superseded,
      cards: stats.cardsUpdated,
    },
    "reasoned window",
  );
  return { touched: new Map([...repeatedIn, ...stats.touched]), summaryWritten };
}

/**
 * Debits a window that went to the model: each target message at its length (with the
 * per-message minimum), and each message read only for context at what the call read of it.
 */
async function debitWindow(
  ctx: AppContext,
  tx: Pick<AppContext["db"], "execute">,
  session: SessionInfo,
  window: PendingMessage[],
  targets: PendingMessage[],
): Promise<void> {
  const isTarget = new Set(targets.map((m) => m.id));
  const context = window.filter((m) => !isTarget.has(m.id));
  await ctx.billing.debitIngest(tx, {
    workspaceId: session.workspaceId,
    sessionId: session.id,
    messageIds: targets.map((m) => m.id),
    tokenCounts: targets.map((m) => m.tokenCount),
    contextMessageIds: context.map((m) => m.id),
    contextTokens: context.reduce(
      (n, m) => n + Math.min(m.tokenCount, CONTEXT_MESSAGE_MAX_TOKENS),
      0,
    ),
  });
}

interface RefCollection {
  id: string;
  peer_card: string[];
}

/** Where a speaker's known facts are read from: its self collection, else an observer's. */
async function referenceCollection(
  ctx: AppContext,
  s: WindowSpeaker,
): Promise<RefCollection | null> {
  const found = await rows<RefCollection & { observer_id: string }>(
    ctx.db,
    sql`SELECT id, observer_id, peer_card FROM collections
        WHERE observed_id = ${s.peerId} AND observer_id = ANY(${textArray([...s.observers, s.peerId])})`,
  );
  return found.find((c) => c.observer_id === s.peerId) ?? found[0] ?? null;
}

interface SimilarFact {
  id: string;
  key: string;
  content: string;
  valid_from: Date | string | null;
  event_start: Date | string | null;
  event_end: Date | string | null;
  event_precision: EventPrecision | null;
}

/**
 * Known facts shown to the extractor: the speaker's standing identity facts
 * (where most updates land: location, job, relationships, instructions) plus
 * the facts most similar to its new messages. All of them when few exist.
 */
async function similarFacts(
  ctx: AppContext,
  collectionId: string,
  messageIds: string[],
): Promise<SimilarFact[]> {
  const [count] = await rows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM conclusions
        WHERE collection_id = ${collectionId} AND deleted_at IS NULL AND valid_to IS NULL`,
  );
  if (!count?.n) return [];
  const anchors = await rows<SimilarFact>(
    ctx.db,
    sql`SELECT id, COALESCE(internal->>'key', id) AS key, content, valid_from, event_start, event_end, event_precision
        FROM conclusions
        WHERE collection_id = ${collectionId} AND deleted_at IS NULL AND valid_to IS NULL
          ${count.n > CONTEXT_FACTS_PER_SPEAKER ? sql`AND category IN ('identity', 'relationship', 'instruction')` : sql``}
        ORDER BY importance DESC, valid_from DESC NULLS LAST, created_at DESC
        LIMIT ${count.n > CONTEXT_FACTS_PER_SPEAKER ? CONTEXT_ANCHOR_FACTS : CONTEXT_FACTS_PER_SPEAKER}`,
  );
  let similar: SimilarFact[] = [];
  if (count.n > CONTEXT_FACTS_PER_SPEAKER && messageIds.length) {
    similar = await rows<SimilarFact & { d: number }>(
      ctx.db,
      sql`SELECT x.id, x.key, x.content, x.valid_from, x.event_start, x.event_end, x.event_precision, min(x.d) AS d
          FROM messages q
          CROSS JOIN LATERAL (
            SELECT c.id, COALESCE(c.internal->>'key', c.id) AS key, c.content, c.valid_from,
                   c.event_start, c.event_end, c.event_precision, (c.embedding <=> q.embedding) + 0 AS d
            FROM conclusions c
            WHERE c.collection_id = ${collectionId} AND c.deleted_at IS NULL AND c.valid_to IS NULL
              AND c.embedding IS NOT NULL
            ORDER BY 8 LIMIT ${NEIGHBOURS_PER_MESSAGE}) x
          WHERE q.id = ANY(${textArray(messageIds)}) AND q.embedding IS NOT NULL
          GROUP BY x.id, x.key, x.content, x.valid_from, x.event_start, x.event_end, x.event_precision
          ORDER BY d LIMIT ${CONTEXT_FACTS_PER_SPEAKER}`,
    );
  }
  const merged = [...new Map([...anchors, ...similar].map((f) => [f.id, f])).values()];
  return merged.sort(
    (a, b) => new Date(a.valid_from ?? 0).getTime() - new Date(b.valid_from ?? 0).getTime(),
  );
}
