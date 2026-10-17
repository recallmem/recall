import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { percent, type SourceRow } from "../../core/funnel.js";
import {
  type Count,
  type SECTIONS,
  TRAFFIC_PERIODS,
  type TrafficReport,
} from "../../core/traffic.js";
import { shortDay } from "./chart.js";
import { consoleHead, consoleTabs, shareCell } from "./console-views.js";
import { dashPath } from "./paths.js";
import {
  channelKind,
  channelSprite,
  coinSprite,
  countryName,
  deviceSprite,
  globeFrame,
  lockSprite,
  minerSprite,
  skyline,
  trophySprite,
  worldMap,
} from "./traffic-art.js";
import { table } from "./views.js";

/**
 * The console's Traffic page: the website's visitors from the self-hosted Umami (core/traffic.ts)
 * dressed up as an arcade night: a scoreboard with a live counter, a skyline of days, a warp-pipe
 * funnel from visit to first API call, a world map, an hour-by-weekday LED board, how deep
 * visitors scroll as a mine shaft, devices as a player select, referrers as high scores and
 * unlockable trophies. The plain tables (referring pages, UTM tags, events, sign-ups by source)
 * stay below for the numbers. Server-rendered; app.js only refreshes the live counter.
 */

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/** What the Traffic page could read from Umami. */
export type TrafficAnalytics =
  | { state: "off" }
  | { state: "error"; message: string }
  | { state: "ok"; report: TrafficReport };

const SECTION_LABELS: Record<(typeof SECTIONS)[number], string> = {
  numbers: "Benchmarks panel",
  how: "How it works",
  "night-shift": "Night shift",
  time: "Time",
  agents: "Integrations",
  "use-cases": "Use cases",
  why: "Why Recall",
  benchmarks: "Benchmarks",
  pricing: "Pricing",
  trust: "Trust",
  source: "Source",
  faq: "FAQ",
  end: "Closing call to action",
};
const sectionLabel = (s: string) => SECTION_LABELS[s as keyof typeof SECTION_LABELS] ?? s;

const CHANNEL_LABELS: Record<string, string> = {
  direct: "Direct",
  organicSocial: "Social",
  paidSocial: "Paid social",
  organicSearch: "Search",
  paidSearch: "Paid search",
  referral: "Referral",
  llm: "AI assistants",
  email: "Email",
  sms: "SMS",
  organicVideo: "Video",
  paidVideo: "Paid video",
  organicShopping: "Shopping",
  paidShopping: "Paid shopping",
  paidAds: "Ads",
  affiliate: "Affiliate",
};
/** Umami's channel key as words: "organicSocial" -> "Social", unknown ones split at capitals. */
const channelLabel = (c: string) =>
  CHANNEL_LABELS[c] ?? c.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (x) => x.toUpperCase());

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ORDINALS = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH", "9TH", "10TH"];

/** An arcade score: six digits, the leading zeros dimmed. */
function score(v: number): H {
  const digits = String(Math.max(0, Math.round(v)));
  const pad = Math.max(0, 6 - digits.length);
  return html`<span class="lead">${"0".repeat(pad)}</span>${digits}`;
}

/** A thin bar in a pixel well: `share` of the width, 0 to 100. */
function bar(share: number, label: string, cls = ""): H {
  const w = Math.max(0, Math.min(100, share));
  return html`<span class="pbar${cls ? ` ${cls}` : ""}" role="img" aria-label="${label}"><svg width="100%" height="8" aria-hidden="true" shape-rendering="crispEdges"><rect class="pb-track" width="100%" height="8"/><rect class="pb-fill" width="${w.toFixed(1)}%" height="8"/><rect fill="url(#pb-seg)" width="100%" height="8"/></svg></span>`;
}

const panelHead = (num: string, title: string, sub: string, id: string, tools: H | "" = "") =>
  html`<header class="panel-head"><span class="panel-no" aria-hidden="true">${num}</span><div><h2 id="${id}">${title}</h2><p class="panel-sub">${sub}</p></div>${tools}</header>`;

/** Flat map or globe: shown by app.js, which draws the globe (the flat map needs no script). */
const VIEW_TOGGLE = html`<div class="view-toggle" role="group" aria-label="Map view" hidden><button type="button" data-view="flat" aria-pressed="true">Flat</button><button type="button" data-view="globe" aria-pressed="false">Globe</button></div>`;

// ---------------------------------------------------------------------------
// Scoreboard

function scoreboard(r: TrafficReport): H {
  const t = r.totals;
  const best = r.daily.reduce(
    (b, d) => (d.visitors > b.visitors ? d : b),
    r.daily[0] ?? { day: "", visitors: 0 },
  );
  const live = r.live;
  return html`<div class="hud" role="group" aria-label="Scoreboard, last ${r.days} days">
  <div class="hud-cell"><span class="hud-k">Visitors</span><span class="hud-v">${score(t.visitors)}</span><span class="hud-s">unique, last ${r.days} days</span></div>
  <div class="hud-cell"><span class="hud-k">Visits</span><span class="hud-v">${score(t.visits)}</span><span class="hud-s">${percent(t.bounces, t.visits)} bounced</span></div>
  <div class="hud-cell"><span class="hud-k">Page views</span><span class="hud-v">${score(t.pageviews)}</span><span class="hud-s">${t.visits ? (t.pageviews / t.visits).toFixed(1) : "0"} a visit</span></div>
  <div class="hud-cell hi"><span class="hud-k">Hi-score</span><span class="hud-v">${score(best.visitors)}</span><span class="hud-s">${best.visitors ? `best day, ${shortDay(best.day)}` : "no visitors yet"}</span></div>
  <div class="hud-cell live${live ? " on" : ""}" data-live-url="${dashPath("/admin/traffic/live")}"><span class="hud-k"><span class="led" aria-hidden="true"></span>Live</span><span class="hud-v" data-live aria-live="polite">${live == null ? "–" : n(live)}</span><span class="hud-s">on the site now<svg class="ekg" viewBox="0 0 60 12" aria-hidden="true" shape-rendering="crispEdges"><polyline points="0,8 18,8 21,8 23,2 25,11 27,6 29,8 60,8"/></svg></span></div>
</div>`;
}

// ---------------------------------------------------------------------------
// Skyline of days

function city(r: TrafficReport): H {
  const unit = (v: number) => plural(v, "visitor", "visitors");
  const labelEvery = r.days <= 7 ? 1 : 5;
  const axis = r.daily.map((d, i) =>
    i % labelEvery === 0 || i === r.daily.length - 1
      ? html`<span>${shortDay(d.day)}</span>`
      : html`<span></span>`,
  );
  return html`<section class="panel city" aria-labelledby="t-city">
${panelHead("01", "Night city", "One building per day: the more visitors, the taller it stands and the more windows are lit. The crown marks the best day, the searchlights today. Hover a building for its numbers.", "t-city")}
<div class="city-frame">${skyline(r.daily, unit)}</div>
<div class="city-axis n${r.days}" aria-hidden="true">${axis}</div>
<details class="as-table"><summary>Show as a table</summary>${table(
    ["Day", "Visitors", "Page views"],
    r.daily
      .slice()
      .reverse()
      .map(
        (d) =>
          html`<tr><td>${d.day}</td><td class="num">${n(d.visitors)}</td><td class="num">${n(d.pageviews)}</td></tr>`,
      ),
  )}</details>
</section>`;
}

// ---------------------------------------------------------------------------
// Warp pipes: visit to first API call

function pipeline(r: TrafficReport, sources: SourceRow[]): H {
  const ev = (name: string) => r.events.find((e) => e.name === name)?.count ?? 0;
  const pricing = r.reach.find((x) => x.name === "pricing")?.count ?? 0;
  const signups = sources.reduce((s, x) => s + x.signups, 0);
  const calls = sources.reduce((s, x) => s + x.apiCalls, 0);
  const stages: { k: string; v: number; note: string; coin?: boolean }[] = [
    { k: "Visits", v: r.totals.visits, note: "on the site" },
    { k: "Saw pricing", v: pricing, note: "scrolled to it" },
    { k: "Clicked Get API key", v: ev("get-api-key"), note: "clicks" },
    { k: "Signed up", v: signups, note: "self-serve", coin: true },
    { k: "First API call", v: calls, note: "key or app used" },
  ];
  const cells: H[] = [];
  stages.forEach((s, i) => {
    if (i > 0) {
      const prev = stages[i - 1]!.v;
      const flow = s.v > 0;
      cells.push(
        html`<div class="pipe ${flow ? "flow" : "clog"}" aria-hidden="true"><span class="pipe-pct">${percent(s.v, prev)}</span></div>`,
      );
    }
    cells.push(
      html`<div class="stage${s.v ? "" : " nil"}"><span class="stage-v">${s.coin ? coinSprite() : ""}${n(s.v)}</span><span class="stage-k">${s.k}</span><span class="stage-s">${s.note}${i > 0 && stages[i - 1]!.v > 0 ? html`, ${percent(s.v, stages[i - 1]!.v)} of the step before` : ""}</span></div>`,
    );
  });
  return html`<section class="panel warp" aria-labelledby="t-warp">
${panelHead("02", "Warp pipes", "From a visit to a first API call. Pipes flow while people get through and clog where nobody does. Sign-ups and API calls come from Recall's own database.", "t-warp")}
<div class="pipeline">${cells}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// Planet: countries

function planet(r: TrafficReport): H {
  const located = r.countries.filter((c) => c.count > 0);
  const total = located.reduce((s, c) => s + c.count, 0);
  const top = located.slice(0, 8);
  const rest = located.length - top.length;
  return html`<section class="panel planet" aria-labelledby="t-planet">
${panelHead("03", "Planet Recall", located.length ? `Visitors from ${plural(located.length, "country", "countries")}. Brighter, bigger markers mean more visitors; the busiest ones ping.` : "Where visitors come from, once Umami has located some.", "t-planet", VIEW_TOGGLE)}
<div class="planet-grid">
  <div class="map-stage" data-map><div class="map-frame" data-view-pane="flat">${worldMap(r.countries)}</div>${globeFrame(r.countries)}</div>
  ${
    top.length
      ? html`<ol class="toplist">${top.map(
          (c) =>
            html`<li><span class="cc">${c.name}</span><span class="tl-name">${countryName(c.name)}</span><span class="tl-v">${n(c.count)}</span>${bar((c.count / Math.max(1, top[0]!.count)) * 100, `${percent(c.count, total)} of located visitors`)}</li>`,
        )}${rest > 0 ? html`<li class="more">+ ${plural(rest, "more country", "more countries")}</li>` : ""}</ol>`
      : html`<p class="muted">No countries yet.</p>`
  }
</div>
</section>`;
}

// ---------------------------------------------------------------------------
// LED board: hour by weekday

function ledBoard(r: TrafficReport): H {
  const max = Math.max(0, ...r.hours.flat());
  let peak = { d: 0, h: 0, v: 0 };
  for (const [d, row] of r.hours.entries())
    for (const [h, v] of row.entries()) if (v > peak.v) peak = { d, h, v };
  const level = (v: number) => (v <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((v / max) * 5)));
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const cells = r.hours.map(
    (row, d) =>
      html`<span class="led-day">${WEEKDAYS[d]}</span>${row.map(
        (v, h) =>
          html`<span class="led q${level(v)}${peak.v && d === peak.d && h === peak.h ? " peak" : ""}" title="${WEEKDAYS[d]} ${hh(h)} UTC: ${plural(v, "visitor", "visitors")}"></span>`,
      )}`,
  );
  const hours = Array.from({ length: 24 }, (_, h) =>
    h % 3 === 0
      ? html`<span class="lh">${String(h).padStart(2, "0")}</span>`
      : html`<span class="lh"></span>`,
  );
  return html`<section class="panel" aria-labelledby="t-led">
${panelHead("04", "Rush hour", peak.v ? `Busiest: ${WEEKDAYS[peak.d]} around ${hh(peak.h)} UTC. Each light is an hour of a weekday, summed over the period.` : "Visitors by weekday and hour (UTC), once there are some.", "t-led")}
<div class="led-board" role="img" aria-label="Visitors by weekday and hour, UTC${peak.v ? `; busiest ${WEEKDAYS[peak.d]} ${hh(peak.h)}` : ""}">${cells}<span class="lh"></span>${hours}</div>
<p class="led-key" aria-hidden="true"><span>fewer</span><span class="led q1"></span><span class="led q2"></span><span class="led q3"></span><span class="led q4"></span><span class="led q5"></span><span>more</span></p>
</section>`;
}

function channels(r: TrafficReport): H {
  const total = r.channels.reduce((s, c) => s + c.count, 0);
  return html`<section class="panel" aria-labelledby="t-chan">
${panelHead("05", "Spawn points", "How visits arrived, as Umami sorts them: typed or bookmarked, social, search, AI assistants, links from other sites.", "t-chan")}
${
  r.channels.length
    ? html`<ul class="spawns">${r.channels
        .slice(0, 9)
        .map(
          (c) =>
            html`<li class="spawn k-${channelKind(c.name)}">${channelSprite(c.name)}<span class="spawn-k">${channelLabel(c.name)}</span><span class="spawn-v">${n(c.count)} <span class="spawn-s">${percent(c.count, total)}</span></span></li>`,
        )}</ul>`
    : html`<p class="muted">No visits yet.</p>`
}
</section>`;
}

// ---------------------------------------------------------------------------
// The descent: scroll reach as a mine shaft

function descent(reach: Count[], visits: number): H {
  let median = -1;
  reach.forEach((f, i) => {
    if (visits > 0 && f.count / visits >= 0.5) median = i;
  });
  return html`<section class="panel" aria-labelledby="t-shaft">
${panelHead("06", "The descent", "The landing page as a mine shaft, one floor per section: how many visits got that deep. Each floor counts once per visit.", "t-shaft")}
<ol class="shaft">${reach.map((f, i) => {
    const share = visits > 0 ? Math.min(100, (f.count / visits) * 100) : 0;
    return html`<li class="floor${i === median ? " median" : ""}"><span class="fl">B${String(i + 1).padStart(2, "0")}</span><span class="fn">${sectionLabel(f.name)}</span>${bar(share, `${Math.round(share)}% of visits`, "hp")}<span class="fv">${n(f.count)} <span class="faint">${percent(f.count, visits)}</span></span>${
      i === median
        ? html`<span class="miner-tag">${minerSprite()}<span>Half the visits make it this far</span></span>`
        : ""
    }</li>`;
  })}</ol>
</section>`;
}

// ---------------------------------------------------------------------------
// Player select: devices, browsers, systems

function players(r: TrafficReport): H {
  const total = r.devices.reduce((s, d) => s + d.count, 0);
  const loot = (title: string, rows: Count[]) =>
    html`<div class="loot"><h3>${title}</h3>${
      rows.length
        ? html`<ol>${rows.slice(0, 5).map((x) => html`<li><span>${x.name}</span><span class="num">${n(x.count)}</span></li>`)}</ol>`
        : html`<p class="muted small">None yet.</p>`
    }</div>`;
  return html`<section class="panel" aria-labelledby="t-players">
${panelHead("07", "Player select", "What visitors play on.", "t-players")}
${
  r.devices.length
    ? html`<ul class="players">${r.devices
        .slice(0, 4)
        .map(
          (d, i) =>
            html`<li class="player${i === 0 ? " p1" : ""}">${i === 0 ? html`<span class="ptag">P1</span>` : ""}${deviceSprite(d.name)}<span class="pn">${d.name}</span><span class="pv">${n(d.count)}</span><span class="ps">${percent(d.count, total)}</span></li>`,
        )}</ul>`
    : html`<p class="muted">No visitors yet.</p>`
}
<div class="loots">${loot("Browsers", r.browsers)}${loot("Systems", r.os)}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// High scores: referring sites

function highScores(r: TrafficReport): H {
  const rows = r.referrerHosts.slice(0, 10);
  return html`<section class="panel arcade" aria-labelledby="t-hi">
${panelHead("08", "High scores", "Sites that sent visitors, by visitors.", "t-hi")}
${
  rows.length
    ? html`<ol class="hiscore">${rows.map(
        (x, i) =>
          html`<li class="r${i + 1}"><span class="rk">${ORDINALS[i]}</span><span class="nm">${x.name}</span><span class="dots" aria-hidden="true"></span><span class="sc">${score(x.count)}</span></li>`,
      )}</ol>`
    : html`<p class="hiscore-empty">INSERT COIN<span class="blink" aria-hidden="true">_</span><span class="sr"> No referring sites yet.</span></p>`
}
</section>`;
}

// ---------------------------------------------------------------------------
// Trophy room

interface Trophy {
  title: string;
  how: string;
  value: number;
  target: number;
}

export function trophies(r: TrafficReport, sources: SourceRow[]): Trophy[] {
  const hostSum = (test: (h: string) => boolean) =>
    r.referrerHosts.filter((x) => test(x.name.toLowerCase())).reduce((s, x) => s + x.count, 0);
  const utm = (test: (h: string) => boolean) =>
    r.utmSources.filter((x) => test(x.name.toLowerCase())).reduce((s, x) => s + x.count, 0);
  const peak = Math.max(0, ...r.daily.map((d) => d.visitors));
  const countries = r.countries.filter((c) => c.count > 0).length;
  const reddit = Math.max(
    hostSum((h) => h.includes("reddit")),
    utm((s) => s.includes("reddit")),
  );
  const hn = Math.max(
    hostSum((h) => h.includes("ycombinator")),
    utm((s) => s === "hn" || s.includes("hackernews")),
  );
  const llm = Math.max(
    r.channels.find((c) => c.name === "llm")?.count ?? 0,
    hostSum((h) => /chatgpt|openai|perplexity|claude\.ai|gemini|copilot/.test(h)),
  );
  const hoursCovered = Array.from({ length: 24 }, (_, h) =>
    r.hours.some((row) => (row[h] ?? 0) > 0),
  ).filter(Boolean).length;
  const ev = (name: string) => r.events.find((e) => e.name === name)?.count ?? 0;
  const deep = r.reach.find((x) => x.name === "end")?.count ?? 0;
  const signups = sources.reduce((s, x) => s + x.signups, 0);
  const calls = sources.reduce((s, x) => s + x.apiCalls, 0);
  return [
    { title: "First contact", how: "A visitor shows up", value: r.totals.visitors, target: 1 },
    { title: "Crowd", how: "100 visitors in one day", value: peak, target: 100 },
    { title: "Hug of death", how: "1,000 visitors in one day", value: peak, target: 1000 },
    { title: "Globetrotter", how: "Visitors from 10 countries", value: countries, target: 10 },
    { title: "World tour", how: "Visitors from 50 countries", value: countries, target: 50 },
    { title: "Reddit hug", how: "100 visitors from Reddit", value: reddit, target: 100 },
    { title: "Front page", how: "A visitor from Hacker News", value: hn, target: 1 },
    { title: "Robot friends", how: "A visit sent by an AI assistant", value: llm, target: 1 },
    {
      title: "Never sleeps",
      how: "Visitors in every hour of the day",
      value: hoursCovered,
      target: 24,
    },
    { title: "Deep diver", how: "25 visits read to the very end", value: deep, target: 25 },
    {
      title: "Demo junkie",
      how: "The demo watched 10 times",
      value: ev("demo-watched"),
      target: 10,
    },
    { title: "First coin", how: "A self-serve sign-up", value: signups, target: 1 },
    { title: "Coin purse", how: "10 sign-ups", value: signups, target: 10 },
    { title: "Hello, world", how: "A sign-up makes an API call", value: calls, target: 1 },
  ];
}

function trophyRoom(r: TrafficReport, sources: SourceRow[]): H {
  const list = trophies(r, sources);
  const won = list.filter((t) => t.value >= t.target).length;
  return html`<section class="panel" aria-labelledby="t-trophy">
${panelHead("09", "Trophy room", `${won} of ${list.length} unlocked in the last ${r.days} days.`, "t-trophy")}
<ul class="trophies">${list.map((t) => {
    const on = t.value >= t.target;
    return html`<li class="trophy-card ${on ? "on" : "off"}">${on ? trophySprite() : lockSprite()}<span class="tt">${t.title}</span><span class="th">${t.how}</span>${
      on
        ? html`<span class="tstamp">Unlocked</span>`
        : html`${bar((t.value / t.target) * 100, `${n(t.value)} of ${n(t.target)}`)}<span class="tp">${n(t.value)} / ${n(t.target)}</span>`
    }</li>`;
  })}</ul>
</section>`;
}

// ---------------------------------------------------------------------------
// The logbook: the plain tables

function countTable(
  title: string,
  column: string,
  rows: Count[],
  unit: string,
  empty: string,
  url = false,
): H {
  return html`<section><h3>${title}</h3>${table(
    [column, unit],
    rows.map(
      (r) =>
        html`<tr><td${url ? html` class="url"` : ""}>${r.name}</td><td class="num">${n(r.count)}</td></tr>`,
    ),
    empty,
  )}</section>`;
}

function logbook(r: TrafficReport): H {
  return html`<section class="logbook" aria-labelledby="t-log">
<h2 id="t-log">Logbook</h2>
<h3>Referring pages</h3>
${table(
  ["Referring page", "Visitors"],
  r.referrers.map(
    (x) => html`<tr><td class="url">${x.name}</td><td class="num">${n(x.count)}</td></tr>`,
  ),
  "No visits from other sites in this period.",
)}
<p class="muted small">Full URLs where the referring site sends one; Reddit, Hacker News and most social sites send only their domain, so make a tagged link for each post on the <a href="${dashPath("/admin/links")}">Links</a> page to tell threads apart.${r.referrersPartial ? " Counted from the newest 5,000 events of this period." : ""}</p>
<div class="split">
  ${countTable("UTM sources", "Source", r.utmSources, "Visitors", "No UTM-tagged visits.", true)}
  ${countTable("UTM campaigns", "Campaign", r.utmCampaigns, "Visitors", "No UTM campaigns.", true)}
  ${countTable("Top events", "Event", r.events, "Count", "No events yet.")}
  ${countTable(
    "Countries",
    "Country",
    r.countries.map((c) => ({ name: `${countryName(c.name)} (${c.name})`, count: c.count })),
    "Visitors",
    "No countries yet.",
  )}
</div>
</section>`;
}

// ---------------------------------------------------------------------------
// The page

function analyticsBlock(a: TrafficAnalytics, sources: SourceRow[]): H {
  if (a.state === "off")
    return html`<div class="card"><p><strong>Website analytics is not configured.</strong></p>
<p class="muted">Set <code>UMAMI_URL</code>, <code>UMAMI_WEBSITE_ID</code> and <code>UMAMI_API_KEY</code> on this server to show visitors, referrers, campaigns and landing-page events here, read from your self-hosted Umami. Sign-ups by source below work without it.</p></div>`;
  if (a.state === "error")
    return html`<p class="error" role="alert">Could not read Umami: ${a.message}. Sign-ups by source below come from Recall's own database.</p>`;
  const r = a.report;
  return html`<div class="arcade-page">
<svg class="defs" width="0" height="0" aria-hidden="true"><defs><pattern id="pb-seg" width="6" height="8" patternUnits="userSpaceOnUse"><rect class="pb-gap" x="5" width="1" height="8"/></pattern><linearGradient id="wm-sweep"><stop offset="0" stop-color="#ffb000" stop-opacity="0"/><stop offset="1" stop-color="#ffb000" stop-opacity=".18"/></linearGradient></defs></svg>
${scoreboard(r)}
${city(r)}
${pipeline(r, sources)}
${planet(r)}
<div class="duo">${ledBoard(r)}${channels(r)}</div>
<div class="duo">${descent(r.reach, r.totals.visits)}${players(r)}</div>
${highScores(r)}
${trophyRoom(r, sources)}
${logbook(r)}
</div>`;
}

export function trafficPage(d: {
  days: number;
  analytics: TrafficAnalytics;
  sources: SourceRow[];
}): H {
  const period = (days: number) =>
    html`<a href="${dashPath(`/admin/traffic?days=${days}`)}"${days === d.days ? html` aria-current="page"` : ""}>Last ${days} days</a>`;
  const signups = d.sources.reduce((s, r) => s + r.signups, 0);
  const calls = d.sources.reduce((s, r) => s + r.apiCalls, 0);
  return html`${consoleHead("Traffic", "Website visitors from the self-hosted, cookieless Umami, and self-serve sign-ups by where they came from. Days and hours are UTC.")}
${consoleTabs("traffic")}
<div class="filters"><nav class="segmented" aria-label="Period">${TRAFFIC_PERIODS.map(period)}</nav></div>
${analyticsBlock(d.analytics, d.sources)}
<h2>Sign-ups by source</h2>
${table(
  ["Source", "Campaign", "Sign-ups", "First API call"],
  [
    ...d.sources.map(
      (r) =>
        html`<tr><td class="url">${r.source ?? html`<span class="faint">unknown</span>`}</td><td class="url">${r.campaign ?? "—"}</td><td class="num">${n(r.signups)}</td>${shareCell(r.apiCalls, r.signups)}</tr>`,
    ),
    ...(d.sources.length > 1
      ? [
          html`<tr><td><strong>All sources</strong></td><td></td><td class="num">${n(signups)}</td>${shareCell(calls, signups)}</tr>`,
        ]
      : []),
  ],
  "No self-serve sign-ups in this period.",
)}
<p class="muted small">Self-serve sign-ups of the last ${d.days} days (test and operator-created accounts left out, as in the funnel). The source is the visit's UTM source, else the referring site, passed from the landing page to the sign-in page by its links; unknown for direct visits and for sign-ups from before sources were recorded. First API call: an API key or connected app used at least once.</p>
`;
}
