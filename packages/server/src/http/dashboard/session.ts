import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../../context.js";
import { type DashSession, loadSession, touchSession } from "../../core/users.js";
import { page, suspendedPage } from "./views.js";

/**
 * Dashboard sessions and CSRF protection.
 *
 * - The session cookie holds a random token plus an HMAC of it (key derived from
 *   RECALL_SESSION_SECRET / RECALL_AUTH_SECRET); the database stores only the
 *   token's SHA-256. Cookies are HttpOnly, Secure, SameSite=Lax, `__Host-` prefixed.
 * - Every POST carries a `_csrf` field: an HMAC bound to the session (or, before
 *   sign-in, to a random `__Host-` cookie), checked in constant time, plus an
 *   Origin check when the browser sends one.
 */

export const SESSION_COOKIE = "__Host-recall_session";
export const ANON_COOKIE = "__Host-recall_csrf";

export interface DashState extends DashSession {
  csrf: string;
  /** The signed-in email is in RECALL_OPERATOR_EMAILS: the operator console is open to it. */
  operator: boolean;
}

export type DashEnv = {
  Variables: {
    dash: DashState | null;
    anonCsrf: string | null;
    form: Record<string, string>;
    /** An extra CSP `form-action` source for this page (the OAuth consent form redirects there). */
    formAction?: string;
  };
};

function mac(secret: Buffer, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}:${value}`).digest("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sessionCookieValue(secret: Buffer, token: string): string {
  return `${token}.${mac(secret, "session", token)}`;
}

/** The token inside a signed cookie value, or null when the signature is wrong. */
export function verifySessionCookie(secret: Buffer, value: string | undefined): string | null {
  if (!value || value.length > 200) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = value.slice(0, dot);
  return same(value.slice(dot + 1), mac(secret, "session", token)) ? token : null;
}

export const csrfForSession = (secret: Buffer, sessionId: string) => mac(secret, "csrf", sessionId);
const csrfForAnon = (secret: Buffer, cookie: string) => mac(secret, "csrf-anon", cookie);

/**
 * A keyed hash of this browser's anonymous cookie, stored with a sign-in link that continues to
 * another page: only the browser that asked for the link is sent on there, so someone requesting
 * a link for another person's address cannot choose where that person lands.
 */
export function browserBinding(c: Context, secret: Buffer): string | null {
  const anon = getCookie(c, ANON_COOKIE);
  return anon ? mac(secret, "next-browser", anon) : null;
}

const cookieBase = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

export function setSessionCookie(c: Context, secret: Buffer, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, sessionCookieValue(secret, token), {
    ...cookieBase,
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { ...cookieBase });
}

const TOUCH_EVERY_MS = 5 * 60_000;

/**
 * Resolves the session (if any) and prepares the anonymous CSRF cookie for the
 * sign-in forms. Sets `dash` (null when signed out).
 */
export function loadDash(ctx: AppContext): MiddlewareHandler<DashEnv> {
  const secret = ctx.config.hosted.sessionSecret;
  const operators = new Set(ctx.config.hosted.operatorEmails);
  return async (c, next) => {
    let dash: DashState | null = null;
    const token = verifySessionCookie(secret, getCookie(c, SESSION_COOKIE));
    if (token) {
      const s = await loadSession(ctx.db, token);
      if (s) {
        dash = {
          ...s,
          csrf: csrfForSession(secret, s.sessionId),
          operator: operators.has(s.email.toLowerCase()),
        };
        if (Date.now() - s.lastSeenAt.getTime() > TOUCH_EVERY_MS)
          void touchSession(ctx.db, s.sessionId).catch(() => undefined);
      }
    }
    c.set("dash", dash);
    let anon = getCookie(c, ANON_COOKIE) ?? null;
    if (!dash && anon?.length !== 32) {
      anon = randomBytes(24).toString("base64url");
      setCookie(c, ANON_COOKIE, anon, { ...cookieBase, maxAge: 86_400 });
    }
    c.set("anonCsrf", anon ? csrfForAnon(secret, anon) : null);
    c.set("form", {});
    await next();
  };
}

/**
 * Security headers for every dashboard response. Billing forms redirect to Stripe: Checkout and
 * the portal, on Stripe's hosts or on `stripeDomain` (a Stripe custom domain).
 */
export const securityHeaders =
  (stripeDomain: string | null = null): MiddlewareHandler<DashEnv> =>
  async (c, next) => {
    await next();
    // The API's permissive CORS must not extend to the cookie-authenticated dashboard.
    c.res.headers.delete("Access-Control-Allow-Origin");
    c.res.headers.delete("Access-Control-Allow-Credentials");
    c.header("Cache-Control", "no-store");
    // same-origin, not no-referrer: with no-referrer browsers send `Origin: null` on form posts, which the CSRF check refuses.
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    const extra = c.get("formAction");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        `form-action 'self' https://checkout.stripe.com https://billing.stripe.com${stripeDomain ? ` https://${stripeDomain}` : ""}${extra ? ` ${extra}` : ""}; ` +
        "frame-ancestors 'none'; base-uri 'none'",
    );
  };

/**
 * A session of a suspended account sees only a notice (403) with a sign-out button,
 * whatever it asks for, except what `allow` lets through (signing out and in again,
 * and for operators their console). Runs after `loadDash`.
 */
export function refuseSuspended(
  site: string,
  allow: (c: Context<DashEnv>, dash: DashState) => boolean = () => false,
): MiddlewareHandler<DashEnv> {
  return async (c, next) => {
    const dash = c.get("dash");
    if (!dash?.suspended || allow(c, dash)) return next();
    return c.html(page({ title: "Account suspended", site, body: suspendedPage(dash.csrf) }), 403);
  };
}

export class CsrfError extends Error {}

/**
 * For every POST: the Origin (when sent) must be ours, and `_csrf` must match
 * the session's token (signed in) or the anonymous cookie's (sign-in forms).
 * The parsed form is left in `form`.
 */
export function csrf(ctx: AppContext): MiddlewareHandler<DashEnv> {
  // The dashboard's forms are posted from its own origin (RECALL_DASHBOARD_URL, else the public one).
  const base = ctx.config.server.dashboardUrl;
  const expectedOrigin = base ? new URL(base).origin : null;
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const origin = c.req.header("origin");
    const ours = expectedOrigin ?? new URL(c.req.url).origin;
    if (origin && origin !== "null" && origin !== ours) throw new CsrfError("cross-origin form");
    if (origin === "null") throw new CsrfError("opaque origin");
    const body = await c.req.parseBody().catch(() => ({}));
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") form[k] = v;
    const given = form._csrf ?? "";
    const dash = c.get("dash");
    const expected = dash ? dash.csrf : c.get("anonCsrf");
    if (!expected || !given || !same(given, expected)) throw new CsrfError("bad csrf token");
    c.set("form", form);
    return next();
  };
}
