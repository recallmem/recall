import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { type Db, rows } from "../db/client.js";
import { badRequest } from "../lib/errors.js";
import { boolParam } from "./common.js";
import { parseQuery } from "./validate.js";

/**
 * Pagination for list endpoints (spec 01 section 1.7).
 *
 * Two envelopes, chosen only by whether `cursor` is present in the query
 * string: the offset envelope (default) and the cursor envelope (`cursor=`
 * present, empty for the first page). Cursor mode is native keyset
 * pagination: the cursor is URL-safe base64 of the sort key of the boundary
 * row, bound to the query it was minted for by a fingerprint, so it can never
 * skip or repeat rows and a cursor from another query is rejected.
 */

export type KeyType = "timestamptz" | "text" | "bigint";

export interface OrderKey {
  /** SQL expression for the sort column (qualified, e.g. `p.created_at`). */
  expr: SQL;
  type: KeyType;
}

export interface CursorToken {
  /** "n": rows after the key (forward). "p": rows before the key (backward). */
  d: "n" | "p";
  /** Include the boundary row itself. */
  i: boolean;
  k: string[];
}

export interface Paging {
  page: number;
  size: number;
  reverse: boolean;
  /** True when `cursor` was present in the query string (even if empty). */
  cursorMode: boolean;
  /** The cursor string as sent, or null for the first page. */
  cursorRaw: string | null;
  cursor: CursorToken | null;
  /** Identifies the query (route, path ids, filters, direction) cursors are bound to. */
  fingerprint: string;
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export interface CursorPage<T> {
  items: T[];
  total: null;
  current_page: string | null;
  current_page_backwards: string | null;
  previous_page: string | null;
  next_page: string | null;
}

export type Page<T> = OffsetPage<T> | CursorPage<T>;

const PagingQuery = z.looseObject({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(50),
  reverse: boolParam.optional(),
});

const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/;
const KEY_CHECKS: Record<KeyType, (v: string) => boolean> = {
  timestamptz: (v) => TIMESTAMP_TEXT.test(v),
  bigint: (v) => /^-?\d{1,19}$/.test(v),
  text: () => true,
};

function encodeCursor(fingerprint: string, token: CursorToken): string {
  return Buffer.from(
    JSON.stringify({ v: 1, f: fingerprint, d: token.d, i: token.i ? 1 : 0, k: token.k }),
  ).toString("base64url");
}

function decodeCursor(raw: string, fingerprint: string, keyTypes: KeyType[]): CursorToken {
  const invalid = () => badRequest("Invalid cursor");
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("charset");
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== "object") throw invalid();
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1 || p.f !== fingerprint) throw invalid();
  if (p.d !== "n" && p.d !== "p") throw invalid();
  if (!Array.isArray(p.k) || p.k.length !== keyTypes.length) throw invalid();
  const keys: string[] = [];
  for (const [idx, value] of p.k.entries()) {
    if (typeof value !== "string" || !KEY_CHECKS[keyTypes[idx]!](value)) throw invalid();
    keys.push(value);
  }
  return { d: p.d, i: p.i === 1, k: keys };
}

/**
 * Reads `page`, `size`, `reverse` and `cursor` from the query string and
 * validates the cursor. Call it before any other handler logic so a bad
 * cursor is rejected first. `fingerprint` must describe everything that
 * determines the result set (route, path ids, filters); `keyTypes` must match
 * the `keys` later given to `paginate`.
 */
export function readPaging(
  c: Context,
  opts: { fingerprint: unknown; keyTypes: KeyType[]; reverse?: boolean },
): Paging {
  const query = parseQuery(c, PagingQuery);
  const reverse = opts.reverse === false ? false : (query.reverse ?? false);
  const raw = c.req.query();
  const cursorMode = Object.hasOwn(raw, "cursor");
  const cursorRaw = cursorMode && raw.cursor ? raw.cursor : null;
  const fingerprint = fingerprintOf(opts.fingerprint, reverse);
  const cursor = cursorRaw ? decodeCursor(cursorRaw, fingerprint, opts.keyTypes) : null;
  return {
    page: query.page,
    size: query.size,
    reverse,
    cursorMode,
    cursorRaw,
    cursor,
    fingerprint,
  };
}

function fingerprintOf(parts: unknown, reverse: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify([parts, reverse]))
    .digest("hex")
    .slice(0, 16);
}

export interface ListSpec<T> {
  /** Select list (no trailing comma). The sort keys are added automatically. */
  select: SQL;
  /** `FROM ... JOIN ...` clause, without WHERE. */
  from: SQL;
  /** Conditions, ANDed. */
  where: (SQL | undefined)[];
  /** Sort keys; the last one must be unique. All sort in the same direction. */
  keys: OrderKey[];
  /** Direction of the default order. `reverse` flips it. */
  natural?: "asc" | "desc";
  map(row: Record<string, unknown>): T;
}

const op = (dir: "asc" | "desc", inclusive: boolean) =>
  sql.raw(`${dir === "asc" ? ">" : "<"}${inclusive ? "=" : ""}`);
const invert = (dir: "asc" | "desc") => (dir === "asc" ? "desc" : "asc");

function castKey(value: string, type: KeyType): SQL {
  return type === "timestamptz"
    ? sql`${value}::timestamptz`
    : type === "bigint"
      ? sql`${value}::bigint`
      : sql`${value}::text`;
}

/** Runs a list query and renders the offset or cursor envelope. */
export async function paginate<T>(
  db: Pick<Db, "execute">,
  paging: Paging,
  spec: ListSpec<T>,
): Promise<Page<T>> {
  const natural = spec.natural ?? "asc";
  const dir: "asc" | "desc" = (natural === "asc") !== paging.reverse ? "asc" : "desc";
  const keySelect = sql.join(
    spec.keys.map((k, i) => sql`(${k.expr})::text AS ${sql.raw(`_k${i}`)}`),
    sql`, `,
  );
  const baseWhere = spec.where.filter((w): w is SQL => w !== undefined);
  const orderBy = (d: "asc" | "desc") =>
    sql.join(
      spec.keys.map((k) => sql`${k.expr} ${sql.raw(d.toUpperCase())}`),
      sql`, `,
    );
  const whereSql = (extra: SQL[]) => {
    const all = [...baseWhere, ...extra];
    return all.length
      ? sql`WHERE ${sql.join(
          all.map((w) => sql`(${w})`),
          sql` AND `,
        )}`
      : sql``;
  };
  const keyTuple = sql`(${sql.join(
    spec.keys.map((k) => k.expr),
    sql`, `,
  )})`;
  const keyValues = (token: CursorToken) =>
    sql`(${sql.join(
      token.k.map((v, i) => castKey(v, spec.keys[i]!.type)),
      sql`, `,
    )})`;
  const keyOf = (row: Record<string, unknown>): string[] =>
    spec.keys.map((_, i) => String(row[`_k${i}`]));
  const finger = paging.fingerprint;

  if (!paging.cursorMode) {
    const offset = (paging.page - 1) * paging.size;
    const result = await rows<Record<string, unknown>>(
      db,
      sql`SELECT ${spec.select} ${spec.from} ${whereSql([])}
          ORDER BY ${orderBy(dir)} LIMIT ${paging.size} OFFSET ${offset}`,
    );
    let total: number;
    if (result.length > 0 && result.length < paging.size) total = offset + result.length;
    else if (result.length === 0 && paging.page === 1) total = 0;
    else {
      const [counted] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n ${spec.from} ${whereSql([])}`,
      );
      total = Number(counted?.n ?? 0);
      // A concurrent write must not make a full page report fewer rows than it holds.
      if (result.length > 0) total = Math.max(total, offset + result.length);
    }
    return {
      items: result.map(spec.map),
      total,
      page: paging.page,
      size: paging.size,
      pages: total === 0 ? 0 : Math.ceil(total / paging.size),
    };
  }

  const token = paging.cursor;
  const backward = token?.d === "p";
  const queryDir = backward ? invert(dir) : dir;
  const extra: SQL[] = [];
  if (token) extra.push(sql`${keyTuple} ${op(queryDir, token.i)} ${keyValues(token)}`);
  const fetched = await rows<Record<string, unknown>>(
    db,
    sql`SELECT ${spec.select}, ${keySelect} ${spec.from} ${whereSql(extra)}
        ORDER BY ${orderBy(queryDir)} LIMIT ${paging.size + 1}`,
  );
  const hasMore = fetched.length > paging.size;
  let page = fetched.slice(0, paging.size);
  if (backward) page = page.reverse();
  const first = page[0];
  const last = page[page.length - 1];
  const mint = (d: "n" | "p", row: Record<string, unknown>, i = false) =>
    encodeCursor(finger, { d, i, k: keyOf(row) });

  let next: string | null;
  let previous: string | null;
  if (backward) {
    previous = hasMore && first ? mint("p", first) : null;
    next = last ? mint("n", last) : null;
  } else {
    next = hasMore && last ? mint("n", last) : null;
    previous = token && first ? mint("p", first) : null;
  }
  return {
    items: page.map(spec.map),
    total: null,
    current_page: paging.cursorRaw,
    current_page_backwards: last ? mint("p", last, true) : null,
    previous_page: previous,
    next_page: next,
  };
}

/** Key types of the standard "created_at, id" and message "seq" orders, for `readPaging`. */
export const CREATED_KEY_TYPES: KeyType[] = ["timestamptz", "text"];
export const SEQ_KEY_TYPES: KeyType[] = ["bigint"];

/** Standard keys for "ordered by created_at then id" lists. */
export const createdAtKeys = (createdAt: SQL, id: SQL): OrderKey[] => [
  { expr: createdAt, type: "timestamptz" },
  { expr: id, type: "text" },
];
