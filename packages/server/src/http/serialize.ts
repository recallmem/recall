import { type SQL, sql } from "drizzle-orm";
import { type EventPrecision, eventOf, formatEventDate } from "../lib/event-time.js";
import { iso } from "../lib/time.js";

/**
 * Response serializers (spec 01 section 3 object shapes). The `*_COLS`
 * fragments are the select lists that feed them, so list queries fetch
 * everything a response needs in one join (no per-row lookups).
 *
 * Public `id`s are the user-chosen names; internal surrogate ids never leave
 * the server. Timestamps are ISO-8601 UTC with a trailing Z.
 */

type Obj = Record<string, unknown>;
type Time = Date | string | null;

export const SCOPE_PREFIX = "scope.";

export const WORKSPACE_COLS: SQL = sql`w.id AS internal_id, w.name, w.metadata, w.configuration, w.created_at`;
export interface WorkspaceRow {
  internal_id: string;
  name: string;
  metadata: Obj | null;
  configuration: Obj | null;
  created_at: Time;
}
export const workspaceOut = (r: WorkspaceRow) => ({
  id: r.name,
  metadata: r.metadata ?? {},
  configuration: r.configuration ?? {},
  created_at: iso(r.created_at),
});

export const PEER_COLS: SQL = sql`p.id AS internal_id, p.name, w.name AS workspace_name, p.is_scope,
  p.metadata, p.configuration, p.created_at`;
export interface PeerRow {
  internal_id: string;
  name: string;
  workspace_name: string;
  is_scope: boolean;
  metadata: Obj | null;
  configuration: Obj | null;
  created_at: Time;
}
export const peerOut = (r: PeerRow) => ({
  id: r.name,
  workspace_id: r.workspace_name,
  created_at: iso(r.created_at),
  metadata: r.metadata ?? {},
  configuration: r.configuration ?? {},
});

export const SESSION_COLS: SQL = sql`s.id AS internal_id, s.name, w.name AS workspace_name, s.is_active,
  s.metadata, s.configuration, s.created_at`;
export interface SessionRow {
  internal_id: string;
  name: string;
  workspace_name: string;
  is_active: boolean;
  metadata: Obj | null;
  configuration: Obj | null;
  created_at: Time;
}
export const sessionOut = (r: SessionRow) => ({
  id: r.name,
  is_active: r.is_active,
  workspace_id: r.workspace_name,
  metadata: r.metadata ?? {},
  configuration: r.configuration ?? {},
  created_at: iso(r.created_at),
});

export const MESSAGE_COLS: SQL = sql`m.id, m.content, p.name AS peer_name, s.name AS session_name, m.metadata,
  m.created_at, w.name AS workspace_name, m.token_count`;
export interface MessageRow {
  id: string;
  content: string;
  peer_name: string;
  session_name: string;
  metadata: Obj | null;
  created_at: Time;
  workspace_name: string;
  token_count: number | string;
}
export const messageOut = (r: MessageRow) => ({
  id: r.id,
  content: r.content,
  peer_id: r.peer_name,
  session_id: r.session_name,
  metadata: r.metadata ?? {},
  created_at: iso(r.created_at),
  workspace_id: r.workspace_name,
  token_count: Number(r.token_count),
});

/** Scopes are peers named `scope.<id>`; the public id is the unprefixed name. */
export const SCOPE_COLS: SQL = sql`p.id AS internal_id, p.name, p.metadata, p.created_at, p.internal`;
export interface ScopeRow {
  internal_id: string;
  name: string;
  metadata: Obj | null;
  created_at: Time;
  internal?: Obj | null;
}
export const scopeOut = (r: ScopeRow) => ({
  id: r.name.startsWith(SCOPE_PREFIX) ? r.name.slice(SCOPE_PREFIX.length) : r.name,
  metadata: r.metadata ?? {},
  created_at: iso(r.created_at),
});

export const CONCLUSION_COLS: SQL = sql`c.id, c.content, obs.name AS observer_name, obd.name AS observed_name,
  s.name AS session_name, c.level, c.source_ids, c.times_derived, c.created_at,
  c.valid_from, c.valid_to, c.superseded_by, c.message_ids, c.event_start, c.event_end, c.event_precision,
  c.tags, c.pinned, c.expires_at`;
export interface ConclusionRow {
  id: string;
  content: string;
  observer_name: string;
  observed_name: string;
  session_name: string | null;
  level: string;
  source_ids: string[] | null;
  times_derived: number | string;
  created_at: Time;
  valid_from: Time;
  valid_to: Time;
  superseded_by: string | null;
  message_ids: string[] | null;
  event_start: Time;
  event_end: Time;
  event_precision: EventPrecision | null;
  tags: string[] | null;
  pinned: boolean | null;
  expires_at: Time;
}
/**
 * The Honcho fields, then Recall's: when the fact held (`valid_from`, which falls back to
 * `created_at`, and `valid_to`, null while it is current), the fact that replaced it, and the
 * public ids of the messages it was learned from. `source_ids` keeps its Honcho meaning
 * (premise conclusions of a derived fact). The event time says when what the fact describes
 * happened or began: `event_start` as precise as it is known (`2025-05-27`, `2025-05` or `2025`),
 * `event_end` the last day of a span, `event_precision` day, month or year; all null when the fact
 * has no time of its own. `tags` name what the fact is about (lowercase, singular). `pinned`
 * facts were set by a person, and the reasoner and dreams never change them.
 */
export const conclusionOut = (r: ConclusionRow) => ({
  id: r.id,
  content: r.content,
  observer_id: r.observer_name,
  observed_id: r.observed_name,
  session_id: r.session_name ?? null,
  level: r.level,
  source_ids: r.source_ids ?? [],
  times_derived: Number(r.times_derived),
  created_at: iso(r.created_at),
  valid_from: iso(r.valid_from ?? r.created_at),
  valid_to: r.valid_to == null ? null : iso(r.valid_to),
  superseded_by: r.superseded_by ?? null,
  message_ids: r.message_ids ?? [],
  ...eventOut(r),
  tags: r.tags ?? [],
  pinned: r.pinned === true,
  expires_at: r.expires_at == null ? null : iso(r.expires_at),
});

function eventOut(r: Pick<ConclusionRow, "event_start" | "event_end" | "event_precision">) {
  const t = eventOf(r);
  return {
    event_start: t ? formatEventDate(t.start, t.precision) : null,
    event_end: t?.end ? formatEventDate(t.end, "day") : null,
    event_precision: t?.precision ?? null,
  };
}

export const WEBHOOK_COLS: SQL = sql`e.id, w.name AS workspace_name, e.url, e.created_at`;
export interface WebhookRow {
  id: string;
  workspace_name: string;
  url: string;
  created_at: Time;
}
export const webhookOut = (r: WebhookRow) => ({
  id: r.id,
  workspace_id: r.workspace_name,
  url: r.url,
  created_at: iso(r.created_at),
});
