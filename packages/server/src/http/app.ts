import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { AppContext } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { register as mcp } from "../mcp/index.js";
import type { AppEnv } from "./auth.js";
import { register as account } from "./routes/account.js";
import { register as admin } from "./routes/admin.js";
import { register as conclusions } from "./routes/conclusions.js";
import { register as hosted } from "./routes/hosted.js";
import { register as keys } from "./routes/keys.js";
import { register as messages } from "./routes/messages.js";
import { register as oauth } from "./routes/oauth.js";
import { register as peers } from "./routes/peers.js";
import { register as queue } from "./routes/queue.js";
import { register as recall } from "./routes/recall.js";
import { register as scopes } from "./routes/scopes.js";
import { register as sessions } from "./routes/sessions.js";
import { register as turn } from "./routes/turn.js";
import { register as webhooks } from "./routes/webhooks.js";
import { register as workspaces } from "./routes/workspaces.js";
import { maxBodySize, securityHeaders } from "./security.js";
import { notFoundPage, registerSite, siteRedirects } from "./site.js";
import { ValidationError } from "./validate.js";

export type App = Hono<AppEnv>;
export type RouteModule = (app: App, ctx: AppContext) => void;

/**
 * Route modules, one per resource. Each module owns its file; see
 * docs/ARCHITECTURE.md for which component implements which routes.
 */
const MODULES: RouteModule[] = [
  hosted, // first: its request metrics wrap every route
  workspaces,
  peers,
  sessions,
  messages,
  conclusions,
  scopes,
  webhooks,
  keys,
  queue,
  recall,
  turn,
  mcp,
  oauth,
  account,
  admin,
];

const API_PATH =
  /^\/(?:v[23]\/|mcp(?:\/|$)|oauth\/(?:token|register|revoke)$|\.well-known\/|admin\/|metrics$|deriver\/|billing\/stripe\/webhook$)/;

/**
 * Requests to a `*.vercel.app` deployment URL go (308) to the canonical host once the site has
 * one (RECALL_SITE_URL, not itself on vercel.app): API paths to RECALL_PUBLIC_URL, dashboard
 * paths to the dashboard, the rest to the site. `/internal/*` and `/health` stay (the cron tick
 * and health probes call the deployment URL).
 */
function vercelAppRedirects(ctx: AppContext): MiddlewareHandler<AppEnv> {
  const { siteUrl, publicUrl, dashboardUrl, splitSite } = ctx.config.server;
  const site = ctx.config.env.RECALL_SITE_URL?.trim() ? siteUrl : null;
  if (!site || !splitSite || new URL(site).hostname.endsWith(".vercel.app"))
    return (_c, next) => next();
  const api = new URL(publicUrl!).origin;
  return async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    if (
      !url.hostname.endsWith(".vercel.app") ||
      path === "/health" ||
      path.startsWith("/internal/")
    )
      return next();
    const legacy = path === "/app" || path.startsWith("/app/");
    const target = API_PATH.test(path)
      ? `${api}${path}`
      : legacy || path === "/oauth/authorize"
        ? `${dashboardUrl}${legacy && ctx.config.server.splitDashboard ? path.slice(4) || "/" : path}`
        : `${site}${path}`;
    return c.redirect(`${target}${url.search}`, 308);
  };
}

export function createApp(ctx: AppContext): App {
  const app = new Hono<AppEnv>();
  // Outermost: security headers on every response, then the body limit for every route.
  app.use("*", securityHeaders());
  app.use("*", maxBodySize());
  // Credentials allowed, every method and header; origins from RECALL_CORS_ORIGINS (default: any).
  const origins = ctx.config.server.corsOrigins;
  const oauth = ctx.config.hosted.oauth.enabled;
  // OAuth discovery, registration, token and revocation endpoints serve browser-based MCP
  // clients from any origin (they use no cookies), whatever RECALL_CORS_ORIGINS says.
  const openToAll = (path: string) =>
    oauth && (path.startsWith("/.well-known/") || /^\/oauth\/(token|register|revoke)$/.test(path));
  app.use(
    "*",
    cors({
      origin: origins
        ? (o, c) => (o && (origins.includes(o) || openToAll(c.req.path)) ? o : null)
        : (o) => o ?? "*",
      credentials: true,
      // With OAuth on, browser clients must read the /mcp challenge to find where to sign in.
      ...(oauth ? { exposeHeaders: ["WWW-Authenticate"] } : {}),
    }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError)
      return c.json({ detail: err.detail }, err.status as 400, err.headers);
    if (err instanceof ValidationError) return c.json({ detail: err.detail }, 422);
    ctx.log.error({ err, path: c.req.path }, "unhandled error");
    return c.json({ detail: "An unexpected error occurred" }, 500);
  });
  const page404 = notFoundPage();
  app.notFound((c) => page404(c) ?? c.json({ detail: "Not Found" }, 404));

  app.use("*", vercelAppRedirects(ctx));
  // The short commit the deployment was built from (Vercel sets it), so a client can tell when a
  // push is live, e.g. before a benchmark run.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  app.get("/health", (c) => c.json({ status: "ok", ...(commit ? { commit } : {}) }));
  // Before any route: the site's pages on the API's or dashboard's host go to the site's host.
  app.use("*", siteRedirects(ctx.config));
  for (const register of MODULES) register(app, ctx);
  registerSite(app, ctx.config);
  return app;
}
