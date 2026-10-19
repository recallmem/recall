import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signupSourceOf } from "../src/core/signup-source.js";
import { referrerUrl, umamiReport, weekHours } from "../src/core/traffic.js";
import { rows } from "../src/db/client.js";
import { signState, verifyState } from "../src/http/dashboard/github.js";
import { trophies } from "../src/http/dashboard/traffic-views.js";
import { COUNTRY_AT, LAND, WORLD_COLS, WORLD_ROWS } from "../src/http/dashboard/world.js";
import { inlineScriptHashes, siteCsp } from "../src/http/security.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Website analytics and sign-up sources: the console's Traffic page (Umami stubbed), the source a
 * sign-up came from carried from the landing page's link through the emailed link and GitHub to
 * the account, and the site's CSP, which the self-hosted tracker must not loosen.
 */

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = (f: string) => readFileSync(join(SERVER, "public", f), "utf8");

const UMAMI = {
  UMAMI_URL: "https://stats.example.com/",
  UMAMI_WEBSITE_ID: "0b9a4c1e-6f3d-4a52-9d1e-2c7b8a9f0e11",
  UMAMI_API_KEY: "umami-test-key",
};

/**
 * Answers Umami's API the way v3 does, for the stubbed website; records the requests. With
 * `extras`, also the Traffic page's optional reads (live visitors, countries, devices, browsers,
 * systems, channels, hours); without, those answer 404 as an older Umami might.
 */
function stubUmami(opts: { status?: number; extras?: boolean } = {}) {
  const calls: { url: URL; auth: string | null }[] = [];
  const today = new Date().toISOString().slice(0, 10);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (opts.status) return new Response("nope", { status: opts.status });
      const path = url.pathname.replace(`/api/websites/${UMAMI.UMAMI_WEBSITE_ID}`, "");
      const type = url.searchParams.get("type");
      if (path === "/stats")
        return Response.json({
          pageviews: 640,
          visitors: 412,
          visits: 455,
          bounces: 300,
          totaltime: 9000,
        });
      if (opts.extras && path === "/active") return Response.json({ visitors: 7 });
      if (opts.extras && path === "/pageviews" && url.searchParams.get("unit") === "hour")
        return Response.json({
          pageviews: [],
          sessions: [
            { x: "2026-10-12T14:00:00Z", y: 30 }, // a Monday
            { x: "2026-10-13T09:00:00Z", y: 4 },
          ],
        });
      const extra: Record<string, { x: string; y: number }[]> = {
        country: [
          { x: "US", y: 200 },
          { x: "DE", y: 41 },
          { x: "ZZ", y: 1 },
        ],
        device: [
          { x: "desktop", y: 300 },
          { x: "mobile", y: 112 },
        ],
        browser: [{ x: "firefox", y: 99 }],
        os: [{ x: "Linux", y: 77 }],
        channel: [
          { x: "organicSocial", y: 300 },
          { x: "llm", y: 3 },
        ],
      };
      if (opts.extras && path === "/metrics" && type && extra[type])
        return Response.json(extra[type]);
      if (path === "/pageviews")
        return Response.json({
          pageviews: [{ x: `${today} 00:00:00`, y: 600 }],
          sessions: [{ x: `${today} 00:00:00`, y: 400 }],
        });
      if (path === "/metrics" && type === "referrer")
        return Response.json([{ x: "reddit.com", y: 300 }]);
      if (path === "/metrics" && type === "utmSource")
        return Response.json([{ x: "reddit", y: 120 }]);
      if (path === "/metrics" && type === "utmCampaign")
        return Response.json([{ x: "launch-thread", y: 120 }]);
      if (path === "/metrics" && type === "event")
        return Response.json([
          { x: "get-api-key", y: 31 },
          { x: "reach-pricing", y: 150 },
          { x: "reach-how", y: 380 },
          { x: "copy-setup-prompt", y: 12 },
        ]);
      if (path === "/events")
        return Response.json({
          data: [
            {
              sessionId: "s1",
              eventType: 1,
              referrerDomain: "reddit.com",
              referrerPath: "/r/LocalLLaMA/comments/abc/recall/",
            },
            {
              sessionId: "s2",
              eventType: 1,
              referrerDomain: "reddit.com",
              referrerPath: "/r/LocalLLaMA/comments/abc/recall/",
            },
            {
              sessionId: "s2",
              eventType: 1,
              referrerDomain: "reddit.com",
              referrerPath: "/r/LocalLLaMA/comments/abc/recall/",
            },
            {
              sessionId: "s3",
              eventType: 1,
              referrerDomain: "news.ycombinator.com",
              referrerPath: "/item",
              referrerQuery: "id=42",
            },
            { sessionId: "s3", eventType: 2, referrerDomain: "news.ycombinator.com" },
            { sessionId: "s4", eventType: 1, referrerDomain: "" },
          ],
          count: 6,
          page: 1,
          pageSize: 500,
        });
      return new Response("not stubbed", { status: 404 });
    }),
  );
  return calls;
}

const accountOf = async (s: HostedServer, email: string) =>
  (
    await rows<{ id: string; signup_source: string | null; signup_campaign: string | null }>(
      s.ctx.db,
      sql`SELECT a.id, a.signup_source, a.signup_campaign FROM accounts a
          JOIN account_members m ON m.account_id = a.id JOIN users u ON u.id = m.user_id
          WHERE u.email = ${email}`,
    )
  )[0];

let s: HostedServer;
let ops: Browser;
beforeAll(async () => {
  s = await createHostedServer({ env: { RECALL_OPERATOR_EMAILS: "ops@example.com", ...UMAMI } });
  ops = new Browser(s.app, "203.0.113.10");
  await ops.signIn(s, "ops@example.com");
}, 60_000);
afterAll(async () => {
  await s.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign-up source", () => {
  it("reads src and campaign, else UTM tags, else another site's Referer", () => {
    const own = ["recall.test", "app.recall.test"];
    expect(signupSourceOf({ src: "Reddit", campaign: "launch" }, undefined, own)).toEqual({
      source: "reddit",
      campaign: "launch",
    });
    expect(signupSourceOf({ utm_source: "hn", utm_campaign: "show" }, undefined, own)).toEqual({
      source: "hn",
      campaign: "show",
    });
    expect(signupSourceOf({}, "https://www.reddit.com/", own)).toEqual({
      source: "reddit.com",
      campaign: null,
    });
    expect(signupSourceOf({}, "https://recall.test/", own)).toBeNull();
    expect(signupSourceOf({}, "javascript:alert(1)", own)).toBeNull();
    // Cut to a short, printable tag.
    const long = signupSourceOf({ src: `<b>${"x".repeat(300)}\n` }, undefined, own)!;
    expect(long.source).toMatch(/^b?x+$/);
    expect(long.source.length).toBeLessThanOrEqual(100);
  });

  it("keeps the landing page's source through the emailed link and stores it on the account", async () => {
    const b = new Browser(s.app, "198.51.100.40");
    const page = await b.get("/app/login?src=reddit&campaign=launch-thread");
    expect(page.html).toContain('name="src" value="reddit"');
    expect(page.html).toContain('name="campaign" value="launch-thread"');
    await b.post("/app/login", {
      email: "reader@example.com",
      src: "reddit",
      campaign: "launch-thread",
    });
    const mail = s.mailer.outbox.filter((m) => m.to === "reader@example.com").at(-1)!;
    const token = new URL(mail.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    await b.get(`/app/auth/verify?token=${token}`);
    expect((await b.post("/app/auth/verify", { token })).res.status).toBe(303);
    expect(await accountOf(s, "reader@example.com")).toMatchObject({
      signup_source: "reddit",
      signup_campaign: "launch-thread",
    });
  });

  it("takes another site's Referer when the link carries nothing, and leaves existing accounts alone", async () => {
    const b = new Browser(s.app, "198.51.100.41");
    const res = await s.app.request("/app/login", {
      headers: {
        referer: "https://news.ycombinator.com/item?id=42",
        "x-forwarded-for": "198.51.100.41",
      },
    });
    expect(await res.text()).toContain('name="src" value="news.ycombinator.com"');
    // Signing in again from elsewhere does not rewrite where the account came from.
    await b.signIn(s, "reader@example.com");
    expect((await accountOf(s, "reader@example.com"))?.signup_source).toBe("reddit");
    // No source at all: null.
    await new Browser(s.app, "198.51.100.42").signIn(s, "direct@example.com");
    expect((await accountOf(s, "direct@example.com"))?.signup_source).toBeNull();
  });

  it("carries the source through GitHub's signed state", () => {
    const secret = Buffer.alloc(32, 7);
    const state = signState(secret, "b", null, Date.now(), false, {
      source: "reddit",
      campaign: "x",
    });
    expect(verifyState(secret, "b", state)?.source).toEqual({ source: "reddit", campaign: "x" });
    expect(verifyState(secret, "b", signState(secret, "b", null))?.source).toBeNull();
  });
});

describe("Traffic page", () => {
  it("is hidden from everyone but operators, like an unknown page", async () => {
    const cust = new Browser(s.app, "203.0.113.30");
    await cust.signIn(s, "cust@example.com");
    const unknown = await cust.get("/app/no-such-page");
    const r = await cust.get("/app/admin/traffic");
    expect(r.res.status).toBe(404);
    expect(r.html).toBe(unknown.html);
    expect((await new Browser(s.app).get("/app/admin/traffic")).res.status).toBe(404);
  });

  it("shows Umami's visitors, full referrer URLs, campaigns, events and scroll reach", async () => {
    const calls = stubUmami();
    const r = await ops.get("/app/admin/traffic?days=30");
    expect(r.res.status).toBe(200);
    const h = r.html;
    expect(h).toContain("Traffic");
    expect(h).toContain('href="/app/admin/traffic"');
    expect(h).toContain("412"); // visitors
    expect(h).toContain("640"); // page views
    expect(h).toContain("reddit.com/r/LocalLLaMA/comments/abc/recall/");
    expect(h).toContain("news.ycombinator.com/item?id=42");
    expect(h).toContain("launch-thread");
    expect(h).toContain("get-api-key");
    expect(h).not.toMatch(/<td>reach-pricing/);
    expect(h).toContain("Pricing");
    expect(h).toMatch(/How it works<\/span>[\s\S]*?<span class="fv">380 /);
    expect(h).not.toContain("style=");
    // Read server-side with the key, from the configured server and website, over 30 days.
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.url.origin).toBe("https://stats.example.com");
      expect(c.url.pathname.startsWith(`/api/websites/${UMAMI.UMAMI_WEBSITE_ID}/`)).toBe(true);
      expect(c.auth).toBe(`Bearer ${UMAMI.UMAMI_API_KEY}`);
    }
    const stats = calls.find((c) => c.url.pathname.endsWith("/stats"))!;
    const span =
      Number(stats.url.searchParams.get("endAt")) - Number(stats.url.searchParams.get("startAt"));
    expect(span).toBeGreaterThan(29 * 86_400_000);
    expect(span).toBeLessThanOrEqual(30 * 86_400_000);
    // The key never reaches the page.
    expect(h).not.toContain(UMAMI.UMAMI_API_KEY);
  });

  it("draws the arcade: a building per day, countries on the map, hours, devices, live visitors", async () => {
    stubUmami({ extras: true });
    const h = (await ops.get("/app/admin/traffic?days=30")).html;
    expect(h.match(/<g class="bld[ "]/g)).toHaveLength(30);
    expect(h).toContain('<svg class="skyline n30"');
    expect(h).toMatch(/<title>[A-Z][a-z]{2} \d+: 400 visitors, 600 page views<\/title>/);
    // Countries: placed by code, named in English; an unknown code stays off the map but is listed.
    expect(h).toContain("<title>Germany: 41 visitors</title>");
    expect(h).toContain('<span class="cc">US</span><span class="tl-name">United States</span>');
    // The globe: hidden until app.js draws it, fed the land cells and the countries as data.
    expect(h).toContain('<div class="view-toggle" role="group" aria-label="Map view" hidden>');
    expect(h).toContain('<div class="globe-frame" data-view-pane="globe" hidden>');
    const attr = (name: string) =>
      h
        .match(new RegExp(`<canvas class="globe"[^>]* ${name}="([^"]*)"`))![1]!
        .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
    expect(attr("data-land")).toHaveLength(WORLD_COLS * WORLD_ROWS);
    const points = JSON.parse(attr("data-points")) as [string, number, number, number, number][];
    expect(points.map((p) => p[0])).toEqual(["United States", "Germany"]);
    expect(points[1]![2]).toBeCloseTo(10.5, 0); // Germany's longitude
    expect(points[1]![3]).toBeCloseTo(51, 0);
    expect(h).not.toContain("<title>ZZ");
    // Monday 14:00 UTC is the busiest hour.
    expect(h).toContain("Busiest: Mon around 14:00 UTC");
    expect(h).toContain('title="Mon 14:00 UTC: 30 visitors"');
    expect(h).toMatch(/<span class="pn">desktop<\/span><span class="pv">300<\/span>/);
    expect(h).toContain("AI assistants");
    expect(h).toMatch(/data-live aria-live="polite">7</);
    expect(h).toContain('data-live-url="/app/admin/traffic/live"');
    // Referring sites as high scores, the funnel as pipes, trophies.
    expect(h).toMatch(/<span class="rk">1ST<\/span><span class="nm">reddit.com<\/span>/);
    expect(h).toContain("Clicked Get API key");
    expect(h).toContain("Robot friends");
    expect(h).not.toContain("style=");
  });

  it("leaves the extras empty when an older Umami does not answer them", async () => {
    stubUmami();
    const cfg = {
      url: "https://stats.example.com",
      websiteId: UMAMI.UMAMI_WEBSITE_ID,
      apiKey: "k",
    };
    const r = await umamiReport(cfg, 7);
    expect(r.live).toBeNull();
    expect(r.countries).toEqual([]);
    expect(r.devices).toEqual([]);
    expect(r.totals.visitors).toBe(412);
    const h = (await ops.get("/app/admin/traffic")).html;
    expect(h).toContain("No countries yet.");
    expect(h).toMatch(/data-live aria-live="polite">–</);
  });

  it("serves the live counter to operators only", async () => {
    stubUmami({ extras: true });
    const live = await ops.get("/app/admin/traffic/live");
    expect(live.res.status).toBe(200);
    expect(JSON.parse(live.html)).toEqual({ visitors: 7 });
    expect(live.res.headers.get("cache-control")).toBe("no-store");
    const cust = new Browser(s.app, "203.0.113.31");
    await cust.signIn(s, "cust2@example.com");
    expect((await cust.get("/app/admin/traffic/live")).res.status).toBe(404);
    // The page's script fetches it, so the dashboard allows same-origin connections (only).
    const page = await ops.get("/app/admin/traffic");
    expect(page.res.headers.get("content-security-policy")).toContain("connect-src 'self';");
    vi.unstubAllGlobals();
    stubUmami({ status: 500 });
    const down = await ops.get("/app/admin/traffic/live");
    expect(down.res.status).toBe(502);
    expect(JSON.parse(down.html)).toEqual({ visitors: null });
  });

  it("sums hourly visitors by UTC weekday and hour", () => {
    const g = weekHours([
      { x: "2026-10-12T14:00:00Z", y: 3 }, // Monday
      { x: "2026-10-19 14:00:00", y: "2" }, // the next Monday
      { x: "2026-10-18T23:00:00Z", y: 1 }, // Sunday
      { x: "nonsense", y: 9 },
    ]);
    expect(g).toHaveLength(7);
    expect(g[0]![14]).toBe(5);
    expect(g[6]![23]).toBe(1);
    expect(g.flat().reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("places countries on land in the generated world map", () => {
    expect(LAND).toHaveLength(WORLD_ROWS);
    for (const row of LAND) expect(row).toMatch(new RegExp(`^[#.]{${WORLD_COLS}}$`));
    for (const code of ["US", "BR", "DE", "IN", "CN", "AU", "ZA", "RU", "CA", "AR"]) {
      const [x, y] = COUNTRY_AT[code]!;
      expect(LAND[Math.floor(y)]![Math.floor(x)], code).toBe("#");
    }
  });

  it("unlocks trophies from the period's numbers", () => {
    const base = {
      days: 7,
      daily: [{ day: "2026-10-15", visitors: 120, pageviews: 300 }],
      totals: { visitors: 120, visits: 130, pageviews: 300, bounces: 50 },
      referrers: [],
      referrersPartial: false,
      referrerHosts: [{ name: "news.ycombinator.com", count: 3 }],
      utmSources: [{ name: "reddit", count: 140 }],
      utmCampaigns: [],
      events: [],
      reach: [],
      live: null,
      countries: [],
      devices: [],
      browsers: [],
      os: [],
      channels: [],
      hours: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
    };
    const won = trophies(base, [{ source: "reddit", campaign: null, signups: 1, apiCalls: 0 }])
      .filter((t) => t.value >= t.target)
      .map((t) => t.title);
    expect(won).toEqual(["First contact", "Crowd", "Reddit hug", "Front page", "First coin"]);
  });

  it("counts sign-ups and first API calls per source from Recall's database", async () => {
    stubUmami();
    const a = await accountOf(s, "reader@example.com");
    await s.ctx.db.execute(
      sql`INSERT INTO api_keys (id, account_id, name, key_hash, prefix, last_used_at)
          VALUES ('key_traffic', ${a!.id}, 'app', 'hash-traffic', 'pk_live_x', now())`,
    );
    const h = (await ops.get("/app/admin/traffic")).html;
    const section = h.slice(h.indexOf("Sign-ups by source"));
    expect(section).toMatch(
      /reddit<\/td><td class="url">launch-thread<\/td><td class="num">1<\/td><td class="num">1 /,
    );
    expect(section).toContain("unknown");
  });

  it("explains an Umami failure and still shows sign-ups by source", async () => {
    stubUmami({ status: 401 });
    const h = (await ops.get("/app/admin/traffic")).html;
    expect(h).toContain("Could not read Umami: Umami answered 401");
    expect(h).toContain("Sign-ups by source");
  });

  it("says analytics is not configured without the Umami settings", async () => {
    const plain = await createHostedServer({ env: { RECALL_OPERATOR_EMAILS: "ops@example.com" } });
    try {
      const b = new Browser(plain.app, "203.0.113.11");
      await b.signIn(plain, "ops@example.com");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const h = (await b.get("/app/admin/traffic")).html;
      expect(h).toContain("Website analytics is not configured");
      expect(h).toContain("UMAMI_API_KEY");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await plain.close();
    }
  });

  it("fills every day of the period and builds referrer URLs without a bare trailing slash", async () => {
    stubUmami();
    const cfg = {
      url: "https://stats.example.com",
      websiteId: UMAMI.UMAMI_WEBSITE_ID,
      apiKey: "k",
    };
    const r = await umamiReport(cfg, 7);
    expect(r.daily).toHaveLength(7);
    expect(r.daily.at(-1)).toMatchObject({ visitors: 400, pageviews: 600 });
    expect(r.referrers[0]).toEqual({
      name: "reddit.com/r/LocalLLaMA/comments/abc/recall/",
      count: 2,
    });
    expect(referrerUrl("reddit.com", "/")).toBe("reddit.com");
  });
});

describe("site analytics and CSP", () => {
  it("keeps the site's CSP: scripts and connections from its own origin only", () => {
    const vercel = JSON.parse(pub("../vercel.json")) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
      rewrites: { source: string; destination: string }[];
    };
    const csp = siteCsp(["home.html", "docs.html"].flatMap((f) => inlineScriptHashes(pub(f))));
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toMatch(/stats\.|umami|https:/);
    for (const rule of vercel.headers.filter(
      (r) => r.source === "/" || r.source.startsWith("/:page("),
    ))
      expect(rule.headers.find((h) => h.key === "Content-Security-Policy")?.value).toBe(csp);
    // The tracker and its endpoint come through this origin, ahead of the API's catch-all.
    const i = vercel.rewrites.findIndex((r) => r.source === "/u/script.js");
    const j = vercel.rewrites.findIndex((r) => r.source === "/u/api/send");
    const all = vercel.rewrites.findIndex((r) => r.source === "/(.*)");
    expect(vercel.rewrites[i]?.destination).toBe("https://stats.recallmem.dev/script.js");
    expect(vercel.rewrites[j]?.destination).toBe("https://stats.recallmem.dev/api/send");
    expect(i).toBeLessThan(all);
    expect(j).toBeLessThan(all);
  });

  it("tags the landing page's calls to action, and loads the tracker only from this origin", () => {
    const home = pub("home.html");
    for (const event of ["get-api-key", "copy-setup-prompt", "copy-plugin-command", "pricing-cta"])
      expect(home, event).toContain(`data-umami-event="${event}"`);
    for (const page of ["home.html", "docs.html", "privacy.html", "evals.html"]) {
      const tags = pub(page).match(/<script[^>]*\/u\/script\.js[^>]*>/g) ?? [];
      for (const t of tags) {
        expect(t).toContain('src="/u/script.js"');
        expect(t).toContain('data-host-url="/u"');
      }
    }
    const js = pub("site.js");
    expect(js).toMatch(/track\(`reach-\$\{e\.target\.id\}`\)/);
    expect(js).toContain('"demo-watched"');
    expect(js).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it("describes the analytics in the privacy policy", () => {
    const privacy = pub("privacy.html");
    expect(privacy).toContain('id="analytics"');
    expect(privacy).toMatch(/Umami.*sets no cookies/s);
    expect(privacy).toContain("Version 2.11");
  });
});
