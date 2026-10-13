import { parseArgs } from "node:util";
import { NAME_MAX, NAME_PATTERN } from "../lib/ids.js";

/** What the command line needs from its surroundings; tests pass fakes. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /**
   * Asks the person a question. Present only when a person can answer (an
   * interactive terminal); `secret` hides what is typed.
   */
  prompt?(question: string, opts?: { secret?: boolean }): Promise<string>;
}

/** A mistake in how the command was invoked: printed without a stack trace, exit code 2. */
export class UsageError extends Error {}

/** A failure while doing the work (server unreachable, API error): exit code 1, JSON-formattable. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

export function parse<const O extends Options>(args: string[], options: O) {
  try {
    return parseArgs({
      args,
      options: { ...options, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** Like `parse`, but with positional arguments (`recall peer card alice`). */
export function parseWithPositionals<const O extends Options>(args: string[], options: O) {
  try {
    return parseArgs({
      args,
      options: { ...options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export function checkId(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > NAME_MAX || !NAME_PATTERN.test(value)) {
    throw new UsageError(
      `${label} must be 1-${NAME_MAX} characters of a-z, A-Z, 0-9, _ and - (got "${value}")`,
    );
  }
  return value;
}

export const isTruthy = (v: string | undefined): boolean =>
  v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());

/** An integer option within bounds, or the default when the option is absent. */
export function intOption(
  label: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${label} must be a whole number from ${min} to ${max} (got "${value}")`);
  }
  return n;
}
