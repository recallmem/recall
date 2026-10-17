/**
 * Peer cards: a short list of stable, prefixed facts (spec 02 §4.1). Same
 * structural rules as Honcho (four prefixes, 200 characters, 40 entries), but
 * edited incrementally: entries shaped "PREFIX: Label: value" replace an
 * existing entry with the same label, so "ATTRIBUTE: Location: Berlin"
 * replaces "ATTRIBUTE: Location: Amsterdam" without a full rewrite.
 *
 * Entries are dated: a collection keeps, per entry key (its label, else the
 * entry), the message time the entry was set from (`collections.card_dates`).
 * An edit that comes from older messages than an entry never replaces or
 * removes it, so learning an old session late (a backfill) cannot move the
 * card back to an older value.
 */

import { normKey } from "./util.js";

export const CARD_PREFIXES = ["IDENTITY", "ATTRIBUTE", "RELATIONSHIP", "INSTRUCTION"] as const;
export const CARD_MAX_ENTRIES = 40;
export const CARD_MAX_CHARS = 200;

const PREFIX_RE = new RegExp(`^\\s*(${CARD_PREFIXES.join("|")})\\s*:\\s*(.+)$`, "is");

/** Returns the canonical entry ("PREFIX: body"), or null when it breaks the rules. */
/**
 * What is wrong with a card a model wrote, by the card rules: too many entries, or entries that
 * are not "PREFIX: ..." lines of at most CARD_MAX_CHARS characters. Empty when it is fine.
 */
export function cardProblems(entries: readonly string[]): string[] {
  const problems: string[] = [];
  if (entries.length > CARD_MAX_ENTRIES)
    problems.push(`it has ${entries.length} entries; at most ${CARD_MAX_ENTRIES} are allowed`);
  const bad = entries.filter((e) => normalizeCardEntry(e) === null);
  if (bad.length)
    problems.push(
      `${bad.length} ${bad.length === 1 ? "entry is" : "entries are"} not a "PREFIX: Label: value" line of at most ${CARD_MAX_CHARS} characters (${bad
        .slice(0, 3)
        .map((e) => `"${e.slice(0, 60)}"`)
        .join(", ")})`,
    );
  return problems;
}

export function normalizeCardEntry(raw: string): string | null {
  const m = String(raw ?? "")
    .replace(/\s+/g, " ")
    .match(PREFIX_RE);
  if (!m) return null;
  const body = m[2]!.trim();
  if (!body) return null;
  const entry = `${m[1]!.toUpperCase()}: ${body}`;
  return entry.length <= CARD_MAX_CHARS ? entry : null;
}

const same = (a: string) => a.toLowerCase().replace(/\s+/g, " ").trim();

/** "ATTRIBUTE: Location: Berlin" → "attribute:location"; entries without a short label have no key. */
function labelKey(entry: string): string | null {
  const m = entry.match(/^([A-Z]+): ([^:]{1,40}): \S/);
  return m ? `${m[1]}:${m[2]!.toLowerCase().trim()}` : null;
}

/** Where an entry's date is kept: its label when it has one ("attribute:location"), else the entry. */
export function cardKey(entry: string): string {
  const e = normalizeCardEntry(entry) ?? entry;
  return labelKey(e) ?? `entry:${same(e)}`;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "has",
  "have",
  "her",
  "his",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "the",
  "their",
  "to",
  "was",
  "with",
]);

/**
 * The words that identify an entry's value: "ATTRIBUTE: Location: Coolsingel 40, Rotterdam" →
 * ["coolsingel", "40", "rotterdam"]. Used to find the facts an entry rests on.
 */
export function cardValueTerms(entry: string): string[] {
  const e = normalizeCardEntry(entry);
  if (!e) return [];
  const body = e.slice(e.indexOf(":") + 1).trim();
  const value = labelKey(e) ? body.slice(body.indexOf(":") + 1) : body;
  return [...new Set(normKey(value).split(" "))].filter((w) => w && !STOP_WORDS.has(w));
}

/** The newest of `facts` that mention every value word of `entry`, or null when none does. */
export function supportDate(entry: string, facts: { content: string; at: Date }[]): Date | null {
  const terms = cardValueTerms(entry);
  if (!terms.length) return null;
  let best: Date | null = null;
  for (const f of facts) {
    const words = new Set(normKey(f.content).split(" "));
    if (terms.every((t) => words.has(t)) && (!best || f.at > best)) best = f.at;
  }
  return best;
}

export interface CardDating {
  /** Message time an edit comes from (null: unknown, so it never overrides a dated entry). */
  asOf: (entry: string) => Date | null;
  /** Per `cardKey`, the ISO time each entry was set from. Updated in place. */
  dates: Record<string, string>;
  /** An edit as old as the entry: replaces it (ingest, the default) or leaves it (dreams). */
  ties?: "replace" | "keep";
}

export function applyCardEdits(
  card: string[],
  add: string[],
  remove: string[],
  dating?: CardDating,
): { card: string[]; changed: boolean; datesChanged: boolean } {
  let datesChanged = false;
  const dates = dating?.dates ?? {};
  // Decisions use the dates as they were before this edit, so one edit's removal and addition
  // of the same attribute do not block each other.
  const before = { ...dates };
  /** The card holds this key from messages newer than the edit: leave it alone. */
  const newer = (key: string, at: Date | null) => {
    if (!dating) return false;
    const held = Date.parse(before[key] ?? "");
    if (!Number.isFinite(held)) return false;
    if (!at) return true;
    return held > at.getTime() || (dating.ties === "keep" && held === at.getTime());
  };
  const stamp = (key: string, at: Date | null) => {
    if (!dating || !at) return;
    const held = Date.parse(dates[key] ?? "");
    if (Number.isFinite(held) && held >= at.getTime()) return;
    dates[key] = at.toISOString();
    datesChanged = true;
  };

  let next = card.map((e) => normalizeCardEntry(e) ?? e);
  // A removal is dated too, also when the entry is not (or no longer) on the card: older
  // messages that state the removed value cannot bring it back.
  const removals = new Map<string, string>();
  for (const r of remove) {
    removals.set(same(normalizeCardEntry(r) ?? r), r);
    if (normalizeCardEntry(r)) stamp(cardKey(r), dating?.asOf(r) ?? null);
  }
  next = next.filter((e) => {
    const r = removals.get(same(e));
    // An entry set from later messages than the removal's stays.
    return r === undefined || newer(cardKey(e), dating?.asOf(r) ?? null);
  });
  for (const raw of add) {
    const entry = normalizeCardEntry(raw);
    if (!entry) continue;
    const at = dating?.asOf(raw) ?? null;
    const key = labelKey(entry);
    const dateKey = cardKey(entry);
    if (next.some((e) => same(e) === same(entry))) {
      stamp(dateKey, at);
      continue;
    }
    // The card reflects later messages for this entry (a newer value, or its removal).
    if (newer(dateKey, at)) continue;
    const idx = key ? next.findIndex((e) => labelKey(e) === key) : -1;
    if (idx >= 0) next[idx] = entry;
    else next.push(entry);
    stamp(dateKey, at);
  }
  // Over the cap: drop the oldest entries that are not identity markers.
  while (next.length > CARD_MAX_ENTRIES) {
    const victim = next.findIndex((e) => !e.startsWith("IDENTITY:"));
    next.splice(victim >= 0 ? victim : 0, 1);
  }
  // Dates of entries no longer on the card are kept as tombstones, the newest ones only.
  if (dating) {
    const live = new Set(next.map(cardKey));
    const gone = Object.keys(dates)
      .filter((k) => !live.has(k))
      .sort((a, b) => Date.parse(dates[b]!) - Date.parse(dates[a]!));
    for (const k of gone.slice(CARD_MAX_ENTRIES)) {
      delete dates[k];
      datesChanged = true;
    }
  }
  const changed = next.length !== card.length || next.some((e, i) => e !== card[i]);
  return { card: next, changed, datesChanged };
}
