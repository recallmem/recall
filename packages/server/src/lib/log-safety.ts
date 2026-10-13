import { stdSerializers } from "pino";

/**
 * The `err` serializer for every log line. A failed query's error carries the statement's bound
 * values (message text, secrets being stored, email addresses) in its `params` and in its
 * message; only the statement is kept, so a database error never writes customer data or
 * credentials to the logs.
 */
export function safeErr(err: unknown): unknown {
  const out = stdSerializers.err(err as Error) as Record<string, unknown> | undefined;
  if (!out || typeof out !== "object") return out;
  return scrub(out);
}

function scrub(o: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = { ...o };
  if ("params" in r) r.params = "[redacted]";
  if (typeof r.message === "string") r.message = withoutParams(r.message);
  if (typeof r.stack === "string") r.stack = withoutParams(r.stack);
  if (r.cause && typeof r.cause === "object") r.cause = scrub(r.cause as Record<string, unknown>);
  return r;
}

/** Drizzle's "Failed query: <sql>\nparams: <values>": keeps the statement, drops the values. */
const withoutParams = (text: string) =>
  text.replace(/\nparams: [\s\S]*?(?=\n {4}at |$)/, "\nparams: [redacted]");
