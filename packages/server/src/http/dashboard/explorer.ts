import { type SQL, sql } from "drizzle-orm";
import { CHAT_LEVELS, usageCharges } from "../../billing/ledger.js";
import type { AppContext } from "../../context.js";
import { listMessages } from "../../core/messages.js";
import { getPeerCard, listPeerSessions, listPeers, selectPeerRow } from "../../core/peers.js";
import { listSessionPeers, listSessions, selectSessionRow } from "../../core/sessions.js";
import { type WsKey, wsKey } from "../../core/tenancy.js";
import { findWorkspace } from "../../core/workspaces.js";
import { rows } from "../../db/client.js";
import { ApiError, notFound } from "../../lib/errors.js";
import { iso } from "../../lib/time.js";
import { LlmError } from "../../llm/types.js";
import { cardValueTerms } from "../../reasoner/cards.js";
import { normKey } from "../../reasoner/util.js";
import type { ChatResult } from "../../recall/cache.js";
import { prepareChat, runChat } from "../../recall/chat.js";
import type { ChatLevel } from "../../recall/prompts.js";
import {
  CONC_COLS,
  CONC_FROM,
  type ConclusionRow,
  type MessageRow,
  MSG_COLS,
  MSG_FROM,
  mapConclusion,
  mapMessage,
  stateCond,
} from "../../recall/search.js";
import { latestSummaries, sessionContext } from "../../recall/session-context.js";
import { and, inList, num, toDate } from "../../recall/util.js";
import { type AuthState, limitChat } from "../auth.js";
import type { OffsetPage, Paging } from "../pagination.js";
import { MAX_MANUAL_RETRIES, queueStatus, unresolvedFailure } from "../routes/queue.js";
import { mapLlmError } from "../routes/recall.js";

/**
 * Read models for the dashboard's memory explorer and playground.
 *
 * Tenant isolation: every function here starts from `accountWorkspace`, which
 * resolves a workspace name inside the signed-in account only (the same
 * resolver the API uses), and every later query is keyed by that workspace's
 * internal id or by its `WsKey`. Nothing takes a workspace id from a URL
 * directly, so another account's data answers 404, never "forbidden".
 * Lists reuse the core list functions; new SQL here is only aggregates and
 * lookups the API has no route for.
 */

type Obj = Record<string, unknown>;

/** A workspace of the signed-in account. */
export interface WsHandle {
  key: WsKey;
  /** Internal id; only ever used in queries, never shown. */
  id: string;
  name: string;
  createdAt: string | null;
}

/** The rights of an unscoped API key of the dashboard user's own account. */
export const dashboardAuth = (accountId: string): AuthState => ({
  admin: true,
  claims: { ad: true },
  account: accountId,
  via: "dashboard",
});

export async function accountWorkspace(
  ctx: AppContext,
  accountId: string,
  name: string,
): Promise<WsHandle> {
  const key = wsKey(accountId, name);
  const row = await findWorkspace(ctx.db, key);
  if (!row) throw notFound("Workspace");
  return { key, id: row.internal_id, name: row.name, createdAt: iso(row.created_at) };
}

/** Offset paging for the core list functions (the dashboard never uses cursors). */
export function offsetPaging(page: number, size: number, newestFirst: boolean): Paging {
  return {
    page: Math.max(1, Math.floor(page) || 1),
    size,
    reverse: newestFirst,
    cursorMode: false,
    cursorRaw: null,
    cursor: null,
    fingerprint: "",
  };
}

const asOffset = <T>(p: unknown) => p as OffsetPage<T>;
const date = (v: unknown) => toDate(v as string | null)?.toISOString() ?? null;

// ---------------------------------------------------------------------------
// Workspaces

export interface WsStats {
  name: string;
  createdAt: string | null;
  peers: number;
  sessions: number;
  messages: number;
  facts: number;
  superseded: number;
  lastActivity: string | null;
}

const WS_STATS = sql`w.name, w.created_at,
  (SELECT count(*) FROM peers p WHERE p.workspace_id = w.id AND NOT p.is_scope)::int AS peers,
  (SELECT count(*) FROM sessions s WHERE s.workspace_id = w.id AND s.is_active)::int AS sessions,
  (SELECT count(*) FROM messages m WHERE m.workspace_id = w.id)::int AS messages,
  (SELECT count(*) FROM conclusions c WHERE c.workspace_id = w.id AND ${stateCond("current")})::int AS facts,
  (SELECT count(*) FROM conclusions c WHERE c.workspace_id = w.id AND ${stateCond("superseded")})::int AS superseded,
  GREATEST(w.created_at,
           (SELECT max(m.created_at) FROM messages m WHERE m.workspace_id = w.id),
           (SELECT max(c.created_at) FROM conclusions c WHERE c.workspace_id = w.id)) AS last_activity`;

const toStats = (r: Obj): WsStats => ({
  name: r.name as string,
  createdAt: date(r.created_at),
  peers: num(r.peers),
  sessions: num(r.sessions),
  messages: num(r.messages),
  facts: num(r.facts),
  superseded: num(r.superseded),
  lastActivity: date(r.last_activity),
});

/** The account's workspaces with counts, most recently active first. */
export async function workspaceList(
  ctx: AppContext,
  accountId: string,
  page: number,
  size = 24,
): Promise<OffsetPage<WsStats>> {
  const p = offsetPaging(page, size, true);
  const [count] = await rows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM workspaces w WHERE w.account_id = ${accountId}`,
  );
  const total = num(count?.n ?? 0);
  const found = await rows<Obj>(
    ctx.db,
    sql`SELECT ${WS_STATS} FROM workspaces w WHERE w.account_id = ${accountId}
        ORDER BY last_activity DESC, w.id LIMIT ${p.size} OFFSET ${(p.page - 1) * p.size}`,
  );
  return {
    items: found.map(toStats),
    total,
    page: p.page,
    size: p.size,
    pages: Math.ceil(total / p.size),
  };
}

/** Names only (for pickers), most recently created first. */
export async function workspaceNames(ctx: AppContext, accountId: string): Promise<string[]> {
  const found = await rows<{ name: string }>(
    ctx.db,
    sql`SELECT w.name FROM workspaces w WHERE w.account_id = ${accountId}
        ORDER BY w.created_at DESC, w.id LIMIT 200`,
  );
  return found.map((r) => r.name);
}

export async function workspaceStats(ctx: AppContext, ws: WsHandle): Promise<WsStats> {
  const [r] = await rows<Obj>(
    ctx.db,
    sql`SELECT ${WS_STATS} FROM workspaces w WHERE w.id = ${ws.id}`,
  );
  return toStats(r!);
}

/** A unit of background work that failed for good and still leaves a hole in the memory. */
export interface FailedUnit {
  kind: "reason" | "summarize" | "dream";
  session: string | null;
  /** What went wrong, in words safe to show a customer (never a provider's or model's name). */
  reason: string;
  at: string | null;
  /** Manual retries left (POST …/queue/retry gives each unit a few). */
  retriesLeft: number;
}

/** A failure's error text, reduced to what a customer can act on. */
export function failureReason(error: string | null): string {
  const e = (error ?? "").toLowerCase();
  if (/budget|credit|402|spend/.test(e)) return "paused by a spend limit";
  if (/rate.?limit|429|too many/.test(e)) return "the model provider was busy";
  if (/timed? ?out|timeout|deadline/.test(e)) return "timed out";
  if (/50[0-9]|unavailable|overloaded|econn|network|fetch failed/.test(e))
    return "the model provider was unavailable";
  return "a processing error";
}

/** Pending and running background work (reasoning, summaries, dreams) of one workspace. */
export async function workspaceQueue(ctx: AppContext, ws: WsHandle) {
  const status = await queueStatus(ctx, ws.id, {
    sessionId: null,
    observerId: null,
    senderId: null,
  });
  const failed = await rows<{
    kind: FailedUnit["kind"];
    session: string | null;
    last_error: string | null;
    at: Date | string | null;
    retries: number | null;
  }>(
    ctx.db,
    sql`SELECT DISTINCT ON (j.work_key) j.kind, s.name AS session, j.last_error,
               COALESCE(j.finished_at, j.created_at) AS at,
               COALESCE((j.payload->>'manual_retries')::int, 0) AS retries
        FROM jobs j LEFT JOIN sessions s ON s.id = j.session_id
        WHERE j.workspace_id = ${ws.id} AND j.kind IN ('reason', 'summarize', 'dream')
          AND ${unresolvedFailure}
        ORDER BY j.work_key, j.id DESC LIMIT 50`,
  );
  const failures: FailedUnit[] = failed
    .map((f) => ({
      kind: f.kind,
      session: f.session,
      reason: failureReason(f.last_error),
      at: date(f.at),
      retriesLeft: Math.max(0, MAX_MANUAL_RETRIES - num(f.retries ?? 0)),
    }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const bySession = Object.values(status.sessions ?? {})
    .filter((s) => s.pending_work_units + s.in_progress_work_units > 0)
    .map((s) => ({
      session: s.session_id ?? "",
      pending: s.pending_work_units,
      running: s.in_progress_work_units,
    }));
  return {
    pending: status.pending_work_units,
    running: status.in_progress_work_units,
    completed: status.completed_work_units,
    bySession,
    failures,
  };
}
export type QueueView = Awaited<ReturnType<typeof workspaceQueue>>;

/**
 * The peer pairs the night shift can work on in a workspace: every observer and observed peer
 * with current facts, the ones with the most new facts since their last night shift first.
 */
export async function nightShiftPairs(
  ctx: AppContext,
  ws: WsHandle,
  limit = 50,
): Promise<{ observer: string; observed: string }[]> {
  return rows<{ observer: string; observed: string }>(
    ctx.db,
    sql`SELECT obs.name AS observer, obd.name AS observed FROM collections col
        JOIN peers obs ON obs.id = col.observer_id JOIN peers obd ON obd.id = col.observed_id
        WHERE col.workspace_id = ${ws.id} AND NOT obd.is_scope
          AND EXISTS (SELECT 1 FROM conclusions c WHERE c.collection_id = col.id
                        AND c.deleted_at IS NULL AND c.valid_to IS NULL)
        ORDER BY col.new_since_dream DESC, col.last_dream_at NULLS FIRST, col.id LIMIT ${limit}`,
  );
}

// ---------------------------------------------------------------------------
// Webhooks of a workspace

export interface WebhookView {
  id: string;
  url: string;
  createdAt: string | null;
  /** The newest delivery to this endpoint still on record (deliveries are kept a day). */
  last: { type: string; status: string; error: string | null; at: string | null } | null;
}

export async function webhookEndpoints(ctx: AppContext, ws: WsHandle): Promise<WebhookView[]> {
  const endpoints = await rows<{ id: string; url: string; created_at: Date | string | null }>(
    ctx.db,
    sql`SELECT id, url, created_at FROM webhook_endpoints WHERE workspace_id = ${ws.id}
        ORDER BY created_at, id`,
  );
  if (!endpoints.length) return [];
  const last = await rows<{
    endpoint_id: string;
    type: string | null;
    status: string;
    last_error: string | null;
    at: Date | string | null;
  }>(
    ctx.db,
    sql`SELECT DISTINCT ON (j.payload->>'endpoint_id') j.payload->>'endpoint_id' AS endpoint_id,
               j.payload->>'type' AS type, j.status, j.last_error,
               COALESCE(j.finished_at, j.created_at) AS at
        FROM jobs j WHERE j.workspace_id = ${ws.id} AND j.kind = 'webhook'
          AND ${inList(
            sql`j.payload->>'endpoint_id'`,
            endpoints.map((e) => e.id),
          )}
        ORDER BY j.payload->>'endpoint_id', j.id DESC`,
  );
  const by = new Map(last.map((r) => [r.endpoint_id, r]));
  return endpoints.map((e) => {
    const l = by.get(e.id);
    return {
      id: e.id,
      url: e.url,
      createdAt: date(e.created_at),
      last: l
        ? {
            type: l.type ?? "event",
            status: l.status,
            error: l.last_error
              ? (l.last_error.trim().split("\n").at(-1) ?? "").slice(0, 200)
              : null,
            at: date(l.at),
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Corrections

/**
 * Marks a current fact as replaced by `replacementId` (a correction made in the dashboard: the
 * replacement is created first, through the API's own path). The old fact keeps its text and
 * gets the end of its validity, as when Recall learns that something changed. False when the fact
 * is no longer current in this workspace.
 */
export async function supersedeFact(
  ctx: AppContext,
  ws: WsHandle,
  id: string,
  replacementId: string,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await rows<{ collection_id: string }>(
      tx,
      sql`UPDATE conclusions SET valid_to = GREATEST(COALESCE(valid_from, created_at), now()),
            superseded_by = ${replacementId}, updated_at = now()
          WHERE id = ${id} AND workspace_id = ${ws.id} AND valid_to IS NULL AND deleted_at IS NULL
          RETURNING collection_id`,
    );
    if (!row) return false;
    // Every change to a collection bumps its version (cached answers key on it).
    await tx.execute(
      sql`UPDATE collections SET version = version + 1 WHERE id = ${row.collection_id}`,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// Peers and sessions of a workspace

export interface PeerListItem {
  name: string;
  createdAt: string | null;
  messages: number;
  facts: number;
  sessions: number;
  lastMessageAt: string | null;
}

export async function peerList(
  ctx: AppContext,
  ws: WsHandle,
  page: number,
  size = 25,
): Promise<OffsetPage<PeerListItem>> {
  const listed = asOffset<{ id: string; created_at: string | null }>(
    await listPeers(ctx, ws.key, offsetPaging(page, size, true), {}),
  );
  const names = listed.items.map((p) => p.id);
  const stats = new Map<string, Obj>();
  if (names.length) {
    for (const r of await rows<Obj>(
      ctx.db,
      sql`SELECT p.name,
            (SELECT count(*) FROM messages m WHERE m.peer_id = p.id)::int AS messages,
            (SELECT count(*) FROM conclusions c WHERE c.observed_id = p.id AND ${stateCond("current")})::int AS facts,
            (SELECT count(*) FROM session_peers sp WHERE sp.peer_id = p.id)::int AS sessions,
            (SELECT max(m.created_at) FROM messages m WHERE m.peer_id = p.id) AS last_message_at
          FROM peers p WHERE p.workspace_id = ${ws.id} AND ${inList(sql`p.name`, names)}`,
    ))
      stats.set(r.name as string, r);
  }
  return {
    ...listed,
    items: listed.items.map((p) => {
      const s = stats.get(p.id) ?? {};
      return {
        name: p.id,
        createdAt: p.created_at,
        messages: num(s.messages ?? 0),
        facts: num(s.facts ?? 0),
        sessions: num(s.sessions ?? 0),
        lastMessageAt: date(s.last_message_at),
      };
    }),
  };
}

/** Peer names of a workspace for pickers (newest first). */
export async function peerNames(ctx: AppContext, ws: WsHandle, limit = 500): Promise<string[]> {
  const found = await rows<{ name: string }>(
    ctx.db,
    sql`SELECT p.name FROM peers p WHERE p.workspace_id = ${ws.id} AND NOT p.is_scope
        ORDER BY p.created_at DESC, p.id LIMIT ${limit}`,
  );
  return found.map((r) => r.name);
}

export interface SessionListItem {
  name: string;
  active: boolean;
  createdAt: string | null;
  messages: number;
  lastMessageAt: string | null;
  peers: string[];
}

async function sessionStats(ctx: AppContext, wsId: string, names: string[]) {
  const stats = new Map<string, Obj>();
  if (!names.length) return stats;
  for (const r of await rows<Obj>(
    ctx.db,
    sql`SELECT s.name,
          (SELECT count(*) FROM messages m WHERE m.session_id = s.id)::int AS messages,
          (SELECT max(m.created_at) FROM messages m WHERE m.session_id = s.id) AS last_message_at,
          ARRAY(SELECT p.name FROM session_peers sp JOIN peers p ON p.id = sp.peer_id
                WHERE sp.session_id = s.id AND sp.left_at IS NULL AND NOT p.is_scope
                ORDER BY sp.joined_at, p.name) AS peers
        FROM sessions s WHERE s.workspace_id = ${wsId} AND ${inList(sql`s.name`, names)}`,
  ))
    stats.set(r.name as string, r);
  return stats;
}

const toSessionItem = (
  s: { id: string; is_active: boolean; created_at: string | null },
  stats: Map<string, Obj>,
): SessionListItem => {
  const x = stats.get(s.id) ?? {};
  return {
    name: s.id,
    active: s.is_active,
    createdAt: s.created_at,
    messages: num(x.messages ?? 0),
    lastMessageAt: date(x.last_message_at),
    peers: Array.isArray(x.peers) ? (x.peers as string[]) : [],
  };
};

export async function sessionList(
  ctx: AppContext,
  ws: WsHandle,
  page: number,
  size = 25,
): Promise<OffsetPage<SessionListItem>> {
  const listed = asOffset<{ id: string; is_active: boolean; created_at: string | null }>(
    await listSessions(ctx, ws.key, offsetPaging(page, size, true), null),
  );
  const stats = await sessionStats(
    ctx,
    ws.id,
    listed.items.map((s) => s.id),
  );
  return { ...listed, items: listed.items.map((s) => toSessionItem(s, stats)) };
}

// ---------------------------------------------------------------------------
// One peer

export interface PeerView {
  name: string;
  internalId: string;
  isScope: boolean;
  createdAt: string | null;
  messages: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  card: string[] | null;
  /** Per line of `card`, the facts it rests on (see `cardSources`). */
  cardSources: CardSource[];
  /** Cards other peers keep about this one. */
  otherCards: { observer: string; card: string[] }[];
  /** Other peers holding conclusions about this one (for the playground). */
  observers: string[];
  /** Facts about this peer per observer, the peer's own view first. */
  views: { observer: string; current: number; superseded: number }[];
  /** Facts about this peer from every observer. */
  totals: { current: number; superseded: number; self: number };
}

/** Most facts listed under one card line. */
const CARD_SOURCES_MAX = 20;

/** The facts behind one peer-card line. */
export interface CardSource {
  entry: string;
  /** Current facts in the peer's own memory that name every word of the line's value. */
  facts: { id: string; content: string; at: string }[];
  /** The value is the peer's own name: every fact names it, so none is listed. */
  isName: boolean;
}

/**
 * For each card line, the current facts in the peer's own memory that name its value: the line
 * "ATTRIBUTE: Home: Utrecht" rests on the facts that mention "Utrecht" (the same matching that
 * dates card entries, `supportDate`). Newest first, at most CARD_SOURCES_MAX per line.
 */
export async function cardSources(
  ctx: AppContext,
  ws: WsHandle,
  peerId: string,
  peerName: string,
  card: string[],
): Promise<CardSource[]> {
  const facts = await rows<{ id: string; content: string; at: Date | string }>(
    ctx.db,
    sql`SELECT c.id, c.content, COALESCE(c.valid_from, c.created_at) AS at FROM conclusions c
        WHERE c.workspace_id = ${ws.id} AND c.observer_id = ${peerId} AND c.observed_id = ${peerId}
          AND c.deleted_at IS NULL AND c.valid_to IS NULL
        ORDER BY at DESC, c.id LIMIT 2000`,
  );
  const words = facts.map((f) => new Set(normKey(f.content).split(" ")));
  const nameWords = new Set(normKey(peerName).split(" "));
  return card.map((entry) => {
    const terms = cardValueTerms(entry);
    const isName = terms.length > 0 && terms.every((t) => nameWords.has(t));
    const matched =
      terms.length && !isName
        ? facts.filter((_, i) => terms.every((t) => words[i]!.has(t))).slice(0, CARD_SOURCES_MAX)
        : [];
    return {
      entry,
      isName,
      facts: matched.map((f) => ({
        id: f.id,
        content: f.content,
        at: (f.at instanceof Date ? f.at : new Date(f.at)).toISOString(),
      })),
    };
  });
}

export async function peerView(ctx: AppContext, ws: WsHandle, name: string): Promise<PeerView> {
  const peer = await selectPeerRow(ctx.db, ws.id, name);
  if (!peer) throw notFound("Peer");
  const card = await getPeerCard(ctx, ws.key, peer.name, undefined);
  const [stats] = await rows<Obj>(
    ctx.db,
    sql`SELECT count(*)::int AS n, min(m.created_at) AS first_at, max(m.created_at) AS last_at
        FROM messages m WHERE m.workspace_id = ${ws.id} AND m.peer_id = ${peer.internal_id}`,
  );
  const others = await rows<{ observer: string; peer_card: unknown }>(
    ctx.db,
    sql`SELECT obs.name AS observer, col.peer_card FROM collections col
        JOIN peers obs ON obs.id = col.observer_id
        WHERE col.workspace_id = ${ws.id} AND col.observed_id = ${peer.internal_id}
          AND col.observer_id <> ${peer.internal_id} AND jsonb_array_length(col.peer_card) > 0
        ORDER BY obs.name LIMIT 20`,
  );
  const observers = await rows<{ name: string; current: number; superseded: number }>(
    ctx.db,
    sql`SELECT obs.name, count(*) FILTER (WHERE c.valid_to IS NULL)::int AS current,
               count(*) FILTER (WHERE c.valid_to IS NOT NULL)::int AS superseded
        FROM conclusions c JOIN peers obs ON obs.id = c.observer_id
        WHERE c.workspace_id = ${ws.id} AND c.observed_id = ${peer.internal_id} AND c.deleted_at IS NULL
        GROUP BY obs.name ORDER BY obs.name LIMIT 100`,
  );
  const sum = (k: "current" | "superseded") => observers.reduce((a, o) => a + num(o[k]), 0);
  const self = observers.find((o) => o.name === peer.name);
  return {
    name: peer.name,
    internalId: peer.internal_id,
    isScope: peer.is_scope,
    createdAt: iso(peer.created_at),
    messages: num(stats?.n ?? 0),
    firstMessageAt: date(stats?.first_at),
    lastMessageAt: date(stats?.last_at),
    card,
    cardSources: card?.length ? await cardSources(ctx, ws, peer.internal_id, peer.name, card) : [],
    otherCards: others
      .filter((o) => Array.isArray(o.peer_card))
      .map((o) => ({ observer: o.observer, card: o.peer_card as string[] })),
    observers: observers.map((o) => o.name).filter((n) => n !== peer.name),
    views: observers
      .map((o) => ({ observer: o.name, current: num(o.current), superseded: num(o.superseded) }))
      .sort((a, b) => Number(b.observer === peer.name) - Number(a.observer === peer.name)),
    totals: {
      current: sum("current"),
      superseded: sum("superseded"),
      self: self ? num(self.current) + num(self.superseded) : 0,
    },
  };
}

export type FactFilter = "current" | "all";

export interface FactQuery {
  state: FactFilter;
  q: string;
  /** One observer's conclusions, or null for every observer's. */
  observer: string | null;
  page: number;
}

export interface MessageRef {
  id: string;
  session: string;
  peer: string;
  content: string;
  createdAt: string | null;
}

export interface FactsView {
  items: ConclusionRow[];
  total: number;
  page: number;
  pages: number;
  counts: { current: number; superseded: number };
  /** Source messages of the listed facts, by id. */
  messages: Map<string, MessageRef>;
  /** Facts the listed ones point at (replacements and premises), by id. */
  related: Map<string, ConclusionRow>;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Conclusions about a peer, current and (optionally) superseded, newest first. */
export async function peerFacts(
  ctx: AppContext,
  ws: WsHandle,
  peer: PeerView,
  f: FactQuery,
  size = 40,
): Promise<FactsView> {
  const base = and(
    sql`c.workspace_id = ${ws.id}`,
    sql`c.observed_id = ${peer.internalId}`,
    f.observer ? sql`obs.name = ${f.observer}` : undefined,
    f.q ? sql`c.content ILIKE ${`%${escapeLike(f.q)}%`} ESCAPE '\\'` : undefined,
  );
  const [counts] = await rows<{ current: number; superseded: number }>(
    ctx.db,
    sql`SELECT count(*) FILTER (WHERE c.valid_to IS NULL)::int AS current,
               count(*) FILTER (WHERE c.valid_to IS NOT NULL)::int AS superseded
        FROM ${CONC_FROM} WHERE ${base} AND c.deleted_at IS NULL`,
  );
  const current = num(counts?.current ?? 0);
  const superseded = num(counts?.superseded ?? 0);
  const total = f.state === "current" ? current : current + superseded;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, f.page), pages);
  const found = (
    await rows<Obj>(
      ctx.db,
      sql`SELECT ${CONC_COLS} FROM ${CONC_FROM} WHERE ${base} AND ${stateCond(f.state)}
          ORDER BY COALESCE(c.valid_from, c.created_at) DESC, c.created_at DESC, c.id
          LIMIT ${size} OFFSET ${(page - 1) * size}`,
    )
  ).map(mapConclusion);
  const related = await factsByIds(ctx, ws, [
    ...new Set(found.flatMap((c) => [...(c.supersededBy ? [c.supersededBy] : []), ...c.sourceIds])),
  ]);
  return {
    items: found,
    total,
    page,
    pages,
    counts: { current, superseded },
    messages: await messagesByIds(ctx, ws, [...new Set(found.flatMap((c) => c.messageIds))]),
    related,
  };
}

/** Conclusions by id, inside this workspace only. */
export async function factsByIds(
  ctx: AppContext,
  ws: WsHandle,
  ids: string[],
): Promise<Map<string, ConclusionRow>> {
  if (!ids.length) return new Map();
  const found = await rows<Obj>(
    ctx.db,
    sql`SELECT ${CONC_COLS} FROM ${CONC_FROM}
        WHERE c.workspace_id = ${ws.id} AND c.deleted_at IS NULL AND ${inList(sql`c.id`, ids)}`,
  );
  return new Map(found.map(mapConclusion).map((c) => [c.id, c]));
}

/** Messages by id, inside this workspace only. */
export async function messagesByIds(
  ctx: AppContext,
  ws: WsHandle,
  ids: string[],
): Promise<Map<string, MessageRef>> {
  if (!ids.length) return new Map();
  const found = (
    await rows<Obj>(
      ctx.db,
      sql`SELECT ${MSG_COLS} FROM ${MSG_FROM}
          WHERE m.workspace_id = ${ws.id} AND ${inList(sql`m.id`, ids.slice(0, 500))}`,
    )
  ).map(mapMessage);
  return new Map(found.map((m: MessageRow) => [m.id, messageRef(m)]));
}

const messageRef = (m: MessageRow): MessageRef => ({
  id: m.id,
  session: m.sessionName,
  peer: m.peerName,
  content: m.content,
  createdAt: m.createdAt.toISOString(),
});

export async function peerSessions(
  ctx: AppContext,
  ws: WsHandle,
  peer: string,
): Promise<OffsetPage<SessionListItem>> {
  const listed = asOffset<{ id: string; is_active: boolean; created_at: string | null }>(
    await listPeerSessions(ctx, ws.key, peer, offsetPaging(1, 20, true), null),
  );
  const stats = await sessionStats(
    ctx,
    ws.id,
    listed.items.map((s) => s.id),
  );
  return { ...listed, items: listed.items.map((s) => toSessionItem(s, stats)) };
}

// ---------------------------------------------------------------------------
// One session

export interface SessionView {
  name: string;
  internalId: string;
  createdAt: string | null;
  messages: number;
  peers: string[];
  summaries: Awaited<ReturnType<typeof latestSummaries>>;
}

export async function sessionView(
  ctx: AppContext,
  ws: WsHandle,
  name: string,
): Promise<SessionView> {
  const s = await selectSessionRow(ctx.db, ws.id, name);
  if (!s?.is_active) throw notFound("Session");
  const members = asOffset<{ id: string }>(
    await listSessionPeers(ctx, ws.key, s.name, offsetPaging(1, 100, false)),
  );
  const [count] = await rows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM messages m WHERE m.session_id = ${s.internal_id}`,
  );
  return {
    name: s.name,
    internalId: s.internal_id,
    createdAt: iso(s.created_at),
    messages: num(count?.n ?? 0),
    peers: members.items.map((p) => p.id),
    summaries: await latestSummaries(ctx, s.internal_id),
  };
}

export interface TranscriptMessage {
  id: string;
  peer: string;
  content: string;
  createdAt: string | null;
  tokens: number;
}

/**
 * One page of the transcript, oldest first within the page. Without a page the
 * latest page is shown; `at` (a message id of this session) picks its page.
 */
export async function transcript(
  ctx: AppContext,
  ws: WsHandle,
  s: SessionView,
  opts: { page: number | null; at: string | null },
  size = 30,
): Promise<{ items: TranscriptMessage[]; page: number; pages: number; total: number }> {
  const pages = Math.max(1, Math.ceil(s.messages / size));
  let page = opts.page ?? pages;
  if (opts.at) {
    const [r] = await rows<{ n: number }>(
      ctx.db,
      sql`SELECT count(*)::int AS n FROM messages m
          WHERE m.session_id = ${s.internalId}
            AND m.seq <= (SELECT t.seq FROM messages t WHERE t.id = ${opts.at} AND t.session_id = ${s.internalId})`,
    );
    const position = num(r?.n ?? 0);
    if (position > 0) page = Math.ceil(position / size);
  }
  page = Math.min(Math.max(1, page), pages);
  const listed = asOffset<{
    id: string;
    peer_id: string;
    content: string;
    created_at: string | null;
    token_count: number;
  }>(await listMessages(ctx, ws.key, s.name, offsetPaging(page, size, false), null));
  return {
    items: listed.items.map((m) => ({
      id: m.id,
      peer: m.peer_id,
      content: m.content,
      createdAt: m.created_at,
      tokens: m.token_count,
    })),
    page,
    pages,
    total: s.messages,
  };
}

export interface ContextParams {
  tokens: number;
  peerTarget: string | null;
  summary: boolean;
}

/** Exactly what `GET …/sessions/{id}/context` returns for these parameters (no model calls). */
export async function contextPreview(
  ctx: AppContext,
  ws: WsHandle,
  s: SessionView,
  p: ContextParams,
  accountId: string,
) {
  return sessionContext(ctx, {
    workspace: ws.key,
    session: s.name,
    tokens: p.tokens,
    summary: p.summary,
    peerTarget: p.peerTarget,
    peerPerspective: null,
    scope: null,
    sessions: null,
    limitToSession: false,
    searchQuery: null,
    searchTopK: null,
    searchMaxDistance: null,
    includeMostFrequent: false,
    maxConclusions: 100,
    auth: dashboardAuth(accountId),
  });
}
export type ContextResult = Awaited<ReturnType<typeof contextPreview>>;

// ---------------------------------------------------------------------------
// Playground

export interface AskInput {
  peer: string;
  /** Whose memory answers; null or the peer itself = the peer's own. */
  perspective: string | null;
  query: string;
  level: ChatLevel;
  /** Per-form nonce: a resubmitted form is charged once. */
  nonce: string | null;
}

export interface AskOutcome {
  input: AskInput;
  result: ChatResult | null;
  error: { status: number; message: string } | null;
  facts: Map<string, ConclusionRow>;
  messages: Map<string, MessageRef>;
}

/**
 * Asks a question about a peer through the API's chat path (`prepareChat` +
 * `runChat`), so validation, the spend cap (402) and per-query billing are the
 * ones `POST …/peers/{id}/chat` applies. The peer (and the perspective) must
 * already exist: the playground never creates anything.
 */
export async function ask(
  ctx: AppContext,
  ws: WsHandle,
  accountId: string,
  input: AskInput,
): Promise<AskOutcome> {
  const observed = await selectPeerRow(ctx.db, ws.id, input.peer);
  if (!observed) throw notFound("Peer");
  const perspective =
    input.perspective && input.perspective !== input.peer ? input.perspective : null;
  if (perspective && !(await selectPeerRow(ctx.db, ws.id, perspective))) throw notFound("Peer");
  const outcome: AskOutcome = {
    input: { ...input, perspective },
    result: null,
    error: null,
    facts: new Map(),
    messages: new Map(),
  };
  try {
    limitChat(ctx, dashboardAuth(accountId));
    const prepared = await prepareChat(ctx, {
      workspace: ws.key,
      peer: perspective ?? input.peer,
      target: perspective ? input.peer : null,
      query: input.query,
      sessionId: null,
      filters: null,
      scope: null,
      level: input.level,
      responseFormat: null,
      includeEvidence: true,
      auth: dashboardAuth(accountId),
      billingKey: input.nonce ? `dash:${input.nonce}` : null,
    });
    for await (const ev of runChat(ctx, prepared, false)) {
      if (ev.type === "done") outcome.result = ev.result;
    }
  } catch (err) {
    const mapped = err instanceof LlmError ? mapLlmError(err, ctx) : err;
    if (!(mapped instanceof ApiError)) throw mapped;
    outcome.error = { status: mapped.status, message: mapped.detail };
    return outcome;
  }
  const evidence = outcome.result?.evidence;
  if (evidence) {
    outcome.facts = await factsByIds(
      ctx,
      ws,
      evidence.conclusions.map((c) => c.id),
    );
    outcome.messages = await messagesByIds(
      ctx,
      ws,
      evidence.messages.map((m) => m.id),
    );
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Account-wide: getting started and activity

export interface Checklist {
  key: boolean;
  messages: boolean;
  facts: boolean;
  asked: boolean;
}

const exists = async (ctx: AppContext, q: SQL) =>
  !!(await rows<{ ok: boolean }>(ctx.db, sql`SELECT EXISTS (${q}) AS ok`))[0]?.ok;

/** Getting-started progress, from the account's real data. */
export async function checklist(ctx: AppContext, accountId: string): Promise<Checklist> {
  const inAccount = (alias: string) =>
    sql`${sql.raw(alias)}.workspace_id IN (SELECT w.id FROM workspaces w WHERE w.account_id = ${accountId})`;
  const [key, messages, facts, charged, called] = await Promise.all([
    exists(
      ctx,
      sql`SELECT 1 FROM api_keys k WHERE k.account_id = ${accountId} AND k.revoked_at IS NULL`,
    ),
    exists(ctx, sql`SELECT 1 FROM messages m WHERE ${inAccount("m")}`),
    exists(ctx, sql`SELECT 1 FROM conclusions c WHERE ${inAccount("c")} AND c.deleted_at IS NULL`),
    exists(
      ctx,
      sql`SELECT 1 FROM credit_ledger l WHERE l.account_id = ${accountId} AND l.kind LIKE 'chat\\_%'`,
    ),
    exists(
      ctx,
      sql`SELECT 1 FROM llm_usage u WHERE u.account_id = ${accountId} AND u.task LIKE 'chat\\_%'`,
    ),
  ]);
  return { key, messages, facts, asked: charged || called };
}

export interface DailySeries {
  /** UTC days, oldest first (YYYY-MM-DD). */
  days: string[];
  messages: number[];
  /** Answered questions (billed accounts: one ledger entry per answer) or chat model calls. */
  questions: number[];
  questionsExact: boolean;
}

/** The last `n` UTC days, oldest first. */
export function lastDays(n: number, now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: n }, (_, i) =>
    new Date(today - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

const DAY = (col: string) =>
  sql.raw(`to_char(date_trunc('day', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`);

/**
 * One kind of usage over a period: learning or storage (in tokens) or chat at one level (questions).
 */
export interface UsageLine {
  /** "ingest", "store" or "chat_<level>". */
  kind: string;
  units: number;
  /** Charged, less charges given back; null for an account that is not billed. */
  micros: number | null;
}

/** One UTC day of usage. */
export interface UsageDay {
  day: string;
  /** Message tokens learned. */
  tokens: number;
  questions: number;
  /** Charged that day; null for an account that is not billed. */
  micros: number | null;
}

export interface UsageReport {
  /** The UTC days covered, oldest first. */
  range: string[];
  /** Days with any usage, newest first. */
  days: UsageDay[];
  /** Learning first, then storage, then chat by level. */
  lines: UsageLine[];
  /**
   * True for a billed account: units and amounts come from its charges. Otherwise message tokens
   * are those of the messages learned from, and questions are counted from answer model calls.
   */
  billed: boolean;
}

/**
 * The billable units of the last `n` UTC days (message tokens learned, questions per level), with
 * what they were charged on a billed account. Never model calls or model tokens: those are our
 * cost, not what the customer buys.
 */
export async function usageReport(
  ctx: AppContext,
  accountId: string,
  billed: boolean,
  n = 30,
): Promise<UsageReport> {
  const range = lastDays(n);
  const since = new Date(`${range[0]}T00:00:00Z`);
  const days = new Map<string, UsageDay>();
  const lines = new Map<string, UsageLine>();
  const add = (d: string, kind: string, units: number, micros: number | null) => {
    const r = days.get(d) ?? { day: d, tokens: 0, questions: 0, micros: billed ? 0 : null };
    days.set(d, r);
    const l = lines.get(kind) ?? { kind, units: 0, micros: billed ? 0 : null };
    lines.set(kind, l);
    if (kind === "ingest") r.tokens += units;
    else if (kind.startsWith("chat_")) r.questions += units;
    l.units += units;
    if (micros !== null) {
      r.micros = (r.micros ?? 0) + micros;
      l.micros = (l.micros ?? 0) + micros;
    }
  };
  if (billed) {
    for (const c of await usageCharges(ctx.db, accountId, { since, by: "day" }))
      add(c.group!, c.kind, c.kind.startsWith("chat_") ? c.count : c.tokens, c.micros);
  } else {
    const [learned, asked] = await Promise.all([
      rows<{ day: string; tokens: number | string }>(
        ctx.db,
        sql`SELECT ${DAY("m.reasoned_at")} AS day, sum(m.token_count) AS tokens
            FROM messages m JOIN workspaces w ON w.id = m.workspace_id
            WHERE w.account_id = ${accountId} AND m.reasoned_at >= ${since} GROUP BY 1`,
      ),
      rows<{ day: string; task: string; n: number }>(
        ctx.db,
        sql`SELECT ${DAY("u.created_at")} AS day, u.task, count(*)::int AS n FROM llm_usage u
            WHERE u.account_id = ${accountId} AND u.created_at >= ${since} AND u.task LIKE 'chat\\_%'
            GROUP BY 1, 2`,
      ),
    ]);
    for (const r of learned) add(r.day, "ingest", num(r.tokens), null);
    for (const r of asked) add(r.day, r.task, num(r.n), null);
  }
  const order = (kind: string) =>
    kind === "ingest"
      ? -2
      : kind === "store"
        ? -1
        : CHAT_LEVELS.indexOf(kind.replace(/^chat_/, "") as ChatLevel);
  return {
    range,
    days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    lines: [...lines.values()]
      .filter((l) => l.units !== 0 || (l.micros ?? 0) !== 0)
      .sort((a, b) => order(a.kind) - order(b.kind)),
    billed,
  };
}

/** Messages stored and questions answered per UTC day, over the last `n` days. */
export async function dailyActivity(
  ctx: AppContext,
  accountId: string,
  billed: boolean,
  n = 30,
): Promise<DailySeries> {
  const days = lastDays(n);
  const since = new Date(`${days[0]}T00:00:00Z`);
  const messages = await rows<{ day: string; n: number }>(
    ctx.db,
    sql`SELECT ${DAY("m.created_at")} AS day, count(*)::int AS n
        FROM messages m JOIN workspaces w ON w.id = m.workspace_id
        WHERE w.account_id = ${accountId} AND m.created_at >= ${since} GROUP BY 1`,
  );
  // Billed accounts are charged once per answered question (cache hits included): exact.
  // Otherwise the closest record is the chat model calls in llm_usage.
  const questions = billed
    ? await rows<{ day: string; n: number }>(
        ctx.db,
        // A charge given back (no answer came) is not a question answered.
        sql`SELECT ${DAY("l.created_at")} AS day,
                   GREATEST(0, count(*) FILTER (WHERE l.amount_micros < 0)
                               - count(*) FILTER (WHERE l.amount_micros > 0))::int AS n
            FROM credit_ledger l
            WHERE l.account_id = ${accountId} AND l.created_at >= ${since} AND l.kind LIKE 'chat\\_%'
            GROUP BY 1`,
      )
    : await rows<{ day: string; n: number }>(
        ctx.db,
        sql`SELECT ${DAY("u.created_at")} AS day, count(*)::int AS n FROM llm_usage u
            WHERE u.account_id = ${accountId} AND u.created_at >= ${since} AND u.task LIKE 'chat\\_%'
            GROUP BY 1`,
      );
  const spread = (found: { day: string; n: number }[]) => {
    const by = new Map(found.map((r) => [r.day, num(r.n)]));
    return days.map((d) => by.get(d) ?? 0);
  };
  return { days, messages: spread(messages), questions: spread(questions), questionsExact: billed };
}
