/**
 * Event time of a fact: when the thing it describes happened or began, separate from when it was
 * said (`valid_from`). Stored as a start, an optional end and how exact the start is.
 */

export type EventPrecision = "day" | "month" | "year";

export interface EventTime {
  start: Date;
  end: Date | null;
  precision: EventPrecision;
}

const MIN_YEAR = 1000;
const MAX_YEAR = 2999;

/**
 * A date as the extractor or an API caller writes it: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a full
 * ISO date-time (day precision). Anything else, or an impossible date, is null.
 */
export function parseEventDate(
  value: string | null | undefined,
): { at: Date; precision: EventPrecision } | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v);
  if (m) {
    const year = Number(m[1]);
    const month = m[2] ? Number(m[2]) : 1;
    const day = m[3] ? Number(m[3]) : 1;
    if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return null;
    const at = new Date(Date.UTC(year, month - 1, day));
    if (at.getUTCMonth() !== month - 1) return null; // 2025-02-30
    return { at, precision: m[3] ? "day" : m[2] ? "month" : "year" };
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const at = new Date(v);
  if (Number.isNaN(at.getTime())) return null;
  const year = at.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  return { at: new Date(Date.UTC(year, at.getUTCMonth(), at.getUTCDate())), precision: "day" };
}

/**
 * The event time of a start and an optional end, as written by the extractor or an API caller.
 * An end before the start is dropped; an end on the start's own day, month or year adds nothing.
 */
export function eventTime(
  start: string | null | undefined,
  end: string | null | undefined,
): EventTime | null {
  const s = parseEventDate(start);
  if (!s) return null;
  const e = parseEventDate(end);
  let endAt: Date | null = null;
  if (e) {
    // An end is the last day it covers: "2025-06" ends on the last day of June.
    const last = new Date(periodEnd(e.at, e.precision).getTime() - 86_400_000);
    if (last.getTime() >= periodEnd(s.at, s.precision).getTime()) endAt = last;
  }
  return { start: s.at, end: endAt, precision: s.precision };
}

/** The first moment after the day, month or year that starts at `at`. */
export function periodEnd(at: Date, precision: EventPrecision): Date {
  const y = at.getUTCFullYear();
  const mo = at.getUTCMonth();
  if (precision === "year") return new Date(Date.UTC(y + 1, 0, 1));
  if (precision === "month") return new Date(Date.UTC(y, mo + 1, 1));
  return new Date(Date.UTC(y, mo, at.getUTCDate() + 1));
}

/** The time span a fact's event covers, end exclusive: its stated end, else its start's period. */
export function eventSpan(t: { start: Date; end: Date | null; precision: EventPrecision }): {
  from: Date;
  to: Date;
} {
  const to = t.end
    ? new Date(Date.UTC(t.end.getUTCFullYear(), t.end.getUTCMonth(), t.end.getUTCDate() + 1))
    : periodEnd(t.start, t.precision);
  return { from: t.start, to };
}

/** `2025-05-27`, `2025-05` or `2025`, as precise as the date is known. */
export function formatEventDate(at: Date, precision: EventPrecision): string {
  const iso = at.toISOString();
  return precision === "year"
    ? iso.slice(0, 4)
    : precision === "month"
      ? iso.slice(0, 7)
      : iso.slice(0, 10);
}

/** `2025-05-27`, or `2025-05-27 to 2025-06-01` when the event spans time. */
export function describeEventTime(t: {
  start: Date;
  end: Date | null;
  precision: EventPrecision;
}): string {
  const start = formatEventDate(t.start, t.precision);
  return t.end ? `${start} to ${t.end.toISOString().slice(0, 10)}` : start;
}

/** Event times of one fact describe the same occurrence when their spans overlap. */
export function sameOccurrence(
  a: { start: Date; end: Date | null; precision: EventPrecision },
  b: { start: Date; end: Date | null; precision: EventPrecision },
): boolean {
  const x = eventSpan(a);
  const y = eventSpan(b);
  return x.from < y.to && y.from < x.to;
}

/** A stored event time from its columns (`event_start`, `event_end`, `event_precision`). */
export function eventOf(r: {
  event_start: Date | string | null;
  event_end: Date | string | null;
  event_precision: EventPrecision | null;
}): EventTime | null {
  if (r.event_start == null || !r.event_precision) return null;
  return {
    start: new Date(r.event_start),
    end: r.event_end != null ? new Date(r.event_end) : null,
    precision: r.event_precision,
  };
}

/**
 * Categories whose event time is when a state began (living somewhere, a job, a relationship): for
 * them a later event time means a newer state. For plans and events the event time is when the
 * thing happens, so which statement is newer is still told by when it was said (a trip moved to an
 * earlier date is an update, not an older state).
 */
const STATE_CATEGORIES = new Set([
  "identity",
  "relationship",
  "state",
  "skill",
  "preference",
  "other",
]);

/** What ordering two facts needs: their category, when each was said, and their event time. */
export interface Timed {
  category: string | null;
  validFrom: Date;
  event: EventTime | null;
}

/** When a state-like fact's state began, if its event time says so (see STATE_CATEGORIES). */
const stateEvent = (f: Timed): Date | null =>
  f.event && STATE_CATEGORIES.has(f.category ?? "other") ? f.event.start : null;

/** The time from which a fact holds: when its state began, else when it was said. */
export const stateStart = (f: Timed): Date => stateEvent(f) ?? f.validFrom;

/**
 * Does `a` describe a later state than `b`? By when the states began when both facts know it (and
 * differ), otherwise by when they were said: an event date is never compared with a mention date
 * (a fact said in March can be older than a change reported in June that happened in February).
 */
export function laterState(a: Timed, b: Timed): boolean {
  const ea = stateEvent(a);
  const eb = stateEvent(b);
  return ea && eb && ea.getTime() !== eb.getTime() ? ea > eb : a.validFrom > b.validFrom;
}

/** Where `older` stops holding once `newer` replaced it: when the new state began, never before `older` was said. */
export function closedAt(older: Timed, newer: Timed): Date {
  const at = stateStart(newer);
  return at > older.validFrom ? at : older.validFrom;
}

/**
 * The event end a replaced state takes: the day before the state that replaced it began, when both
 * have such a date and the replaced one had no end ("lived in Berlin from 2019", replaced by "lives
 * in Paris since 2025-02", ends on 2025-01-31). Null when that says nothing new.
 */
export function endedBy(older: Timed, newer: Timed): Date | null {
  const a = stateEvent(older);
  const b = stateEvent(newer);
  if (!a || !b || !older.event || older.event.end || b <= a) return null;
  const end = new Date(b.getTime() - 86_400_000);
  return end >= periodEnd(older.event.start, older.event.precision) ? end : null;
}

/** Two dated occurrences that do not overlap are different things that happened: never one fact. */
export const distinctOccurrences = (a: EventTime | null, b: EventTime | null): boolean =>
  !!a && !!b && !sameOccurrence(a, b);
