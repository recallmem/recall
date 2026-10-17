import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { countTokens, truncateTokens } from "../lib/tokens.js";
import { budgetPause, type ClaimedJob, type JobOutcome } from "../queue/types.js";
import { loadSession, type SessionInfo } from "../reasoner/session.js";
import { isoMinute, textArray } from "../reasoner/util.js";
import { emitQueueEmpty } from "../webhooks/index.js";
import "./offline.js";
import {
  blockDates,
  crossesBoundary,
  lastBoundary,
  loadBlocksAfter,
  loadSummaries,
  lockSessionSummaries,
  markSummaryInputs,
  summaryInputsIntact,
  writeBlock,
  writeSummary,
} from "./store.js";

/**
 * The `summarize` job and the long-summary assembler.
 *
 * Normally the reasoner writes summaries inside its extraction call: a
 * synopsis block per window, and the short summary whenever a window crosses
 * a short boundary. This job is the fallback that keeps summaries correct
 * when that did not happen: sessions or messages with reasoning off, windows
 * with nothing to extract, gaps. It never re-reads the whole session: input is
 * the previous short summary plus the messages after its `end_seq`.
 */

const CHUNK_MAX_TOKENS = 6000;
const MESSAGE_MAX_TOKENS = 600;
/** The long summary is a dated log of window synopses; past this size it is condensed. */
export const LONG_MAX_TOKENS = 3000;
const LONG_CONDENSED_TOKENS = 1200;

export const SUMMARY_SYSTEM = `You maintain running summaries of a conversation between peers (people, agents or services; refer to them by id).

Input: PREVIOUS SUMMARY (may be empty) and the NEW MESSAGES, one per line as "<peer> <UTC time>: <text>".

Return JSON:
short_summary: the previous summary updated so it covers the whole conversation so far: the most important facts about the peers, their preferences and requests, decisions made, and open threads. At most 200 words. Plain prose, no preamble, no meta-commentary.
synopsis: 1 to 3 sentences on what the new messages covered (topics, decisions, requests, open questions), naming people, places, titles, numbers and dates exactly as they were given.`;

export const SummaryOut = z.object({ short_summary: z.string(), synopsis: z.string() });

const CONDENSE_SYSTEM = `You condense a dated log of conversation synopses into a shorter chronological summary, in sections by period. Each section starts on its own line with the dates it covers ("2025-03-02 to 2025-04-18:"), then plain prose. Keep names, places, titles, numbers and dates exactly as written, and the decisions, stated facts, preferences and how things changed over time; drop repetition. End with one line "Left out:" naming the topics you dropped or cut short, so a reader knows what to look up. No preamble.`;

/** True when a summary boundary has passed that the current summaries do not cover. */
export async function summaryWorkPending(ctx: AppContext, session: SessionInfo): Promise<boolean> {
  const [m] = await rows<{ seq: number | string | null }>(
    ctx.db,
    sql`SELECT max(seq_in_session) AS seq FROM messages WHERE session_id = ${session.id} AND reasoned_at IS NOT NULL`,
  );
  const maxSeq = Number(m?.seq ?? 0);
  if (!maxSeq) return false;
  const { short } = await loadSummaries(ctx.db, session.id);
  return lastBoundary(session.config.summary.shortEvery, maxSeq) > (short?.endSeq ?? 0);
}

interface SummaryMessage {
  id: string;
  seq_in_session: number | string;
  peer_name: string;
  content: string;
  token_count: number;
  created_at: Date | string;
  /** No reasoning call read it (reasoning off, or a window without anything to learn). */
  unbilled: boolean;
}

export async function handleSummarize(ctx: AppContext, job: ClaimedJob): Promise<JobOutcome> {
  const sessionId = job.sessionId ?? (job.payload.session_id as string | undefined);
  if (!sessionId || !ctx.config.features.summaries) return;
  const session = await loadSession(ctx, sessionId);
  if (!session?.config.summary.enabled) return;
  const cfg = session.config.summary;
  const mark = await markSummaryInputs(ctx.db, session.id);
  let { short, long } = await loadSummaries(ctx.db, session.id);

  const [m] = await rows<{ seq: number | string | null; unreasoned: number | string | null }>(
    ctx.db,
    sql`SELECT max(seq_in_session) AS seq, min(seq_in_session) FILTER (WHERE reasoned_at IS NULL) AS unreasoned
        FROM messages WHERE session_id = ${session.id}`,
  );
  const maxSeq = Number(m?.seq ?? 0);
  const target = lastBoundary(cfg.shortEvery, maxSeq);
  const shortDue = target > (short?.endSeq ?? 0);
  const longDue = lastBoundary(cfg.longEvery, maxSeq) > (long?.endSeq ?? 0);
  if (!shortDue && !longDue) return;
  // The reasoner has not reached the boundary yet: it folds the summary into
  // its own call and enqueues this job again afterwards if it could not.
  if (m?.unreasoned != null && Number(m.unreasoned) <= target)
    return { payload: { deferred: true } };

  let wrote = false;
  while (shortDue && (short?.endSeq ?? 0) < target) {
    // Each chunk is a model call: none once the account cannot pay for it.
    if (await ctx.tenancy.budget.exceededForWorkspace(session.workspaceId, true))
      return budgetPause(ctx);
    const messages = await rows<SummaryMessage>(
      ctx.db,
      sql`SELECT m.id, m.seq_in_session, p.name AS peer_name, m.content, m.token_count, m.created_at,
                 COALESCE((m.internal->>'unbilled')::boolean, false) AS unbilled
          FROM messages m JOIN peers p ON p.id = m.peer_id
          WHERE m.session_id = ${session.id} AND m.seq_in_session > ${short?.endSeq ?? 0}
            AND m.seq_in_session <= ${target}
          ORDER BY m.seq_in_session LIMIT 400`,
    );
    if (!messages.length) break;
    const chunk: SummaryMessage[] = [];
    let used = 0;
    for (const msg of messages) {
      const cost = Math.min(msg.token_count, MESSAGE_MAX_TOKENS) + 8;
      if (chunk.length && used + cost > CHUNK_MAX_TOKENS) break;
      chunk.push(msg);
      used += cost;
    }
    const lastMsg = chunk.at(-1)!;
    const transcript = chunk
      .map((x) => {
        const text =
          x.token_count > MESSAGE_MAX_TOKENS
            ? truncateTokens(x.content, MESSAGE_MAX_TOKENS)
            : x.content;
        return `${x.peer_name} ${isoMinute(new Date(x.created_at))}: ${text.replace(/\s*\n\s*/g, " ")}`;
      })
      .join("\n");
    const context = [
      `PREVIOUS SUMMARY:\n${short?.content ?? "(none: this is the start of the conversation)"}`,
      cfg.instructions ? `APPLICATION INSTRUCTIONS FOR SUMMARIES:\n${cfg.instructions}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const { data } = await ctx.llm.structured(
      {
        task: "summary",
        workspaceId: session.workspaceId,
        system: SUMMARY_SYSTEM,
        context,
        messages: [{ role: "user", content: `NEW MESSAGES\n${transcript}` }],
        effort: "low",
        maxTokens: 600,
      },
      SummaryOut,
      "session_summary",
    );
    const endSeq = Number(lastMsg.seq_in_session);
    const unbilled = chunk.filter((x) => x.unbilled);
    const intact = await ctx.db.transaction(async (tx) => {
      await lockSessionSummaries(tx, session.id);
      if (!(await summaryInputsIntact(tx, session.id, mark))) return false;
      // Messages no reasoning call read are billed here, for what this call read of them, once.
      if (unbilled.length) {
        await ctx.billing.debitIngest(tx, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          messageIds: [],
          tokenCounts: [],
          contextMessageIds: unbilled.map((x) => x.id),
          contextTokens: unbilled.reduce(
            (n, x) => n + Math.min(x.token_count, MESSAGE_MAX_TOKENS),
            0,
          ),
          summary: true,
        });
        await tx.execute(
          sql`UPDATE messages SET internal = internal - 'unbilled'
              WHERE id = ANY(${textArray(unbilled.map((x) => x.id))})`,
        );
      }
      await writeBlock(tx, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        startSeq: Number(chunk[0]!.seq_in_session),
        endSeq,
        lastMessageId: lastMsg.id,
        content: `${blockDates(new Date(chunk[0]!.created_at), new Date(lastMsg.created_at))}: ${data.synopsis.trim()}`,
      });
      wrote =
        (await writeSummary(tx, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          kind: "short",
          endSeq,
          lastMessageId: lastMsg.id,
          content: data.short_summary,
        })) || wrote;
      return true;
    });
    // A peer was erased while this ran: its rebuild job starts over from what is left.
    if (!intact) return;
    ({ short, long } = await loadSummaries(ctx.db, session.id));
  }
  if (crossesBoundary(cfg.longEvery, long?.endSeq ?? 0, maxSeq)) {
    wrote = (await updateLongSummary(ctx, session)) || wrote;
  }
  if (wrote) await emitQueueEmpty(ctx, session, "summary", []);
}

/**
 * Brings the long summary up to date from the block synopses written since
 * it: zero LLM calls until it outgrows LONG_MAX_TOKENS, then one call that
 * condenses it.
 */
export async function updateLongSummary(ctx: AppContext, session: SessionInfo): Promise<boolean> {
  const mark = await markSummaryInputs(ctx.db, session.id);
  const { long } = await loadSummaries(ctx.db, session.id);
  const blocks = await loadBlocksAfter(ctx.db, session.id, long?.endSeq ?? 0);
  if (!blocks.length) return false;
  const lines = blocks.map((b) => `[messages ${b.startSeq}-${b.endSeq}] ${b.content}`);
  let content = [long?.content, ...lines].filter(Boolean).join("\n");
  if (countTokens(content) > LONG_MAX_TOKENS) {
    // Condense everything except the newest blocks, which stay verbatim.
    const keep = lines.slice(-3);
    const older = [long?.content, ...lines.slice(0, -3)].filter(Boolean).join("\n");
    const res = await ctx.llm.complete({
      task: "summary",
      workspaceId: session.workspaceId,
      system: CONDENSE_SYSTEM,
      context: session.config.summary.instructions
        ? `APPLICATION INSTRUCTIONS FOR SUMMARIES:\n${session.config.summary.instructions}`
        : undefined,
      messages: [
        {
          role: "user",
          content: `Condense to at most ${Math.round(LONG_CONDENSED_TOKENS * 0.75)} words:\n${older}`,
        },
      ],
      effort: "low",
      maxTokens: LONG_CONDENSED_TOKENS + 200,
    });
    if (res.text.trim()) content = [res.text.trim(), ...keep].join("\n");
  }
  const lastBlock = blocks.at(-1)!;
  return ctx.db.transaction(async (tx) => {
    await lockSessionSummaries(tx, session.id);
    if (!(await summaryInputsIntact(tx, session.id, mark))) return false;
    return writeSummary(tx, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      kind: "long",
      endSeq: lastBlock.endSeq,
      lastMessageId: lastBlock.lastMessageId,
      content,
    });
  });
}
