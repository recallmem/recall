import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { describeEventTime } from "../lib/event-time.js";
import { questionTags } from "../lib/tags.js";
import { countTokens, truncateTokens } from "../lib/tokens.js";
import { textArray } from "../reasoner/util.js";
import type { EvidenceLog } from "./format.js";
import { type Allowlist, getCard, type PeerRef, type SessionRef, type WsRef } from "./lookup.js";
import type { LevelPlan } from "./prompts.js";
import { EMBED_TOKEN_LIMIT } from "./representation.js";
import {
  allowlistCond,
  CONC_COLS,
  CONC_FROM,
  type ConclusionHit,
  type ConclusionRow,
  type MessageHit,
  type MessageRow,
  mapConclusion,
  messagesAround,
  messagesByIds,
  pairCond,
  predecessorsOf,
  rankScore,
  searchConclusions,
  searchMessages,
} from "./search.js";
import { latestSummaries, recentMessages } from "./session-context.js";
import { isAggregate, shapeOf } from "./shape.js";
import { type TimeWindow, withoutQuestionDate } from "./time-window.js";
import { and, day, inList, normalizeQuery, queryTerms, toDate } from "./util.js";

/** Everything that decides what a request may recall. Built once per request by `prepareChat`. */
export interface View {
  ws: WsRef;
  /** Collection owner; null for workspace chat (every peer's own collection). */
  observer: PeerRef | null;
  observed: PeerRef | null;
  /**
   * Who asks: the path peer of a peer chat (the observer, unless a scope took its place); null
   * for workspace chat. Decides who "you" is in the answer, and whose privacy wishes do not apply.
   */
  asker?: PeerRef | null;
  /** Observed peer does not exist: there is nothing to recall about them. */
  noMemory: boolean;
  allowlist: Allowlist | null;
  session: SessionRef | null;
  /** Message visibility follows this peer's session membership (unless an allowlist applies). */
  messageObserver: PeerRef | null;
  cardsEnabled: boolean;
  instructions: string | null;
  /** Unprefixed scope name when a single scope swapped the observer. */
  scopeName: string | null;
}

export const workspaceWide = (v: View): boolean => v.observer == null;

export function conclusionCond(v: View): SQL {
  return and(
    pairCond(v.ws.id, v.observer?.id ?? null, v.observed?.id ?? null),
    v.allowlist && allowlistCond(v.allowlist.ids),
  );
}

export function messageCond(v: View): SQL | undefined {
  // Visible to the observer: messages in sessions it belongs to (until it left), and its own.
  const member =
    v.messageObserver && !v.allowlist
      ? sql`m.peer_id = ${v.messageObserver.id} OR EXISTS (
          SELECT 1 FROM session_peers sp WHERE sp.session_id = m.session_id AND sp.peer_id = ${v.messageObserver.id}
            AND (sp.left_at IS NULL OR m.created_at <= sp.left_at))`
      : undefined;
  return and(
    v.session && sql`m.session_id = ${v.session.id}`,
    v.allowlist && inList(sql`m.session_id`, v.allowlist.ids),
    member,
  );
}

/** Cosine distance under which a hit with no lexical match still counts as relevant. */
export const RELEVANT_DIST = 0.8;
/** Facts always kept regardless of relevance, so broad questions still get the best-ranked basics. */
const MIN_FACTS = 5;

export interface FactItem {
  label: string;
  hit: ConclusionHit;
  previous: ConclusionRow | null;
  /** Retrieval rank (0 = best) when the pack is shown in time order instead. */
  rank?: number;
}
export interface SnippetItem {
  label: string;
  messages: MessageRow[];
  score: number;
  relevant: boolean;
  /** Ids of the messages the search matched; the others are context around them. */
  hits?: Set<string>;
  /** Retrieval rank (0 = best) when the pack is shown in time order instead. */
  rank?: number;
}
/** A dated note on what one stretch of a conversation covered (a summary block synopsis). */
export interface LogItem {
  label: string;
  content: string;
  at: Date;
  tokens: number;
  /** Relevance rank (0 = best): what is dropped first when the pack is over budget. */
  rank: number;
}
export interface Pack {
  profile: string[];
  selfProfile: string[];
  peerProfiles: { peer: string; lines: string[] }[];
  facts: FactItem[];
  history: FactItem[];
  snippets: SnippetItem[];
  /** Conversation log for overview and ordering questions, oldest first. */
  log: LogItem[];
  /** The observed peer's brief (a dated account kept by dreams), for overview and ordering questions. */
  brief: string | null;
  /** Facts and excerpts are listed oldest first (overview and ordering questions). */
  chronological: boolean;
  /** Words of the question that pick which part of a long message an excerpt shows. */
  focus: string[];
  /** The question asks what was said back to the person: replies are shown whole. */
  replies: boolean;
  summary: string | null;
  recent: MessageRow[];
  relevant: boolean;
  /** Next free [F#] / [M#] numbers, so tool results continue the numbering. */
  nextF: number;
  nextM: number;
  /** Rendered context block. */
  text: string;
  tokens: number;
  /** Retrieval steps performed, reported as evidence tool calls. */
  steps: { tool_name: string; tool_input: Record<string, unknown> }[];
}

const isRelevant = (h: { dist: number | null; lexical: boolean }) =>
  h.lexical || (h.dist != null && h.dist <= RELEVANT_DIST);

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const msgLine = (m: MessageRow, max = 500, focus: string[] = []): string =>
  `${day(m.createdAt)} ${m.peerName}: ${focusClip(m.content, max, focus)}`;

const FOCUS_STOP = new Set(
  "about above after again also another back been before being between both could does doing during each earlier from have having here into just like made make many more most much must only other over previous really remind remember said same should some such tell than that their them then there these they this those told through under very what when where which while will with would your yours you’re".split(
    " ",
  ),
);

const ORDINALS =
  "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth".split(
    " ",
  );

/**
 * Lower-cased content words of a question (four letters or more), for {@link focusClip}. An
 * ordinal ("the 27th", "the fifth one") also becomes a list marker term, `#27`, which matches the
 * item numbered 27 in a numbered list.
 */
export function focusTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const words = lower.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{3,}/gu) ?? [];
  const items = [
    ...[...lower.matchAll(/\b(\d{1,3})(?:st|nd|rd|th)\b/g)].map((m) => `#${Number(m[1])}`),
    ...ORDINALS.filter((o) => new RegExp(`\\b${o}\\b`).test(lower)).map(
      (o) => `#${ORDINALS.indexOf(o) + 1}`,
    ),
  ];
  return [...new Set([...items, ...words.filter((w) => !FOCUS_STOP.has(w))])].slice(0, 12);
}

/**
 * Questions about what was said back to the person: "you recommended", "the list you provided",
 * "our previous chat", "remind me". The detail asked for (the 7th item of a list, a name near the
 * end) usually sits deep in a long reply, so those replies are shown whole (see {@link REPLY_CHARS}).
 */
const REPLY_QUESTION =
  /\byou(?:'d| had| have)? (?:told|said|mentioned|recommended|suggested|provided|gave|listed|described|explained|wrote|shared|named|cited|offered|proposed|came up with|created|made|put together|showed|compiled|answered|replied|advised|outlined|included)\b|\bdid you (?:say|tell|mention|recommend|suggest|give|provide|list|name|call|describe|share|cite)\b|\b(?:our|that|the) (?:previous|earlier|last|past|prior) (?:chat|conversation|discussion|exchange|talk|session)s?\b|\bwe (?:discussed|talked|chatted|spoke|went over)\b|\bremind me\b/i;

export const asksAboutReplies = (query: string): boolean => REPLY_QUESTION.test(query);

/** Characters shown of a reply when the question asks what was said back (whole, nearly always). */
export const REPLY_CHARS = 4000;

/** Extra context tokens for such questions, so whole replies do not push out facts. */
export const REPLY_BUDGET = 4000;

/** Does `window` contain the term? `#N` matches a list item numbered N ("27." or "27)"). */
function hasTerm(window: string, term: string): boolean {
  if (!term.startsWith("#")) return window.includes(term);
  return new RegExp(`(?:^|[\\s(*])${term.slice(1)}[.)]\\s`).test(window);
}

/**
 * Clips a message for an excerpt. A long message (an assistant's detailed reply, say) keeps its
 * opening and the window of `max` characters that holds the most question words, so a detail
 * deep in the reply is not cut off; without a better window it is the plain start.
 */
export function focusClip(text: string, max: number, focus: string[]): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max || focus.length === 0) return clip(t, max);
  const lower = t.toLowerCase();
  const score = (from: number) => {
    const w = lower.slice(from, from + max);
    let n = 0;
    for (const term of focus) if (hasTerm(w, term)) n++;
    return n;
  };
  let best = 0;
  let bestScore = score(0);
  // Windows start at sentence boundaries, so an excerpt reads as whole sentences.
  for (let i = 1; i < t.length - 40; i++) {
    if (t[i] !== " " || !/[.!?:;]/.test(t[i - 1]!)) continue;
    const s = score(i + 1);
    if (s > bestScore) {
      bestScore = s;
      best = i + 1;
    }
  }
  if (best === 0) return clip(t, max);
  const head = clip(t.slice(0, Math.min(140, best)), 140);
  const body = t.slice(best, best + max);
  return `${head.endsWith("…") ? head : `${head} …`} ${body}${best + max < t.length ? "…" : ""}`;
}

/** Merges hit windows (±radius messages) per session into snippets, best-scoring first. */
export async function expandSnippets(
  ctx: AppContext,
  view: View,
  hits: MessageHit[],
  firstLabel: number,
  radius = 1,
  skip: Set<string> = new Set(),
): Promise<SnippetItem[]> {
  const live = hits.filter((h) => !skip.has(h.row.id));
  if (!live.length) return [];
  const around = await messagesAround(
    ctx,
    view.ws.id,
    live.map((h) => ({ sessionInternal: h.row.sessionInternal, seqInSession: h.row.seqInSession })),
    radius,
    messageCond(view),
  );
  const bySession = new Map<string, MessageRow[]>();
  for (const m of around)
    bySession.set(m.sessionInternal, [...(bySession.get(m.sessionInternal) ?? []), m]);
  const windows: {
    session: string;
    lo: number;
    hi: number;
    score: number;
    relevant: boolean;
    hits: Set<string>;
  }[] = [];
  for (const h of [...live].sort(
    (a, b) =>
      a.row.sessionInternal.localeCompare(b.row.sessionInternal) ||
      a.row.seqInSession - b.row.seqInSession,
  )) {
    const last = windows[windows.length - 1];
    const lo = h.row.seqInSession - radius;
    const hi = h.row.seqInSession + radius;
    if (last && last.session === h.row.sessionInternal && lo <= last.hi + 1) {
      last.hi = Math.max(last.hi, hi);
      last.score = Math.max(last.score, h.score);
      last.relevant ||= isRelevant(h);
      last.hits.add(h.row.id);
    } else
      windows.push({
        session: h.row.sessionInternal,
        lo,
        hi,
        score: h.score,
        relevant: isRelevant(h),
        hits: new Set([h.row.id]),
      });
  }
  return windows
    .sort((a, b) => b.score - a.score)
    .map((w, i) => ({
      label: `M${firstLabel + i}`,
      messages: (bySession.get(w.session) ?? []).filter(
        (m) => m.seqInSession >= w.lo && m.seqInSession <= w.hi,
      ),
      score: w.score,
      relevant: w.relevant,
      hits: w.hits,
    }))
    .filter((s) => s.messages.length);
}

/** Attaches to each fact the value it replaced (one hop), for "was X until DATE" context. */
async function attachPrevious(
  ctx: AppContext,
  hits: ConclusionHit[],
  firstLabel: number,
): Promise<FactItem[]> {
  const prev = await predecessorsOf(
    ctx,
    hits.map((h) => h.row.id),
  );
  const bySuccessor = new Map<string, ConclusionRow>();
  for (const p of prev)
    if (p.supersededBy && !bySuccessor.has(p.supersededBy)) bySuccessor.set(p.supersededBy, p);
  return hits.map((hit, i) => ({
    label: `F${firstLabel + i}`,
    hit,
    previous: bySuccessor.get(hit.row.id) ?? null,
  }));
}

async function loadCards(ctx: AppContext, view: View) {
  if (!view.cardsEnabled || view.allowlist || view.noMemory || !view.observer || !view.observed) {
    return { profile: [] as string[], self: [] as string[] };
  }
  const [profile, self] = await Promise.all([
    getCard(ctx, view.ws.id, view.observer.id, view.observed.id),
    view.observer.id !== view.observed.id && !view.scopeName
      ? getCard(ctx, view.ws.id, view.observer.id, view.observer.id)
      : Promise.resolve({ card: [] as string[], version: 0 }),
  ]);
  return { profile: profile.card.slice(0, 30), self: self.card.slice(0, 12) };
}

/** The brief of the viewed (observer, observed) pair, when the view may read all of its memory. */
async function loadBrief(ctx: AppContext, view: View): Promise<string | null> {
  if (view.allowlist || view.noMemory || !view.observer || !view.observed) return null;
  const [r] = await rows<{ brief: string | null }>(
    ctx.db,
    sql`SELECT brief FROM collections
        WHERE workspace_id = ${view.ws.id} AND observer_id = ${view.observer.id} AND observed_id = ${view.observed.id}`,
  );
  return r?.brief?.trim() || null;
}

async function sessionBits(ctx: AppContext, session: SessionRef, tokens: number) {
  const sums = await latestSummaries(ctx, session.id);
  const pick = sums.long && sums.long.tokenCount <= 900 ? sums.long : (sums.short ?? sums.long);
  const recent = await recentMessages(ctx, session.id, tokens, pick?.endSeq ?? 0);
  return { summary: pick ? truncateTokens(pick.content, 600) : null, recent };
}

/** Query embeddings for the pack: the question, plus a keyword-only variant for multi-query levels. */
export async function queryVectors(
  ctx: AppContext,
  wsId: string,
  query: string,
  multi: boolean,
): Promise<number[][]> {
  const variants = [query];
  if (multi) {
    const kw = queryTerms(query).join(" ");
    if (kw && kw !== normalizeQuery(query)) variants.push(kw);
  }
  try {
    return await ctx.embeddings.embed(
      variants.map((v) => truncateTokens(v, EMBED_TOKEN_LIMIT)),
      wsId,
    );
  } catch (err) {
    ctx.log.debug({ err }, "query embedding failed; chat continues on lexical retrieval");
    return [];
  }
}

/**
 * Other peers the question names ("What book did Melanie read from Caroline's
 * suggestion?"). Their facts are often the answer, but live in their own collection.
 */
async function mentionedPeers(ctx: AppContext, view: View, query: string): Promise<PeerRef[]> {
  if (view.noMemory || workspaceWide(view) || !view.observed) return [];
  const candidates = await rows<{ id: string; name: string }>(
    ctx.db,
    sql`SELECT id, name FROM peers WHERE workspace_id = ${view.ws.id} AND NOT is_scope
          AND id <> ${view.observed.id} AND length(name) >= 3
          AND position(lower(name) in lower(${query})) > 0 LIMIT 10`,
  );
  const escapeRe = (n: string) => n.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return candidates
    .filter((p) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(p.name)}($|[^\\p{L}\\p{N}])`, "iu").test(query),
    )
    .slice(0, 3)
    .map((p) => ({ id: p.id, name: p.name, isScope: false, configuration: {} }));
}

/**
 * A mentioned peer's own facts, limited to what the asking side could have seen:
 * facts filed under sessions the message observer belongs to (the same rule as
 * message visibility), or the session allowlist when one applies.
 */
function mentionedCond(view: View, peer: PeerRef): SQL {
  const visible = view.allowlist
    ? allowlistCond(view.allowlist.ids)
    : view.messageObserver
      ? sql`c.session_id IS NOT NULL AND EXISTS (SELECT 1 FROM session_peers sp
              WHERE sp.session_id = c.session_id AND sp.peer_id = ${view.messageObserver.id})`
      : undefined;
  return and(pairCond(view.ws.id, peer.id, peer.id), visible);
}

/** Share of the pack budget the conversation log may take. */
const LOG_SHARE = 0.4;

/** Sessions whose summaries the view may read: the rule of `messageCond`, applied to summary blocks `b`. */
function logCond(v: View): SQL {
  const member =
    v.messageObserver && !v.allowlist
      ? sql`EXISTS (SELECT 1 FROM session_peers sp WHERE sp.session_id = b.session_id AND sp.peer_id = ${v.messageObserver.id}
          AND (sp.left_at IS NULL OR lm.created_at IS NULL OR lm.created_at <= sp.left_at))`
      : undefined;
  return and(
    v.session && sql`b.session_id = ${v.session.id}`,
    v.allowlist && inList(sql`b.session_id`, v.allowlist.ids),
    member,
  );
}

/**
 * The conversation log: the dated synopsis written for every processed stretch of a session,
 * oldest first. When it is longer than `maxTokens`, the notes sharing the most words with the
 * question are kept. No LLM call and no embedding: the synopses already exist.
 */
async function loadLog(
  ctx: AppContext,
  view: View,
  query: string,
  maxTokens: number,
  window: TimeWindow | null,
): Promise<LogItem[]> {
  const found = await rows<{ content: string; token_count: number | string; at: string | Date }>(
    ctx.db,
    sql`SELECT b.content, b.token_count, coalesce(lm.created_at, b.created_at) AS at
        FROM summary_blocks b
        JOIN sessions s ON s.id = b.session_id
        LEFT JOIN messages lm ON lm.id = b.last_message_id
        WHERE b.workspace_id = ${view.ws.id} AND b.kind = 'block' AND s.is_active AND ${logCond(view)}
        ORDER BY 3, b.session_id, b.start_seq
        LIMIT 5000`,
  );
  const terms = queryTerms(query);
  const notes = found.map((r, i) => {
    const at = toDate(r.at) ?? new Date(0);
    const text = r.content.trim();
    const content = /^\d{4}-\d{2}-\d{2}/.test(text) ? text : `${day(at)}: ${text}`;
    const words = new Set(content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    // Notes from the time the question asks about come first, then those sharing its words.
    const inWindow = window && at >= window.from && at < window.to ? 1000 : 0;
    const score = inWindow + terms.filter((t) => words.has(t)).length;
    return { i, content, at, tokens: Number(r.token_count) || countTokens(content), score };
  });
  const byRelevance = [...notes].sort((a, b) => b.score - a.score || b.i - a.i);
  const kept = new Map<number, number>();
  let used = 0;
  for (const [rank, n] of byRelevance.entries()) {
    if (used + n.tokens + 4 > maxTokens) continue;
    used += n.tokens + 4;
    kept.set(n.i, rank);
  }
  return notes
    .filter((n) => kept.has(n.i))
    .map((n, j) => ({
      label: `S${j + 1}`,
      content: n.content,
      at: n.at,
      tokens: n.tokens,
      rank: kept.get(n.i) ?? 0,
    }));
}

/**
 * The messages the given facts were drawn from, as excerpt hits ranked after the question's own
 * message hits, in the facts' order. A fact is a one-line digest; the details around it (the rest
 * of a list, the reason given, a date mentioned in passing) are in its source.
 */
async function factSources(
  ctx: AppContext,
  view: View,
  facts: ConclusionHit[],
  hits: MessageHit[],
): Promise<MessageHit[]> {
  if (!facts.length) return [];
  const have = new Set(hits.map((h) => h.row.id));
  const ids = [...new Set(facts.flatMap((f) => f.row.messageIds.slice(0, 2)))].filter(
    (id) => !have.has(id),
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  const floor = Math.min(1, ...hits.map((h) => h.score));
  const found = await messagesByIds(ctx, view.ws.id, ids, messageCond(view));
  return found.map((row) => ({
    row,
    score: floor * (1 - ((order.get(row.id) ?? 0) + 1) / (2 * (ids.length + 1))),
    dist: null,
    lexical: true,
  }));
}

const firstAt = (s: SnippetItem) => s.messages[0]?.createdAt.getTime() ?? 0;
/** When a fact's event happened, else when it was said: the order facts are listed in by time. */
const factAt = (f: ConclusionHit) =>
  (f.row.event?.start ?? f.row.validFrom ?? f.row.createdAt).getTime();

/**
 * Every fact tagged with what a counting question counts ("how many concerts", "all my trips"),
 * oldest first, up to `limit`: the items are usually spread over many conversations, so the
 * closest few by meaning miss some. A tag on more than a few times `limit` facts says too little
 * to count by and is left out.
 */
async function taggedFacts(
  ctx: AppContext,
  view: View,
  query: string,
  limit: number,
): Promise<ConclusionHit[]> {
  const tags = questionTags(queryTerms(withoutQuestionDate(query)));
  if (!tags.length) return [];
  const cond = and(conclusionCond(view), sql`c.deleted_at IS NULL`);
  const counts = await rows<{ tag: string; n: number | string }>(
    ctx.db,
    sql`SELECT t.tag, count(*) AS n FROM conclusions c, unnest(c.tags) AS t(tag)
        WHERE ${cond} AND c.tags && ${textArray(tags)} AND t.tag = ANY(${textArray(tags)})
        GROUP BY t.tag`,
  );
  const useful = counts.filter((r) => Number(r.n) <= limit * 3).map((r) => r.tag);
  if (!useful.length) return [];
  const found = await rows<Record<string, unknown>>(
    ctx.db,
    sql`SELECT ${CONC_COLS} FROM ${CONC_FROM} WHERE ${cond} AND c.tags && ${textArray(useful)}
        ORDER BY COALESCE(c.event_start, c.valid_from, c.created_at), c.id LIMIT ${limit}`,
  );
  return found.map((r) => ({ row: mapConclusion(r), dist: null, lexical: true, rel: 0.5 }));
}

/**
 * Facts from a window of time: their event overlaps it, or, without an event time, they were
 * learned in it.
 */
export function factInWindow(w: TimeWindow): SQL {
  const eventEnd = sql`COALESCE(c.event_end + interval '1 day', CASE c.event_precision
    WHEN 'year' THEN c.event_start + interval '1 year' WHEN 'month' THEN c.event_start + interval '1 month'
    ELSE c.event_start + interval '1 day' END)`;
  return sql`(CASE WHEN c.event_start IS NOT NULL
    THEN c.event_start < ${w.to}::timestamptz AND ${eventEnd} > ${w.from}::timestamptz
    ELSE COALESCE(c.valid_from, c.created_at) >= ${w.from}::timestamptz
      AND COALESCE(c.valid_from, c.created_at) < ${w.to}::timestamptz END)`;
}

/**
 * Retrieval for the one-call path: hybrid facts, superseded facts for historical questions,
 * excerpts, cards, session; for a question that names a time, also what memory has from then.
 */
export async function buildPack(
  ctx: AppContext,
  view: View,
  query: string,
  plan: LevelPlan,
): Promise<Pack> {
  const now = new Date();
  const ws = view.ws;
  // Overviews, summaries, "in what order" questions and questions that name a time: add the
  // conversation log and list facts and excerpts in time order, so the answer can follow the
  // actual sequence.
  const { kind, historical, chronological, window } = shapeOf(query, now);
  const logP = chronological
    ? loadLog(ctx, view, query, Math.floor(plan.budget * LOG_SHARE), window)
    : Promise.resolve([]);
  const [vectors, others] = await Promise.all([
    queryVectors(ctx, ws.id, query, plan.multiQuery),
    mentionedPeers(ctx, view, query),
  ]);
  const base = { workspaceId: ws.id, query, vectors };
  const [factHits, histHits, msgHits, cards, sess, otherHits, winFactHits, winMsgHits, tagHits] =
    await Promise.all([
      view.noMemory
        ? []
        : searchConclusions(ctx, {
            ...base,
            pool: plan.facts * 2,
            cond: conclusionCond(view),
            state: "current",
          }),
      historical && !view.noMemory
        ? searchConclusions(ctx, {
            ...base,
            pool: plan.history * 2,
            cond: conclusionCond(view),
            state: "superseded",
          })
        : [],
      searchMessages(ctx, { ...base, limit: plan.snippets, cond: messageCond(view) }),
      loadCards(ctx, view),
      view.session ? sessionBits(ctx, view.session, plan.sessionTokens) : null,
      Promise.all(
        others.map((p) =>
          searchConclusions(ctx, {
            ...base,
            pool: plan.facts,
            cond: mentionedCond(view, p),
            state: "current",
          }),
        ),
      ),
      // The time the question names: facts dated in it (replaced ones too: they held then) and
      // the messages written in it, best matches first.
      window && !view.noMemory
        ? searchConclusions(ctx, {
            ...base,
            pool: plan.facts,
            cond: and(conclusionCond(view), factInWindow(window)),
            state: "all",
          })
        : [],
      window
        ? searchMessages(ctx, {
            ...base,
            limit: plan.snippets,
            cond: and(
              messageCond(view),
              sql`m.created_at >= ${window.from}::timestamptz AND m.created_at < ${window.to}::timestamptz`,
            ),
          })
        : [],
      (kind === "counting" || isAggregate(query)) && !view.noMemory
        ? taggedFacts(ctx, view, query, plan.facts * 2)
        : [],
    ]);

  // Best-ranked first. Beyond a few always-kept facts, hits that match neither by words nor by
  // meaning are noise (a vector leg returns its nearest neighbours however far away they are).
  const ranked = (hits: ConclusionHit[], n: number, min: number) =>
    [...hits]
      .sort((a, b) => rankScore(b, now) - rankScore(a, now))
      .filter((h, i) => i < min || isRelevant(h))
      .slice(0, n);
  const topFacts = ranked(factHits, plan.facts, MIN_FACTS);
  // Facts about other people the question names get their own share of the pack.
  const otherFacts = ranked(otherHits.flat(), Math.ceil(plan.facts / 2), 0);
  // Facts from the time asked about count by their date, whether or not their words match.
  const shown = new Set([...topFacts, ...otherFacts].map((h) => h.row.id));
  const winFresh = winFactHits.filter((h) => !shown.has(h.row.id));
  const half = Math.ceil(plan.facts / 2);
  const winFacts = ranked(
    winFresh.filter((h) => !h.row.validTo),
    half,
    half,
  );
  const winOld = ranked(
    winFresh.filter((h) => h.row.validTo),
    plan.history,
    plan.history,
  );
  // Facts tagged with what a counting question counts, whatever their rank.
  for (const h of winFresh) shown.add(h.row.id);
  const tagFresh = tagHits.filter((h) => !shown.has(h.row.id));
  const tagFacts = tagFresh.filter((h) => !h.row.validTo).slice(0, plan.facts);
  const tagOld = tagFresh.filter((h) => h.row.validTo).slice(0, plan.history);
  const picked = [...topFacts, ...otherFacts, ...winFacts, ...tagFacts];
  const factRank = new Map(picked.map((h, i) => [h, i]));
  const inOrder = (hits: ConclusionHit[]) =>
    chronological ? [...hits].sort((a, b) => factAt(a) - factAt(b)) : hits;
  const facts = (await attachPrevious(ctx, inOrder(picked), 1)).map((f) => ({
    ...f,
    rank: factRank.get(f.hit) ?? 0,
  }));
  const oldHits = ranked(histHits, plan.history, 0);
  const oldIds = new Set(oldHits.map((h) => h.row.id));
  const later = [...winOld, ...tagOld].filter((h) => !oldIds.has(h.row.id));
  const history = inOrder([
    ...oldHits,
    ...later.filter((h, i) => later.findIndex((x) => x.row.id === h.row.id) === i),
  ]).map((hit, i) => ({
    label: `F${facts.length + i + 1}`,
    hit,
    previous: null,
  }));
  const recentIds = new Set(sess?.recent.map((m) => m.id));
  const sourceHits = await factSources(ctx, view, topFacts.slice(0, plan.sources), msgHits);
  let snippets = (
    await expandSnippets(
      ctx,
      view,
      [
        ...msgHits,
        ...sourceHits,
        ...winMsgHits.filter((h) => !msgHits.some((m) => m.row.id === h.row.id)),
      ],
      1,
      1,
      recentIds,
    )
  ).map((s, i) => ({
    ...s,
    rank: i,
  }));
  if (chronological)
    snippets = snippets
      .sort((a, b) => firstAt(a) - firstAt(b))
      .map((s, i) => ({ ...s, label: `M${i + 1}` }));
  const log = await logP;
  const brief = kind === "summary" || kind === "ordering" ? await loadBrief(ctx, view) : null;

  // Workspace chat has no anchor peer: add the cards of the people the best facts are about.
  const peerProfiles: Pack["peerProfiles"] = [];
  if (workspaceWide(view) && view.cardsEnabled && !view.allowlist) {
    const people = new Map<string, string>();
    for (const f of facts.slice(0, 6))
      people.set(f.hit.row.observedInternal, f.hit.row.observedName);
    for (const [id, name] of [...people].slice(0, 3)) {
      const c = (await getCard(ctx, ws.id, id, id)).card;
      if (c.length) peerProfiles.push({ peer: name, lines: c.slice(0, 8) });
    }
  }

  const pack: Pack = {
    profile: cards.profile,
    selfProfile: cards.self,
    peerProfiles,
    facts,
    history,
    snippets,
    log,
    brief,
    chronological,
    focus: focusTerms(query),
    replies: asksAboutReplies(query),
    summary: sess?.summary ?? null,
    recent: sess?.recent ?? [],
    relevant:
      facts.some((f) => isRelevant(f.hit)) ||
      history.some((f) => isRelevant(f.hit)) ||
      snippets.some((s) => s.relevant) ||
      log.length > 0 ||
      !!brief,
    nextF: facts.length + history.length + 1,
    nextM: snippets.length + 1,
    text: "",
    tokens: 0,
    steps: [
      { tool_name: "search_memory", tool_input: { query, top_k: plan.facts } },
      { tool_name: "search_messages", tool_input: { query, limit: plan.snippets } },
    ],
  };
  return pack;
}

export const packIsEmpty = (p: Pack): boolean =>
  !p.profile.length &&
  !p.selfProfile.length &&
  !p.peerProfiles.length &&
  !p.facts.length &&
  !p.history.length &&
  !p.snippets.length &&
  !p.log.length &&
  !p.brief &&
  !p.summary &&
  !p.recent.length;

// ---------------------------------------------------------------------------
// Rendering under a token budget
// ---------------------------------------------------------------------------

type Section = "profile" | "brief" | "facts" | "history" | "excerpts" | "log" | "session";
interface Entry {
  section: Section;
  text: string;
  tokens: number;
  /** Lower is more important. */
  priority: number;
  order: number;
  fact?: FactItem;
  history?: FactItem;
  snippet?: SnippetItem;
  message?: MessageRow;
  recent?: MessageRow;
  log?: LogItem;
  /** A shorter version, used when the full text does not fit the budget. */
  short?: { text: string; tokens: number };
}

function factLine(f: FactItem, wide: boolean, historyItem: boolean, anchor: string | null): string {
  const r = f.hit.row;
  const subject = wide || (anchor && r.observedName !== anchor) ? `(${r.observedName}) ` : "";
  const event = r.event ? ` (event ${describeEventTime(r.event)})` : "";
  // A replaced state with a known end says when it ended; otherwise, until when it was believed.
  if (historyItem)
    return `[${f.label}]${event} ${subject}${r.content}${r.event?.end ? "" : ` (true until ${day(r.validTo)})`}`;
  const tags = `${r.pinned ? " (pinned)" : ""}${r.level !== "explicit" ? " (inferred)" : ""}${r.confidence < 0.5 ? " (uncertain)" : ""}`;
  const was = f.previous
    ? ` (was: "${clip(f.previous.content, 140)}" until ${day(f.previous.validTo)})`
    : "";
  return `[${f.label}] ${day(r.validFrom ?? r.createdAt)}${event} ${subject}${r.content}${tags}${was}`;
}

/** Memory that holds a wish to keep something from other people. */
const PRIVACY_WISH =
  /\b(?:confidential\w*|secretly|in secret|a secret|between (?:us|you and me)|keep (?:\S+\s+){0,5}?(?:private|secret|quiet|to (?:yourself|ourselves))|(?:don[’']?t|do not|never|not to|haven[’']?t|hasn[’']?t|have not|has not) (?:yet )?(?:tell|told|share|shared|mention|mentioned|reveal|revealed|disclose|disclosed))\b/i;

/**
 * A card entry that tells the assistant to keep something from people ("INSTRUCTION:
 * Confidentiality: Keep carla's move private", "INSTRUCTION: Don't tell her brother").
 */
const isPrivacyInstruction = (line: string): boolean =>
  /^\s*INSTRUCTION:/i.test(line) &&
  (/\b(?:confidential\w*|privacy|secret\w*|discreet\w*)\b/i.test(line) || PRIVACY_WISH.test(line));

/**
 * A privacy wish protects a person from other people, never from themself. Shown to its owner, a
 * card's privacy instruction is put as what it is for them (information about whom it is kept
 * from), so the owner's own questions are answered; anyone else sees it as written.
 */
export function cardLineFor(line: string, owner: string | null): string {
  if (!owner || !isPrivacyInstruction(line)) return line;
  return line.replace(
    /^\s*INSTRUCTION:\s*/i,
    `Privacy wish (kept from others; ${owner} may always be told): `,
  );
}

/**
 * The header of the context block: whose memory it is and who asks. When someone other than the
 * person it is about asks, the answer must not address them as that person; `privacy` adds that
 * the owner's own privacy wishes do not apply to the owner asking.
 */
export function describeView(v: View, privacy = false): string {
  const lines: string[] = [];
  if (workspaceWide(v))
    lines.push("About: everyone in the workspace; each fact names the person it concerns.");
  else if (v.scopeName)
    lines.push(
      `About: ${v.observed!.name}, using only what is known within the scope "${v.scopeName}".`,
    );
  else if (v.observer!.id === v.observed!.id) lines.push(`About: ${v.observed!.name}.`);
  else lines.push(`About: ${v.observed!.name}, as known by ${v.observer!.name}.`);
  const asker = v.asker?.name;
  const about = v.observed?.name;
  if (asker && about && v.asker!.id !== v.observed!.id)
    lines.push(
      `${asker} is asking, not ${about}: speak of ${about} in the third person ("${about} said"), and "you" means ${asker}.`,
    );
  else if (asker && privacy)
    lines.push(
      `${asker} is the one asking: what ${asker} wants kept private or secret is kept from other people, never from ${asker}.`,
    );
  if (v.allowlist)
    lines.push(
      `Restricted: only information from ${v.allowlist.ids.length} selected session(s) is available.`,
    );
  if (v.session) lines.push(`The question comes from the session "${v.session.name}".`);
  return lines.join("\n");
}

const TITLES: Record<Section, string> = {
  profile: "## Profile",
  brief: "## Brief",
  facts: "## Facts",
  history: "## No longer true",
  excerpts: "## Excerpts",
  log: "## Conversation log",
  session: "## Session",
};

/**
 * Renders the pack as the context block, dropping the least important items until
 * it fits `budget` tokens (best facts and excerpts first, then profile, session and
 * the long tail; owner instructions always stay). The pack is trimmed to what was
 * rendered, so evidence and citations only cover what the model saw.
 */
export function renderPack(
  view: View,
  pack: Pack,
  budget: number,
  clips: Pick<LevelPlan, "excerptChars" | "contextChars" | "focusContext"> = {
    excerptChars: 600,
    contextChars: 240,
    focusContext: false,
  },
): void {
  const wide = workspaceWide(view);
  const entries: Entry[] = [];
  let order = 0;
  const add = (
    section: Section,
    text: string,
    priority: number,
    extra: Partial<Entry> = {},
  ): void => {
    entries.push({
      section,
      text,
      tokens: countTokens(text) + 1,
      priority,
      order: order++,
      ...extra,
    });
  };

  // Card lines about the person asking are shown as theirs (see cardLineFor).
  const asker = view.asker ?? null;
  const ownProfile = asker && asker.id === view.observed?.id ? asker.name : null;
  const ownSelf = asker && asker.id === view.observer?.id ? asker.name : null;
  for (const [i, l] of pack.profile.entries())
    add("profile", `- ${cardLineFor(clip(l, 220), ownProfile)}`, i < 6 ? 1.2 : 4 + i / 100);
  for (const [i, l] of pack.selfProfile.entries()) {
    add("profile", `- (${view.observer?.name}) ${cardLineFor(clip(l, 160), ownSelf)}`, 3 + i / 100);
  }
  for (const pp of pack.peerProfiles) {
    for (const [i, l] of pp.lines.entries())
      add("profile", `- (${pp.peer}) ${clip(l, 160)}`, 2.6 + i / 100);
  }
  for (const [i, f] of pack.facts.entries()) {
    const r = f.rank ?? i;
    add("facts", factLine(f, wide, false, view.observed?.name ?? null), r < 4 ? 1 : 2 + r / 100, {
      fact: f,
    });
  }
  for (const [i, f] of pack.history.entries()) {
    add("history", factLine(f, wide, true, view.observed?.name ?? null), 2.5 + i / 100, {
      history: f,
    });
  }
  // Messages around a hit are context: when they come from someone other than the person asked
  // about (typically an assistant's long reply), a short clip says enough and leaves room for more.
  // Unless the question asks what was said back to them: then the reply is the answer, shown whole
  // while it fits.
  const subject = wide ? null : (view.observed?.name ?? null);
  for (const [i, s] of pack.snippets.entries()) {
    const r = s.rank ?? i;
    for (const [j, m] of s.messages.entries()) {
      const other = subject !== null && m.peerName !== subject;
      const context = other && !s.hits?.has(m.id);
      const line = msgLine(
        m,
        context ? clips.contextChars : clips.excerptChars,
        context && !clips.focusContext ? [] : pack.focus,
      );
      const whole = pack.replies && other ? msgLine(m, REPLY_CHARS, pack.focus) : line;
      add("excerpts", whole, r < 2 ? 1.4 : 3 + r / 100 + j / 1000, {
        snippet: s,
        message: m,
        ...(whole !== line ? { short: { text: line, tokens: countTokens(line) + 1 } } : {}),
      });
    }
  }
  for (const l of pack.log)
    add("log", `[${l.label}] ${clip(l.content, 700)}`, 1.3 + l.rank / 1000, { log: l });
  if (pack.brief) add("brief", pack.brief, 1.4);
  if (pack.summary) add("session", `Summary: ${pack.summary}`, 1.8);
  for (const [i, m] of pack.recent.entries()) {
    add("session", msgLine(m, 400), 2.2 + (pack.recent.length - i) / 100, { recent: m });
  }

  const owner = view.instructions
    ? `Owner instructions: ${truncateTokens(view.instructions, 400)}`
    : "";
  const header = describeView(
    view,
    !!ownProfile &&
      (pack.profile.some(isPrivacyInstruction) || entries.some((e) => PRIVACY_WISH.test(e.text))),
  );
  const fixed =
    countTokens(header) +
    countTokens(owner) +
    60 +
    pack.snippets.length * 4 +
    (pack.log.length ? 6 : 0);

  const chosen = new Set<Entry>();
  let used = fixed;
  for (const e of [...entries].sort((a, b) => a.priority - b.priority || a.order - b.order)) {
    if (used + e.tokens > budget && e.short && used + e.short.tokens <= budget) {
      e.text = e.short.text;
      e.tokens = e.short.tokens;
    }
    if (used + e.tokens > budget) continue;
    used += e.tokens;
    chosen.add(e);
  }

  const render = (): string => {
    const out: string[] = [header];
    const labelled = new Set<SnippetItem>();
    for (const section of Object.keys(TITLES) as Section[]) {
      const lines = entries
        .filter((e) => e.section === section && chosen.has(e))
        .sort((a, b) => a.order - b.order);
      if (!lines.length) continue;
      out.push(
        `${TITLES[section]}\n${lines
          .map((e) => {
            if (!e.snippet || labelled.has(e.snippet)) return e.text;
            labelled.add(e.snippet);
            return `[${e.snippet.label}] ${e.text}`;
          })
          .join("\n")}`,
      );
    }
    if (
      ![...chosen].some((e) => e.fact || e.history || e.snippet || e.log || e.section === "brief")
    )
      out.push("## Facts\n(nothing relevant was found in memory)");
    if (owner) out.push(owner);
    return out.join("\n\n");
  };
  let text = render();
  let tokens = countTokens(text);
  const byWorst = [...chosen].sort((a, b) => b.priority - a.priority || b.order - a.order);
  while (tokens > budget && byWorst.length) {
    chosen.delete(byWorst.shift()!);
    text = render();
    tokens = countTokens(text);
  }

  const kept = [...chosen];
  const keptMessages = new Set(kept.filter((e) => e.message).map((e) => e.message!));
  pack.facts = pack.facts.filter((f) => kept.some((e) => e.fact === f));
  pack.history = pack.history.filter((f) => kept.some((e) => e.history === f));
  pack.snippets = pack.snippets
    .map((s) => ({ ...s, messages: s.messages.filter((m) => keptMessages.has(m)) }))
    .filter((s) => s.messages.length);
  pack.recent = pack.recent.filter((m) => kept.some((e) => e.recent === m));
  pack.log = pack.log.filter((l) => kept.some((e) => e.log === l));
  if (!kept.some((e) => e.section === "brief")) pack.brief = null;
  if (!kept.some((e) => e.section === "session" && !e.recent)) pack.summary = null;
  pack.text = text;
  pack.tokens = tokens;
}

/** Records what the model was shown. */
export function recordEvidence(pack: Pack, evidence: EvidenceLog): void {
  for (const f of [...pack.facts, ...pack.history]) evidence.conclusion(f.hit.row);
  for (const s of pack.snippets) for (const m of s.messages) evidence.message(m);
  for (const m of pack.recent) evidence.message(m);
  for (const step of pack.steps) evidence.toolCall(step.tool_name, step.tool_input);
}
