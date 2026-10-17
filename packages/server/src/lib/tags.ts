/**
 * Tags: short lowercase names of what a fact is about (the kind of thing or activity, and the
 * named entities it mentions), so every fact about one thing can be found again: "how many
 * concerts did I go to?" fetches every fact tagged `concert`, not just the closest few.
 */

export const MAX_TAGS = 6;
const MAX_TAG_CHARS = 40;

/** A word in its singular form, by the common English endings: trips -> trip, parties -> party. */
export function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3 || /(ss|us|is|ous)$/.test(w)) return w;
  if (/[^aeiou]ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** One tag as stored: lowercase, letters, digits, spaces and hyphens, the last word singular. */
export function normalizeTag(raw: string): string | null {
  const t = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > MAX_TAG_CHARS) return null;
  const words = t.split(" ");
  words[words.length - 1] = singular(words.at(-1)!);
  return words.join(" ");
}

/** The tags of one fact: normalized, without duplicates, at most MAX_TAGS. */
export function normalizeTags(raw: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const r of raw ?? []) {
    const t = typeof r === "string" ? normalizeTag(r) : null;
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** The tags a question may be about: its words and adjacent word pairs, in tag form. */
export function questionTags(terms: readonly string[]): string[] {
  const words = terms.map((t) => t.toLowerCase());
  const out = new Set<string>();
  for (const [i, w] of words.entries()) {
    const one = normalizeTag(w);
    if (one) out.add(one);
    if (i + 1 < words.length) {
      const two = normalizeTag(`${w} ${words[i + 1]}`);
      if (two) out.add(two);
    }
  }
  return [...out];
}
