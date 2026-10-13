import { sql } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppContext } from "../../context.js";
import { rows } from "../../db/client.js";
import { notFound, unauthorized } from "../../lib/errors.js";
import { metrics, renderMetrics, SampledGauge } from "../../lib/metrics.js";
import type { App } from "../app.js";
import { type AppEnv, limitFailures, safeEqual } from "../auth.js";
import { hiddenFromConsole } from "../dashboard/console.js";
import { dashboard } from "../dashboard/index.js";
import type { DashEnv } from "../dashboard/session.js";

/**
 * Hosted-service surface (Recall extensions, not part of Honcho's API):
 *
 *   *                              request count and latency by route pattern (Prometheus)
 *   GET  /metrics                  Prometheus metrics; `Authorization: Bearer $RECALL_METRICS_TOKEN`
 *                                  when set, and always required in hosted mode (404 without a token)
 *   POST /billing/stripe/webhook   Stripe events (signature-verified; 404 unless billing is on)
 *   /app/*                         customer dashboard (hosted mode only); at the root of its own
 *                                  host instead with RECALL_DASHBOARD_URL (see dashboardHost)
 */

function httpMetrics(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      const pattern = routePath(c);
      const route = !pattern || pattern === "/*" || pattern === "*" ? "unmatched" : pattern;
      const status = c.res.status;
      const method = c.req.method;
      metrics.httpRequests.inc({ method, route, status: String(status) });
      metrics.httpDuration.observe(
        { method, route, status: `${Math.floor(status / 100)}xx` },
        (performance.now() - start) / 1000,
      );
    }
  };
}

async function databaseGauges(ctx: AppContext): Promise<SampledGauge[]> {
  const jobs = new SampledGauge(
    "recall_queue_jobs",
    "Jobs not yet done, by kind and status (pending, running, failed).",
  );
  const due = new SampledGauge(
    "recall_queue_due_jobs",
    "Pending jobs whose run_after has passed (the backlog), by kind.",
  );
  const lag = new SampledGauge(
    "recall_queue_oldest_due_seconds",
    "Age of the oldest due pending job, by kind.",
  );
  const paused = new SampledGauge(
    "recall_queue_budget_paused_jobs",
    "Pending jobs postponed because their account is out of credit or over budget.",
  );
  const byStatus = await rows<{ kind: string; status: string; n: number }>(
    ctx.db,
    sql`SELECT kind, status, count(*)::int AS n FROM jobs WHERE status <> 'done' GROUP BY 1, 2`,
  );
  jobs.samples = byStatus.map((r) => ({ labels: { kind: r.kind, status: r.status }, value: r.n }));
  const dueRows = await rows<{ kind: string; n: number; age: number | string | null }>(
    ctx.db,
    sql`SELECT kind, count(*)::int AS n, EXTRACT(EPOCH FROM now() - min(run_after))::float8 AS age
        FROM jobs WHERE status = 'pending' AND run_after <= now() GROUP BY 1`,
  );
  due.samples = dueRows.map((r) => ({ labels: { kind: r.kind }, value: r.n }));
  lag.samples = dueRows.map((r) => ({ labels: { kind: r.kind }, value: Number(r.age ?? 0) }));
  const [p] = await rows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM jobs WHERE status = 'pending' AND run_after > now()
          AND payload->>'budget_paused_at' IS NOT NULL`,
  );
  paused.samples = [{ labels: {}, value: p?.n ?? 0 }];
  const out = [jobs, due, lag, paused];
  if (ctx.billing.enabled) {
    const [b] = await rows<{ accounts: number; empty: number; balance: string | number | null }>(
      ctx.db,
      sql`SELECT count(*)::int AS accounts, count(*) FILTER (WHERE balance_micros <= 0)::int AS empty,
                 COALESCE(sum(balance_micros), 0) AS balance FROM billing_accounts`,
    );
    const g = (name: string, help: string, value: number) => {
      const m = new SampledGauge(name, help);
      m.samples = [{ labels: {}, value }];
      return m;
    };
    out.push(
      g("recall_billing_accounts", "Billed (self-serve) accounts.", b?.accounts ?? 0),
      g(
        "recall_billing_accounts_out_of_credit",
        "Billed accounts at or below zero.",
        b?.empty ?? 0,
      ),
      g(
        "recall_billing_outstanding_credit_usd",
        "Sum of all prepaid balances (unspent customer credit).",
        Number(b?.balance ?? 0) / 1_000_000,
      ),
    );
  }
  return out;
}

export function register(app: App, ctx: AppContext): void {
  app.use("*", httpMetrics());

  const { token, requireToken } = ctx.config.hosted.metrics;
  app.get("/metrics", async (c) => {
    if (!token && requireToken) throw notFound("Resource");
    if (token) {
      const given = c.req
        .header("authorization")
        ?.match(/^Bearer\s+(.+)$/i)?.[1]
        ?.trim();
      // Wrong tokens spend the same per-network budget as wrong admin tokens.
      await limitFailures(ctx, c, "operator", () => {
        if (!given || !safeEqual(given, token)) throw unauthorized("Invalid metrics token");
      });
    }
    let extra: SampledGauge[] = [];
    try {
      extra = await databaseGauges(ctx);
    } catch (err) {
      ctx.log.warn({ err }, "could not read queue metrics");
    }
    return c.body(renderMetrics(extra), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  app.post("/billing/stripe/webhook", async (c) => {
    if (!ctx.billing.enabled) throw notFound("Resource");
    const payload = await c.req.text();
    const result = await ctx.billing.handleWebhook(payload, c.req.header("stripe-signature"));
    return c.json(result);
  });

  if (!ctx.config.hosted.dashboard) {
    if (ctx.config.tenancy.hosted)
      ctx.log.warn("dashboard (/app) is off: set RECALL_PUBLIC_URL to enable sign-up and sign-in");
    return;
  }
  const dash = dashboard(ctx);
  if (ctx.config.server.splitDashboard) app.use("*", dashboardHost(ctx, dash));
  else app.route("/app", dash);
}

/** Matchers for the paths a Hono app routes (its middleware excluded); `:param` is one segment. */
function routePatterns(sub: Hono<DashEnv>): RegExp[] {
  const paths = new Set(sub.routes.map((r) => r.path).filter((p) => p !== "*" && p !== "/*"));
  return [...paths].map((p) => {
    const body = p
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/");
    return new RegExp(`^${body === "/" ? "/" : `${body}/?`}$`);
  });
}

/**
 * The dashboard on a host of its own (RECALL_DASHBOARD_URL differs from RECALL_PUBLIC_URL):
 *
 * - on the dashboard host its pages are at the root (`/`, `/login`, `/keys`, ...), and old
 *   `/app/*` URLs redirect (308) to the same path without the prefix. Everything else there
 *   (the site's fonts and pages the dashboard links to, the API, MCP, OAuth) is served as on
 *   the public host: it uses bearer tokens, never the dashboard's cookie;
 * - on any other host (the public one, www, a deployment URL) `/app/*` and the OAuth consent
 *   screen redirect (302) to the dashboard host, the only origin its cookies and CSRF checks
 *   accept.
 */
function dashboardHost(ctx: AppContext, dash: Hono<DashEnv>): MiddlewareHandler<AppEnv> {
  const base = ctx.config.server.dashboardUrl!;
  const host = new URL(base).host;
  const patterns = routePatterns(dash);
  return async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const legacy = path === "/app" || path.startsWith("/app/");
    const unprefixed = legacy ? path.slice("/app".length) || "/" : path;
    if (url.host !== host) {
      if (legacy || path === "/oauth/authorize")
        return c.redirect(`${base}${unprefixed}${url.search}`, 302);
      return next();
    }
    if (legacy) return c.redirect(`${base}${unprefixed}${url.search}`, 308);
    if (!patterns.some((re) => re.test(path))) return next();
    const res = await dash.fetch(c.req.raw, c.env);
    // The operator console turned a non-operator away: answer as if no dashboard route matched.
    if (hiddenFromConsole.has(c.req.raw)) return next();
    c.res = res;
    // The API's permissive CORS (set before this ran) must not reach the cookie-authenticated pages.
    c.res.headers.delete("Access-Control-Allow-Origin");
    c.res.headers.delete("Access-Control-Allow-Credentials");
    return c.res;
  };
}
