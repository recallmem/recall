import type {
  Conclusion,
  ConclusionLevel,
  Evidence,
  Message,
  QueueCounts,
  QueueStatus,
  ScopeStatus,
  Summary,
  Usage,
  UsageBilled,
  UsageTotals,
  WebhookEndpoint,
} from "./types.js";
import type { Obj } from "./util.js";

/** Wire (snake_case) <-> SDK (camelCase) conversion. Hand-written per type so user data is never touched. */

const KEY_PAIRS: [camel: string, snake: string][] = [
  ["customInstructions", "custom_instructions"],
  ["peerCard", "peer_card"],
  ["messagesPerShortSummary", "messages_per_short_summary"],
  ["messagesPerLongSummary", "messages_per_long_summary"],
  ["observeMe", "observe_me"],
  ["observeOthers", "observe_others"],
];
const TO_SNAKE = new Map(KEY_PAIRS);
const TO_CAMEL = new Map(KEY_PAIRS.map(([c, s]) => [s, c]));

function renameKeys(value: unknown, map: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => renameKeys(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [map.get(k) ?? k, renameKeys(v, map)]),
    );
  }
  return value;
}

/** Configuration objects: only the documented keys are renamed, everything else passes through. */
export const configToWire = <T>(config: T): T => renameKeys(config, TO_SNAKE) as T;
export const configFromWire = <T = Obj>(config: unknown): T =>
  (config == null ? {} : renameKeys(config, TO_CAMEL)) as T;

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export function messageFromWire(w: Obj): Message {
  return {
    id: str(w.id),
    content: str(w.content),
    peerId: str(w.peer_id),
    sessionId: str(w.session_id),
    workspaceId: str(w.workspace_id),
    metadata: (w.metadata as Obj | null) ?? {},
    createdAt: str(w.created_at),
    tokenCount: num(w.token_count),
  };
}

export function summaryFromWire(w: unknown): Summary | null {
  if (!w || typeof w !== "object") return null;
  const s = w as Obj;
  return {
    content: str(s.content),
    messageId: str(s.message_id),
    summaryType: str(s.summary_type),
    createdAt: str(s.created_at),
    tokenCount: num(s.token_count),
  };
}

export function conclusionFromWire(w: Obj): Conclusion {
  return {
    id: str(w.id),
    content: str(w.content),
    observerId: str(w.observer_id),
    observedId: str(w.observed_id),
    sessionId: strOrNull(w.session_id),
    level: (w.level ?? "explicit") as ConclusionLevel,
    sourceIds: Array.isArray(w.source_ids) ? (w.source_ids as string[]) : [],
    timesDerived: w.times_derived == null ? 1 : num(w.times_derived),
    createdAt: str(w.created_at),
    // Recall's validity and provenance fields; a server without them leaves them out.
    ...("valid_from" in w ? { validFrom: strOrNull(w.valid_from) } : {}),
    ...("valid_to" in w ? { validTo: strOrNull(w.valid_to) } : {}),
    ...("superseded_by" in w ? { supersededBy: strOrNull(w.superseded_by) } : {}),
    ...(Array.isArray(w.message_ids) ? { messageIds: w.message_ids as string[] } : {}),
    ...("event_start" in w ? { eventStart: strOrNull(w.event_start) } : {}),
    ...("event_end" in w ? { eventEnd: strOrNull(w.event_end) } : {}),
    ...(Array.isArray(w.tags) ? { tags: w.tags as string[] } : {}),
    ...("pinned" in w ? { pinned: w.pinned === true } : {}),
    ...("expires_at" in w ? { expiresAt: strOrNull(w.expires_at) } : {}),
    ...("event_precision" in w
      ? { eventPrecision: strOrNull(w.event_precision) as Conclusion["eventPrecision"] }
      : {}),
  };
}

export function evidenceFromWire(w: unknown): Evidence | null {
  if (!w || typeof w !== "object") return null;
  const e = w as Obj;
  const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
  return {
    conclusions: list(e.conclusions).map((c) => ({
      id: str(c.id),
      level: str(c.level),
      content: str(c.content),
      createdAt: strOrNull(c.created_at),
      sessionId: strOrNull(c.session_id),
      observerId: strOrNull(c.observer_id),
      observedId: strOrNull(c.observed_id),
      sourceIds: Array.isArray(c.source_ids) ? (c.source_ids as string[]) : [],
    })),
    messages: list(e.messages).map((m) => ({
      id: str(m.id),
      sessionId: str(m.session_id),
      peerId: str(m.peer_id),
      createdAt: strOrNull(m.created_at),
    })),
    toolCalls: list(e.tool_calls).map((t) => ({
      toolName: str(t.tool_name),
      toolInput: (t.tool_input as Obj | null) ?? {},
    })),
    reasoningTraceId: strOrNull(e.reasoning_trace_id),
  };
}

const counts = (w: Obj): QueueCounts => ({
  totalWorkUnits: num(w.total_work_units),
  completedWorkUnits: num(w.completed_work_units),
  inProgressWorkUnits: num(w.in_progress_work_units),
  pendingWorkUnits: num(w.pending_work_units),
});

export function queueStatusFromWire(w: Obj): QueueStatus {
  const sessions = w.sessions as Record<string, Obj> | null | undefined;
  return {
    ...counts(w),
    sessions: sessions
      ? Object.fromEntries(
          Object.entries(sessions).map(([id, s]) => [
            id,
            { ...counts(s), sessionId: strOrNull(s.session_id) },
          ]),
        )
      : null,
    ...(typeof w.idle === "boolean" ? { idle: w.idle } : {}),
  };
}

export function scopeStatusFromWire(w: Obj): ScopeStatus {
  const raw = (w.backfill_status as Record<string, Obj> | null) ?? {};
  return {
    backfillStatus: Object.fromEntries(
      Object.entries(raw).map(([id, s]) => [
        id,
        {
          state: str(s.state),
          updatedAt: strOrNull(s.updated_at),
          ...(s.docs_copied === undefined ? {} : { docsCopied: s.docs_copied as number | null }),
        },
      ]),
    ),
  };
}

export const webhookFromWire = (w: Obj): WebhookEndpoint => ({
  id: str(w.id),
  workspaceId: str(w.workspace_id),
  url: str(w.url),
  createdAt: str(w.created_at),
});

/** A number the server may leave out (the hosted service reports no provider cost): null, not 0. */
const numOrNull = (v: unknown): number | null => (v == null ? null : num(v));

const totals = (w: Obj): UsageTotals => ({
  calls: num(w.calls),
  inputTokens: num(w.input_tokens),
  outputTokens: num(w.output_tokens),
  cacheReadTokens: num(w.cache_read_tokens),
  cacheWriteTokens: num(w.cache_write_tokens),
  costUsd: numOrNull(w.cost_usd),
  unpricedCalls: numOrNull(w.unpriced_calls),
});

const LEVELS = ["minimal", "low", "medium", "high", "max"] as const;

function billedFromWire(w: Obj): UsageBilled {
  const learning = (w.learning as Obj | null) ?? {};
  const storage = (w.storage as Obj | null) ?? {};
  const chat = (w.chat as Obj | null) ?? {};
  const byLevel = (chat.by_level as Record<string, Obj> | null) ?? {};
  const questions = (q: Obj) => ({ questions: num(q.questions), billedUsd: num(q.billed_usd) });
  return {
    billedUsd: num(w.billed_usd),
    learning: { messageTokens: num(learning.message_tokens), billedUsd: num(learning.billed_usd) },
    storage: { tokens: num(storage.tokens), billedUsd: num(storage.billed_usd) },
    chat: {
      ...questions(chat),
      byLevel: Object.fromEntries(
        LEVELS.map((l) => [l, questions(byLevel[l] ?? {})]),
      ) as UsageBilled["chat"]["byLevel"],
    },
  };
}

export function usageFromWire(w: Obj): Usage {
  const byTask = (w.by_task as Record<string, Obj> | null) ?? {};
  const items = Array.isArray(w.items) ? (w.items as Obj[]) : [];
  return {
    workspaceId: str(w.workspace_id),
    since: strOrNull(w.since),
    until: strOrNull(w.until),
    total: totals((w.total as Obj | null) ?? {}),
    byTask: Object.fromEntries(Object.entries(byTask).map(([k, v]) => [k, totals(v)])),
    items: items.map((i) => ({
      task: str(i.task),
      provider: strOrNull(i.provider),
      model: str(i.model),
      ...totals(i),
    })),
    billed: w.billed && typeof w.billed === "object" ? billedFromWire(w.billed as Obj) : null,
  };
}
