import { sql } from "drizzle-orm";
import { type Config, dashboardLink } from "../config.js";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import {
  FUNNEL_STEPS,
  type Funnel,
  type FunnelGroup,
  formatDuration,
  funnel,
  percent,
  STEP_LABELS,
  signupsByLink,
  testEmails,
} from "./funnel.js";
import { linkVisitors, listLinks } from "./links.js";
import { type Count, umamiReport } from "./traffic.js";

/**
 * The weekly activation-funnel email to the operator: once a week, from Monday 08:00
 * Europe/Amsterdam, the funnel of the last 7 days and the last 30 days by sign-up week (numbers
 * only: no names or addresses), with a link to the console's Funnel page. With Umami configured
 * it also carries the week's website traffic (visitors, top referring sites and campaigns, "Get
 * API key" clicks) and the tagged link that did best; when Umami cannot be read the email goes
 * out without that part. It goes to
 * RECALL_ALERT_EMAIL, else to every RECALL_OPERATOR_EMAILS address; RECALL_FUNNEL_REPORT_ENABLED=false
 * turns it off. Needs the dashboard (hosted mode with RECALL_PUBLIC_URL).
 *
 * Checked by the worker every 10 minutes (`startFunnelReports`) and by the serverless tick every
 * minute. A week is claimed in `operator_reports` (INSERT ... ON CONFLICT DO NOTHING) before the
 * email is built, so of several workers or instances exactly one sends it; a claim whose email
 * reached nobody is given back, so the next check tries again. A check after Monday 08:00 that
 * finds the week unsent (the service was down) sends it late, within the same week.
 */

type Deps = Pick<AppContext, "config" | "db" | "log" | "mailer">;

export const FUNNEL_REPORT = "funnel_weekly";
const TIME_ZONE = "Europe/Amsterdam";
const SEND_HOUR = 8;
const CHECK_EVERY_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** The week a report is known to be handled for, per database handle (skips the claim query). */
const handled = new WeakMap<object, string>();

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const local = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

/**
 * The report week `now` falls in, in Amsterdam time: its Monday (YYYY-MM-DD), and whether that
 * Monday's 08:00 has passed (the report is due).
 */
export function reportWeek(now: Date): { week: string; due: boolean } {
  const p = Object.fromEntries(local.formatToParts(now).map((x) => [x.type, x.value]));
  const sinceMonday = WEEKDAYS.indexOf(p.weekday ?? "");
  if (sinceMonday < 0) throw new Error(`unexpected weekday ${p.weekday}`);
  const today = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const week = new Date(today - sinceMonday * DAY_MS).toISOString().slice(0, 10);
  return { week, due: sinceMonday > 0 || Number(p.hour) >= SEND_HOUR };
}

/** Who gets the report: the alert address, else the console's operators. */
export function funnelReportRecipients(config: Pick<Config, "hosted">): string[] {
  const h = config.hosted;
  return h.email.alertTo ? [h.email.alertTo.toLowerCase()] : h.operatorEmails;
}

export type FunnelReportOutcome = "off" | "not_due" | "already_sent" | "sent" | "failed";

/** Sends this week's report if it is due and nobody has sent it yet. */
export async function sendWeeklyFunnelReport(
  ctx: Deps,
  now = new Date(),
): Promise<FunnelReportOutcome> {
  const hosted = ctx.config.hosted;
  if (!hosted.dashboard || !hosted.funnelReport) return "off";
  const to = funnelReportRecipients(ctx.config);
  if (!to.length) return "off";
  const { week, due } = reportWeek(now);
  if (!due) return "not_due";
  if (handled.get(ctx.db) === week) return "already_sent";

  const claimed = await rows<{ report: string }>(
    ctx.db,
    sql`INSERT INTO operator_reports (report, period) VALUES (${FUNNEL_REPORT}, ${week})
        ON CONFLICT DO NOTHING RETURNING report`,
  );
  if (!claimed.length) {
    handled.set(ctx.db, week);
    return "already_sent";
  }
  const release = () =>
    ctx.db
      .execute(
        sql`DELETE FROM operator_reports WHERE report = ${FUNNEL_REPORT} AND period = ${week}`,
      )
      .catch((err) => ctx.log.error({ err }, "could not release the weekly funnel report"));

  let mail: { subject: string; text: string; html: string };
  try {
    const emails = testEmails(hosted);
    const [last7, last30] = await Promise.all([
      funnel(ctx.db, { days: 7, now, testEmails: emails, recent: 0 }),
      funnel(ctx.db, { days: 30, now, testEmails: emails, recent: 0 }),
    ]);
    mail = renderFunnelReport({
      week,
      last7,
      last30,
      consoleUrl: dashboardLink(ctx.config, "/admin/funnel?days=30"),
      traffic: await trafficSummary(ctx, now, emails),
      trafficUrl: dashboardLink(ctx.config, "/admin/traffic"),
    });
  } catch (err) {
    await release();
    ctx.log.error({ err }, "could not build the weekly funnel report");
    return "failed";
  }

  let delivered = 0;
  for (const address of to) {
    try {
      await ctx.mailer.send({ to: address, ...mail });
      delivered++;
    } catch (err) {
      ctx.log.error({ err }, "could not send the weekly funnel report");
    }
  }
  if (!delivered) {
    await release();
    return "failed";
  }
  handled.set(ctx.db, week);
  ctx.log.info({ week, recipients: delivered }, "weekly funnel report sent");
  return "sent";
}

/** The week's website traffic for the email, if Umami is configured; null when it is not or fails. */
export interface TrafficSummary {
  visitors: number;
  visits: number;
  pageviews: number;
  topSites: Count[];
  topCampaigns: Count[];
  apiKeyClicks: number;
  /** The live tagged link with the most sign-ups since it was made (visitors break ties). */
  bestLink: { source: string; campaign: string; signups: number; visitors: number | null } | null;
}

async function trafficSummary(
  ctx: Deps,
  now: Date,
  emails: string[],
): Promise<TrafficSummary | null> {
  const umami = ctx.config.hosted.umami;
  if (!umami) return null;
  try {
    const r = await umamiReport(umami, 7, now);
    const links = (await listLinks(ctx.db)).slice(0, 25);
    const [signups, visitors] = await Promise.all([
      signupsByLink(ctx.db, { testEmails: emails }),
      linkVisitors(umami, links, now),
    ]);
    const ranked = links
      .map((l) => ({
        source: l.source,
        campaign: l.campaign,
        signups: signups.get(l.id)?.signups ?? 0,
        visitors: visitors.get(l.id) ?? null,
      }))
      .filter((l) => l.signups > 0 || (l.visitors ?? 0) > 0)
      .sort((a, b) => b.signups - a.signups || (b.visitors ?? 0) - (a.visitors ?? 0));
    return {
      visitors: r.totals.visitors,
      visits: r.totals.visits,
      pageviews: r.totals.pageviews,
      topSites: r.referrerHosts.slice(0, 3),
      topCampaigns: r.utmCampaigns.slice(0, 3),
      apiKeyClicks: r.events.find((e) => e.name === "get-api-key")?.count ?? 0,
      bestLink: ranked[0] ?? null,
    };
  } catch (err) {
    ctx.log.warn({ err }, "weekly funnel report: website traffic left out");
    return null;
  }
}

/** Checks for the weekly report every few minutes (worker processes); returns a stop function. */
export function startFunnelReports(ctx: Deps): () => Promise<void> {
  const h = ctx.config.hosted;
  if (!h.dashboard || !h.funnelReport) return async () => {};
  const check = () =>
    void sendWeeklyFunnelReport(ctx).catch((err) =>
      ctx.log.error({ err }, "weekly funnel report check failed"),
    );
  const timer = setInterval(check, CHECK_EVERY_MS);
  timer.unref?.();
  check();
  return async () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// The email

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v: number) => v.toLocaleString("en-US");
const STEPS = FUNNEL_STEPS.filter((s) => s !== "signed_up");
const SHORT: Record<string, string> = {
  connected: "Key/app",
  message: "Message",
  answer: "Answer",
  topup: "Top-up",
  active: "Active",
};

function stepLines(g: FunnelGroup): string[] {
  return [
    `  ${STEP_LABELS.signed_up.padEnd(22)}${num(g.signups).padStart(6)}`,
    ...STEPS.map(
      (s) =>
        `  ${STEP_LABELS[s].padEnd(22)}${num(g.reached[s]).padStart(6)}  ${percent(g.reached[s], g.signups).padStart(4)}`,
    ),
    `  Median time from sign-up to first answer: ${formatDuration(g.medianAnswerMs)}`,
  ];
}

/** The traffic part of the email, as lines of text (the HTML shows the same lines). */
function trafficLines(t: TrafficSummary): string[] {
  const list = (rows: Count[]) =>
    rows.length ? rows.map((r) => `${r.name} (${num(r.count)})`).join(", ") : "none yet";
  return [
    `Visitors: ${num(t.visitors)} (${num(t.visits)} visits, ${num(t.pageviews)} page views).`,
    `Top referring sites: ${list(t.topSites)}.`,
    `Top campaigns: ${list(t.topCampaigns)}.`,
    `"Get API key" clicks: ${num(t.apiKeyClicks)}.`,
    t.bestLink
      ? `Best tagged link: ${t.bestLink.source} / ${t.bestLink.campaign}, ${num(t.bestLink.signups)} sign-up${t.bestLink.signups === 1 ? "" : "s"}${t.bestLink.visitors == null ? "" : ` and ${num(t.bestLink.visitors)} visitor${t.bestLink.visitors === 1 ? "" : "s"}`} since it was made.`
      : "No tagged link has brought visitors yet.",
  ];
}

export function renderFunnelReport(d: {
  week: string;
  last7: Funnel;
  last30: Funnel;
  consoleUrl: string;
  traffic?: TrafficSummary | null;
  trafficUrl?: string;
}): { subject: string; text: string; html: string } {
  const w = d.last7.total;
  const subject = `Recall funnel, week of ${d.week}: ${num(w.signups)} sign-up${w.signups === 1 ? "" : "s"} in 7 days`;
  const left = d.last30.leftOut;
  const accounts = (count: number, kind: string) =>
    `${num(count)} ${kind} account${count === 1 ? "" : "s"}`;
  const leftLine = `Left out (last 30 days): ${accounts(left.operatorCreated, "operator-created")} and ${accounts(left.test, "test")}.`;
  const cols = ["Signed up", ...STEPS.map((s) => SHORT[s]!), "Median to answer"];
  const weekRows = [
    ...d.last30.weeks.map((g) => ({ label: g.key, g })),
    { label: "All 30 days", g: d.last30.total },
  ];

  const traffic = d.traffic ? trafficLines(d.traffic) : null;
  const text = [
    `Recall activation funnel, week of ${d.week}`,
    "",
    "Self-serve sign-ups in the last 7 days:",
    ...stepLines(w),
    "",
    ...(traffic
      ? [
          "Website, last 7 days:",
          ...traffic.map((l) => `  ${l}`),
          ...(d.trafficUrl ? [`  More: ${d.trafficUrl}`] : []),
          "",
        ]
      : []),
    "Last 30 days by sign-up week (UTC, from Monday), count and share of sign-ups:",
    `  ${"Week of".padEnd(12)}${cols.map((c) => c.padStart(c === "Median to answer" ? 18 : 12)).join("")}`,
    ...weekRows.map(
      ({ label, g }) =>
        `  ${label.padEnd(12)}${num(g.signups).padStart(12)}${STEPS.map((s) =>
          `${num(g.reached[s])} (${percent(g.reached[s], g.signups)})`.padStart(12),
        ).join("")}${formatDuration(g.medianAnswerMs).padStart(18)}`,
    ),
    "",
    leftLine,
    "Each step counts on its own, as of now. Active: an API key or connected app used, or a model call, in the last 7 days.",
    "",
    `Console: ${d.consoleUrl}`,
    "",
    "Sent once a week to the operator. Turn it off with RECALL_FUNNEL_REPORT_ENABLED=false.",
  ].join("\n");

  const cell = "padding:4px 10px;border-bottom:1px solid #ddd;text-align:right;";
  const head = "padding:4px 10px;border-bottom:2px solid #999;text-align:right;";
  const first = "padding:4px 10px;border-bottom:1px solid #ddd;text-align:left;";
  const summary = [
    `<tr><td style="${first}">${esc(STEP_LABELS.signed_up)}</td><td style="${cell}">${num(w.signups)}</td><td style="${cell}"></td></tr>`,
    ...STEPS.map(
      (s) =>
        `<tr><td style="${first}">${esc(STEP_LABELS[s])}</td><td style="${cell}">${num(w.reached[s])}</td><td style="${cell}">${percent(w.reached[s], w.signups)}</td></tr>`,
    ),
  ].join("\n");
  const byWeek = weekRows
    .map(
      ({ label, g }) =>
        `<tr><td style="${first}">${esc(label)}</td><td style="${cell}">${num(g.signups)}</td>${STEPS.map(
          (s) =>
            `<td style="${cell}">${num(g.reached[s])} (${percent(g.reached[s], g.signups)})</td>`,
        ).join("")}<td style="${cell}">${esc(formatDuration(g.medianAnswerMs))}</td></tr>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;background:#fff;">
<h1 style="font-size:18px;margin:0 0 16px;">Recall activation funnel, week of ${esc(d.week)}</h1>
<h2 style="font-size:15px;margin:16px 0 8px;">Self-serve sign-ups in the last 7 days</h2>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
${summary}
</table>
<p>Median time from sign-up to first answer: ${esc(formatDuration(w.medianAnswerMs))}</p>
${
  traffic
    ? `<h2 style="font-size:15px;margin:16px 0 8px;">Website, last 7 days</h2>
<ul style="margin:0;padding-left:18px;">${traffic.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
${d.trafficUrl ? `<p><a href="${esc(d.trafficUrl)}">Open Traffic in the console</a></p>` : ""}`
    : ""
}
<h2 style="font-size:15px;margin:16px 0 8px;">Last 30 days by sign-up week (UTC, from Monday)</h2>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr><th style="${head}text-align:left;">Week of</th>${cols.map((c) => `<th style="${head}">${esc(c)}</th>`).join("")}</tr>
${byWeek}
</table>
<p style="color:#555;">${esc(leftLine)} Each step counts on its own, as of now, as a share of the sign-ups. Active: an API key or connected app used, or a model call, in the last 7 days.</p>
<p><a href="${esc(d.consoleUrl)}">Open the funnel in the console</a></p>
<p style="color:#777;font-size:12px;">Sent once a week to the operator. Turn it off with RECALL_FUNNEL_REPORT_ENABLED=false.</p>
</body></html>`;
  return { subject, text, html };
}
