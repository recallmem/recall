import { type SQL, sql } from "drizzle-orm";
import { unprocessable } from "../lib/errors.js";
import { NAME_PATTERN } from "../lib/ids.js";

export type FilterResource = "workspaces" | "peers" | "sessions" | "messages" | "conclusions";

/**
 * Compiles a Honcho `filters` object (spec 01 section 1.10) to a SQL boolean
 * expression, or undefined when it imposes no condition.
 *
 * The SQL references these table aliases, which every caller must provide:
 * - workspaces:  w (workspaces)
 * - peers:       p (peers), w
 * - sessions:    s (sessions), w
 * - messages:    m (messages), s (sessions), p (author peers), w
 * - conclusions: c (conclusions), obs (observer peers), obd (observed peers), s (sessions, LEFT JOIN), w
 * External field names map to names, not internal ids (e.g. `session_id` becomes s.name).
 *
 * Only whitelisted fields are accepted (the `observer`/`observed` aliases on
 * conclusions are the single exception); anything else is a 422.
 */
export function compileFilters(resource: FilterResource, filters: unknown): SQL | undefined {
  if (filters == null) return undefined;
  if (!isPlainObject(filters)) throw unprocessable("filters must be an object");
  checkFilterSize(filters);
  return compileObject(RESOURCES[resource], filters, 0);
}

/** At most this many keys and list entries in one filter, and this long a string in it. */
const MAX_FILTER_NODES = 200;
const MAX_FILTER_STRING = 1000;

/**
 * Bounds a filter before it becomes SQL: a pattern match costs the product of the pattern's and
 * the value's length per row, so neither long patterns nor huge IN lists get to the database.
 */
function checkFilterSize(filters: Record<string, unknown>): void {
  let nodes = 0;
  const walk = (v: unknown): void => {
    if (++nodes > MAX_FILTER_NODES)
      throw unprocessable(`filters may have at most ${MAX_FILTER_NODES} keys and list entries`);
    if (typeof v === "string") {
      if (v.length > MAX_FILTER_STRING)
        throw unprocessable(`filter values may be at most ${MAX_FILTER_STRING} characters`);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v))
      for (const [k, x] of Object.entries(v)) {
        walk(k);
        walk(x);
      }
  };
  walk(filters);
}

// ---------------------------------------------------------------------------
// Field tables

type Kind = "text" | "bool" | "datetime" | "number" | "enum" | "json" | "id_array";

interface Field {
  kind: Kind;
  col: SQL;
  values?: readonly string[];
}

interface ResourceDef {
  label: string;
  fields: Record<string, Field>;
  aliases?: Record<string, string>;
  /** Recognised-but-unsupported generic names, rejected with "does not exist on X". */
  absent?: readonly string[];
}

const text = (col: string): Field => ({ kind: "text", col: sql.raw(col) });
const datetime = (col: string): Field => ({ kind: "datetime", col: sql.raw(col) });
const json = (col: string): Field => ({ kind: "json", col: sql.raw(col) });
const number = (col: string): Field => ({ kind: "number", col: sql.raw(col) });

const LEVELS = ["explicit", "deductive", "inductive", "contradiction"] as const;

const RESOURCES: Record<FilterResource, ResourceDef> = {
  workspaces: {
    label: "Workspace",
    fields: {
      id: text("w.name"),
      created_at: datetime("w.created_at"),
      metadata: json("w.metadata"),
    },
    absent: ["is_active", "workspace_id", "session_id", "peer_id"],
  },
  peers: {
    label: "Peer",
    fields: {
      id: text("p.name"),
      created_at: datetime("p.created_at"),
      workspace_id: text("w.name"),
      metadata: json("p.metadata"),
    },
    absent: ["is_active", "session_id", "peer_id"],
  },
  sessions: {
    label: "Session",
    fields: {
      id: text("s.name"),
      created_at: datetime("s.created_at"),
      is_active: { kind: "bool", col: sql.raw("s.is_active") },
      workspace_id: text("w.name"),
      metadata: json("s.metadata"),
    },
    absent: ["session_id", "peer_id"],
  },
  messages: {
    label: "Message",
    fields: {
      workspace_id: text("w.name"),
      session_id: text("s.name"),
      peer_id: text("p.name"),
      token_count: number("m.token_count"),
      created_at: datetime("m.created_at"),
      metadata: json("m.metadata"),
    },
  },
  conclusions: {
    label: "Conclusion",
    fields: {
      id: text("c.id"),
      session_id: text("s.name"),
      workspace_id: text("w.name"),
      observer_id: text("obs.name"),
      observed_id: text("obd.name"),
      level: { kind: "enum", col: sql.raw("c.level"), values: LEVELS },
      source_ids: { kind: "id_array", col: sql.raw("c.source_ids") },
      times_derived: number("c.times_derived"),
      metadata: json("c.internal"),
      // Recall: validity and provenance. `current` is true while the fact still holds.
      current: { kind: "bool", col: sql.raw("(c.valid_to IS NULL)") },
      valid_from: datetime("COALESCE(c.valid_from, c.created_at)"),
      valid_to: datetime("c.valid_to"),
      superseded_by: text("c.superseded_by"),
      message_ids: { kind: "id_array", col: sql.raw("c.message_ids") },
    },
    aliases: { observer: "observer_id", observed: "observed_id" },
  },
};

// ---------------------------------------------------------------------------
// Compiler

const MAX_DEPTH = 5;
const LOGICAL = ["AND", "OR", "NOT"] as const;
const OPERATORS = ["gt", "gte", "lt", "lte", "ne", "in", "contains", "icontains"] as const;
type Operator = (typeof OPERATORS)[number];
const isOperator = (k: string): k is Operator => (OPERATORS as readonly string[]).includes(k);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pyType(v: unknown): string {
  if (v === null) return "NoneType";
  if (Array.isArray(v)) return "list";
  switch (typeof v) {
    case "string":
      return "str";
    case "number":
      return Number.isInteger(v) ? "int" : "float";
    case "boolean":
      return "bool";
    default:
      return "dict";
  }
}

const and = (parts: SQL[]): SQL | undefined =>
  parts.length === 0
    ? undefined
    : parts.length === 1
      ? parts[0]
      : sql.join(
          parts.map((p) => sql`(${p})`),
          sql` AND `,
        );

function compileObject(
  def: ResourceDef,
  filter: Record<string, unknown>,
  depth: number,
): SQL | undefined {
  const parts: SQL[] = [];
  for (const [key, value] of Object.entries(filter)) {
    let part: SQL | undefined;
    if ((LOGICAL as readonly string[]).includes(key)) {
      part = compileLogical(def, key as (typeof LOGICAL)[number], value, depth);
    } else {
      part = compileField(def, key, value);
    }
    if (part) parts.push(part);
  }
  return and(parts);
}

function compileLogical(
  def: ResourceDef,
  key: (typeof LOGICAL)[number],
  value: unknown,
  depth: number,
): SQL | undefined {
  if (!Array.isArray(value))
    throw unprocessable(`${key} operator must contain a list, got ${pyType(value)}`);
  if (depth + 1 > MAX_DEPTH)
    throw unprocessable(`Filter nesting exceeds maximum depth of ${MAX_DEPTH}`);
  const subs: (SQL | undefined)[] = value.map((sub) => {
    if (!isPlainObject(sub))
      throw unprocessable(`${key} operator entries must be objects, got ${pyType(sub)}`);
    return compileObject(def, sub, depth + 1);
  });
  if (key === "AND") return and(subs.filter((s): s is SQL => s !== undefined));
  if (key === "OR") {
    // A sub-filter that imposes no condition matches everything, so the OR does too.
    if (subs.length === 0 || subs.some((s) => s === undefined)) return undefined;
    return sql.join(
      subs.map((s) => sql`(${s})`),
      sql` OR `,
    );
  }
  // NOT: none of the sub-filters is TRUE (null-safe: "is not true", not plain NOT).
  const negated = subs.filter((s): s is SQL => s !== undefined).map((s) => sql`(${s}) IS NOT TRUE`);
  return and(negated);
}

function resolveField(def: ResourceDef, name: string): { name: string; field: Field } {
  const canonical = def.aliases?.[name] ?? name;
  const field = Object.hasOwn(def.fields, canonical) ? def.fields[canonical] : undefined;
  if (!field) {
    if (def.absent?.includes(name))
      throw unprocessable(`Column '${name}' does not exist on ${def.label}`);
    throw unprocessable(
      `Column '${name}' is not allowed to be filtered on or does not exist on ${def.label}`,
    );
  }
  return { name: canonical, field };
}

function compileField(def: ResourceDef, rawName: string, value: unknown): SQL | undefined {
  const { name, field } = resolveField(def, rawName);
  if (value === "*") return undefined;
  if (field.kind === "json") return compileMetadata(field.col, name, value);
  if (field.kind === "id_array") return compileIdArray(field.col, name, value);
  if (value === null) return sql`${field.col} IS NULL`;
  if (Array.isArray(value)) return compileOperator(field, name, "in", value);
  if (isPlainObject(value)) {
    const parts: SQL[] = [];
    for (const [op, operand] of Object.entries(value)) {
      if (!isOperator(op)) throw unprocessable(`Unsupported comparison operator: ${op}`);
      const part = compileOperator(field, name, op, operand);
      if (part) parts.push(part);
    }
    return and(parts);
  }
  return sql`${field.col} = ${scalar(field, name, value)}`;
}

// -- scalar coercion --------------------------------------------------------

const NUMERIC_STRING = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Parses the datetime forms of spec 01 section 1.4 into an unambiguous ISO string, or null. */
export function normalizeDatetime(input: string): string | null {
  const m = DATETIME.exec(input.trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", frac, tz] = m;
  const probe = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
  if (
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() !== Number(mo) - 1 ||
    probe.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59
  ) {
    return null;
  }
  let offset = "Z";
  if (tz && tz.toUpperCase() !== "Z") {
    const digits = tz.slice(1).replace(":", "");
    const oh = digits.slice(0, 2);
    const om = digits.slice(2) || "00";
    if (Number(oh) > 23 || Number(om) > 59) return null;
    offset = `${tz[0]}${oh}:${om}`;
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ? `.${frac}` : ""}${offset}`;
}

function scalar(field: Field, name: string, value: unknown): SQL {
  switch (field.kind) {
    case "text":
      if (typeof value !== "string")
        throw unprocessable(`Invalid value for ${name}: expected a string`);
      return sql`${value}`;
    case "bool":
      if (typeof value !== "boolean")
        throw unprocessable(`Invalid value for ${name}: expected a boolean (true or false)`);
      return sql`${value}`;
    case "datetime": {
      const iso = typeof value === "string" ? normalizeDatetime(value) : null;
      if (!iso) throw unprocessable(`Invalid datetime value: ${JSON.stringify(value)}`);
      return sql`${iso}::timestamptz`;
    }
    case "number": {
      let n: number | null = null;
      if (typeof value === "number") n = value;
      else if (typeof value === "string" && NUMERIC_STRING.test(value.trim())) n = Number(value);
      if (n === null || !Number.isFinite(n)) {
        throw unprocessable(
          `Invalid value for ${name}: expected a number, got ${JSON.stringify(value)}`,
        );
      }
      if (Math.abs(n) >= 1e18)
        throw unprocessable(`Invalid value for ${name}: number out of range`);
      return sql`${String(n)}::numeric`;
    }
    case "enum":
      if (typeof value !== "string" || !field.values?.includes(value)) {
        throw unprocessable(
          `Invalid value for ${name}: ${JSON.stringify(value)}. Must be one of [${field.values?.join(", ")}]`,
        );
      }
      return sql`${value}`;
    default:
      throw unprocessable(`Column '${name}' does not support this filter`);
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

function compileOperator(
  field: Field,
  name: string,
  op: Operator,
  operand: unknown,
): SQL | undefined {
  if (operand === "*") return undefined;
  if (operand === null) {
    if (op === "ne") return sql`${field.col} IS NOT NULL`;
    throw unprocessable(
      `Operator '${op}' does not accept null. Use {"ne": null} to match non-null values`,
    );
  }
  switch (op) {
    case "in": {
      if (!Array.isArray(operand))
        throw unprocessable(`Operator 'in' on '${name}' requires a list, got ${pyType(operand)}`);
      if (operand.includes("*")) return undefined;
      if (operand.length === 0) return sql`FALSE`;
      for (const item of operand) {
        if (item === null)
          throw unprocessable(`Operator 'in' on '${name}' does not accept null entries`);
      }
      const values = operand.map((item) => scalar(field, name, item));
      return sql`${field.col} IN (${sql.join(values, sql`, `)})`;
    }
    case "ne":
      return sql`${field.col} IS DISTINCT FROM ${scalar(field, name, operand)}`;
    case "contains":
    case "icontains": {
      if (field.kind !== "text") {
        throw unprocessable(`Operator '${op}' is only supported on text fields, not '${name}'`);
      }
      if (typeof operand !== "string")
        throw unprocessable(`Invalid value for ${name}: expected a string`);
      return sql`${field.col} ILIKE ${`%${escapeLike(operand)}%`} ESCAPE '\\'`;
    }
    default: {
      if (field.kind === "bool" || field.kind === "enum") {
        throw unprocessable(`Operator '${op}' is not supported on '${name}'`);
      }
      const cmp = sql.raw({ gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]);
      return sql`${field.col} ${cmp} ${scalar(field, name, operand)}`;
    }
  }
}

// -- source_ids (conclusions) -------------------------------------------------

function textArray(values: unknown[], name: string): SQL {
  for (const v of values)
    if (typeof v !== "string") throw unprocessable(`Invalid value for ${name}: expected a string`);
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v as string}`),
    sql`, `,
  )}]::text[]`;
}

function compileIdArray(col: SQL, name: string, value: unknown): SQL | undefined {
  if (typeof value === "string") return sql`${col} @> ${textArray([value], name)}`;
  if (Array.isArray(value))
    return value.length === 0 ? undefined : sql`${col} @> ${textArray(value, name)}`;
  if (isPlainObject(value)) {
    const parts: SQL[] = [];
    for (const [op, operand] of Object.entries(value)) {
      if (operand === "*") continue;
      if (op === "contains") {
        if (typeof operand !== "string")
          throw unprocessable(`Invalid value for ${name}: expected a string`);
        parts.push(sql`${col} @> ${textArray([operand], name)}`);
      } else if (op === "in") {
        if (!Array.isArray(operand))
          throw unprocessable(`Operator 'in' on '${name}' requires a list, got ${pyType(operand)}`);
        if (operand.includes("*")) continue;
        parts.push(operand.length === 0 ? sql`FALSE` : sql`${col} && ${textArray(operand, name)}`);
      } else {
        throw unprocessable(
          `Operator '${op}' is not supported on '${name}'; use 'contains' or 'in'`,
        );
      }
    }
    return and(parts);
  }
  throw unprocessable(
    `Invalid filter for '${name}': expected a string, a list, or {"contains": ..} / {"in": [..]}`,
  );
}

// -- metadata (JSON object columns) -------------------------------------------

const NUMERIC_TEXT = "^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$";

function compileMetadata(col: SQL, name: string, value: unknown): SQL | undefined {
  if (value === null) return sql`${col} IS NULL`;
  if (!isPlainObject(value))
    throw unprocessable(`Invalid filter for '${name}': expected an object`);
  const parts: SQL[] = [];
  for (const [key, operand] of Object.entries(value)) {
    if (operand === "*") continue;
    // {"metadata": {"contains": {...}}}: containment of the given object.
    if (key === "contains" && isPlainObject(operand)) {
      parts.push(sql`${col} @> ${JSON.stringify(operand)}::jsonb`);
      continue;
    }
    if (
      isPlainObject(operand) &&
      Object.keys(operand).length > 0 &&
      Object.keys(operand).every(isOperator)
    ) {
      const sub = compileMetadataKey(col, key, operand);
      if (sub) parts.push(sub);
    } else {
      parts.push(sql`${col} @> ${JSON.stringify({ [key]: operand })}::jsonb`);
    }
  }
  return and(parts);
}

function compileMetadataKey(
  col: SQL,
  key: string,
  operators: Record<string, unknown>,
): SQL | undefined {
  const extracted = sql`(${col} ->> ${key}::text)`;
  const numeric = sql`(CASE WHEN ${extracted} ~ ${NUMERIC_TEXT} THEN ${extracted}::numeric END)`;
  const parts: SQL[] = [];
  for (const [op, operand] of Object.entries(operators)) {
    if (!isOperator(op) || operand === "*") continue;
    if (operand === null) {
      if (op === "ne") {
        parts.push(sql`${extracted} IS NOT NULL`);
        continue;
      }
      throw unprocessable(
        `Operator '${op}' does not accept null. Use {"ne": null} to match non-null values`,
      );
    }
    switch (op) {
      case "in": {
        if (!Array.isArray(operand))
          throw unprocessable(`Operator 'in' on 'metadata.${key}' requires a list`);
        if (operand.includes("*")) break;
        if (operand.length === 0) {
          parts.push(sql`FALSE`);
          break;
        }
        const texts = operand.map((item) => {
          if (item === null || typeof item === "object") {
            throw unprocessable(`Operator 'in' on 'metadata.${key}' accepts scalar values only`);
          }
          return sql`${String(item)}`;
        });
        parts.push(sql`${extracted} IN (${sql.join(texts, sql`, `)})`);
        break;
      }
      case "contains":
      case "icontains":
        if (typeof operand === "object")
          throw unprocessable(`Operator '${op}' on 'metadata.${key}' requires a string`);
        parts.push(sql`${extracted} ILIKE ${`%${escapeLike(String(operand))}%`} ESCAPE '\\'`);
        break;
      default: {
        if (typeof operand === "object")
          throw unprocessable(`Operator '${op}' on 'metadata.${key}' requires a scalar`);
        const isNumeric =
          typeof operand === "number" ||
          (typeof operand === "string" && NUMERIC_STRING.test(operand.trim()));
        if (typeof operand === "boolean") {
          if (op !== "ne")
            throw unprocessable(`Operator '${op}' is not supported for boolean values`);
          parts.push(sql`${extracted} IS DISTINCT FROM ${String(operand)}`);
        } else if (isNumeric) {
          const n = String(Number(operand));
          if (op === "ne") parts.push(sql`${numeric} IS DISTINCT FROM ${n}::numeric`);
          else
            parts.push(
              sql`${numeric} ${sql.raw({ gt: ">", gte: ">=", lt: "<", lte: "<=" }[op as "gt"])} ${n}::numeric`,
            );
        } else {
          const s = String(operand);
          if (op === "ne") parts.push(sql`${extracted} IS DISTINCT FROM ${s}`);
          else
            parts.push(
              sql`${extracted} ${sql.raw({ gt: ">", gte: ">=", lt: "<", lte: "<=" }[op as "gt"])} ${s}`,
            );
        }
      }
    }
  }
  return and(parts);
}

// ---------------------------------------------------------------------------
// Restricted "session allowlist" dialect (peer chat / representation / session context)

export const SESSION_ALLOWLIST_MAX = 1000;

const pyList = (items: string[]) => `[${items.map((i) => `'${i}'`).join(", ")}]`;

/**
 * Parses the restricted filter dialect of the recall endpoints:
 * `{"session_id": "<id>"}`, `{"session_id": ["<id>", ...]}` or
 * `{"session_id": {"in": ["<id>", ...]}}`.
 *
 * Returns the de-duplicated allowlist, or null when `filters` is absent. An
 * explicit empty list is returned as `[]` and means "recall nothing" (fail
 * closed). `sessionId` is the request's top-level `session_id`, which must be
 * part of the list when both are given.
 */
export function parseSessionAllowlist(
  filters: unknown,
  sessionId?: string | null,
): string[] | null {
  if (filters == null) return null;
  if (!isPlainObject(filters)) throw unprocessable("filters must be an object");
  const keys = Object.keys(filters);
  const unsupported = keys.filter((k) => k !== "session_id");
  if (unsupported.length > 0) {
    throw unprocessable(
      `Unsupported filter key(s) for this endpoint: ${pyList(unsupported)}. Only 'session_id' is supported.`,
    );
  }
  if (!Object.hasOwn(filters, "session_id")) {
    throw unprocessable("filters must contain 'session_id'. Only 'session_id' is supported.");
  }
  const raw = filters.session_id;
  let list: unknown[];
  if (typeof raw === "string") list = [raw];
  else if (Array.isArray(raw)) list = raw;
  else if (isPlainObject(raw) && Object.keys(raw).length === 1 && Array.isArray(raw.in))
    list = raw.in;
  else {
    throw unprocessable(
      'filters.session_id must be a session id, a list of session ids, or {"in": [session ids]}',
    );
  }
  if (list.length > SESSION_ALLOWLIST_MAX) {
    throw unprocessable(`filters.session_id may contain at most ${SESSION_ALLOWLIST_MAX} entries`);
  }
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw unprocessable("filters.session_id entries must be non-empty strings");
    }
    if (entry === "*") throw unprocessable("filters.session_id does not support the '*' wildcard");
    if (entry.length > 512 || !NAME_PATTERN.test(entry)) {
      throw unprocessable(`filters.session_id contains an invalid session id: '${entry}'`);
    }
    seen.add(entry);
  }
  const allowlist = [...seen];
  if (sessionId && !seen.has(sessionId))
    throw unprocessable("session_id must be included in filters.session_id");
  return allowlist;
}
