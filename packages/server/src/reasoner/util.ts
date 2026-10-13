import { type SQL, sql } from "drizzle-orm";

/** pgvector literal for raw SQL: `${vec(v)}` binds '[...]'::vector. */
export const vec = (v: number[]): SQL => sql`${`[${v.join(",")}]`}::vector`;

/** Parses a vector column read as text ('[0.1,0.2]') or already an array. */
export function parseVec(v: unknown): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "string") return JSON.parse(v) as number[];
  return null;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** `2026-10-01T14:02Z`: minute precision is enough for resolving "yesterday". */
export const isoMinute = (d: Date): string => `${d.toISOString().slice(0, 16)}Z`;
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Strips NULs and control characters, collapses whitespace, caps length. */
export function cleanText(s: string, max = 1000): string {
  const t = s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Case- and whitespace-insensitive comparison key. */
export const normKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/**
 * A text[] parameter. Drizzle expands JS arrays into "(a, b)" lists, which
 * breaks `= ANY(...)` and array columns, so bind one array literal instead.
 */
export function textArray(values: readonly string[]): SQL {
  const literal = `{${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}
