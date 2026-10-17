import type { HostedConfig } from "../config.js";

/**
 * Website analytics for the operator console's Traffic page, read from a self-hosted Umami server
 * (UMAMI_URL, UMAMI_WEBSITE_ID, UMAMI_API_KEY) over its REST API with a bearer API key. Umami is
 * cookieless and keeps no personal data; the site loads its tracker from its own origin
 * (/u/script.js, see vercel.json).
 *
 * What the landing page sends (public/site.js, data-umami-event attributes): page views, CTA
 * clicks, `reach-<section>` once per visit for each section scrolled into view, and
 * `demo-watched`. Referrers come as full URLs where the referring site sends one (many send only
 * their origin: Reddit and Hacker News do), so threads are best told apart by UTM campaign.
 *
 * Days are UTC. Every request has a timeout; a failure is reported on the page, never thrown. The
 * page's extras (live visitors, countries, devices, browsers, systems, channels, hours) are read
 * the same way but are optional: one that fails is left empty instead of failing the page.
 */

export type UmamiConfig = NonNullable<HostedConfig["umami"]>;

/** Periods the Traffic page offers, in days. */
export const TRAFFIC_PERIODS = [7, 30] as const;
export type TrafficPeriod = (typeof TRAFFIC_PERIODS)[number];

/** A period from a query parameter: 7 or 30, else 7. */
export function trafficPeriod(raw: string | undefined): TrafficPeriod {
  return Number(raw) === 30 ? 30 : 7;
}

/** The prefix of the landing page's section events: `reach-pricing`. */
export const REACH_PREFIX = "reach-";

/** The landing page's sections in page order, as their reach events name them. */
export const SECTIONS = [
  "numbers",
  "how",
  "night-shift",
  "time",
  "agents",
  "use-cases",
  "why",
  "benchmarks",
  "pricing",
  "trust",
  "source",
  "faq",
  "end",
] as const;

export interface Count {
  name: string;
  count: number;
}

export interface TrafficReport {
  days: number;
  /** UTC days, oldest first. */
  daily: { day: string; visitors: number; pageviews: number }[];
  totals: { visitors: number; visits: number; pageviews: number; bounces: number };
  /** Referring pages as full URLs (where the referrer sent one), by visitors. */
  referrers: Count[];
  /** True when the referrer URLs were counted from only the newest events of a busy period. */
  referrersPartial: boolean;
  /** Referring sites (host only), by visitors. */
  referrerHosts: Count[];
  utmSources: Count[];
  utmCampaigns: Count[];
  /** Custom events other than section reach, by count. */
  events: Count[];
  /** Visits that reached each landing section, in page order. */
  reach: Count[];
  /** Visitors on the site in the last 5 minutes; null when Umami did not say. */
  live: number | null;
  /** Visitors by country (ISO 3166 alpha-2 code), most first. */
  countries: Count[];
  /** Visitors by device type (desktop, laptop, mobile, tablet), most first. */
  devices: Count[];
  browsers: Count[];
  os: Count[];
  /** Visits by Umami's channel (direct, organicSocial, organicSearch, referral, llm, ...). */
  channels: Count[];
  /** Visitors by UTC weekday (0 = Monday) and hour: 7 rows of 24. */
  hours: number[][];
}

const TIMEOUT_MS = 8_000;
const DAY_MS = 86_400_000;
/** The events listing is read in pages of this size, at most this many pages, for referrer URLs. */
const EVENT_PAGE = 500;
const EVENT_PAGES = 10;

type Fetch = typeof fetch;

/** A number from Umami: v3 sends plain numbers, v2 sent `{ value, prev }`. */
function num(v: unknown): number {
  if (v && typeof v === "object" && "value" in v) return num((v as { value: unknown }).value);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const counts = (data: unknown): Count[] =>
  Array.isArray(data)
    ? data
        .filter((r) => r && typeof r.x === "string" && r.x !== "")
        .map((r) => ({ name: r.x as string, count: num(r.y) }))
    : [];

/** The UTC days of a period ending today, oldest first. */
export function periodDays(days: number, now: Date): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/** A referrer as a full URL: host, path and query, without a trailing "/" alone. */
export function referrerUrl(domain: string, path?: string | null, query?: string | null): string {
  const p = path && path !== "/" ? path : "";
  const q = query ? `?${query.replace(/^\?/, "")}` : "";
  return `${domain}${p}${q}`.slice(0, 300);
}

/** The Traffic page's analytics for the last `days` days (UTC, today included). */
export async function umamiReport(
  cfg: UmamiConfig,
  days: number,
  now = new Date(),
  fetchImpl: Fetch = fetch,
): Promise<TrafficReport> {
  const dayList = periodDays(days, now);
  const startAt = Date.parse(`${dayList[0]}T00:00:00Z`);
  const endAt = now.getTime();
  const base = `${cfg.url}/api/websites/${encodeURIComponent(cfg.websiteId)}`;

  const get = async (path: string, params: Record<string, string | number> = {}) => {
    const q = new URLSearchParams({
      startAt: String(startAt),
      endAt: String(endAt),
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    });
    const res = await fetchImpl(`${base}${path}?${q}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Umami answered ${res.status} for ${path}`);
    return (await res.json()) as unknown;
  };
  const metric = (type: string, limit = 25) => get("/metrics", { type, limit }).then(counts);

  /** An extra the page can do without: empty when Umami fails or does not know it. */
  const extra = (type: string, limit = 25) => metric(type, limit).catch((): Count[] => []);

  const [stats, series, hosts, sources, campaigns, allEvents, refs, more] = await Promise.all([
    get("/stats") as Promise<Record<string, unknown>>,
    get("/pageviews", { unit: "day", timezone: "UTC" }) as Promise<Series>,
    metric("referrer"),
    metric("utmSource"),
    metric("utmCampaign"),
    metric("event", 100),
    referrerUrls(get),
    Promise.all([
      (get("/active") as Promise<{ visitors?: unknown } | null>).then(
        (a) => (a && "visitors" in a ? num(a.visitors) : null),
        () => null,
      ),
      extra("country", 250),
      extra("device", 10),
      extra("browser", 10),
      extra("os", 10),
      extra("channel", 20),
      (get("/pageviews", { unit: "hour", timezone: "UTC" }) as Promise<Series>).then(
        (h) => weekHours(h?.sessions),
        () => weekHours([]),
      ),
    ]),
  ]);
  const [live, countries, devices, browsers, os, channels, hours] = more;

  const byDay = (list: { x: string; y: unknown }[] | undefined) => {
    const m = new Map<string, number>();
    for (const p of list ?? []) {
      const d = String(p.x).slice(0, 10);
      m.set(d, (m.get(d) ?? 0) + num(p.y));
    }
    return m;
  };
  const views = byDay(series?.pageviews);
  const visitors = byDay(series?.sessions);
  const reachCounts = new Map(
    allEvents
      .filter((e) => e.name.startsWith(REACH_PREFIX))
      .map((e) => [e.name.slice(REACH_PREFIX.length), e.count]),
  );

  return {
    days,
    daily: dayList.map((day) => ({
      day,
      visitors: visitors.get(day) ?? 0,
      pageviews: views.get(day) ?? 0,
    })),
    totals: {
      visitors: num(stats?.visitors),
      visits: num(stats?.visits),
      pageviews: num(stats?.pageviews),
      bounces: num(stats?.bounces),
    },
    referrers: refs.list,
    referrersPartial: refs.partial,
    referrerHosts: hosts,
    utmSources: sources,
    utmCampaigns: campaigns,
    events: allEvents.filter((e) => !e.name.startsWith(REACH_PREFIX)).slice(0, 25),
    reach: SECTIONS.map((s) => ({ name: s, count: reachCounts.get(s) ?? 0 })),
    live,
    countries: countries.map((c) => ({ ...c, name: c.name.toUpperCase() })),
    devices,
    browsers,
    os,
    channels,
    hours,
  };
}

type Series = {
  pageviews?: { x: string; y: unknown }[];
  sessions?: { x: string; y: unknown }[];
};

/** Hourly points ("2026-10-15T13:00:00Z") summed by UTC weekday (0 = Monday) and hour. */
export function weekHours(points: { x: string; y: unknown }[] | undefined): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const p of points ?? []) {
    const at = Date.parse(`${String(p.x).slice(0, 13).replace(" ", "T")}:00:00Z`);
    if (Number.isNaN(at)) continue;
    const d = new Date(at);
    const row = grid[(d.getUTCDay() + 6) % 7]!;
    const h = d.getUTCHours();
    row[h] = (row[h] ?? 0) + num(p.y);
  }
  return grid;
}

/** Visitors on the site in the last 5 minutes, for the Traffic page's live counter. */
export async function liveVisitors(cfg: UmamiConfig, fetchImpl: Fetch = fetch): Promise<number> {
  const res = await fetchImpl(
    `${cfg.url}/api/websites/${encodeURIComponent(cfg.websiteId)}/active`,
    {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Umami answered ${res.status} for /active`);
  const body = (await res.json()) as { visitors?: unknown } | null;
  return num(body?.visitors);
}

/**
 * Referring pages as full URLs, by distinct visitors: Umami's metrics give only the referring
 * host, so this reads the period's events (newest first, up to 5,000) and counts the page views
 * that came from another site.
 */
async function referrerUrls(
  get: (path: string, params?: Record<string, string | number>) => Promise<unknown>,
): Promise<{ list: Count[]; partial: boolean }> {
  const visitors = new Map<string, Set<string>>();
  let partial = false;
  for (let page = 1; page <= EVENT_PAGES; page++) {
    const r = (await get("/events", { page, pageSize: EVENT_PAGE })) as {
      data?: {
        sessionId?: string;
        eventType?: number;
        referrerDomain?: string | null;
        referrerPath?: string | null;
        referrerQuery?: string | null;
      }[];
      count?: number;
    };
    const data = r?.data ?? [];
    for (const e of data) {
      if (e.eventType !== 1 || !e.referrerDomain) continue;
      const url = referrerUrl(e.referrerDomain, e.referrerPath, e.referrerQuery);
      const set = visitors.get(url) ?? new Set<string>();
      visitors.set(url, set);
      set.add(e.sessionId ?? `${page}:${visitors.size}`);
    }
    const seen = page * EVENT_PAGE;
    if (data.length < EVENT_PAGE || seen >= num(r?.count)) break;
    if (page === EVENT_PAGES) partial = true;
  }
  const list = [...visitors]
    .map(([name, s]) => ({ name, count: s.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 25);
  return { list, partial };
}
