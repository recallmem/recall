import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Response headers every route gets unless it sets its own (the dashboard and
 * the OAuth consent screen set stricter ones), and the request body limit.
 *
 * On Vercel the site's static files are served by the CDN, not by this app:
 * vercel.json repeats SITE_HEADERS for them (test/security-headers.test.ts
 * checks that the two agree).
 */

/** Headers for every response. */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** API responses (JSON, text): nothing in them may load or run, and nothing may frame them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** sha256 CSP sources of the inline <script> blocks of an HTML page. */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`,
  );
}

/**
 * The site's (public/*.html) policy: its own scripts, styles and fonts only. The
 * pages' two small inline scripts are allowed by hash; inline style attributes
 * are not used.
 */
export function siteCsp(scriptHashes: readonly string[]): string {
  return [
    "default-src 'none'",
    `script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(" ")}` : ""}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Pages an OAuth client may open in a popup and then expect to talk back to
 * its opener from: `Cross-Origin-Opener-Policy: same-origin` there would cut
 * the popup off from the app that opened it, so they get `unsafe-none`.
 */
const POPUP_PATHS = /^\/(?:oauth\/authorize|(?:app\/)?(?:login|auth\/verify))$/;

/**
 * Adds BASE_HEADERS, a CSP and `Cache-Control: no-store` to every response
 * that does not set them itself (API responses carry account data and must
 * not be cached; the site and discovery documents set their own caching).
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    for (const [name, value] of Object.entries(BASE_HEADERS)) if (!h.has(name)) h.set(name, value);
    if (POPUP_PATHS.test(c.req.path)) h.set("Cross-Origin-Opener-Policy", "unsafe-none");
    if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", API_CSP);
    if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  };
}

/**
 * Largest request body any route accepts: a batch of 100 messages of 25,000
 * characters fits. Routes that need less set a lower limit of their own (file
 * uploads 5.25 MB, the dashboard's forms 1 MB, OAuth 64 KB). On Vercel the
 * platform caps bodies at 4.5 MB anyway.
 */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** The body limit for every route: 413 with `{"detail"}` before the body is read. */
export function maxBodySize(): MiddlewareHandler {
  return bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        { detail: `Request body too large (at most ${MAX_BODY_BYTES / 1024 / 1024} MB)` },
        413,
      ),
  });
}
