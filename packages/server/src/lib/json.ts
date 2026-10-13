import { createHash } from "node:crypto";

/** Strips NUL characters (Postgres text/jsonb cannot store them) from strings, recursively. */
export function stripNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k.replaceAll("\u0000", "")] = stripNul(v);
    return out as T;
  }
  return value;
}

/** Object nesting depth (arrays do not count as a level). */
export function objectDepth(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(objectDepth));
  if (!value || typeof value !== "object") return 0;
  return 1 + Math.max(0, ...Object.values(value).map(objectDepth));
}

/** JSON with sorted keys (cache keys, request fingerprints). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A short hash of a JSON value that ignores key order: two requests with the same content match. */
export const fingerprint = (v: unknown): string =>
  createHash("sha256").update(stableStringify(v)).digest("base64url").slice(0, 32);
