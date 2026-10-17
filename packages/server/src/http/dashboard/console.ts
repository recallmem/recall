import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { chargesByKind, getBillingRow, ledgerEntries } from "../../billing/ledger.js";
import { topupStatus } from "../../billing/withdrawal.js";
import type { AppContext } from "../../context.js";
import { getAccount } from "../../core/accounts.js";
import { recentApiKeys, revokeApiKey } from "../../core/apikeys.js";
import {
  funnel,
  funnelPeriod,
  signupsByLink,
  signupsBySource,
  testEmails,
} from "../../core/funnel.js";
import { archiveLink, createLink, linkVisitors, listLinks } from "../../core/links.js";
import {
  consoleAccounts,
  consoleOverview,
  membersOf,
  summarize,
  usageByTask,
} from "../../core/operator.js";
import { suspendAccount, unsuspendAccount } from "../../core/suspend.js";
import { liveVisitors, trafficPeriod, umamiReport } from "../../core/traffic.js";
import { ApiError } from "../../lib/errors.js";
import * as cv from "./console-views.js";
import { linksPage } from "./links-views.js";
import { dashPath } from "./paths.js";
import type { DashEnv, DashState } from "./session.js";
import { trafficPage } from "./traffic-views.js";
import type { page } from "./views.js";

/**
 * The operator console, at <dashboard>/admin: business and system health
 * (sign-ups, money, model cost, the job queue), the activation funnel of
 * self-serve sign-ups (core/funnel.ts), website traffic and sign-ups by source
 * (core/traffic.ts), the accounts, and per-account actions
 * (grant credit, revoke a key, suspend, unsuspend).
 *
 * Open only to signed-in dashboard users whose email is in RECALL_OPERATOR_EMAILS.
 * Everyone else gets exactly what an unknown dashboard path gets (404), so the
 * console's existence is not revealed; on a dashboard host of its own the request
 * falls through to the routes behind the dashboard (see `hiddenFromConsole`).
 * Every POST has passed the dashboard's CSRF check, asks for an explicit
 * confirmation in the form, and is logged with the operator's email.
 */

type C = Context<DashEnv>;
type Render = (
  c: C,
  status: number,
  opts: Omit<Parameters<typeof page>[0], "dash">,
) => Response | Promise<Response>;

/**
 * Requests the console turned away (not an operator). With the dashboard on its own
 * host, `dashboardHost` serves these as if no dashboard route had matched.
 */
export const hiddenFromConsole = new WeakSet<Request>();

/** Console paths, relative to the dashboard base: open to operators of a suspended account. */
export const isConsolePath = (path: string) => path === "/admin" || path.startsWith("/admin/");

const DAY_MS = 86_400_000;
const nonce = () => randomBytes(12).toString("base64url");
const cleanNonce = (v: string | undefined) => (v && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
const ticked = (v: string | undefined) => v === "1" || v === "on" || v === "yes";

export function registerConsole(
  app: Hono<DashEnv>,
  ctx: AppContext,
  h: { render: Render; notFound: (c: C) => Response | Promise<Response> },
): void {
  const { render } = h;

  /** The signed-in operator, or null (the caller then answers like an unknown path). */
  const operatorOf = (c: C): DashState | null => {
    const dash = c.get("dash");
    return dash?.operator ? dash : null;
  };
  const hide = (c: C) => {
    hiddenFromConsole.add(c.req.raw);
    // Exactly what an unknown dashboard path answers (on a dashboard host of its own the
    // request falls through instead; see `hiddenFromConsole`).
    return h.notFound(c);
  };
  const accountHref = (id: string, msg?: string) =>
    dashPath(`/admin/accounts/${encodeURIComponent(id)}${msg ? `?msg=${msg}` : ""}`);
  const audit = (op: DashState, account: string, msg: string, extra: object = {}) =>
    ctx.log.info({ operator: op.email, account, ...extra }, `operator console: ${msg}`);

  // ---- overview ------------------------------------------------------------
  app.get("/admin", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    await ctx.usage.flush();
    const data = await consoleOverview(ctx.db, {
      welcomeCapMicros: ctx.config.hosted.billing.signupCreditDailyCapMicros,
    });
    return render(c, 200, {
      title: "Console",
      active: "/admin",
      body: cv.overviewPage({ ...data, billing: ctx.billing.enabled }),
    });
  });

  // ---- activation funnel -------------------------------------------------------
  app.get("/admin/funnel", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    await ctx.usage.flush();
    const days = funnelPeriod(c.req.query("days"));
    const data = await funnel(ctx.db, { days, testEmails: testEmails(ctx.config.hosted) });
    return render(c, 200, {
      title: "Funnel · Console",
      active: "/admin",
      body: cv.funnelPage({ ...data, billing: ctx.billing.enabled }),
    });
  });

  // ---- traffic: website analytics (Umami) and sign-ups by source ----------------
  app.get("/admin/traffic", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const days = trafficPeriod(c.req.query("days"));
    const umami = ctx.config.hosted.umami;
    const [sources, analytics] = await Promise.all([
      signupsBySource(ctx.db, { days, testEmails: testEmails(ctx.config.hosted) }),
      umami
        ? umamiReport(umami, days).then(
            (report) => ({ state: "ok" as const, report }),
            (err: unknown) => {
              ctx.log.warn({ err }, "operator console: could not read Umami");
              const timeout = err instanceof Error && err.name === "TimeoutError";
              const message = timeout
                ? "the request timed out"
                : err instanceof Error
                  ? err.message
                  : "unknown error";
              return { state: "error" as const, message };
            },
          )
        : { state: "off" as const },
    ]);
    return render(c, 200, {
      title: "Traffic · Console",
      active: "/admin",
      body: trafficPage({ days, analytics, sources }),
    });
  });

  /** The Traffic page's live counter: visitors in the last 5 minutes, polled by app.js. */
  app.get("/admin/traffic/live", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const umami = ctx.config.hosted.umami;
    if (!umami) return c.json({ visitors: null }, 404);
    try {
      return c.json({ visitors: await liveVisitors(umami) }, 200, { "Cache-Control": "no-store" });
    } catch (err) {
      ctx.log.warn({ err }, "operator console: could not read Umami's live visitors");
      return c.json({ visitors: null }, 502, { "Cache-Control": "no-store" });
    }
  });

  // ---- links: tagged links for the operator's posts ---------------------------------
  app.get("/admin/links", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const umami = ctx.config.hosted.umami;
    const links = await listLinks(ctx.db);
    const [visitors, signups] = await Promise.all([
      umami ? linkVisitors(umami, links.slice(0, 40)) : Promise.resolve(null),
      signupsByLink(ctx.db, { testEmails: testEmails(ctx.config.hosted) }),
    ]);
    const madeId = c.req.query("made");
    return render(c, 200, {
      title: "Links · Console",
      active: "/admin",
      notice: cv.notice(c.req.query("msg")),
      body: linksPage({
        csrf: op.csrf,
        siteUrl: ctx.config.server.siteUrl,
        links,
        visitors,
        signups,
        made: madeId ? (links.find((l) => l.id === madeId) ?? null) : null,
      }),
    });
  });

  app.post("/admin/links", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    if (!ctx.config.server.siteUrl)
      throw new ApiError(409, "Set RECALL_SITE_URL on this server to make links.");
    const link = await createLink(ctx.db, c.get("form"), op.email);
    ctx.log.info(
      { operator: op.email, link: link.id, source: link.source, campaign: link.campaign },
      "operator console: link made",
    );
    return c.redirect(dashPath(`/admin/links?made=${encodeURIComponent(link.id)}`), 303);
  });

  app.post("/admin/links/:link_id/archive", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const link = await archiveLink(ctx.db, c.req.param("link_id"));
    ctx.log.info({ operator: op.email, link: link.id }, "operator console: link archived");
    return c.redirect(dashPath("/admin/links?msg=link_archived"), 303);
  });

  // ---- accounts --------------------------------------------------------------
  app.get("/admin/accounts", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    await ctx.usage.flush();
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    const cursor = c.req.query("after") ?? undefined;
    const list = await consoleAccounts(ctx.db, { q, cursor });
    return render(c, 200, {
      title: "Accounts · Console",
      active: "/admin",
      body: cv.accountsPage({ q, paged: !!cursor, ...list }),
    });
  });

  app.get("/admin/accounts/:account_id", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const id = c.req.param("account_id");
    await ctx.usage.flush();
    const account = await getAccount(ctx.db, id); // 404 when unknown
    const now = new Date();
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const [summary, members, keys, usage, charges, ledger, billing, topups] = await Promise.all([
      summarize(
        ctx.db,
        [
          {
            id,
            name: account.name,
            created_at: account.created_at,
            suspended_at: account.suspended_at,
          },
        ],
        now,
      ),
      membersOf(ctx.db, id),
      recentApiKeys(ctx.db, id, 100),
      usageByTask(ctx.db, id, since),
      chargesByKind(ctx.db, id, since),
      ledgerEntries(ctx.db, id, 50),
      getBillingRow(ctx.db, id),
      topupStatus(ctx.db, id),
    ]);
    return render(c, 200, {
      title: `${account.name} · Console`,
      active: "/admin",
      notice: cv.notice(c.req.query("msg")),
      body: cv.accountPage({
        csrf: op.csrf,
        account,
        summary: summary[0]!,
        balanceMicros: billing?.balance_micros ?? null,
        members,
        keys,
        usage,
        charges,
        ledger,
        topups,
        canGrant: ctx.billing.enabled,
        grantNonce: nonce(),
      }),
    });
  });

  // ---- actions ----------------------------------------------------------------
  /** Grant (or, negative, correct) credit: the form's nonce makes a re-posted form a no-op. */
  app.post("/admin/accounts/:account_id/credits", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const account = await getAccount(ctx.db, c.req.param("account_id"));
    const f = c.get("form");
    if (!ctx.billing.enabled) throw new ApiError(409, "Billing is not enabled on this server.");
    if (!ticked(f.confirm)) throw new ApiError(422, "Tick the box to confirm the grant.");
    const key = cleanNonce(f.nonce);
    if (!key) throw new ApiError(422, "This form expired. Reload the page and try again.");
    const usd = Number((f.amount_usd ?? "").trim());
    if (!(f.amount_usd ?? "").trim() || !Number.isFinite(usd) || Math.abs(usd) > 1_000_000)
      throw new ApiError(422, "The amount must be a number of dollars (at most 1,000,000).");
    const micros = Math.round(usd * 1_000_000);
    if (micros === 0) throw new ApiError(422, "The amount must not be zero.");
    const note = (f.note ?? "").trim().slice(0, 500) || null;
    const r = await ctx.billing.grant(account.id, micros, `console:${key}`, note, op.email);
    audit(op, account.id, r?.applied ? "credit granted" : "credit grant repeated (no change)", {
      amount_micros: micros,
      note,
    });
    return c.redirect(
      accountHref(account.id, r?.applied ? "credit_granted" : "credit_duplicate"),
      303,
    );
  });

  app.post("/admin/accounts/:account_id/keys/:key_id/revoke", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const account = await getAccount(ctx.db, c.req.param("account_id"));
    if (!ticked(c.get("form").confirm))
      throw new ApiError(422, "Tick the box to confirm revoking the key.");
    const key = await revokeApiKey(ctx.db, c.req.param("key_id"), account.id);
    ctx.tenancy.keys.forget(key.id);
    audit(op, account.id, "API key revoked", { key: key.id });
    return c.redirect(accountHref(account.id, "key_revoked"), 303);
  });

  app.post("/admin/accounts/:account_id/suspend", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const account = await getAccount(ctx.db, c.req.param("account_id"));
    const f = c.get("form");
    if ((f.confirm ?? "").trim() !== account.id)
      throw new ApiError(422, "Type the account id exactly to confirm the suspension.");
    const reason = (f.reason ?? "").trim();
    if (!reason) throw new ApiError(422, "Give a reason for the suspension.");
    await suspendAccount(ctx, account.id, reason);
    audit(op, account.id, "account suspended", { reason });
    return c.redirect(accountHref(account.id, "account_suspended"), 303);
  });

  app.post("/admin/accounts/:account_id/unsuspend", async (c) => {
    const op = operatorOf(c);
    if (!op) return hide(c);
    const account = await getAccount(ctx.db, c.req.param("account_id"));
    if (!ticked(c.get("form").confirm))
      throw new ApiError(422, "Tick the box to confirm lifting the suspension.");
    await unsuspendAccount(ctx, account.id);
    audit(op, account.id, "account unsuspended");
    return c.redirect(accountHref(account.id, "account_unsuspended"), 303);
  });
}
