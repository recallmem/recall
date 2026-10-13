import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";

/**
 * Raw SQL through `db.execute` returns timestamps as Postgres text
 * ("2026-10-08 19:59:13.112+00"), so normalise to a Date before any use.
 */
export function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  let s = v.includes("T") ? v : v.replace(" ", "T");
  if (/[+-]\d\d$/.test(s)) s += ":00";
  if (!/(Z|[+-]\d\d:\d\d)$/.test(s)) s += "Z";
  return new Date(s);
}

export const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

/** pgvector text literal. */
export const vecLiteral = (v: number[]): string => `[${v.join(",")}]`;

/** AND of the given fragments (falsy entries skipped); `TRUE` when nothing is left. */
export function and(...parts: (SQL | undefined | null | false)[]): SQL {
  const real = parts.filter((p): p is SQL => !!p);
  return real.length
    ? sql.join(
        real.map((p) => sql`(${p})`),
        sql` AND `,
      )
    : sql`TRUE`;
}

export function or(...parts: (SQL | undefined | null | false)[]): SQL {
  const real = parts.filter((p): p is SQL => !!p);
  return real.length
    ? sql.join(
        real.map((p) => sql`(${p})`),
        sql` OR `,
      )
    : sql`FALSE`;
}

/** `col IN (...)`; drizzle would expand a JS array into a record, so build the list by hand. */
export function inList(col: SQL, values: readonly string[]): SQL {
  return values.length
    ? sql`${col} IN (${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )})`
    : sql`FALSE`;
}

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

export { stableStringify } from "../lib/json.js";

export const normalizeQuery = (q: string): string => q.trim().replace(/\s+/g, " ").toLowerCase();

export const day = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10) : "");
export const stamp = (d: Date | null | undefined): string =>
  d ? d.toISOString().slice(0, 19).replace("T", " ") : "";

// ---------------------------------------------------------------------------
// Lexical query building
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a an the and or but if of to in on at by for with from as is are was were be been being am do does did done " +
    "have has had having i me my mine we our ours you your yours he him his she her hers it its they them their " +
    "this that these those there here what which who whom whose when where why how not no yes can could would " +
    "should will shall may might must so than then too very just also about into over under again more most some " +
    "any each other such own same s t d ll m re ve " +
    "de het een en of maar als van naar in op aan bij voor met uit is zijn was waren ben bent wordt worden werd " +
    "heb heeft hebben had hadden ik mij mijn jij je jou jouw hij hem zijn zij ze haar wij we ons onze jullie " +
    "u uw dit dat deze die er hier daar wat welke wie waar wanneer waarom hoe niet geen ja kan kunnen zou zouden " +
    "zal moet moeten ook nog al dan toen wel naar over onder meer meest dus want omdat"
  ).split(" "),
);

export function queryTerms(q: string, max = 16): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (STOPWORDS.has(w) || seen.has(w)) continue;
    if (w.length < 2 && !/^\d$/.test(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** Cheap suffix stripping so "walking"/"walked" and "wandelen"/"wandelt" meet on a shared prefix. */
function stem(w: string): string {
  if (/^\d+$/.test(w) || w.length < 6) return w;
  for (const suf of ["ingen", "ing", "eren", "ers", "ed", "es", "en", "er", "s", "e"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  return w;
}

const OPERATORS = /"|(^|\s)-\S/;

/**
 * Builds the tsquery for the lexical leg. Natural-language questions become an
 * OR of prefix terms (an AND of every word, which is what plain web-search
 * syntax gives, almost never matches a question); queries that use quotes
 * or `-term` keep their operator semantics through websearch_to_tsquery.
 */
export function tsQuery(q: string): SQL | null {
  if (OPERATORS.test(q)) return sql`websearch_to_tsquery('simple', ${q})`;
  const terms = queryTerms(q);
  if (!terms.length) return null;
  const expr = terms
    .map((t) => {
      if (/^\d+$/.test(t) || t.length < 5) return t;
      return `${stem(t)}:*`;
    })
    .join(" | ");
  return sql`to_tsquery('simple', ${expr})`;
}

/** Weighted Reciprocal Rank Fusion over ranked id lists (best first, rank is 1-based). */
export const RRF_K = 60;
export function rrf<T>(lists: readonly (readonly T[])[]): Map<T, number> {
  const scores = new Map<T, number>();
  for (const list of lists) {
    for (const [i, id] of list.entries())
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }
  return scores;
}
