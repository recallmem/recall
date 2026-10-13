import { type CliError, type CliIo, isTruthy } from "./common.js";

/** Rendering: JSON for machines (`--json`, `RECALL_JSON`), readable tables for people. */

export const wantsJson = (flag: boolean | undefined, env: CliIo["env"]): boolean =>
  flag === true || isTruthy(env.RECALL_JSON);

export const dash = (v: unknown): string =>
  v === null || v === undefined || v === "" ? "-" : String(v);

/** One line, at most `max` characters. */
export function clip(v: unknown, max = 60): string {
  const flat = dash(v).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `2026-10-09T12:34:56.789Z` -> `2026-10-09 12:34:56`. */
export function when(v: unknown): string {
  if (typeof v !== "string") return "-";
  return v.length >= 19 ? v.slice(0, 19).replace("T", " ") : v;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

export function keyValues(pairs: [string, string][]): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${`${k}:`.padEnd(width + 2)}${v}`).join("\n");
}

/** "3 of 12 shown" footer for a paginated listing. */
export function pageNote(page: { items: unknown[]; total?: number | null }): string {
  const total = page.total ?? page.items.length;
  return total > page.items.length
    ? `\nShowing ${page.items.length} of ${total}. Use --limit and --page to see more.`
    : "";
}

/** Prints a failure to stderr: one line, or `{"error": {...}}` under `--json`. */
export function reportError(io: CliIo, command: string, err: CliError, json: boolean): void {
  if (json) {
    io.err(
      JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }),
    );
  } else {
    io.err(`recall ${command}: ${err.message}`);
  }
}
