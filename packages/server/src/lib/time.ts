/** RFC 3339 UTC with a trailing Z (microsecond precision is not available in JS; milliseconds are emitted). */
export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : (typeof d === "string" ? new Date(d) : d).toISOString();

/** `YYYY-MM-DDTHH:MM:SSZ`, used by summary `created_at` and webhook timestamps. */
export const isoSeconds = (d: Date = new Date()): string => `${d.toISOString().slice(0, 19)}Z`;
