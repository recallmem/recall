/**
 * Configuration storage and resolution (spec 01 section 4).
 *
 * Storage: workspace/session updates merge one level deep (a provided
 * top-level key replaces the whole sub-object); nulls are dropped, so stored
 * configuration contains only keys that were set.
 * Resolution: workspace, then session, then message are deep-merged with null
 * values skipped, over server defaults; custom instructions use a separate
 * first-non-null scan (message, session, workspace).
 */

export type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Removes null-valued keys recursively from plain objects (arrays are kept as they are). */
export function dropNulls<T>(value: T): T {
  if (!isObj(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[k] = dropNulls(v);
  }
  return out as T;
}

/** One-level-deep merge used when a client updates workspace/session configuration. */
export function mergeConfiguration(
  stored: Obj | null | undefined,
  patch: Obj | null | undefined,
): Obj {
  const base = { ...(stored ?? {}) };
  if (!patch) return base;
  for (const [k, v] of Object.entries(dropNulls(patch))) base[k] = v;
  return base;
}

/** Deep merge that skips null/undefined values in `over`. */
function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null || v === undefined) continue;
    const current = out[k];
    out[k] = isObj(v) && isObj(current) ? deepMerge(current, v) : isObj(v) ? deepMerge({}, v) : v;
  }
  return out;
}

/**
 * Legacy keys: `deriver.enabled` and `skip_deriver: true` act as
 * `reasoning.enabled` unless that is explicitly set at the same level.
 */
function normalizeLevel(level: Obj | null | undefined): Obj {
  if (!level) return {};
  const reasoning = isObj(level.reasoning) ? level.reasoning : {};
  if (typeof reasoning.enabled === "boolean") return level;
  let legacy: boolean | undefined;
  if (isObj(level.deriver) && typeof level.deriver.enabled === "boolean")
    legacy = level.deriver.enabled;
  else if (level.skip_deriver === true) legacy = false;
  return legacy === undefined ? level : { ...level, reasoning: { ...reasoning, enabled: legacy } };
}

export interface ServerDefaults {
  reasoningEnabled: boolean;
  summariesEnabled: boolean;
}

export interface ResolvedSettings {
  reasoning: { enabled: boolean; instructions: string | null };
  summary: { enabled: boolean; short: number; long: number };
}

/** First non-null custom instruction scanning message, session, workspace; blank means "none". */
function scanInstructions(
  module: string,
  levels: (Obj | null | undefined)[],
  shared: boolean,
): string | null {
  for (const level of levels) {
    if (!level) continue;
    const specific = isObj(level[module]) ? (level[module] as Obj).custom_instructions : undefined;
    for (const candidate of shared ? [specific, level.custom_instructions] : [specific]) {
      if (typeof candidate === "string") return candidate.trim() === "" ? null : candidate;
    }
  }
  return null;
}

/** Effective settings for a message (or for a session when `message` is omitted). */
export function resolveSettings(
  defaults: ServerDefaults,
  workspace: Obj | null | undefined,
  session: Obj | null | undefined,
  message?: Obj | null,
): ResolvedSettings {
  const levels = [workspace, session, message].map(normalizeLevel);
  let merged: Obj = {
    reasoning: { enabled: defaults.reasoningEnabled },
    summary: {
      enabled: defaults.summariesEnabled,
      messages_per_short_summary: 20,
      messages_per_long_summary: 60,
    },
  };
  for (const level of levels) merged = deepMerge(merged, level);
  const reasoning = merged.reasoning as Obj;
  const summary = merged.summary as Obj;
  return {
    reasoning: {
      enabled: reasoning.enabled === true,
      instructions: scanInstructions("reasoning", [message, session, workspace], true),
    },
    summary: {
      enabled: summary.enabled === true,
      short: Number(summary.messages_per_short_summary) || 20,
      long: Number(summary.messages_per_long_summary) || 60,
    },
  };
}
