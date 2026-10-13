import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { WsKey } from "../core/tenancy.js";
import { rows } from "../db/client.js";
import type { AuthState } from "../http/auth.js";
import { unauthorized, unprocessable } from "../lib/errors.js";
import { countTokens } from "../lib/tokens.js";
import { type SummaryRow, serializeMessage, serializeSummary } from "./format.js";
import {
  type Allowlist,
  assertPeerMemberOf,
  getCard,
  getPeer,
  getSession,
  getWorkspace,
  isPeerToken,
  isSessionToken,
  type PeerRef,
  rejectScopePeer,
  requireWorkspaceLevelForScope,
  resolveAllowlist,
  resolveScopePeers,
} from "./lookup.js";
import { buildRepresentation } from "./representation.js";
import { type MessageRow, MSG_COLS, MSG_FROM, mapMessage } from "./search.js";
import { num, toDate } from "./util.js";

type Obj = Record<string, unknown>;

export const CONTEXT_MAX_TOKENS = 100_000;
/** Share of the budget a summary may take. */
const SUMMARY_SHARE = 0.4;

export async function latestSummaries(
  ctx: AppContext,
  sessionId: string,
): Promise<{ short: SummaryRow | null; long: SummaryRow | null }> {
  const r = await rows<Obj>(
    ctx.db,
    sql`SELECT DISTINCT ON (kind) kind, content, last_message_id, token_count, created_at, end_seq
        FROM summary_blocks WHERE session_id = ${sessionId} AND kind IN ('short', 'long')
        ORDER BY kind, end_seq DESC, created_at DESC`,
  );
  const map = (kind: "short" | "long"): SummaryRow | null => {
    const x = r.find((row) => row.kind === kind);
    return x
      ? {
          kind,
          content: x.content as string,
          lastMessageId: x.last_message_id as string,
          tokenCount: num(x.token_count),
          createdAt: toDate(x.created_at as string)!,
          endSeq: num(x.end_seq),
        }
      : null;
  };
  return { short: map("short"), long: map("long") };
}

/**
 * The long summary when it fits in 40% of the budget and says more than the
 * short one; otherwise the short summary when it fits; otherwise none.
 */
export function chooseSummary(
  s: { short: SummaryRow | null; long: SummaryRow | null },
  budget: number,
): SummaryRow | null {
  const cap = Math.floor(budget * SUMMARY_SHARE);
  if (s.long && s.long.tokenCount <= cap && s.long.tokenCount > (s.short?.tokenCount ?? 0))
    return s.long;
  if (s.short && s.short.tokenCount > 0 && s.short.tokenCount <= cap) return s.short;
  return null;
}

/** Newest messages (from `fromSeq` on) whose running token total fits `budget`, oldest first. */
export async function recentMessages(
  ctx: AppContext,
  sessionId: string,
  budget: number,
  fromSeq = 0,
): Promise<MessageRow[]> {
  if (budget <= 0) return [];
  const out: MessageRow[] = [];
  let used = 0;
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = (
      await rows<Obj>(
        ctx.db,
        sql`SELECT ${MSG_COLS} FROM ${MSG_FROM}
            WHERE m.session_id = ${sessionId} AND m.seq_in_session >= ${fromSeq} AND m.seq_in_session < ${before}
            ORDER BY m.seq_in_session DESC LIMIT 100`,
      )
    ).map(mapMessage);
    for (const m of page) {
      if (used + m.tokenCount > budget) return out.reverse();
      used += m.tokenCount;
      out.push(m);
    }
    if (page.length < 100) return out.reverse();
    before = page[page.length - 1]!.seqInSession;
  }
}

export interface SessionContextParams {
  workspace: WsKey;
  session: string;
  tokens: number | null;
  summary: boolean;
  peerTarget: string | null;
  peerPerspective: string | null;
  scope: string | null;
  sessions: string[] | null;
  limitToSession: boolean;
  searchQuery: string | null;
  searchTopK: number | null;
  searchMaxDistance: number | null;
  includeMostFrequent: boolean;
  maxConclusions: number;
  auth: AuthState;
}

export function validateContextParams(p: SessionContextParams): void {
  if (p.peerPerspective && !p.peerTarget)
    throw unprocessable("peer_target must be provided if peer_perspective is provided");
  if (p.scope && p.peerPerspective)
    throw unprocessable("`scope` and `peer_perspective` are mutually exclusive");
  if (p.scope && !p.peerTarget)
    throw unprocessable("peer_target must be provided if scope is provided");
  if (p.sessions && p.scope) throw unprocessable("`sessions` and `scope` are mutually exclusive");
  if (p.sessions && p.limitToSession)
    throw unprocessable("`sessions` and `limit_to_session` are mutually exclusive");
  if (p.sessions && !p.peerTarget)
    throw unprocessable("peer_target must be provided if sessions is provided");
  if (p.sessions && !p.sessions.includes(p.session))
    throw unprocessable("session_id must be included in sessions");
  if (p.sessions && p.sessions.length > 1000)
    throw unprocessable("sessions may contain at most 1000 entries");
  if (p.scope) requireWorkspaceLevelForScope(p.auth);
}

/** `GET …/sessions/{id}/context`: summary + recent messages (+ representation and card) inside one token budget. */
export async function sessionContext(ctx: AppContext, p: SessionContextParams) {
  validateContextParams(p);
  const empty = {
    id: p.session,
    messages: [],
    summary: null,
    peer_representation: null,
    peer_card: null,
  };
  const ws = await getWorkspace(ctx, p.workspace);
  if (!ws) return empty;
  const session = await getSession(ctx, ws.id, p.session);

  let representation: string | null = null;
  let card: string[] | null = null;
  let budget = Math.min(p.tokens ?? CONTEXT_MAX_TOKENS, CONTEXT_MAX_TOKENS);

  if (p.peerTarget) {
    const effectiveObserver = p.peerPerspective ?? p.peerTarget;
    if (isPeerToken(p.auth) && p.auth.claims.p !== effectiveObserver) throw unauthorized();
    if (isSessionToken(p.auth) && !p.limitToSession && !(p.sessions?.length === 1))
      throw unauthorized();
    if (p.sessions) await assertPeerMemberOf(ctx, p.auth, ws, p.sessions);

    const [target, perspective] = await Promise.all([
      getPeer(ctx, ws.id, p.peerTarget),
      p.peerPerspective ? getPeer(ctx, ws.id, p.peerPerspective) : Promise.resolve(null),
    ]);
    rejectScopePeer(target);
    rejectScopePeer(perspective);
    const scopePeer: PeerRef | undefined = p.scope
      ? (await resolveScopePeers(ctx, ws.id, [p.scope]))[0]
      : undefined;
    const observer = scopePeer ?? perspective ?? target;

    let allowlist: Allowlist | null = null;
    if (p.limitToSession)
      allowlist = session ? { ids: [session.id], names: [session.name] } : { ids: [], names: [] };
    else if (p.sessions) allowlist = await resolveAllowlist(ctx, ws.id, p.sessions);

    representation = "";
    if (target && observer) {
      const rep = await buildRepresentation(ctx, {
        ws,
        observer,
        observed: target,
        allowlist,
        searchQuery: p.searchQuery,
        searchTopK: p.searchTopK,
        searchMaxDistance: p.searchMaxDistance,
        includeMostFrequent: p.includeMostFrequent,
        maxConclusions: p.maxConclusions,
      });
      representation = rep.text;
      if (!allowlist) {
        const c = (await getCard(ctx, ws.id, observer.id, target.id)).card;
        card = c.length ? c : null;
      }
    }
    budget -= countTokens(representation) + (card ? countTokens(card.join("\n")) : 0);
  }

  if (!session) return { ...empty, peer_representation: representation, peer_card: card };

  let summary: SummaryRow | null = null;
  if (p.summary && budget > 0)
    summary = chooseSummary(await latestSummaries(ctx, session.id), budget);
  const messages = await recentMessages(
    ctx,
    session.id,
    budget - (summary?.tokenCount ?? 0),
    summary?.endSeq ?? 0,
  );
  return {
    id: session.name,
    messages: messages.map(serializeMessage),
    summary: summary ? serializeSummary(summary) : null,
    peer_representation: representation,
    peer_card: card,
  };
}

/** `GET …/sessions/{id}/summaries`. */
export async function sessionSummaries(ctx: AppContext, workspace: WsKey, sessionName: string) {
  const ws = await getWorkspace(ctx, workspace);
  const session = ws ? await getSession(ctx, ws.id, sessionName) : null;
  const s = session ? await latestSummaries(ctx, session.id) : { short: null, long: null };
  return {
    id: sessionName,
    short_summary: s.short ? serializeSummary(s.short) : null,
    long_summary: s.long ? serializeSummary(s.long) : null,
  };
}
