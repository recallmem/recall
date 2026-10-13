import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Nearest-rank percentile (p in 0..100) of a list of numbers; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] as number;
}

export const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const v of values) total += v;
  return total;
};

/** 95% Wilson score interval for a proportion; [0, 1] bounds, null when n = 0. */
export function wilson95(correct: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959964;
  const p = correct / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Byte range of one top-level element of a JSON array file. */
export interface ElementSpan {
  start: number;
  end: number;
}

/**
 * Finds the byte span of every top-level object in a JSON array file without
 * parsing it, so a 277 MB dataset never has to sit in memory. Scanning bytes is
 * safe for UTF-8: the structural characters never occur inside multi-byte sequences.
 */
export async function scanJsonArray(path: string): Promise<ElementSpan[]> {
  const spans: ElementSpan[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let offset = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i] as number;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 0x5c) escaped = true;
        else if (c === 0x22) inString = false;
        continue;
      }
      if (c === 0x22) inString = true;
      else if (c === 0x7b || c === 0x5b) {
        depth++;
        if (depth === 2 && c === 0x7b) start = offset + i;
      } else if (c === 0x7d || c === 0x5d) {
        if (depth === 2 && c === 0x7d && start >= 0) {
          spans.push({ start, end: offset + i + 1 });
          start = -1;
        }
        depth--;
      }
    }
    offset += buf.length;
  }
  return spans;
}

/** The lines of a JSON-lines file, parsed; an empty list when the file does not exist. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Strips anything outside `[a-zA-Z0-9_-]` so a value is a valid Honcho-style resource id. */
export function slug(value: string, max = 64): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}
