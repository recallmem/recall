import type { Context } from "hono";
import type { z } from "zod";
import { stripNul } from "../lib/json.js";

type Detail = { type: string; loc: (string | number)[]; msg: string; input: unknown };

/**
 * FastAPI-style 422 body: `{"detail": [{type, loc, msg, input}]}`. Honcho SDKs parse this shape.
 * Each `input` is cut with `clipInput`, so a 422 never sends a huge value back.
 */
export class ValidationError extends Error {
  readonly detail: Detail[];
  constructor(detail: Detail[]) {
    super("validation error");
    this.name = "ValidationError";
    this.detail = detail.map((d) => ({ ...d, input: clipInput(d.input) }));
  }
}

/** About this many characters of an offending value are echoed in a 422. */
export const MAX_ECHO_CHARS = 200;
const ELLIPSIS = "…";

/**
 * An echoed input cut to about MAX_ECHO_CHARS characters: a long string keeps its start and
 * ends in "…"; in an object or list, the strings, keys and entries share that budget, and the
 * entries past it become one "…" entry. Short values come back unchanged.
 */
export function clipInput(value: unknown): unknown {
  let left = MAX_ECHO_CHARS;
  const clip = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= left) {
        left -= v.length;
        return v;
      }
      const kept = v.slice(0, Math.max(left, 0));
      left = 0;
      return `${kept}${ELLIPSIS}`;
    }
    if (Array.isArray(v)) {
      left -= 2;
      const out: unknown[] = [];
      for (const item of v) {
        if (left <= 0) {
          out.push(ELLIPSIS);
          break;
        }
        out.push(clip(item));
      }
      return out;
    }
    if (v !== null && typeof v === "object") {
      left -= 2;
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) {
        if (left <= 0) {
          out[ELLIPSIS] = ELLIPSIS;
          break;
        }
        left -= Math.min(k.length, left);
        out[k.length > MAX_ECHO_CHARS ? `${k.slice(0, MAX_ECHO_CHARS)}${ELLIPSIS}` : k] =
          clip(item);
      }
      return out;
    }
    left -= String(v).length;
    return v;
  };
  return clip(value);
}

function toDetail(where: "body" | "query" | "path", error: z.ZodError, input: unknown) {
  return error.issues.map((issue) => {
    let value: unknown = input;
    for (const key of issue.path)
      value = (value as Record<PropertyKey, unknown> | undefined)?.[key];
    return {
      type: issue.code,
      loc: [where, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))],
      msg: issue.message,
      input: value ?? null,
    };
  });
}

/** Parses and validates a JSON body. NUL characters are stripped from all strings first. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  const text = await c.req.text();
  try {
    raw = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    throw new ValidationError([
      { type: "json_invalid", loc: ["body"], msg: "JSON decode error", input: text },
    ]);
  }
  const input = stripNul(raw);
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError(toDetail("body", parsed.error, input));
  return parsed.data;
}

/** Validates query parameters (all strings; use z.coerce for numbers and booleans). */
export function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const input = c.req.query();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError(toDetail("query", parsed.error, input));
  return parsed.data;
}
