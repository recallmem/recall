import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { WsKey } from "../core/tenancy.js";
import { findWorkspace } from "../core/workspaces.js";
import { rows } from "../db/client.js";
import type { AuthState } from "../http/auth.js";
import { ApiError, notFound, unauthorized, unprocessable } from "../lib/errors.js";
import { NAME_PATTERN } from "../lib/ids.js";
import { and, inList } from "./util.js";

type Obj = Record<string, unknown>;

export interface WsRef {
  id: string;
  name: string;
  configuration: Obj;
}
export interface PeerRef {
  id: string;
  name: string;
  isScope: boolean;
  configuration: Obj;
}
export interface SessionRef {
  id: string;
  name: string;
  configuration: Obj;
}
export interface Allowlist {
  ids: string[];
  names: string[];
}

export const SCOPE_PREFIX = "scope.";
export const MAX_ALLOWLIST = 1000;

/** Resolves a workspace within its account (see core/workspaces.ts `findWorkspace`). */
export async function getWorkspace(ctx: AppContext, key: WsKey): Promise<WsRef | null> {
  const r = await findWorkspace(ctx.db, key);
  return r ? { id: r.internal_id, name: r.name, configuration: r.configuration ?? {} } : null;
}

export async function getPeer(
  ctx: AppContext,
  wsId: string,
  name: string,
): Promise<PeerRef | null> {
  const [r] = await rows<{ id: string; name: string; is_scope: boolean; configuration: Obj }>(
    ctx.db,
    sql`SELECT id, name, is_scope, configuration FROM peers WHERE workspace_id = ${wsId} AND name = ${name}`,
  );
  return r ? { id: r.id, name: r.name, isScope: r.is_scope, configuration: r.configuration } : null;
}

export async function getSession(
  ctx: AppContext,
  wsId: string,
  name: string,
): Promise<SessionRef | null> {
  const [r] = await rows<{ id: string; name: string; configuration: Obj }>(
    ctx.db,
    sql`SELECT id, name, configuration FROM sessions WHERE workspace_id = ${wsId} AND name = ${name}`,
  );
  return r ?? null;
}

export const rejectScopePeer = (peer: Pick<PeerRef, "name" | "isScope"> | null) => {
  if (peer && (peer.isScope || peer.name.startsWith(SCOPE_PREFIX))) {
    throw unprocessable(
      "No representation is formed of a scope. Use the `scope` parameter instead.",
    );
  }
};

/** What kind of credential is calling. */
export const isPeerToken = (a: AuthState): boolean => !a.admin && !!a.claims.p && !a.claims.s;
export const isSessionToken = (a: AuthState): boolean => !a.admin && !!a.claims.s;
export const isWorkspaceLevel = (a: AuthState): boolean => a.admin || (!a.claims.p && !a.claims.s);

export function requireWorkspaceLevelForScope(a: AuthState): void {
  if (!isWorkspaceLevel(a)) throw unauthorized("`scope` requires a workspace- or admin-level key");
}

/** Sessions (internal ids) the peer currently belongs to, among the given names or ids. */
export async function activeMemberSessions(
  ctx: AppContext,
  wsId: string,
  peerId: string,
): Promise<Set<string>> {
  const r = await rows<{ name: string }>(
    ctx.db,
    sql`SELECT s.name FROM session_peers sp JOIN sessions s ON s.id = sp.session_id
        WHERE sp.workspace_id = ${wsId} AND sp.peer_id = ${peerId} AND sp.left_at IS NULL`,
  );
  return new Set(r.map((x) => x.name));
}

/** Peer tokens may only touch sessions their peer is an active member of (401 otherwise). */
export async function assertPeerMemberOf(
  ctx: AppContext,
  auth: AuthState,
  ws: WsRef,
  sessionNames: string[],
): Promise<void> {
  if (!isPeerToken(auth) || !sessionNames.length) return;
  const peer = await getPeer(ctx, ws.id, auth.claims.p!);
  const member = peer ? await activeMemberSessions(ctx, ws.id, peer.id) : new Set<string>();
  for (const s of sessionNames) if (!member.has(s)) throw unauthorized();
}

const quote = (items: string[]) => `[${items.map((i) => `'${i}'`).join(", ")}]`;

/**
 * Parses the restricted `filters` dialect of the recall endpoints (spec 01 §1.10):
 * only `session_id` as a string, a list, or `{"in": [...]}`. Returns null when no
 * filters were sent; an empty array means "recall nothing".
 */
export function parseSessionAllowlist(
  filters: unknown,
  sessionId?: string | null,
): string[] | null {
  if (filters == null) return null;
  if (typeof filters !== "object" || Array.isArray(filters))
    throw unprocessable("filters must be an object");
  const obj = filters as Obj;
  const extra = Object.keys(obj).filter((k) => k !== "session_id");
  if (extra.length) {
    throw unprocessable(
      `Unsupported filter key(s) for this endpoint: ${quote(extra)}. Only 'session_id' is supported.`,
    );
  }
  if (!("session_id" in obj)) throw unprocessable("filters must include 'session_id'");
  const v = obj.session_id;
  let list: unknown;
  if (typeof v === "string") list = [v];
  else if (Array.isArray(v)) list = v;
  else if (
    v &&
    typeof v === "object" &&
    Object.keys(v).length === 1 &&
    Array.isArray((v as Obj).in)
  ) {
    list = (v as Obj).in;
  } else {
    throw unprocessable("filters.session_id must be a string, a list of strings, or {'in': [...]}");
  }
  const entries = list as unknown[];
  if (entries.length > MAX_ALLOWLIST) {
    throw unprocessable(`filters.session_id may contain at most ${MAX_ALLOWLIST} entries`);
  }
  for (const e of entries) {
    if (typeof e !== "string" || !e || e === "*" || !NAME_PATTERN.test(e)) {
      throw unprocessable(
        "filters.session_id entries must be non-empty session ids (wildcards are not allowed)",
      );
    }
  }
  const unique = [...new Set(entries as string[])];
  if (sessionId && !unique.includes(sessionId))
    throw unprocessable("session_id must be included in filters.session_id");
  return unique;
}

/** Maps session names to an allowlist of internal ids. Unknown names simply match nothing. */
export async function resolveAllowlist(
  ctx: AppContext,
  wsId: string,
  names: string[],
): Promise<Allowlist> {
  if (!names.length) return { ids: [], names: [] };
  const r = await rows<{ id: string; name: string }>(
    ctx.db,
    sql`SELECT id, name FROM sessions WHERE ${and(sql`workspace_id = ${wsId}`, inList(sql`name`, names))}`,
  );
  return { ids: r.map((x) => x.id), names: r.map((x) => x.name) };
}

export const asScopeList = (scope: string | string[]): string[] =>
  Array.isArray(scope) ? scope : [scope];

/** Looks up scope peers by their unprefixed names (404 unknown, 422 if the reserved name is not a scope). */
export async function resolveScopePeers(
  ctx: AppContext,
  wsId: string,
  scopes: string[],
): Promise<PeerRef[]> {
  const out: PeerRef[] = [];
  for (const name of [...new Set(scopes)]) {
    if (!name || !NAME_PATTERN.test(name) || name.startsWith(SCOPE_PREFIX)) {
      throw unprocessable(`Invalid scope name '${name}'`);
    }
    const peer = await getPeer(ctx, wsId, `${SCOPE_PREFIX}${name}`);
    if (!peer) throw notFound(`Scope '${name}'`);
    if (!peer.isScope) throw unprocessable(`Peer '${SCOPE_PREFIX}${name}' is not a scope`);
    out.push(peer);
  }
  return out;
}

/** Union of the sessions the scope peers currently belong to. */
export async function scopeSessions(
  ctx: AppContext,
  wsId: string,
  scopePeers: PeerRef[],
): Promise<Allowlist> {
  if (!scopePeers.length) return { ids: [], names: [] };
  const r = await rows<{ id: string; name: string }>(
    ctx.db,
    sql`SELECT DISTINCT s.id, s.name FROM session_peers sp JOIN sessions s ON s.id = sp.session_id
        WHERE sp.workspace_id = ${wsId} AND sp.left_at IS NULL AND s.is_active
          AND ${inList(
            sql`sp.peer_id`,
            scopePeers.map((p) => p.id),
          )}`,
  );
  if (r.length > MAX_ALLOWLIST) {
    throw new ApiError(422, `Combined scope membership exceeds ${MAX_ALLOWLIST} sessions`);
  }
  return { ids: r.map((x) => x.id), names: r.map((x) => x.name) };
}

export async function getCard(
  ctx: AppContext,
  wsId: string,
  observerId: string,
  observedId: string,
) {
  const [r] = await rows<{ peer_card: string[]; version: number | string }>(
    ctx.db,
    sql`SELECT peer_card, version FROM collections
        WHERE workspace_id = ${wsId} AND observer_id = ${observerId} AND observed_id = ${observedId}`,
  );
  return {
    card: Array.isArray(r?.peer_card) ? r!.peer_card : [],
    version: r ? Number(r.version) : 0,
  };
}

/**
 * Resolved `custom_instructions` for the dialectic module: message → session → workspace, at each
 * level `dialectic.custom_instructions` then the shared one; a blank string means "none" and stops.
 */
export function dialecticInstructions(...levels: (Obj | undefined)[]): string | null {
  for (const cfg of levels) {
    if (!cfg) continue;
    const d = (cfg.dialectic as Obj | null | undefined)?.custom_instructions;
    const shared = cfg.custom_instructions;
    for (const v of [d, shared]) {
      if (typeof v === "string") return v.trim() ? v.trim() : null;
    }
  }
  return null;
}

/** `peer_card.use` (default true), most specific level wins. */
export function peerCardEnabled(...levels: (Obj | undefined)[]): boolean {
  for (const cfg of levels) {
    const use = (cfg?.peer_card as Obj | null | undefined)?.use;
    if (typeof use === "boolean") return use;
  }
  return true;
}
