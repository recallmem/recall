/**
 * The time a question asks about, read in code: "last week", "in May", "three months ago",
 * "on 2025-05-27", "between March and June", "vorige maand". Relative phrases resolve against the
 * date the question is asked on, which a caller can state in the question ("The current date is
 * 2025-06-03."); otherwise against now. Windows are generous on purpose: they choose what is
 * pulled into the pack, and ranking inside them still decides what comes first.
 */

export interface TimeWindow {
  /** First moment inside the window. */
  from: Date;
  /** First moment after it. */
  to: Date;
  /** The words of the question it was read from. */
  phrase: string;
}

const DAY = 86_400_000;

const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const startOfDay = (t: Date) => utcDay(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
const addDays = (t: Date, n: number) => new Date(t.getTime() + n * DAY);
const addMonths = (t: Date, n: number) =>
  utcDay(t.getUTCFullYear(), t.getUTCMonth() + n, Math.min(t.getUTCDate(), 28));
const monthStart = (y: number, m: number) => utcDay(y, m, 1);

// biome-ignore format: a table reads better in rows
const MONTHS: Record<string, number> = {
  january: 0, jan: 0, januari: 0,
  february: 1, feb: 1, februari: 1,
  march: 2, mar: 2, maart: 2, mrt: 2,
  april: 3, apr: 3,
  may: 4, mei: 4,
  june: 5, jun: 5, juni: 5,
  july: 6, jul: 6, juli: 6,
  august: 7, aug: 7, augustus: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, oktober: 9, okt: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};
const MONTH = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
/** Full month names only: a bare "jan" or "mar" next to a preposition is more often a name or a word. */
const MONTH_FULL = Object.keys(MONTHS)
  .filter(
    (k) =>
      k.length > 4 ||
      k === "may" ||
      k === "mei" ||
      k === "juni" ||
      k === "juli" ||
      k === "june" ||
      k === "july",
  )
  .sort((a, b) => b.length - a.length)
  .join("|");

/** Monday = 0. */
// biome-ignore format: a table reads better in rows
const WEEKDAYS: Record<string, number> = {
  monday: 0, maandag: 0,
  tuesday: 1, dinsdag: 1,
  wednesday: 2, woensdag: 2,
  thursday: 3, donderdag: 3,
  friday: 4, vrijdag: 4,
  saturday: 5, zaterdag: 5,
  sunday: 6, zondag: 6,
};
const WEEKDAY = Object.keys(WEEKDAYS).join("|");

// biome-ignore format: a table reads better in rows
const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, een: 1, "a couple of": 2, "a couple": 2, couple: 2, two: 2, twee: 2,
  "a few": 3, few: 3, three: 3, drie: 3, four: 4, vier: 4, five: 5, vijf: 5, six: 6, zes: 6,
  seven: 7, zeven: 7, eight: 8, acht: 8, nine: 9, negen: 9, ten: 10, tien: 10, eleven: 11, elf: 11,
  twelve: 12, twaalf: 12, "a dozen": 12, "een paar": 3, paar: 3, "enkele": 3,
};
const NUMBER = `\\d{1,3}|${Object.keys(NUMBERS)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/ /g, "\\s+"))
  .join("|")}`;
const numberOf = (s: string): number | null => {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBERS[t] ?? null;
};

type Unit = "day" | "week" | "month" | "year";
const unitOf = (s: string): Unit | null => {
  const t = s.toLowerCase();
  if (/^(days?|dagen|dag)$/.test(t)) return "day";
  if (/^(weeks?|weken)$/.test(t)) return "week";
  if (/^(months?|maanden|maand)$/.test(t)) return "month";
  if (/^(years?|jaren|jaar)$/.test(t)) return "year";
  return null;
};
const UNIT = "days?|weeks?|months?|years?|dagen|dag|weken|maanden|maand|jaren|jaar";

// ------------------------------------------------------------ question date --

const STATED_DATE =
  /\b(?:the current date is|current date(?: is)?:?|today(?:'s date)? is|today's date:|the date today is|vandaag is het|het is vandaag|de datum (?:van vandaag )?is)\s*:?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s*\([A-Za-z]{2,3}\))?(?:\s*\d{1,2}:\d{2})?\.?/i;

/** The date a question says it is asked on ("The current date is 2025-06-03."), if it says so. */
export function questionDate(query: string): Date | null {
  const m = STATED_DATE.exec(query);
  if (!m) return null;
  const at = utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(at.getTime()) || at.getUTCMonth() !== Number(m[2]) - 1 ? null : at;
}

/** The question without its stated date, so that date is not read as the time asked about. */
export const withoutQuestionDate = (query: string): string => query.replace(STATED_DATE, " ");

// ------------------------------------------------------------------ windows --

interface Span {
  from: Date;
  to: Date;
}

/** The year of a month or day named without one: the latest that is not far in the future. */
function yearFor(month: number, day: number, ref: Date): number {
  const y = ref.getUTCFullYear();
  return utcDay(y, month, day).getTime() > ref.getTime() + 62 * DAY ? y - 1 : y;
}

/** The most recent given weekday strictly before the reference day. */
function lastWeekday(weekday: number, ref: Date): Date {
  const today = (ref.getUTCDay() + 6) % 7;
  const back = (today - weekday + 7) % 7 || 7;
  return addDays(startOfDay(ref), -back);
}

const weekStart = (t: Date) => addDays(startOfDay(t), -((t.getUTCDay() + 6) % 7));

// biome-ignore format: a table reads better in rows
const SEASONS: Record<string, [number, number]> = {
  spring: [2, 3], lente: [2, 3], voorjaar: [2, 3],
  summer: [5, 3], zomer: [5, 3],
  autumn: [8, 3], fall: [8, 3], herfst: [8, 3], najaar: [8, 3],
  winter: [11, 3],
};
const SEASON = Object.keys(SEASONS).join("|");

/** A season of the northern hemisphere: the three months that start at its first month. */
function season(name: string, year: number): Span {
  const [m, n] = SEASONS[name.toLowerCase()]!;
  return { from: monthStart(year, m), to: monthStart(year, m + n) };
}

interface Rule {
  re: RegExp;
  span: (m: RegExpExecArray, ref: Date) => Span | null;
}

const day = (t: Date): Span => ({ from: t, to: addDays(t, 1) });
const isoDay = (y: string, m: string, d: string): Span | null => {
  const at = utcDay(Number(y), Number(m) - 1, Number(d));
  return at.getUTCMonth() === Number(m) - 1 && at.getUTCDate() === Number(d) ? day(at) : null;
};
const yearSpan = (y: number): Span => ({ from: utcDay(y, 0, 1), to: utcDay(y + 1, 0, 1) });
const monthSpan = (y: number, m: number): Span => ({
  from: monthStart(y, m),
  to: monthStart(y, m + 1),
});

/** A span "N units ago": around the point N units back, as wide as the unit. */
function ago(n: number, unit: Unit, ref: Date): Span {
  const today = startOfDay(ref);
  if (unit === "day") return { from: addDays(today, -n - 1), to: addDays(today, -n + 2) };
  if (unit === "week") {
    const at = addDays(today, -7 * n);
    return { from: addDays(weekStart(at), -3), to: addDays(weekStart(at), 10) };
  }
  if (unit === "month") {
    const at = addMonths(today, -n);
    return {
      from: addDays(monthStart(at.getUTCFullYear(), at.getUTCMonth()), -15),
      to: addDays(monthStart(at.getUTCFullYear(), at.getUTCMonth() + 1), 15),
    };
  }
  return yearSpan(ref.getUTCFullYear() - n);
}

/** "the past N units": from N units back up to the reference day. */
function past(n: number, unit: Unit, ref: Date): Span {
  const end = addDays(startOfDay(ref), 1);
  const from =
    unit === "day"
      ? addDays(end, -n - 1)
      : unit === "week"
        ? addDays(end, -7 * n - 1)
        : unit === "month"
          ? addMonths(startOfDay(ref), -n)
          : addMonths(startOfDay(ref), -12 * n);
  return { from, to: end };
}

const PREP = "(?:in|during|on|of|for|from|around|by|in de maand|tijdens|op|rond)";
/** Right after "since", "before" or "after", which timeWindow reads as the side of the date asked about. */
const AFTER_SIDE = "(?<=\\b(?:since|before|after|until|prior to|sinds|voor|na|tot)\\s)";

/** Rules in order of precision: the first that matches wins (ranges are handled before these). */
const RULES: Rule[] = [
  // 2025-05-27, 2025/05/27
  { re: /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/, span: (m) => isoDay(m[1]!, m[2]!, m[3]!) },
  // 27 May 2025, 27th of May, 27 mei
  {
    re: new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\.?(?:,?\\s+(\\d{4}))?\\b`,
      "i",
    ),
    span: (m, ref) => {
      const mo = MONTHS[m[2]!.toLowerCase()]!;
      const d = Number(m[1]);
      const y = m[3] ? Number(m[3]) : yearFor(mo, d, ref);
      return isoDay(String(y), String(mo + 1), String(d));
    },
  },
  // May 27, 2025; May 27th
  {
    re: new RegExp(
      `\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b(?!:)`,
      "i",
    ),
    span: (m, ref) => {
      const mo = MONTHS[m[1]!.toLowerCase()]!;
      const d = Number(m[2]);
      if (d > 31) return null;
      const y = m[3] ? Number(m[3]) : yearFor(mo, d, ref);
      return isoDay(String(y), String(mo + 1), String(d));
    },
  },
  // May 2025, mei 2025
  {
    re: new RegExp(`\\b(${MONTH})\\.?,?\\s+(?:of\\s+)?(\\d{4})\\b`, "i"),
    span: (m) => monthSpan(Number(m[2]), MONTHS[m[1]!.toLowerCase()]!),
  },
  // 2025-05
  {
    re: /\b(\d{4})-(\d{2})\b(?!-)/,
    span: (m) =>
      Number(m[2]) >= 1 && Number(m[2]) <= 12 ? monthSpan(Number(m[1]), Number(m[2]) - 1) : null,
  },
  // the summer of 2024, summer 2024
  {
    re: new RegExp(`\\b(?:the\\s+)?(${SEASON})\\s+(?:of\\s+)?(\\d{4})\\b`, "i"),
    span: (m) => season(m[1]!, Number(m[2])),
  },
  // today, tonight, this morning; vandaag
  {
    re: /\b(today|tonight|this (?:morning|afternoon|evening)|vandaag|vanochtend|vanmiddag|vanavond)\b/i,
    span: (_m, ref) => day(startOfDay(ref)),
  },
  // the day before yesterday; eergisteren
  {
    re: /\b(the day before yesterday|eergisteren)\b/i,
    span: (_m, ref) => day(addDays(startOfDay(ref), -2)),
  },
  // yesterday, last night; gisteren
  {
    re: /\b(yesterday|last night|gisteren|gisteravond)\b/i,
    span: (_m, ref) => day(addDays(startOfDay(ref), -1)),
  },
  // in the past 3 weeks, over the last two months, afgelopen 3 maanden
  {
    re: new RegExp(
      `\\b(?:(?:in|over|during|within)\\s+)?(?:the\\s+)?(?:past|last|previous|afgelopen|laatste)\\s+(${NUMBER})\\s+(${UNIT})\\b`,
      "i",
    ),
    span: (m, ref) => {
      const n = numberOf(m[1]!);
      const u = unitOf(m[2]!);
      return n && u ? past(n, u, ref) : null;
    },
  },
  // a few days ago: up to a week back (before the rule for "3 days ago", which would read it as 3)
  {
    re: /\b(?:a few|several|some|een paar|enkele)\s+(days|dagen)\s+(?:ago|geleden)\b/i,
    span: (_m, ref) => ({ from: addDays(startOfDay(ref), -6), to: addDays(startOfDay(ref), 1) }),
  },
  // 3 weeks ago, a couple of months ago, 2 jaar geleden
  {
    re: new RegExp(`\\b(${NUMBER})\\s+(${UNIT})\\s+(?:ago|geleden)\\b`, "i"),
    span: (m, ref) => {
      const n = numberOf(m[1]!);
      const u = unitOf(m[2]!);
      return n && u ? ago(n, u, ref) : null;
    },
  },
  // last weekend / this weekend; afgelopen/vorig weekend
  {
    re: /\b(last|this|past|afgelopen|vorig|dit)\s+weekend\b/i,
    span: (m, ref) => {
      const sat = lastWeekday(5, addDays(ref, /^(this|dit)$/i.test(m[1]!) ? 7 : 0));
      return { from: sat, to: addDays(sat, 2) };
    },
  },
  // last Tuesday, on Tuesday, vorige dinsdag
  {
    re: new RegExp(`\\b(?:(last|this past|past|on|vorige|afgelopen|op)\\s+)(${WEEKDAY})\\b`, "i"),
    span: (m, ref) => {
      const t = lastWeekday(WEEKDAYS[m[2]!.toLowerCase()]!, ref);
      return { from: addDays(t, -1), to: addDays(t, 2) };
    },
  },
  // this week / last week; deze week / vorige week
  {
    re: /\b(this|last|past|previous|deze|vorige|afgelopen)\s+week\b/i,
    span: (m, ref) => {
      const start = weekStart(ref);
      const end = addDays(startOfDay(ref), 1);
      return /^(this|deze)$/i.test(m[1]!)
        ? { from: start, to: end }
        : { from: addDays(start, -7), to: end };
    },
  },
  // this month / last month
  {
    re: /\b(this|last|past|previous|deze|vorige|afgelopen)\s+(month|maand)\b/i,
    span: (m, ref) => {
      const start = monthStart(ref.getUTCFullYear(), ref.getUTCMonth());
      const end = addDays(startOfDay(ref), 1);
      if (/^(this|deze)$/i.test(m[1]!)) return { from: start, to: end };
      return { from: monthStart(ref.getUTCFullYear(), ref.getUTCMonth() - 1), to: end };
    },
  },
  // this year / last year
  {
    re: /\b(this|last|past|previous|dit|vorig|afgelopen)\s+(year|jaar)\b/i,
    span: (m, ref) => {
      const y = ref.getUTCFullYear();
      // "last year" may be the calendar year before or the past twelve months: both.
      return {
        from: utcDay(/^(this|dit)$/i.test(m[1]!) ? y : y - 1, 0, 1),
        to: addDays(startOfDay(ref), 1),
      };
    },
  },
  // last summer, this winter, in the spring
  {
    re: new RegExp(
      `\\b(last|this|past|in the|during the|vorige|afgelopen|deze|in de)\\s+(${SEASON})\\b`,
      "i",
    ),
    span: (m, ref) => {
      const s = season(m[2]!, ref.getUTCFullYear());
      const cur = s.from.getTime() <= ref.getTime();
      const recent = cur ? s : season(m[2]!, ref.getUTCFullYear() - 1);
      if (/^(last|past|vorige|afgelopen)$/i.test(m[1]!) && recent.to.getTime() > ref.getTime())
        return season(m[2]!, recent.from.getUTCFullYear() - 1);
      return recent;
    },
  },
  // in May, last March, early June (a month named with a preposition or a qualifier); since May
  {
    re: new RegExp(
      `(?:\\b(?:${PREP}|last|this|early|late|mid|begin|eind|half|vorige)\\s+(?:-\\s*)?|${AFTER_SIDE})(${MONTH_FULL})\\b`,
      "i",
    ),
    span: (m, ref) => {
      const mo = MONTHS[m[1]!.toLowerCase()]!;
      return monthSpan(yearFor(mo, 1, ref), mo);
    },
  },
  // in 2024, during 2023; since 2023
  {
    re: new RegExp(
      `(?:\\b(?:in|during|of|for|throughout|tijdens)\\s+|${AFTER_SIDE})((?:19|20)\\d{2})\\b`,
      "i",
    ),
    span: (m) => yearSpan(Number(m[1])),
  },
];

const LONG_AGO = utcDay(1900, 0, 1);

type Found = Span & { index: number; end: number; phrase: string; rule: number };

/**
 * The first date expression in `text`. Expressions that overlap or touch ("in May 2025",
 * "on Monday, May 5") are one: the most precise rule among them reads it.
 */
function findSpan(text: string, ref: Date): Found | null {
  const all: Found[] = [];
  for (const [rule, r] of RULES.entries()) {
    const m = r.re.exec(text);
    if (!m) continue;
    const span = r.span(m, ref);
    if (!span || span.to <= span.from) continue;
    all.push({ ...span, index: m.index, end: m.index + m[0].length, phrase: m[0].trim(), rule });
  }
  if (!all.length) return null;
  all.sort((a, b) => a.index - b.index);
  const first = all[0]!;
  const group = all.filter((f) => f.index <= first.end + 3);
  return group.reduce((best, f) => (f.rule < best.rule ? f : best));
}

/**
 * The window of time a question asks about, or null when it names none. `now` is used when the
 * question does not state its own date.
 */
export function timeWindow(query: string, now: Date = new Date()): TimeWindow | null {
  const ref = questionDate(query) ?? now;
  const text = withoutQuestionDate(query);

  // between X and Y, from X to/until Y, tussen X en Y
  const range =
    /\b(between|from|tussen|van)\s+(.{3,40}?)\s+(?:and|to|until|till|through|en|tot)\s+(.{3,40}?)(?=[?.,;!]|$)/i.exec(
      text,
    );
  if (range) {
    // Each side read as if a preposition came before it ("between May and July").
    const a = findSpan(`in ${range[2]}`, ref);
    const b = findSpan(`in ${range[3]}`, ref);
    if (a && b && a.from < b.to) return { from: a.from, to: b.to, phrase: range[0].trim() };
  }

  const found = findSpan(text, ref);
  if (!found) return null;
  // since X, before X, after X: the side of X the question looks at
  const lead = text.slice(Math.max(0, found.index - 12), found.index).toLowerCase();
  const end = addDays(startOfDay(ref), 1);
  if (/\b(since|sinds|sindsdien)\s*$/.test(lead) && found.from < end)
    return { from: found.from, to: end, phrase: `since ${found.phrase}` };
  if (/\b(before|prior to|until|voor|tot)\s*$/.test(lead))
    return { from: LONG_AGO, to: found.from, phrase: `before ${found.phrase}` };
  if (/\b(after|na)\s*$/.test(lead) && found.to < end)
    return { from: found.to, to: end, phrase: `after ${found.phrase}` };
  return { from: found.from, to: found.to, phrase: found.phrase };
}

/** `2025-05-26 to 2025-06-01` (the last day inside), or one day. */
export function describeWindow(w: TimeWindow): string {
  const first = w.from.toISOString().slice(0, 10);
  const last = addDays(w.to, -1).toISOString().slice(0, 10);
  return first === last ? first : `${first} to ${last}`;
}
