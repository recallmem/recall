import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { WsKey } from "../core/tenancy.js";
import type { AuthState } from "../http/auth.js";
import { compileFilters } from "../http/filters.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { countTokens } from "../lib/tokens.js";
import { serializeMessage } from "./format.js";
import {
  type Allowlist,
  asScopeList,
  assertPeerMemberOf,
  getCard,
  getPeer,
  getSession,
  getWorkspace,
  type PeerRef,
  parseSessionAllowlist,
  rejectScopePeer,
  requireWorkspaceLevelForScope,
  resolveAllowlist,
  resolveScopePeers,
  SCOPE_PREFIX,
  scopeSessions,
} from "./lookup.js";
import { queryVectors } from "./pack.js";
import { buildRepresentation, EMBED_TOKEN_LIMIT } from "./representation.js";
import { searchMessages } from "./search.js";
import { and, inList } from "./util.js";

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Message search (workspace, peer, session)
// ---------------------------------------------------------------------------

/** Removes keys the route forces itself, so a client cannot widen the search by sending them. */
function withoutKeys(filters: unknown, keys: string[]): unknown {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return filters;
  const copy = { ...(filters as Obj) };
  for (const k of keys) delete copy[k];
  return copy;
}

/**
 * The top-level `peer_perspective` key of a message-search filter (Honcho accepts it; its
 * integrations send it to search "what this peer saw"). Validated here instead of being passed
 * through: it must be a peer id. Returns null when absent.
 */
function perspectiveOf(filters: unknown): string | null {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;
  if (!Object.hasOwn(filters, "peer_perspective")) return null;
  const value = (filters as Obj).peer_perspective;
  if (typeof value !== "string" || !value || value === "*") {
    throw unprocessable("peer_perspective must be a peer id (a non-empty string)");
  }
  return value;
}

/**
 * Messages `peerId` saw: those in sessions it belongs to (or belonged to) that were written while
 * it was a member (`joined_at` through `left_at`), plus everything it wrote itself. Evaluated in
 * SQL, so a perspective search still fills `limit` (the reference post-filters and can come back short).
 */
function seenBy(peerId: string) {
  return sql`EXISTS (SELECT 1 FROM session_peers sp
      WHERE sp.session_id = m.session_id AND sp.peer_id = ${peerId}
        AND (m.peer_id = ${peerId}
             OR (m.created_at >= sp.joined_at AND (sp.left_at IS NULL OR m.created_at <= sp.left_at))))`;
}

export interface SearchParams {
  workspace: WsKey;
  query: string;
  filters?: unknown;
  limit: number;
  /** Narrow to a peer's authored messages. */
  peer?: string;
  /** Narrow to one session. */
  session?: string;
  /** Unprefixed scope name (workspace search). */
  scope?: string | null;
  /** Recall: add to each result why it ranked where it did. */
  explain?: boolean;
}

export async function searchMessagesApi(ctx: AppContext, p: SearchParams) {
  if (countTokens(p.query) > EMBED_TOKEN_LIMIT) {
    throw unprocessable(`Query exceeds maximum token limit of ${EMBED_TOKEN_LIMIT}.`);
  }
  if (p.scope && p.filters && typeof p.filters === "object" && "session_id" in (p.filters as Obj)) {
    throw unprocessable("`scope` and a 'session_id' filter are mutually exclusive");
  }
  const perspective = perspectiveOf(p.filters);
  const forced = [
    "workspace_id",
    "peer_perspective",
    ...(p.peer ? ["peer_id"] : []),
    ...(p.session ? ["session_id"] : []),
  ];
  const clientFilter = compileFilters("messages", withoutKeys(p.filters, forced));

  const ws = await getWorkspace(ctx, p.workspace);
  if (!ws) {
    if (p.scope) throw notFound(`Scope '${p.scope}'`);
    return [];
  }
  let cond: SQL | undefined = clientFilter;
  if (perspective) {
    // A peer that does not exist saw nothing.
    const viewer = await getPeer(ctx, ws.id, perspective);
    if (!viewer) return [];
    cond = and(cond, seenBy(viewer.id));
  }
  if (p.peer) {
    const peer = await getPeer(ctx, ws.id, p.peer);
    if (!peer) return [];
    cond = and(cond, sql`m.peer_id = ${peer.id}`);
  }
  if (p.session) {
    const session = await getSession(ctx, ws.id, p.session);
    if (!session) return [];
    cond = and(cond, sql`m.session_id = ${session.id}`);
  }
  if (p.scope) {
    const peers = await resolveScopePeers(ctx, ws.id, [p.scope]);
    const sessions = await scopeSessions(ctx, ws.id, peers);
    if (!sessions.ids.length) return [];
    cond = and(cond, inList(sql`m.session_id`, sessions.ids));
  }
  const vectors = await queryVectors(ctx, ws.id, p.query, false);
  const hits = await searchMessages(ctx, {
    workspaceId: ws.id,
    query: p.query,
    vectors,
    limit: p.limit,
    cond,
  });
  return hits.map((h, i) =>
    p.explain
      ? {
          ...serializeMessage(h.row),
          explain: {
            rank: i + 1,
            score: Math.round(h.score * 1e6) / 1e6,
            rank_by_meaning: h.vectorRank ?? null,
            distance: h.dist == null ? null : Math.round(h.dist * 1e4) / 1e4,
            rank_by_words: h.lexicalRank ?? null,
          },
        }
      : serializeMessage(h.row),
  );
}

// ---------------------------------------------------------------------------
// Representation and peer context
// ---------------------------------------------------------------------------

export interface RepresentationParams {
  workspace: WsKey;
  peer: string;
  auth: AuthState;
  sessionId?: string | null;
  filters?: unknown;
  scope?: string | string[] | null;
  target?: string | null;
  searchQuery?: string | null;
  searchTopK?: number | null;
  searchMaxDistance?: number | null;
  includeMostFrequent: boolean;
  maxConclusions: number;
}

export async function representation(ctx: AppContext, p: RepresentationParams): Promise<string> {
  for (const name of [p.peer, p.target]) {
    if (name?.startsWith(SCOPE_PREFIX)) rejectScopePeer({ name, isScope: true });
  }
  let scopes: string[] | null = null;
  if (p.scope != null) {
    scopes = asScopeList(p.scope);
    if (p.sessionId) throw unprocessable("`scope` and `session_id` are mutually exclusive");
    if (p.filters != null) throw unprocessable("`scope` and `filters` are mutually exclusive");
    requireWorkspaceLevelForScope(p.auth);
  }
  const filterNames = parseSessionAllowlist(p.filters, p.sessionId);
  const sessionNames = filterNames ?? (p.sessionId ? [p.sessionId] : null);

  const ws = await getWorkspace(ctx, p.workspace);
  if (ws && sessionNames) await assertPeerMemberOf(ctx, p.auth, ws, sessionNames);
  if (!ws) return "";

  let allowlist: Allowlist | null = sessionNames
    ? await resolveAllowlist(ctx, ws.id, sessionNames)
    : null;
  let observer: PeerRef | null = await getPeer(ctx, ws.id, p.peer);
  if (scopes) {
    const scopePeers = await resolveScopePeers(ctx, ws.id, scopes);
    if (typeof p.scope === "string") observer = scopePeers[0]!;
    else allowlist = await scopeSessions(ctx, ws.id, scopePeers);
  }
  const observed = p.target
    ? await getPeer(ctx, ws.id, p.target)
    : await getPeer(ctx, ws.id, p.peer);
  rejectScopePeer(observed);
  if (!observer || !observed) return "";
  return (
    await buildRepresentation(ctx, {
      ws,
      observer,
      observed,
      allowlist,
      searchQuery: p.searchQuery,
      searchTopK: p.searchTopK,
      searchMaxDistance: p.searchMaxDistance,
      includeMostFrequent: p.includeMostFrequent,
      maxConclusions: p.maxConclusions,
    })
  ).text;
}

export interface PeerContextParams {
  workspace: WsKey;
  peer: string;
  target: string | null;
  searchQuery: string | null;
  searchTopK: number | null;
  searchMaxDistance: number | null;
  includeMostFrequent: boolean;
  maxConclusions: number;
}

export async function peerContext(ctx: AppContext, p: PeerContextParams) {
  for (const name of [p.peer, p.target]) {
    if (name?.startsWith(SCOPE_PREFIX)) rejectScopePeer({ name, isScope: true });
  }
  const ws = await getWorkspace(ctx, p.workspace);
  const observer = ws ? await getPeer(ctx, ws.id, p.peer) : null;
  if (!ws || !observer) throw notFound("Peer");
  const targetName = p.target ?? p.peer;
  const observed = targetName === observer.name ? observer : await getPeer(ctx, ws.id, targetName);
  rejectScopePeer(observed);
  let text = "";
  let card: string[] = [];
  if (observed) {
    text = (
      await buildRepresentation(ctx, {
        ws,
        observer,
        observed,
        allowlist: null,
        searchQuery: p.searchQuery,
        searchTopK: p.searchTopK,
        searchMaxDistance: p.searchMaxDistance,
        includeMostFrequent: p.includeMostFrequent,
        maxConclusions: p.maxConclusions,
      })
    ).text;
    card = (await getCard(ctx, ws.id, observer.id, observed.id)).card;
  }
  return {
    peer_id: p.peer,
    target_id: targetName,
    representation: text,
    peer_card: card.length ? card : null,
  };
}
