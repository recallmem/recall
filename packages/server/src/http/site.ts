import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, MiddlewareHandler } from "hono";
import type { Config } from "../config.js";
import type { App } from "./app.js";
import { inlineScriptHashes, siteCsp } from "./security.js";

/**
 * The marketing site and docs in packages/server/public, for deployments
 * without a CDN in front (on Vercel the CDN serves these files itself).
 * Files are read once at startup; `/x.html` is also served at `/x`, and
 * home.html at `/`.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** The URLs a page of the site is served at: `/x.html` and `/x`, and `/` for home.html. */
function pagePaths(file: string): string[] {
  const paths = [`/${file}`];
  // The home page is home.html, not index.html: on Vercel an index.html would be served at "/"
  // by the CDN on every host, including the dashboard's (see vercel.json).
  if (file === "home.html") paths.push("/", "/home");
  else if (file.endsWith(".html")) paths.push(`/${file.slice(0, -".html".length)}`);
  return paths;
}

function listFiles(root: string): string[] {
  try {
    return files(root);
  } catch {
    return []; // no public directory: API only
  }
}

const escapeAttr = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * The docs show the API's URL in their examples. The pages carry
 * `<meta name="recall-api" content="<API URL>" data-site="<site origin>">`
 * (the hosted values, for Vercel's CDN, which serves the file as it is) and
 * site.js shows `content` on the site's own origin, else the page's origin.
 * Served from here, both are this deployment's: RECALL_PUBLIC_URL and the
 * site's origin.
 */
function withApiUrl(html: string, config: Pick<Config, "server">): string {
  const api = config.server.publicUrl ? new URL(config.server.publicUrl).origin : "";
  const site = config.server.siteUrl ?? "";
  return html.replace(
    /<meta name="recall-api" content="[^"]*" data-site="[^"]*" \/>/,
    `<meta name="recall-api" content="${escapeAttr(api)}" data-site="${escapeAttr(site)}" />`,
  );
}

export function registerSite(app: App, config: Pick<Config, "server">, root = ROOT): void {
  for (const file of listFiles(root)) {
    const type = TYPES[extname(file)];
    if (!type) continue;
    const html = file.endsWith(".html");
    const raw = readFileSync(join(root, file));
    const body = html ? Buffer.from(withApiUrl(raw.toString("utf8"), config), "utf8") : raw;
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Cache-Control": html ? "public, max-age=300" : "public, max-age=86400",
      // The pages' own policy (their inline scripts by hash); other headers come from security.ts.
      ...(html
        ? { "Content-Security-Policy": siteCsp(inlineScriptHashes(body.toString("utf8"))) }
        : {}),
    };
    for (const path of pagePaths(file))
      app.get(path, (c) => c.body(new Uint8Array(body), 200, headers));
  }
}

/**
 * Browsers asking for a path that does not exist get the site's 404 page (public/404.html);
 * API clients keep the JSON answer. Without the page (an API-only build) this does nothing.
 */
export function notFoundPage(root = ROOT): (c: Context) => Response | null {
  let page: Buffer;
  try {
    page = readFileSync(join(root, "404.html"));
  } catch {
    return () => null;
  }
  const headers = {
    "Content-Type": TYPES[".html"]!,
    "Cache-Control": "no-store",
    "Content-Security-Policy": siteCsp(inlineScriptHashes(page.toString("utf8"))),
  };
  return (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return null;
    if (!(c.req.header("accept") ?? "").includes("text/html")) return null;
    return c.body(new Uint8Array(page), 404, headers);
  };
}

/**
 * With the site on a host of its own (RECALL_SITE_URL), its pages requested on
 * the API's or the dashboard's host redirect (308) there. Only the HTML pages:
 * the API, MCP, OAuth, discovery, health, admin, metrics and the Stripe webhook
 * are never redirected, and the fonts and icons stay available because the
 * dashboard uses them. The dashboard's own root is not a site page.
 */
export function siteRedirects(config: Pick<Config, "server">, root = ROOT): MiddlewareHandler {
  const { siteUrl, splitSite, publicUrl, dashboardUrl, splitDashboard } = config.server;
  if (!splitSite || !siteUrl) return (_c, next) => next();
  const siteHost = new URL(siteUrl).host;
  const apiHost = publicUrl ? new URL(publicUrl).host : null;
  const dashHost = splitDashboard && dashboardUrl ? new URL(dashboardUrl).host : null;
  const pages = new Set(
    listFiles(root)
      .filter((f) => f.endsWith(".html"))
      .flatMap(pagePaths),
  );
  return async (c, next) => {
    const url = new URL(c.req.url);
    const from = url.host === apiHost ? "api" : url.host === dashHost ? "dashboard" : null;
    if (!from || url.host === siteHost || !pages.has(url.pathname)) return next();
    if (from === "dashboard" && url.pathname === "/") return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    return c.redirect(`${siteUrl}${url.pathname}${url.search}`, 308);
  };
}
