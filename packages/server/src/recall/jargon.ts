import { stripMarkers } from "./markers.js";

/**
 * Internal vocabulary that can slip into an answer despite the rules. To the model, memory is a
 * "pack" of "Profile" lines, facts and "excerpts"; to the reader it is simply what the assistant
 * remembers. A few clearly internal phrases are rewritten into plain words: "The pack has no later
 * change" → "My memory has no later change", "the excerpt cuts off" → "the message cuts off",
 * "the Profile still lists Jest" → "my memory still lists Jest".
 *
 * Each rule on an everyday word applies only when that word occurs nowhere in the question or in
 * the memory the model saw, so a backpack, a book excerpt or a dating profile the person talked
 * about is left alone; "a six-pack" or "her profile picture" never match in the first place.
 * Streaming-safe: the last few words are held back until a phrase can no longer grow, so a
 * streamed answer reads exactly like the same answer returned whole.
 */

/** Lower-cased content words of the question and the memory: what the answer may legitimately use. */
export class Corpus {
  private readonly words = new Set<string>();

  constructor(...texts: string[]) {
    for (const t of texts) this.add(t);
  }

  /** Adds question or memory text. Section headings and citation markers are not content. */
  add(text: string): void {
    const body = text
      .split("\n")
      .filter((l) => !l.startsWith("## "))
      .join("\n");
    for (const w of stripMarkers(body)
      .text.toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [])
      this.words.add(w);
  }

  has(word: string): boolean {
    return this.words.has(word.toLowerCase());
  }
}

interface Rule {
  /** Off when any of these words occurs in the question or the memory. */
  unless: string[];
  source: string;
  /** The replacement, or null to leave this match as it is. */
  to: (match: string) => string | null;
}

const MEMORY = "my memory";
const SECTIONS = ["Facts", "Excerpts", "Session", "Conversation log", "No longer true"];

const RULES: Rule[] = [
  {
    // "the memory pack", "your context pack": internal whatever the memory holds.
    unless: [],
    source: String.raw`\b(?:the|this|my|your|our)\s+(?:memory|context)\s+pack\b`,
    to: () => MEMORY,
  },
  {
    // "The pack has no later change", "nothing in the pack about it"; not "the pack of cards".
    unless: ["pack", "packs"],
    source: String.raw`\b(?:the|this|my|your|our)\s+pack\b(?!\s+of\b|-\w)`,
    to: () => MEMORY,
  },
  {
    // "the excerpt cuts off" → "the message cuts off"; "an excerpt" → "a message".
    unless: ["excerpt", "excerpts", "excerpted"],
    source: String.raw`\b(?:an?\s+)?excerpts?\b(?!-\w)`,
    to: (m) =>
      m
        .replace(/^(a)n?(\s+)/i, "$1$2")
        .replace(/excerpt/i, (w) => (w[0] === "E" ? "Message" : "message")),
  },
  {
    // "The Profile still lists Jest", "your Profile line says": the section, capitalised.
    unless: ["profile", "profiles"],
    source: String.raw`\b(?:the|this|that|your|his|her|their|a|one)\s+profile(?:\s+(?:lines?|entry|entries|section|card))?\b`,
    to: (m) => (/\sProfile\b/.test(m) ? MEMORY : null),
  },
  {
    // "the Facts section", "the Conversation log list": section names are never the reader's words.
    unless: [],
    source: String.raw`\b(?:the|a|my|your)\s+(?:facts|excerpts|session|conversation\s+log|no\s+longer\s+true)\s+(?:section|list|block|heading|part)\b`,
    to: (m) => (SECTIONS.some((s) => m.includes(` ${s} `)) ? MEMORY : null),
  },
  {
    // "My notes say you moved" → "I remember you moved".
    unless: ["notes"],
    source: String.raw`\b(?:my|the)\s+notes\s+(?:say|says|said|show|shows|showed|state|states|stated|indicate|indicates|indicated)\b`,
    to: () => "I remember",
  },
];

/** Words held back while streaming: longer than any phrase above, plus a word of lookahead. */
const HOLD_WORDS = 6;

/** Start of the `n`-th last word of `text` (0 when it has fewer words). */
function holdFrom(text: string, n: number): number {
  let seen = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (/\s/.test(text[i]!)) continue;
    if (i === 0 || /\s/.test(text[i - 1]!)) {
      if (++seen === n) return i;
    }
  }
  return 0;
}

const capitalised = (match: string, out: string) =>
  /^\p{Lu}/u.test(match) ? out.charAt(0).toUpperCase() + out.slice(1) : out;

export class JargonFilter {
  private pending = "";
  private readonly re: RegExp | null;
  private readonly rules: Rule[];

  constructor(corpus: Corpus) {
    this.rules = RULES.filter((r) => !r.unless.some((w) => corpus.has(w)));
    this.re = this.rules.length
      ? new RegExp(this.rules.map((r) => `(${r.source})`).join("|"), "gi")
      : null;
  }

  /** Feeds a chunk; returns the text that is safe to show now. */
  push(chunk: string): string {
    this.pending += chunk;
    if (!this.re) return this.emit(this.pending.length);
    return this.emit(holdFrom(this.pending, HOLD_WORDS));
  }

  /** Releases whatever is still held at the end of the stream. */
  flush(): string {
    return this.emit(this.pending.length);
  }

  /** Rewrites and releases the text before `cut` (moved past any phrase that straddles it). */
  private emit(cut: number): string {
    const text = this.pending;
    if (!this.re) {
      this.pending = "";
      return text;
    }
    let out = "";
    let last = 0;
    this.re.lastIndex = 0;
    for (let m = this.re.exec(text); m; m = this.re.exec(text)) {
      if (m.index >= cut) break;
      const end = m.index + m[0].length;
      if (end > cut) cut = end;
      const rule = this.rules[m.slice(1).findIndex((g) => g !== undefined)];
      const to = rule?.to(m[0]);
      out += text.slice(last, m.index) + (to == null ? m[0] : capitalised(m[0], to));
      last = end;
    }
    out += text.slice(last, cut);
    this.pending = text.slice(cut);
    return out;
  }
}

/** Whole-text convenience for answers that are not streamed. */
export function rewriteJargon(text: string, corpus: Corpus): string {
  const f = new JargonFilter(corpus);
  return f.push(text) + f.flush();
}
