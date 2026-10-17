import { createHmac } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import {
  type AlertSettings,
  getAlertSettings,
  MAX_LOW_BALANCE_MICROS,
  saveAlertSettings,
} from "../../billing/alerts.js";
import { chargesSince, getBillingRow, ledgerHistory, usageCharges } from "../../billing/ledger.js";
import { mailboxKey, pendingSignupCreditMicros } from "../../billing/signup.js";
import { type ClientIpConfig, siteHome } from "../../config.js";
import type { AppContext } from "../../context.js";
import { accountUsage, getAccount, monthStart, updateAccount } from "../../core/accounts.js";
import { type ApiKeyOut, createApiKey, listApiKeys, revokeApiKey } from "../../core/apikeys.js";
import { isDisposableEmail } from "../../core/disposable.js";
import { eraseAccount } from "../../core/erase.js";
import { exportAccount } from "../../core/export.js";
import { listGrants, revokeGrant, setAutoRemember } from "../../core/oauth.js";
import { stopOnboardingEmails, verifyUnsubscribeToken } from "../../core/onboarding.js";
import { selectPeerRow } from "../../core/peers.js";
import { selectSessionRow } from "../../core/sessions.js";
import { type SignupSource, signupSourceOf, sourceQuery } from "../../core/signup-source.js";
import { wsKey } from "../../core/tenancy.js";
import {
  accountMembers,
  connectGithub,
  consumeLogin,
  createSession,
  disconnectGithub,
  githubOf,
  hasAccount,
  issueLoginToken,
  normalizeEmail,
  peekLogin,
  revokeSession,
  signIn,
  userByEmail,
  userByGithub,
} from "../../core/users.js";
import { findWorkspace } from "../../core/workspaces.js";
import { isUniqueViolation } from "../../db/client.js";
import { renderEmail } from "../../lib/email.js";
import { ApiError } from "../../lib/errors.js";
import { NAME_MAX, NAME_PATTERN } from "../../lib/ids.js";
import { TERMS_VERSION } from "../../lib/legal.js";
import { networkKey } from "../../lib/network.js";
import { verifyPassword } from "../../lib/passwords.js";
import { clientIp } from "../common.js";
import { modelNamer } from "../redact.js";
import { STYLESHEET } from "./app-css.js";
import { SCRIPT } from "./app-js.js";
import { isConsolePath, registerConsole } from "./console.js";
import { checklist, dailyActivity, usageReport, workspaceNames } from "./explorer.js";
import { setFlash, takeFlash } from "./flash.js";
import * as gh from "./github.js";
import { registerMemory } from "./memory.js";
import { dashboardBase, dashboardLink, dashPath, withDashboardBase } from "./paths.js";
import {
  browserBinding,
  CsrfError,
  clearSessionCookie,
  csrf,
  type DashEnv,
  type DashState,
  loadDash,
  refuseSuspended,
  securityHeaders,
  setSessionCookie,
} from "./session.js";
import * as v from "./views.js";

/**
 * The customer dashboard (hosted mode), at /app, or at the root of its own host
 * (RECALL_DASHBOARD_URL; see paths.ts): magic-link sign-in, overview,
 * the memory explorer and playground (memory.ts), API keys, usage, billing and
 * settings. Server-rendered; works without JavaScript.
 * Every page and action is scoped to the account of the signed-in session;
 * nothing in a URL or form can name another account.
 */

type C = Context<DashEnv>;

/**
 * Keyed hash of the client's network (an IPv4 address, or an IPv6 /64, or a /48 with
 * `wide`), for limits per network; null when the address is unknown or not an IP
 * address. Never the raw address.
 */
function networkHash(c: C, key: Buffer, ipFrom: ClientIpConfig, wide = false): string | null {
  const ip = clientIp(c, ipFrom);
  const network = ip ? networkKey(ip, wide ? 3 : 4) : null;
  return network ? createHmac("sha256", key).update(`net:${network}`).digest("hex") : null;
}

const MANAGE_ROLES = new Set(["owner", "admin"]);

export function dashboard(ctx: AppContext): Hono<DashEnv> {
  const app = new Hono<DashEnv>();
  const cfg = ctx.config.hosted;
  const secret = cfg.sessionSecret;
  // Links are built from the configured URLs only, never from the request's Host header.
  const publicUrl = (ctx.config.server.publicUrl ?? "").replace(/\/+$/, "");
  /** The marketing site and docs, linked from signed-out pages (on their own host when they have one). */
  const site = siteHome(ctx.config);
  /** For copyable snippets only (never for links we send): the API's URL, else this origin. */
  const snippetBase = (c: C) => publicUrl || new URL(c.req.url).origin;

  const legal = cfg.legal;
  // Continuing past a sign-in page that shows the terms notice is the acceptance recorded here.
  const terms = legal ? { termsVersion: TERMS_VERSION } : {};
  const render = (c: C, status: number, opts: Omit<Parameters<typeof v.page>[0], "dash">) =>
    c.html(v.page({ site, legal, ...opts, dash: c.get("dash") }), status as 200);

  /** Unknown pages, and workspaces, peers, sessions or keys this account does not have. */
  const notFound = (c: C, detail: string | null = null) =>
    render(c, 404, {
      title: "Not found",
      body: v.notFoundPage({ signedIn: !!c.get("dash"), detail }),
    });
  /** "Go back" on an error page: the dashboard page the form was on, never anything else. */
  const backLink = (c: C): string | null => {
    const ref = c.req.header("referer");
    if (!ref) return null;
    try {
      const from = new URL(ref);
      const here = new URL(c.req.url);
      const root = dashboardBase(ctx.config);
      if (from.origin !== here.origin) return null;
      if (root && from.pathname !== root && !from.pathname.startsWith(`${root}/`)) return null;
      return `${from.pathname}${from.search}`;
    } catch {
      return null;
    }
  };

  app.onError((err, c) => {
    const signedIn = !!c.get("dash");
    if (err instanceof CsrfError)
      return render(c as C, 403, {
        title: "Form expired",
        body: v.linkInvalidPage(),
        error: "This form expired or came from another site. Reload the page and try again.",
      });
    if (err instanceof ApiError) {
      if (err.status === 404) return notFound(c as C, err.detail);
      return render(c as C, err.status, {
        title: "Error",
        body: v.errorPage({ status: err.status, back: backLink(c as C), signedIn }),
        error: err.detail,
      });
    }
    ctx.log.error({ err, path: c.req.path }, "dashboard error");
    return render(c as C, 500, {
      title: "Error",
      body: v.errorPage({ status: 500, back: backLink(c as C), signedIn }),
      error: "Something went wrong.",
    });
  });

  app.use("*", withDashboardBase(ctx.config));
  // "/app/" and "/keys/" are the pages without the slash (paths are matched exactly). The
  // target is always a path of this host: leading slashes collapse, so "//x/" cannot leave it.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || path === "/" || !path.endsWith("/"))
      return next();
    return c.redirect(`/${path.replace(/^\/+|\/+$/g, "")}${url.search}`, 308);
  });
  app.use("*", securityHeaders(ctx.config.hosted.billing.customDomain));
  // Forms only: small bodies (the global limit is for message batches).
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () => {
        throw new ApiError(413, "The form is too large.");
      },
    }),
  );
  app.get("/static/app.css", (c) =>
    c.body(STYLESHEET, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    }),
  );
  app.get("/static/app.js", (c) =>
    c.body(SCRIPT, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    }),
  );
  // Turning off onboarding emails (core/onboarding.ts), before sign-in and CSRF: the signed token
  // in the link is the only credential, so it works signed out, and the mail client's one-click
  // POST (RFC 8058, List-Unsubscribe-Post) needs no cookie or form token. A GET only shows the
  // button, so link scanners that open every link in an email unsubscribe nobody.
  const unsubscribe = (c: C, state: "ask" | "done" | "invalid", token = "") =>
    c.html(
      v.page({
        site,
        legal,
        title: "Email preferences",
        dash: null,
        body: v.unsubscribePage(state, token),
      }),
      state === "invalid" ? 400 : 200,
    );
  app.get("/unsubscribe", (c) => {
    const token = (c.req.query("t") ?? "").slice(0, 200);
    return unsubscribe(c, verifyUnsubscribeToken(secret, token) ? "ask" : "invalid", token);
  });
  app.post("/unsubscribe", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const field = typeof body.t === "string" ? body.t : "";
    const accountId = verifyUnsubscribeToken(secret, c.req.query("t") ?? field);
    if (!accountId) return unsubscribe(c, "invalid");
    await stopOnboardingEmails(ctx.db, accountId);
    ctx.log.info({ account: accountId }, "onboarding emails turned off");
    return unsubscribe(c, "done");
  });

  app.use("*", loadDash(ctx));
  // A suspended account's members see only a notice; they can still sign out (or in, as
  // someone else). Operators keep their console. For anyone else a console path answers
  // what an unknown path would: this notice under /app, or (on a dashboard host of its
  // own, where unknown paths never reach this app) whatever console.ts falls through to.
  const base = dashboardBase(ctx.config);
  // A suspended account can still sign in and out, and download its data (the right of access
  // does not end with a suspension); deleting it goes through support meanwhile.
  const SIGN_IN_PATHS = new Set([
    "/logout",
    "/login",
    "/auth/verify",
    "/auth/github",
    "/auth/github/callback",
    "/settings/export",
  ]);
  const splitHost = ctx.config.server.splitDashboard;
  app.use(
    "*",
    refuseSuspended(site, (c, dash) => {
      const path = c.req.path.slice(base.length) || "/";
      return SIGN_IN_PATHS.has(path) || (isConsolePath(path) && (dash.operator || splitHost));
    }),
  );
  app.use("*", csrf(ctx));

  /** Signed-in gate; with `manage`, owners and admins only. */
  const user = (c: C, opts: { manage?: boolean; owner?: boolean } = {}): DashState => {
    const dash = c.get("dash");
    if (!dash) throw new ApiError(401, "Sign in first");
    if (opts.owner && dash.role !== "owner") throw new ApiError(403, "Only an owner can do this");
    if (opts.manage && !MANAGE_ROLES.has(dash.role))
      throw new ApiError(403, "Your role cannot change this account");
    return dash;
  };
  const signedOut = (c: C) => c.redirect(dashPath("/login"), 303);
  const csrfToken = (c: C) => c.get("dash")?.csrf ?? c.get("anonCsrf") ?? "";
  const oauth = ctx.config.hosted.oauth.enabled;
  /**
   * Where to continue after signing in: only an OAuth authorization request of
   * this server (a local path), never anything else, so it cannot be used to
   * redirect elsewhere. Null when OAuth is off.
   */
  const safeNext = (raw: string | undefined): string | null =>
    oauth &&
    raw &&
    raw.length <= 4000 &&
    /^\/oauth\/authorize\?[\x21-\x7e]*$/.test(raw) &&
    !raw.includes("\\")
      ? raw
      : null;

  // "Continue with GitHub" needs an absolute callback URL, so the dashboard's own URL.
  const github = cfg.github && ctx.config.server.dashboardUrl ? cfg.github : null;
  const githubCallback = dashboardLink(ctx.config, "/auth/github/callback");
  /** Where the GitHub button starts, carrying `next` and the sign-up source; null when it is off. */
  const githubHref = (next: string | null | undefined, source: SignupSource | null = null) => {
    if (!github) return null;
    const q = [next ? `next=${encodeURIComponent(next)}` : "", sourceQuery(source)]
      .filter(Boolean)
      .join("&");
    return dashPath(`/auth/github${q ? `?${q}` : ""}`);
  };
  /** The site's, the API's and the dashboard's hosts: a Referer from these names no source. */
  const ownHosts = [
    ctx.config.server.siteUrl,
    ctx.config.server.publicUrl,
    ctx.config.server.dashboardUrl,
  ].flatMap((u) => (u ? [new URL(u).host] : []));
  /** The source a sign-in form or the GitHub button carried on (`src`, `campaign`). */
  const carriedSource = (q: Record<string, string | undefined>) =>
    signupSourceOf({ src: q.src, campaign: q.campaign }, undefined, []);

  // ---- sign-in -------------------------------------------------------------
  app.get("/login", (c) => {
    const next = safeNext(c.req.query("next"));
    if (c.get("dash")) return c.redirect(next ?? dashPath("/"), 303);
    const source = signupSourceOf(c.req.query(), c.req.header("referer"), ownHosts);
    return render(c, 200, {
      title: "Sign in",
      notice: v.notice(c.req.query("msg")),
      body: v.loginPage(csrfToken(c), {
        site,
        legal,
        signup: cfg.signup,
        next,
        source,
        reviewer: !!cfg.reviewer,
        github: githubHref(next, source),
      }),
    });
  });

  app.post("/login", async (c) => {
    const form = c.get("form");
    const next = safeNext(form.next);
    const source = carriedSource(form);
    const email = normalizeEmail(form.email ?? "");
    if (!email)
      return render(c, 422, {
        title: "Sign in",
        error: "Enter a valid email address.",
        body: v.loginPage(csrfToken(c), {
          site,
          legal,
          signup: cfg.signup,
          email: form.email,
          next,
          source,
          github: githubHref(next, source),
        }),
      });
    // Counted per network, not per address: one IPv6 host has a whole /64 to rotate through.
    const ipHash = networkHash(c, secret, ctx.config.server.clientIp);
    // Unknown addresses: without sign-up they get the same answer but no email; with it,
    // throwaway domains are refused (each new account gets a welcome credit). Existing
    // users are never affected, whatever their domain.
    if (!cfg.signup) {
      if (!(await hasAccount(ctx.db, email)))
        return render(c, 200, { title: "Check your email", body: v.checkEmailPage() });
    } else if (
      isDisposableEmail(email, cfg.signupBlockedDomains) &&
      !(await hasAccount(ctx.db, email))
    ) {
      return render(c, 422, {
        title: "Sign in",
        error: "Use a personal or work email address; disposable addresses can't sign up.",
        body: v.loginPage(csrfToken(c), {
          site,
          legal,
          signup: cfg.signup,
          email: form.email,
          next,
          source,
          github: githubHref(next, source),
        }),
      });
    }
    const issued = await issueLoginToken(
      ctx.db,
      email,
      ipHash,
      undefined,
      next,
      browserBinding(c, secret),
      source,
    );
    if ("limited" in issued)
      return render(c, 429, {
        title: "Too many requests",
        error: "Too many sign-in links were requested. Wait a few minutes and try again.",
        body: v.loginPage(csrfToken(c), {
          site,
          legal,
          signup: cfg.signup,
          email,
          next,
          source,
          github: githubHref(next, source),
        }),
      });
    // On the dashboard's own host when it has one (RECALL_DASHBOARD_URL), else under /app.
    const link = dashboardLink(
      ctx.config,
      `/auth/verify?token=${encodeURIComponent(issued.token)}`,
    );
    try {
      const mail = renderEmail(
        ctx.config.server.siteUrl ?? ctx.config.server.publicUrl ?? "https://recallmem.dev",
        {
          preheader: "Your sign-in link for Recall. It works once and expires in 15 minutes.",
          heading: "Sign in to Recall",
          paragraphs: ["Press the button to open your dashboard. No password needed."],
          button: { label: "Sign in", url: link },
          footnote:
            "The link works once and expires in 15 minutes. If you did not ask for it, you can ignore this email: nothing happens until the link is used.",
        },
      );
      await ctx.mailer.send({ to: email, subject: "Your Recall sign-in link", ...mail });
    } catch (err) {
      ctx.log.error({ err }, "could not send the sign-in email");
      return render(c, 503, {
        title: "Sign in",
        error: "We could not send the email right now. Try again in a minute.",
        body: v.loginPage(csrfToken(c), {
          site,
          legal,
          signup: cfg.signup,
          email,
          next,
          source,
          github: githubHref(next, source),
        }),
      });
    }
    return render(c, 200, { title: "Check your email", body: v.checkEmailPage() });
  });

  // A GET only shows a button: mail scanners that prefetch links cannot use the token up.
  app.get("/auth/verify", async (c) => {
    const token = (c.req.query("token") ?? "").slice(0, 200);
    // Name the address the link is for, so a link someone else requested for their own account
    // cannot quietly sign this browser into it.
    const email = await peekLogin(ctx.db, token);
    if (!email) return render(c, 400, { title: "Link expired", body: v.linkInvalidPage() });
    return render(c, 200, {
      title: "Sign in",
      body: v.verifyPage(csrfToken(c), token, legal, {
        email,
        current: c.get("dash")?.email ?? null,
      }),
    });
  });

  app.post("/auth/verify", async (c) => {
    const login = await consumeLogin(ctx.db, c.get("form").token ?? "");
    if (!login) return render(c, 400, { title: "Link expired", body: v.linkInvalidPage() });
    const email = login.email;
    // The person opening the link decides the network the welcome credit is limited by
    // (per IPv6 /48, so rotating addresses in one customer's range does not help).
    const ipHash = networkHash(c, secret, ctx.config.server.clientIp, true);
    const emailHash = createHmac("sha256", secret)
      .update(`email:${mailboxKey(email)}`)
      .digest("hex");
    const result = await signIn(ctx.db, email, {
      allowSignup: cfg.signup,
      ...terms,
      source: login.source,
      onNewAccount: (tx, accountId) => ctx.billing.onSignup(tx, accountId, { ipHash, emailHash }),
    });
    if (!result)
      return render(c, 403, {
        title: "Sign in",
        error: "There is no account for this address, and sign-up is closed.",
        body: v.loginPage(csrfToken(c), { site, legal, signup: false }),
      });
    const previous = c.get("dash");
    if (previous) await revokeSession(ctx.db, previous.sessionId);
    const session = await createSession(ctx.db, result.userId, result.accountId, cfg.sessionTtlMs);
    setSessionCookie(c, secret, session.token, session.expiresAt);
    ctx.log.info({ account: result.accountId, created: result.created }, "dashboard sign-in");
    // The link continues to its page only in the browser that asked for it.
    const sameBrowser = !!login.browser && login.browser === browserBinding(c, secret);
    return c.redirect((sameBrowser && safeNext(login.next ?? undefined)) || dashPath("/"), 303);
  });

  // ---- "Continue with GitHub" (RECALL_GITHUB_CLIENT_ID/_SECRET; see ./github.ts) ------------
  const githubFailed = (c: C, status: number, error: string, next: string | null) =>
    render(c, status, {
      title: "Sign in",
      error,
      body: v.loginPage(csrfToken(c), {
        site,
        legal,
        signup: cfg.signup,
        next,
        reviewer: !!cfg.reviewer,
        github: githubHref(next),
      }),
    });

  /** Failed GitHub code exchanges per minute per client network (IPv6 /48). */
  const GITHUB_FAILURES_PER_MIN = 10;
  app.get("/auth/github", (c) => {
    if (!github) return c.notFound();
    const next = safeNext(c.req.query("next"));
    if (c.get("dash")) return c.redirect(next ?? dashPath("/"), 303);
    const source = carriedSource(c.req.query());
    // The state is bound to this browser's sign-in cookie, which the sign-in page sets first.
    const binding = browserBinding(c, secret);
    if (!binding) {
      const q = [next ? `next=${encodeURIComponent(next)}` : "", sourceQuery(source)]
        .filter(Boolean)
        .join("&");
      return c.redirect(dashPath(`/login${q ? `?${q}` : ""}`), 303);
    }
    return c.redirect(
      gh.authorizeUrl(
        github,
        githubCallback,
        gh.signState(secret, binding, next, Date.now(), false, source),
      ),
      302,
    );
  });

  app.get("/auth/github/callback", async (c) => {
    if (!github) return c.notFound();
    const query = c.req.query("state");
    const dash = c.get("dash");
    // A sign-in state is bound to this browser; a connect state to the session that asked.
    let state = gh.verifyState(secret, browserBinding(c, secret), query);
    if (state?.link) state = undefined;
    if (!state && dash) {
      const linking = gh.verifyState(secret, gh.linkBinding(dash.sessionId), query);
      if (linking?.link) state = linking;
    }
    if (!state)
      return githubFailed(
        c,
        400,
        "That GitHub sign-in expired or was started in another browser. Try again.",
        null,
      );
    const next = safeNext(state.next ?? undefined);
    const code = c.req.query("code");
    // The person pressed Cancel on GitHub (error=access_denied), or GitHub sent no code.
    if (!code) {
      if (state.link) return c.redirect(dashPath("/settings?msg=github_cancelled#signin"), 303);
      return githubFailed(c, 400, "GitHub sign-in was cancelled.", next);
    }
    // Failed exchanges are throttled per client network, like the reviewer sign-in.
    const failureKey = `github:${networkHash(c, secret, ctx.config.server.clientIp, true) ?? "unknown"}`;
    if (ctx.tenancy.failures.peek(failureKey, GITHUB_FAILURES_PER_MIN) > 0)
      return githubFailed(c, 429, "Too many attempts. Wait a minute and try again.", next);
    let found: gh.GithubUser | { error: "exchange" };
    try {
      found = await gh.githubUser(github, code.slice(0, 200), githubCallback);
    } catch (err) {
      ctx.log.warn({ err }, "GitHub sign-in failed");
      found = { error: "exchange" };
    }
    if ("error" in found) {
      ctx.tenancy.failures.take(failureKey, GITHUB_FAILURES_PER_MIN);
      ctx.log.warn("GitHub sign-in: code exchange failed");
      if (state.link) return c.redirect(dashPath("/settings?msg=github_failed#signin"), 303);
      return githubFailed(
        c,
        502,
        "GitHub sign-in did not work. Try again, or sign in with an email link.",
        next,
      );
    }
    const identity = { id: found.id, login: found.login };

    // Connecting GitHub to the signed-in user (from Settings).
    if (state.link) {
      // Operators sign in with an email link only (see below).
      if (!dash || dash.operator)
        return c.redirect(dashPath("/settings?msg=github_failed#signin"), 303);
      const r = await connectGithub(ctx.db, dash.userId, identity);
      ctx.log.info({ user: dash.userId, result: r }, "GitHub connect");
      return c.redirect(
        dashPath(`/settings?msg=${r === "connected" ? "github_connected" : "github_taken"}#signin`),
        303,
      );
    }

    // Signing in: by the user this GitHub account is tied to, whatever address GitHub reports.
    let email: string | null;
    let signUp = false;
    const tied = await userByGithub(ctx.db, identity);
    if (tied) email = tied.email;
    else {
      email = found.email ? normalizeEmail(found.email) : null;
      if (!email)
        return githubFailed(
          c,
          422,
          "Your GitHub account has no verified email address. Verify one on GitHub, or sign in with an email link.",
          next,
        );
      // An address that has a Recall user opens it only once that user connects GitHub, so an
      // address still verified on a GitHub account after its owner lost the mailbox does not.
      const existing = await userByEmail(ctx.db, email);
      if (existing)
        return githubFailed(
          c,
          409,
          existing.githubLinked
            ? "Your Recall sign-in for this address is connected to a different GitHub account."
            : "There is already a Recall account for your GitHub email address. Sign in with an email link, then connect GitHub under Settings.",
          next,
        );
      signUp = true;
    }
    // Operators sign in with an email link only: a verified address on someone's GitHub account
    // outlives the mailbox, and the console must not.
    if (ctx.config.hosted.operatorEmails.includes(email))
      return githubFailed(c, 403, "This address signs in with an email link only.", next);
    // The same rule as the email form: throwaway domains cannot create an account.
    if (signUp && cfg.signup && isDisposableEmail(email, cfg.signupBlockedDomains))
      return githubFailed(
        c,
        422,
        "Use a personal or work email address on GitHub; disposable addresses can't sign up.",
        next,
      );
    const ipHash = networkHash(c, secret, ctx.config.server.clientIp, true);
    const emailHash = createHmac("sha256", secret)
      .update(`email:${mailboxKey(email)}`)
      .digest("hex");
    let result: Awaited<ReturnType<typeof signIn>>;
    try {
      result = await signIn(ctx.db, email, {
        allowSignup: cfg.signup && signUp,
        ...terms,
        ...(signUp ? { github: identity, source: state.source } : {}),
        onNewAccount: (tx, accountId) => ctx.billing.onSignup(tx, accountId, { ipHash, emailHash }),
      });
    } catch (err) {
      // The same GitHub account finishing two sign-ups at once: the other one won.
      if (!isUniqueViolation(err)) throw err;
      result = null;
    }
    if (!result)
      return githubFailed(
        c,
        403,
        signUp
          ? "There is no account for your GitHub email address, and sign-up is closed."
          : "Your GitHub account is not a member of any Recall account. Sign in with an email link.",
        null,
      );
    if (dash) await revokeSession(ctx.db, dash.sessionId);
    const session = await createSession(ctx.db, result.userId, result.accountId, cfg.sessionTtlMs);
    setSessionCookie(c, secret, session.token, session.expiresAt);
    ctx.log.info(
      { account: result.accountId, created: result.created },
      "dashboard sign-in (GitHub)",
    );
    return c.redirect(next ?? dashPath("/"), 303);
  });

  // Connecting GitHub to the signed-in user, and disconnecting it, from Settings. A POST, so
  // another site cannot start it; the settings page allows the form's redirect to GitHub.
  app.post("/settings/github", (c) => {
    if (!github) return c.notFound();
    const dash = user(c);
    if (dash.operator) throw new ApiError(403, "This address signs in with an email link only");
    return c.redirect(
      gh.authorizeUrl(
        github,
        githubCallback,
        gh.signState(secret, gh.linkBinding(dash.sessionId), null, Date.now(), true),
      ),
      303,
    );
  });
  app.post("/settings/github/disconnect", async (c) => {
    const dash = user(c);
    await disconnectGithub(ctx.db, dash.userId);
    return c.redirect(dashPath("/settings?msg=github_disconnected#signin"), 303);
  });

  // ---- password sign-in for the app-directory reviewer (RECALL_REVIEWER_*) ----------------
  // Directory reviews (Claude, ChatGPT) need a login without email links. Only the one
  // configured address can use it; failures are throttled per client network.
  const reviewer = cfg.reviewer;
  /** Failed attempts per minute per client network (IPv6 /48), in the shared failure budgets. */
  const REVIEWER_FAILURES_PER_MIN = 5;
  /** Password checks running at once: each costs ~16 MB and tens of milliseconds of CPU. */
  const REVIEWER_MAX_CHECKS = 2;
  let checking = 0;
  app.get("/login/password", (c) => {
    if (!reviewer) return c.notFound();
    const next = safeNext(c.req.query("next"));
    if (c.get("dash")) return c.redirect(next ?? dashPath("/"), 303);
    return render(c, 200, {
      title: "Sign in",
      body: v.passwordLoginPage(csrfToken(c), { legal, next }),
    });
  });
  app.post("/login/password", async (c) => {
    if (!reviewer) return c.notFound();
    const form = c.get("form");
    const next = safeNext(form.next);
    const key = `reviewer:${networkHash(c, secret, ctx.config.server.clientIp, true) ?? "unknown"}`;
    const budget = ctx.tenancy.failures;
    if (budget.peek(key, REVIEWER_FAILURES_PER_MIN) > 0 || checking >= REVIEWER_MAX_CHECKS)
      return render(c, 429, {
        title: "Too many attempts",
        error: "Too many attempts. Wait a minute and try again.",
        body: v.passwordLoginPage(csrfToken(c), { legal, next }),
      });
    const email = normalizeEmail(form.email ?? "");
    // Always run the hash, so a wrong address takes as long as a wrong password.
    checking++;
    let passwordOk: boolean;
    try {
      passwordOk = verifyPassword(form.password ?? "", reviewer.passwordHash);
    } finally {
      checking--;
    }
    const result =
      passwordOk && email === reviewer.email
        ? await signIn(ctx.db, email, { allowSignup: false, ...terms })
        : null;
    if (!result) {
      budget.take(key, REVIEWER_FAILURES_PER_MIN);
      ctx.log.warn("reviewer sign-in failed");
      return render(c, 401, {
        title: "Sign in",
        error: "That email and password do not match.",
        body: v.passwordLoginPage(csrfToken(c), { legal, next, email: form.email }),
      });
    }
    const previous = c.get("dash");
    if (previous) await revokeSession(ctx.db, previous.sessionId);
    const session = await createSession(ctx.db, result.userId, result.accountId, cfg.sessionTtlMs);
    setSessionCookie(c, secret, session.token, session.expiresAt);
    ctx.log.info({ account: result.accountId }, "reviewer sign-in");
    return c.redirect(next ?? dashPath("/"), 303);
  });

  app.post("/logout", async (c) => {
    const dash = c.get("dash");
    if (dash) await revokeSession(ctx.db, dash.sessionId);
    clearSessionCookie(c);
    return c.redirect(dashPath("/login?msg=signed_out"), 303);
  });

  // ---- overview ------------------------------------------------------------
  /** The MCP endpoint customers connect to (the OAuth resource when OAuth is on). */
  const mcpUrl = (c: C) => ctx.config.hosted.oauth.resource || `${snippetBase(c)}/mcp`;
  /** Where the onboarding snippets and the setup prompt point, as absolute URLs. */
  const connectInfo = (c: C, tab: string): v.ConnectInfo => {
    const origin = new URL(c.req.url).origin;
    return {
      base: snippetBase(c),
      mcp: mcpUrl(c),
      keysUrl: new URL(dashboardLink(ctx.config, "/keys"), origin).toString(),
      site: `${(ctx.config.server.siteUrl ?? publicUrl) || origin}/`,
      tab,
    };
  };
  /** Days the runway estimate averages over. */
  const RUNWAY_DAYS = 14;

  app.get("/", async (c) => {
    const dash = c.get("dash");
    if (!dash) return signedOut(c);
    await ctx.usage.flush();
    const usage = await accountUsage(ctx.db, dash.accountId);
    const billingRow = ctx.billing.enabled ? await getBillingRow(ctx.db, dash.accountId) : null;
    ctx.tenancy.budget.invalidate(dash.accountId);
    const [progress, activity, recent] = await Promise.all([
      checklist(ctx, dash.accountId),
      dailyActivity(ctx, dash.accountId, !!billingRow),
      billingRow
        ? chargesSince(ctx.db, dash.accountId, new Date(Date.now() - RUNWAY_DAYS * 86_400_000))
        : Promise.resolve(null),
    ]);
    return render(c, 200, {
      title: "Overview",
      active: "/",
      notice: v.notice(c.req.query("msg")),
      body: v.overviewPage({
        billing: !!billingRow,
        unbilledHosted: ctx.config.tenancy.hosted && !billingRow,
        balanceMicros: billingRow?.balance_micros ?? null,
        pendingCreditMicros: billingRow
          ? await pendingSignupCreditMicros(ctx.db, dash.accountId)
          : null,
        blocked: await ctx.tenancy.budget.blocked(dash.accountId),
        charges: billingRow
          ? await usageCharges(ctx.db, dash.accountId, { since: monthStart() })
          : [],
        budget: usage.budget,
        burnPerDayMicros: recent === null ? null : recent / RUNWAY_DAYS,
        checklist: progress,
        activity,
        connect: connectInfo(c, c.req.query("connect") ?? "curl"),
        csrf: dash.csrf,
      }),
    });
  });

  // ---- memory explorer and playground ----------------------------------------
  registerMemory(app, ctx, { render, base: snippetBase, notFound });

  // ---- operator console (RECALL_OPERATOR_EMAILS only; 404 for everyone else) ----
  registerConsole(app, ctx, { render, notFound });

  // ---- API keys ------------------------------------------------------------
  const keysView = async (c: C, dash: DashState) => ({
    csrf: dash.csrf,
    keys: await listApiKeys(ctx.db, dash.accountId),
    apps: oauth ? await listGrants(ctx.db, dash.accountId) : null,
    canManage: MANAGE_ROLES.has(dash.role),
    workspaces: await workspaceNames(ctx, dash.accountId),
    defaultRateLimit: ctx.config.tenancy.keyRateLimitPerMin,
    base: snippetBase(c),
    mcpUrl: mcpUrl(c),
  });

  app.get("/keys", async (c) => {
    const dash = c.get("dash");
    if (!dash) return signedOut(c);
    // A key just created (POST /keys redirected here): shown on this one response only.
    const created = takeFlash(c, secret, dash.sessionId, ["key"]);
    return render(c, 200, {
      title: "API keys",
      active: "/keys",
      notice: v.notice(c.req.query("msg")),
      body: v.keysPage({
        ...(await keysView(c, dash)),
        created: created
          ? { key: created.key, name: created.name, workspace: created.workspace }
          : null,
      }),
    });
  });

  const EXPIRY_DAYS = new Set<string>(v.EXPIRY_CHOICES.map(([d]) => d).filter(Boolean));
  const scopeName = (label: string, raw: string) => {
    if (raw.length > NAME_MAX || !NAME_PATTERN.test(raw))
      throw new ApiError(422, `${label} ids use letters, digits, - and _ only.`);
    return raw;
  };
  /** The create-key form, checked against this account: the scope must name what exists. */
  const readKeyForm = async (accountId: string, f: v.KeyForm) => {
    const workspace = f.workspace_id || null;
    const peer = f.peer_id ? scopeName("Peer", f.peer_id) : null;
    const session = f.session_id ? scopeName("Session", f.session_id) : null;
    if ((peer || session) && !workspace)
      throw new ApiError(422, "Pick a workspace to scope a key to a peer or a session.");
    if (workspace) {
      const ws = await findWorkspace(ctx.db, wsKey(accountId, workspace));
      if (!ws) throw new ApiError(422, "Pick one of this account's workspaces.");
      if (peer && !(await selectPeerRow(ctx.db, ws.internal_id, peer)))
        throw new ApiError(
          422,
          `There is no peer “${peer}” in ${workspace}. A peer appears once it sends a message; scope the key to the workspace until then.`,
        );
      const s = session ? await selectSessionRow(ctx.db, ws.internal_id, session) : null;
      if (session && !s?.is_active)
        throw new ApiError(422, `There is no session “${session}” in ${workspace}.`);
    }
    let expiresAt: Date | null = null;
    if (f.expires_in) {
      if (!EXPIRY_DAYS.has(f.expires_in)) throw new ApiError(422, "Pick an expiry from the list.");
      expiresAt = new Date(Date.now() + Number(f.expires_in) * 86_400_000);
    }
    let rate: number | null = null;
    if (f.rate_limit_per_min) {
      const cap = ctx.config.tenancy.keyRateLimitPerMin;
      rate = Number(f.rate_limit_per_min);
      if (!Number.isSafeInteger(rate) || rate < 1 || (cap > 0 && rate > cap))
        throw new ApiError(
          422,
          cap > 0
            ? `Requests per minute must be a whole number from 1 to ${cap.toLocaleString("en-US")}, or empty for the default.`
            : "Requests per minute must be a whole number of at least 1, or empty for no limit.",
        );
    }
    return {
      accountId,
      name: (f.name ?? "").slice(0, 200),
      mode: f.mode === "test" ? ("test" as const) : ("live" as const),
      workspace,
      peer,
      session,
      expiresAt,
      rateLimitPerMin: rate,
    };
  };

  app.post("/keys", async (c) => {
    const dash = user(c, { manage: true });
    const raw = c.get("form");
    const form: v.KeyForm = Object.fromEntries(
      (
        [
          "name",
          "mode",
          "workspace_id",
          "peer_id",
          "session_id",
          "expires_in",
          "rate_limit_per_min",
        ] as const
      ).map((k) => [k, (raw[k] ?? "").trim()]),
    );
    let input: Awaited<ReturnType<typeof readKeyForm>>;
    try {
      input = await readKeyForm(dash.accountId, form);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      return render(c, 422, {
        title: "API keys",
        active: "/keys",
        error: err.detail,
        body: v.keysPage({ ...(await keysView(c, dash)), form }),
      });
    }
    const created = await createApiKey(ctx.db, input);
    // Post, redirect, get: the key travels once, encrypted, in a two-minute cookie; reloading
    // the page neither shows it again nor creates another.
    setFlash(c, secret, dash.sessionId, {
      kind: "key",
      key: created.key,
      name: input.name,
      workspace: input.workspace,
    });
    return c.redirect(dashPath("/keys#new-key"), 303);
  });

  const accountKey = async (accountId: string, id: string): Promise<ApiKeyOut> => {
    const k = (await listApiKeys(ctx.db, accountId)).find((x) => x.id === id);
    if (!k) throw new ApiError(404, "API key not found");
    return k;
  };

  app.get("/keys/:key_id/revoke", async (c) => {
    if (!c.get("dash")) return signedOut(c);
    const dash = user(c, { manage: true });
    const k = await accountKey(dash.accountId, c.req.param("key_id"));
    if (k.revoked_at) return c.redirect(dashPath("/keys"), 303);
    return render(c, 200, {
      title: "Revoke key",
      active: "/keys",
      body: v.revokeKeyPage(dash.csrf, k),
    });
  });

  app.post("/keys/:key_id/revoke", async (c) => {
    const dash = user(c, { manage: true });
    const k = await accountKey(dash.accountId, c.req.param("key_id"));
    // Without the confirmation step's field, the form asks first (and nothing is revoked).
    if (c.get("form").confirm !== "1")
      return render(c, 200, {
        title: "Revoke key",
        active: "/keys",
        body: v.revokeKeyPage(dash.csrf, k),
      });
    const key = await revokeApiKey(ctx.db, k.id, dash.accountId);
    ctx.tenancy.keys.forget(key.id);
    ctx.log.info({ account: dash.accountId, key: key.id }, "api key revoked from the dashboard");
    return c.redirect(dashPath("/keys?msg=key_revoked"), 303);
  });

  // ---- connected apps (OAuth grants) -----------------------------------------
  const accountGrant = async (accountId: string, id: string) => {
    if (!oauth) throw new ApiError(404, "Not found");
    const g = (await listGrants(ctx.db, accountId)).find((x) => x.id === id);
    if (!g) throw new ApiError(404, "Connected app not found");
    return g;
  };

  app.get("/connected-apps/:grant_id/revoke", async (c) => {
    if (!c.get("dash")) return signedOut(c);
    const dash = user(c, { manage: true });
    const g = await accountGrant(dash.accountId, c.req.param("grant_id"));
    return render(c, 200, {
      title: "Disconnect app",
      active: "/keys",
      body: v.revokeAppPage(dash.csrf, g),
    });
  });

  app.post("/connected-apps/:grant_id/revoke", async (c) => {
    const dash = user(c, { manage: true });
    if (!oauth) throw new ApiError(404, "Not found");
    const grantId = c.req.param("grant_id");
    if (c.get("form").confirm !== "1")
      return render(c, 200, {
        title: "Disconnect app",
        active: "/keys",
        body: v.revokeAppPage(dash.csrf, await accountGrant(dash.accountId, grantId)),
      });
    const found = await revokeGrant(ctx.db, grantId, {
      accountId: dash.accountId,
      reason: "user_revoked",
    });
    if (!found) throw new ApiError(404, "Connected app not found");
    ctx.tenancy.oauth.forgetGrant(grantId);
    ctx.log.info({ account: dash.accountId, grant: grantId }, "oauth app revoked");
    return c.redirect(dashPath("/keys?msg=app_revoked#connected-apps"), 303);
  });

  app.post("/connected-apps/:grant_id/auto-remember", async (c) => {
    const dash = user(c, { manage: true });
    if (!oauth) throw new ApiError(404, "Not found");
    const grantId = c.req.param("grant_id");
    const on = c.get("form").on === "1";
    if (!(await setAutoRemember(ctx.db, dash.accountId, grantId, on)))
      throw new ApiError(404, "Connected app not found");
    // Cached access carries the setting: drop it so the next connection reads the new value.
    ctx.tenancy.oauth.forgetGrant(grantId);
    ctx.log.info({ account: dash.accountId, grant: grantId, on }, "oauth app auto-remember set");
    return c.redirect(dashPath("/keys?msg=app_updated#connected-apps"), 303);
  });

  // ---- usage ---------------------------------------------------------------
  app.get("/usage", async (c) => {
    const dash = c.get("dash");
    if (!dash) return signedOut(c);
    await ctx.usage.flush();
    const billed = ctx.billing.enabled && !!(await getBillingRow(ctx.db, dash.accountId));
    return render(c, 200, {
      title: "Usage",
      active: "/usage",
      body: v.usagePage({
        ...(await usageReport(ctx, dash.accountId, billed)),
        minTokens: ctx.config.hosted.billing.prices.ingestMinTokens,
      }),
    });
  });

  // ---- billing -------------------------------------------------------------
  app.get("/billing", async (c) => {
    const dash = c.get("dash");
    if (!dash) return signedOut(c);
    const row = ctx.billing.enabled ? await getBillingRow(ctx.db, dash.accountId) : null;
    const b = ctx.config.hosted.billing;
    let invoices: v.BillingData["invoices"] = [];
    if (row?.stripe_customer_id) {
      invoices = await ctx.billing.invoices(dash.accountId).catch((err) => {
        ctx.log.warn({ err }, "could not list invoices");
        return null;
      });
    }
    const checkout = c.req.query("checkout");
    const ledgerPage = Number.parseInt(c.req.query("ledger_page") ?? "1", 10);
    return render(c, 200, {
      title: "Billing",
      active: "/billing",
      notice: v.notice(checkout ? `checkout_${checkout}` : c.req.query("msg")),
      body: v.billingPage({
        csrf: dash.csrf,
        enabled: !!row,
        serverBilling: ctx.billing.enabled,
        taxed: b.tax,
        balanceMicros: row?.balance_micros ?? 0,
        pendingCreditMicros: row ? await pendingSignupCreditMicros(ctx.db, dash.accountId) : null,
        amounts: b.topupAmountsMicros,
        minMicros: b.topupMinMicros,
        maxMicros: b.topupMaxMicros,
        hasCard: !!row?.payment_method_id,
        auto: {
          enabled: !!row?.auto_topup_enabled,
          thresholdMicros: row?.auto_topup_threshold_micros ?? 5_000_000,
          amountMicros: row?.auto_topup_amount_micros ?? 25_000_000,
          failures: row?.auto_topup_failures ?? 0,
          lastError: row?.auto_topup_last_error ?? null,
          // With legal pages, switching it on needs the consent box unless given for these terms.
          needsConsent: !!legal && row?.auto_topup_consent_version !== TERMS_VERSION,
        },
        termsUrl: legal?.terms ?? null,
        prices: b.prices,
        ledger: row
          ? await ledgerHistory(
              ctx.db,
              dash.accountId,
              Number.isFinite(ledgerPage) ? ledgerPage : 1,
            )
          : { items: [], page: 1, pages: 1, total: 0 },
        invoices,
      }),
    });
  });

  const requireBilled = async (accountId: string) => {
    if (!ctx.billing.enabled || !(await getBillingRow(ctx.db, accountId)))
      throw new ApiError(404, "Billing is not enabled for this account");
  };
  const usdField = (raw: string | undefined, label: string) => {
    const n = Number(raw);
    if (raw === undefined || raw.trim() === "" || !Number.isFinite(n))
      throw new ApiError(422, `${label} must be a number`);
    return Math.round(n * 1_000_000);
  };

  app.post("/billing/checkout", async (c) => {
    const dash = user(c, { manage: true });
    await requireBilled(dash.accountId);
    const micros = usdField(c.get("form").amount_usd, "Amount");
    const url = await ctx.billing.createCheckout(dash.accountId, dash.email, micros);
    return c.redirect(url, 303);
  });

  app.post("/billing/portal", async (c) => {
    const dash = user(c, { manage: true });
    await requireBilled(dash.accountId);
    return c.redirect(await ctx.billing.portalUrl(dash.accountId, dash.email), 303);
  });

  app.post("/billing/auto-topup", async (c) => {
    const dash = user(c, { manage: true });
    await requireBilled(dash.accountId);
    const f = c.get("form");
    await ctx.billing.updateAutoTopup(dash.accountId, {
      enabled: f.enabled === "1",
      thresholdMicros: usdField(f.threshold_usd, "Threshold"),
      amountMicros: usdField(f.amount_usd, "Amount"),
      consent: f.consent === "1",
    });
    return c.redirect(dashPath("/billing?msg=autotopup_saved"), 303);
  });

  // ---- settings ------------------------------------------------------------
  /** Checks the spend alerts now (after a setting changed); a failure only logs. */
  const checkAlerts = (accountId: string) =>
    ctx.billing.alerts
      .check(accountId)
      .catch((err) => ctx.log.error({ err, account: accountId }, "spend alert check failed"));

  app.get("/settings", async (c) => {
    const dash = c.get("dash");
    if (!dash) return signedOut(c);
    const manage = MANAGE_ROLES.has(dash.role);
    const account = await getAccount(ctx.db, dash.accountId, { secrets: true });
    const members = await accountMembers(ctx.db, dash.accountId);
    const billingRow = ctx.billing.enabled ? await getBillingRow(ctx.db, dash.accountId) : null;
    const msg = c.req.query("msg");
    // "Connect GitHub" posts here and is redirected on to GitHub.
    if (github) c.set("formAction", "https://github.com");
    return render(c, 200, {
      title: "Settings",
      active: "/settings",
      notice: v.notice(msg),
      body: v.settingsPage({
        csrf: dash.csrf,
        name: account.name,
        accountId: account.id,
        owner: dash.role === "owner",
        canManage: manage,
        budgetUsd: account.monthly_budget_usd,
        webhookSecret: manage ? (account.webhook_secret ?? null) : null,
        secretRotated: msg === "secret_rotated",
        members,
        alerts: await getAlertSettings(ctx.db, dash.accountId),
        billed: !!billingRow,
        autoTopup: !!billingRow?.auto_topup_enabled,
        email: dash.email,
        github:
          github && !dash.operator ? { connected: await githubOf(ctx.db, dash.userId) } : null,
      }),
    });
  });

  app.post("/settings/name", async (c) => {
    const dash = user(c, { manage: true });
    await updateAccount(ctx.db, dash.accountId, { name: c.get("form").name ?? "" });
    return c.redirect(dashPath("/settings?msg=name_saved"), 303);
  });

  app.post("/settings/budget", async (c) => {
    const dash = user(c, { manage: true });
    const raw = (c.get("form").monthly_budget_usd ?? "").trim();
    const budget = raw === "" ? null : Number(raw);
    if (budget !== null && (!Number.isFinite(budget) || budget < 0 || budget > 1_000_000_000))
      throw new ApiError(422, "The budget must be a positive number of dollars, or empty");
    await updateAccount(ctx.db, dash.accountId, { monthlyBudgetUsd: budget });
    ctx.tenancy.budget.invalidate(dash.accountId);
    // A cap set at or below this month's spend warns at once.
    await checkAlerts(dash.accountId);
    return c.redirect(dashPath("/settings?msg=budget_saved#budget"), 303);
  });

  app.post("/settings/alerts", async (c) => {
    const dash = user(c, { manage: true });
    const f = c.get("form");
    const current = await getAlertSettings(ctx.db, dash.accountId);
    const billed = ctx.billing.enabled && !!(await getBillingRow(ctx.db, dash.accountId));
    let threshold = current.lowBalanceThresholdMicros;
    const raw = (f.low_balance_usd ?? "").trim();
    if (billed && raw !== "") {
      const usd = Number(raw);
      threshold = Math.round(usd * 1_000_000);
      if (!Number.isFinite(usd) || threshold < 10_000 || threshold > MAX_LOW_BALANCE_MICROS)
        throw new ApiError(422, "The low-balance line must be between $0.01 and $100,000.");
    }
    const next: AlertSettings = {
      // The balance alerts are only on the form of a prepaid account; elsewhere they keep their value.
      lowBalance: billed ? f.low_balance === "1" : current.lowBalance,
      lowBalanceThresholdMicros: threshold,
      outOfCredit: billed ? f.out_of_credit === "1" : current.outOfCredit,
      budget80: f.budget_80 === "1",
      budget100: f.budget_100 === "1",
    };
    await saveAlertSettings(ctx.db, dash.accountId, next);
    await checkAlerts(dash.accountId);
    return c.redirect(dashPath("/settings?msg=alerts_saved#alerts"), 303);
  });

  /**
   * Where the secret's pages return to: "settings", or "ws:<workspace>" for that workspace's
   * webhooks. Never a URL, so the field cannot send anyone elsewhere.
   */
  const secretReturn = (next: string | undefined) => {
    const ws = next?.match(/^ws:(.{1,512})$/)?.[1];
    return ws && NAME_PATTERN.test(ws)
      ? dashPath(`/memory/${encodeURIComponent(ws)}/webhooks`)
      : dashPath("/settings");
  };
  const rotatePage = (c: C, dash: DashState, next: string, error?: string) =>
    render(c, error ? 422 : 200, {
      title: "Rotate webhook secret",
      active: next.startsWith("ws:") ? "/memory" : "/settings",
      error,
      body: v.rotateSecretPage(dash.csrf, next, `${secretReturn(next)}#webhook-secret`),
    });

  app.get("/settings/rotate-webhook-secret", (c) => {
    if (!c.get("dash")) return signedOut(c);
    const dash = user(c, { manage: true });
    return rotatePage(c, dash, (c.req.query("next") ?? "settings").slice(0, 600));
  });

  app.post("/settings/rotate-webhook-secret", async (c) => {
    const dash = user(c, { manage: true });
    const f = c.get("form");
    const next = (f.next ?? "settings").slice(0, 600);
    if (f.confirm !== "1") return rotatePage(c, dash, next);
    if ((f.confirm_text ?? "").trim().toLowerCase() !== "rotate")
      return rotatePage(c, dash, next, "Type “rotate” to confirm; the secret was not changed.");
    await updateAccount(ctx.db, dash.accountId, { rotateWebhookSecret: true });
    ctx.log.info({ account: dash.accountId }, "webhook secret rotated from the dashboard");
    return c.redirect(`${secretReturn(next)}?msg=secret_rotated#webhook-secret`, 303);
  });

  app.post("/settings/export", async (c) => {
    const dash = user(c, { manage: true });
    const day = new Date().toISOString().slice(0, 10);
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="recall-export-${dash.accountId}-${day}.json"`,
    );
    const model = await modelNamer(ctx, dash.accountId);
    return stream(c, async (s) => {
      for await (const chunk of exportAccount(ctx.db, dash.accountId, { model }))
        await s.write(chunk);
    });
  });

  app.post("/settings/delete", async (c) => {
    const dash = user(c, { owner: true });
    const account = await getAccount(ctx.db, dash.accountId);
    if ((c.get("form").confirm ?? "").trim() !== account.name)
      throw new ApiError(422, "Type the account name exactly to confirm deletion");
    await eraseAccount(ctx, dash.accountId);
    ctx.log.info({ account: dash.accountId }, "account deleted from the dashboard");
    clearSessionCookie(c);
    return c.redirect(dashPath("/login?msg=deleted"), 303);
  });

  // ---- anything else: the dashboard's own 404, inside its layout ------------------
  app.all("*", (c) => notFound(c));
  app.notFound((c) => notFound(c));

  return app;
}
