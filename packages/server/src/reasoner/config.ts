/**
 * Effective background-processing configuration for a session (spec 01 §4.1,
 * §4.5): workspace < session, deep-merged, nulls skipped. Custom instructions
 * resolve most-specific-first, module value before the shared one (except for
 * peer cards), and a blank string means "explicitly none".
 */

type Obj = Record<string, unknown>;

export interface EffectiveConfig {
  reasoning: { enabled: boolean; instructions: string | null };
  peerCard: { use: boolean; create: boolean; instructions: string | null };
  summary: { enabled: boolean; shortEvery: number; longEvery: number; instructions: string | null };
  dream: { enabled: boolean; instructions: string | null };
}

export const SUMMARY_DEFAULTS = { shortEvery: 20, longEvery: 60 };

const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const boolOr = (v: unknown, fallback: boolean | undefined) =>
  typeof v === "boolean" ? v : fallback;

function reasoningEnabled(level: Obj): boolean | undefined {
  const explicit = boolOr(obj(level.reasoning).enabled, undefined);
  if (explicit !== undefined) return explicit;
  const legacy = boolOr(obj(level.deriver).enabled, undefined);
  if (legacy !== undefined) return legacy;
  if (level.skip_deriver === true) return false;
  return undefined;
}

function instructions(levels: Obj[], module: string, shared: boolean): string | null {
  for (const level of [...levels].reverse()) {
    for (const v of [
      obj(level[module]).custom_instructions,
      shared ? level.custom_instructions : undefined,
    ]) {
      if (typeof v === "string") return v.trim() ? v.trim() : null;
    }
  }
  return null;
}

/** `levels` from least to most specific, e.g. [workspace.configuration, session.configuration]. */
export function resolveConfig(levels: (Obj | null | undefined)[]): EffectiveConfig {
  const ls = levels.map(obj);
  let reasoning = true;
  let use = true;
  let create = true;
  let summary = true;
  let shortEvery = SUMMARY_DEFAULTS.shortEvery;
  let longEvery = SUMMARY_DEFAULTS.longEvery;
  let dream = true;
  for (const l of ls) {
    reasoning = reasoningEnabled(l) ?? reasoning;
    use = boolOr(obj(l.peer_card).use, use)!;
    create = boolOr(obj(l.peer_card).create, create)!;
    const s = obj(l.summary);
    summary = boolOr(s.enabled, summary)!;
    if (typeof s.messages_per_short_summary === "number") shortEvery = s.messages_per_short_summary;
    if (typeof s.messages_per_long_summary === "number") longEvery = s.messages_per_long_summary;
    dream = boolOr(obj(l.dream).enabled, dream)!;
  }
  return {
    reasoning: { enabled: reasoning, instructions: instructions(ls, "reasoning", true) },
    peerCard: {
      use,
      create: create && reasoning,
      instructions: instructions(ls, "peer_card", false),
    },
    summary: {
      enabled: summary,
      shortEvery: Math.max(1, Math.floor(shortEvery)),
      longEvery: Math.max(1, Math.floor(longEvery)),
      instructions: instructions(ls, "summary", true),
    },
    dream: { enabled: dream && reasoning, instructions: instructions(ls, "dream", true) },
  };
}
