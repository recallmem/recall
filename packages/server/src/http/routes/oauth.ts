import { createHmac, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { html } from "hono/html";
import { z } from "zod";
import { type OAuthConfig, siteHome } from "../../config.js";
import type { AppContext } from "../../context.js";
import {
  CHALLENGE_SHAPE,
  canonicalResource,
  createAuthorizationCode,
  exchangeCode,
  manageableAccounts,
  refreshTokenGrant,
  refreshTokens,
  revokeToken,
  workspaceNames,
} from "../../core/oauth.js";
import {
  ClientMetadataError,
  clientIdUrlProblem,
  isClientIdUrl,
  isLoopbackRedirect,
  loadClient,
  type OAuthClient,
  OAuthError,
  redirectUriAllowed,
  registerClient,
  SCOPE,
  withParams,
} from "../../core/oauth-clients.js";
import { ApiError } from "../../lib/errors.js";
import { NAME_MAX, NAME_PATTERN } from "../../lib/ids.js";
import { networkKey } from "../../lib/network.js";
import type { App } from "../app.js";
import { clientIp } from "../common.js";
import { authorizeErrorPage, consentPage } from "../dashboard/oauth-views.js";
import { dashPath, withDashboardBase } from "../dashboard/paths.js";
import {
  CsrfError,
  csrf,
  type DashEnv,
  type DashState,
  loadDash,
  refuseSuspended,
  securityHeaders,
} from "../dashboard/session.js";
import * as v from "../dashboard/views.js";

/**
 * OAuth 2.1 authorization server for the MCP endpoint (hosted mode with the
 * dashboard; nothing here is registered otherwise, so those routes stay 404).
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 metadata of the MCP endpoint
 *   GET  /.well-known/oauth-authorization-server       RFC 8414 metadata (also served as
 *        /.well-known/openid-configuration, the second URL MCP clients try: same document,
 *        no OpenID features, so a client probing either finds the OAuth endpoints)
 *   POST /oauth/register    RFC 7591 dynamic client registration (public clients)
 *   GET  /oauth/authorize   consent screen (dashboard sign-in first); POST records the decision
 *   POST /oauth/token       authorization_code (PKCE S256) and refresh_token (rotating) grants
 *   POST /oauth/revoke      RFC 7009 revocation
 *
 * The authorization request must name this server's MCP endpoint as `resource`
 * (RFC 8707); tokens are only accepted there. A `client_id` that is an https
 * URL is a client ID metadata document (core/oauth-clients.ts). Protocol errors
 * use OAuth's `{"error", "error_description"}` shape instead of `{"detail"}`,
 * as OAuth clients expect.
 */

const AUTHZ_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
  "prompt",
  "response_mode",
] as const;
type AuthzParams = Partial<Record<(typeof AUTHZ_PARAMS)[number], string>>;

/** A problem with the client or its redirect URI: shown to the user, never redirected (RFC 6749 4.1.2.1). */
class PageError extends Error {}

/** Any other problem with an authorization request: sent back to the client's redirect URI. */
class RedirectError extends Error {
  constructor(
    readonly redirectUri: string,
    readonly error: string,
    readonly description: string,
    readonly state: string | undefined,
  ) {
    super(description);
  }
}

interface AuthzRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  resource: string;
  /** The request's own parameters, carried through the consent form. */
  carry: Record<string, string>;
}

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/**
 * The consent form's token: when the page was rendered, and a MAC binding that
 * time to the session, the account and the authorization request. "Allow" is
 * accepted only CONSENT_MIN_MS after rendering (a scripted double-click lands
 * sooner, with or without JavaScript; with JavaScript the button also stays
 * disabled until the page has been seen and used, see dashboard/app-js.ts) and within
 * CONSENT_MAX_MS.
 */
export const CONSENT_MIN_MS = 1_000;
const CONSENT_MAX_MS = 60 * 60_000;

interface ConsentBinding {
  sessionId: string;
  account: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string | undefined;
}

const consentMac = (key: Buffer, at: number, b: ConsentBinding) =>
  createHmac("sha256", key)
    .update(
      JSON.stringify([
        "oauth-consent",
        at,
        b.sessionId,
        b.account,
        b.clientId,
        b.redirectUri,
        b.codeChallenge,
        b.resource,
        b.state ?? null,
      ]),
    )
    .digest("base64url");

export function consentToken(key: Buffer, b: ConsentBinding, now = Date.now()): string {
  return `${now}.${consentMac(key, now, b)}`;
}

/** "ok", "early" (rendered less than CONSENT_MIN_MS ago) or "invalid" (forged, expired, other request). */
function checkConsentToken(
  key: Buffer,
  token: string | undefined,
  b: ConsentBinding,
  now = Date.now(),
): "ok" | "early" | "invalid" {
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token ?? "");
  if (!m) return "invalid";
  const at = Number(m[1]);
  const given = Buffer.from(m[2]!);
  const expected = Buffer.from(consentMac(key, at, b));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "invalid";
  if (now - at > CONSENT_MAX_MS || at - now > 5_000) return "invalid";
  return now - at < CONSENT_MIN_MS ? "early" : "ok";
}

/** Token requests per minute and grant: a client refreshes about once an access token's lifetime. */
const REFRESHES_PER_GRANT_PER_MIN = 10;

export function authorizationServerMetadata(cfg: OAuthConfig) {
  const i = cfg.issuer;
  return {
    issuer: i,
    // On the dashboard's host (RECALL_DASHBOARD_URL) when it has its own: consent needs its cookie.
    authorization_endpoint: cfg.authorizationEndpoint,
    token_endpoint: `${i}/oauth/token`,
    registration_endpoint: `${i}/oauth/register`,
    revocation_endpoint: `${i}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${i}/docs#mcp`,
  };
}

function protectedResourceMetadata(cfg: OAuthConfig, full: boolean) {
  return {
    resource: full ? `${cfg.resource}?profile=full` : cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Recall memory",
    resource_documentation: `${cfg.issuer}/docs#mcp`,
  };
}

/** A CSP `form-action` source for the redirect URI (the consent POST answers with a redirect there). */
function formActionSource(uri: string): string {
  const u = new URL(uri);
  // CSP host-source has no IPv6 literal syntax: fall back to the scheme for [::1].
  return u.hostname.startsWith("[") ? u.protocol : u.origin;
}

/** One value per authorization parameter; a repeated one is refused (OAuth 2.1 3.1). */
function singleParams(all: Record<string, string[]>): AuthzParams {
  const out: AuthzParams = {};
  for (const name of AUTHZ_PARAMS) {
    const values = all[name];
    if (!values?.length) continue;
    if (values.length > 1) throw new PageError(`The request repeats the parameter ${name}.`);
    out[name] = values[0];
  }
  return out;
}

const authorizePath = (p: AuthzParams) => {
  const q = new URLSearchParams();
  for (const name of AUTHZ_PARAMS) if (p[name] !== undefined) q.set(name, p[name]!);
  return `/oauth/authorize?${q.toString()}`;
};

/** Parameters of a token or revocation request (form-encoded, or JSON for lenient clients). */
async function requestParams(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  let raw: Record<string, unknown>;
  if (/^application\/x-www-form-urlencoded/i.test(type)) {
    raw = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  } else if (/^application\/json/i.test(type)) {
    try {
      raw = JSON.parse(await c.req.text()) as Record<string, unknown>;
    } catch {
      throw new OAuthError("invalid_request", "The body is not valid JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new OAuthError("invalid_request", "The body must be a JSON object");
  } else {
    throw new OAuthError(
      "invalid_request",
      "Send the parameters as application/x-www-form-urlencoded",
    );
  }
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(raw)) {
    if (Array.isArray(value)) throw new OAuthError("invalid_request", `Repeated parameter ${k}`);
    if (typeof value === "string") out[k] = value;
  }
  return out;
}

/** Validates request parameters with a Zod schema; failures are OAuth `invalid_request` errors. */
function parseParams<T extends z.ZodType>(schema: T, params: Record<string, string>): z.infer<T> {
  const parsed = schema.safeParse(params);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new OAuthError("invalid_request", issue.message);
}

const required = (name: string, max: number) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .max(max, `${name} is too long`);

const CodeGrant = z.object({
  grant_type: z.literal("authorization_code"),
  code: required("code", 200),
  redirect_uri: required("redirect_uri", 2000),
  client_id: required("client_id", 2000),
  code_verifier: required("code_verifier", 128),
  resource: required("resource", 2000),
});

const RefreshGrant = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: required("refresh_token", 200),
  client_id: required("client_id", 2000),
  resource: z.string().max(2000, "resource is too long").optional(),
  scope: z.string().max(1000, "scope is too long").optional(),
});

const Revocation = z.object({
  token: required("token", 200),
  token_type_hint: z.string().max(100).optional(),
  client_id: z.string().max(2000).optional(),
});

/** A client_id sent with HTTP Basic (RFC 6749 2.3.1); public clients have no secret, so it is ignored. */
function basicClientId(c: Context): string | undefined {
  const m = c.req.header("authorization")?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  try {
    return decodeURIComponent((colon >= 0 ? decoded.slice(0, colon) : decoded).replace(/\+/g, " "));
  } catch {
    throw new OAuthError("invalid_client", "Malformed Basic credentials", 401, {
      "WWW-Authenticate": 'Basic realm="recall"',
    });
  }
}

function clientIdOf(c: Context, params: Record<string, string>): Record<string, string> {
  const basic = basicClientId(c);
  if (basic === undefined) return params;
  if (params.client_id !== undefined && params.client_id !== basic)
    throw new OAuthError("invalid_request", "client_id differs from the Basic credentials");
  return { ...params, client_id: basic };
}

const nameOk = (v: string) => v.length > 0 && v.length <= NAME_MAX && NAME_PATTERN.test(v);
const NAME_RULE = `1-${NAME_MAX} characters of a-z, A-Z, 0-9, _ and -`;

export function register(app: App, ctx: AppContext): void {
  const cfg = ctx.config.hosted.oauth;
  if (!cfg.enabled) return;

  // ---- discovery ------------------------------------------------------------
  const cacheable = { "Cache-Control": "public, max-age=300" };
  const resourceMeta = (c: Context) =>
    c.json(
      protectedResourceMetadata(cfg, c.req.query("profile")?.toLowerCase() === "full"),
      200,
      cacheable,
    );
  app.get("/.well-known/oauth-protected-resource", resourceMeta);
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMeta);
  const serverMeta = (c: Context) => c.json(authorizationServerMetadata(cfg), 200, cacheable);
  app.get("/.well-known/oauth-authorization-server", serverMeta);
  app.get("/.well-known/openid-configuration", serverMeta);

  app.route("/oauth", oauthApp(ctx));
}

function oauthApp(ctx: AppContext): Hono<DashEnv> {
  const cfg = ctx.config.hosted.oauth;
  const app = new Hono<DashEnv>();
  const iss = cfg.issuer;

  const site = siteHome(ctx.config);
  const render = (
    c: Context<DashEnv>,
    status: number,
    title: string,
    body: ReturnType<typeof html>,
  ) =>
    c.html(
      v.page({ title, body, site, legal: ctx.config.hosted.legal, dash: c.get("dash") }),
      status as 200,
    );

  app.onError((err, c) => {
    if (err instanceof RedirectError) {
      const href = withParams(err.redirectUri, {
        error: err.error,
        error_description: err.description,
        state: err.state,
        iss,
      });
      // After the user acted on the consent form, back to the app; before that, only by their
      // click: a registered redirect URI is not trusted (anyone can register a client).
      if (c.req.method === "POST") return c.redirect(href, 303);
      return render(
        c,
        400,
        "Can't connect this app",
        authorizeErrorPage(`The app's request is not valid: ${err.description}.`, {
          href,
          host: new URL(err.redirectUri).host,
        }),
      );
    }
    if (err instanceof PageError)
      return render(c, 400, "Can't connect this app", authorizeErrorPage(err.message));
    if (err instanceof CsrfError)
      return render(
        c,
        403,
        "Form expired",
        authorizeErrorPage(
          "This form expired or came from another site. Go back to the app and connect again.",
        ),
      );
    if (err instanceof OAuthError)
      return c.json({ error: err.error, error_description: err.description }, err.status as 400, {
        ...NO_STORE,
        ...err.headers,
      });
    const onPage = c.req.path.endsWith("/authorize");
    if (err instanceof ApiError)
      return onPage
        ? render(c, err.status, "Can't connect this app", authorizeErrorPage(err.detail))
        : c.json({ error: "invalid_request", error_description: err.detail }, err.status as 400);
    ctx.log.error({ err, path: c.req.path }, "oauth error");
    return onPage
      ? render(c, 500, "Error", authorizeErrorPage("Something went wrong. Try again in a minute."))
      : c.json({ error: "server_error", error_description: "An unexpected error occurred" }, 500);
  });

  /**
   * Checks an authorization request. Client and redirect URI problems are
   * PageErrors; everything after that is a RedirectError. Returns null when
   * the client is a metadata document not fetched yet and `fetch` is off
   * (signed out: the fetch waits until a user has signed in).
   */
  const check = async (
    p: AuthzParams,
    opts: { fetch: boolean; userId?: string },
  ): Promise<AuthzRequest | null> => {
    const clientId = p.client_id;
    if (!clientId)
      throw new PageError("The request does not say which app is asking (no client_id).");
    let client: OAuthClient | null;
    try {
      client = await loadClient(ctx.db, clientId, {
        fetch: opts.fetch,
        onFetch: () => {
          // Fetches of client documents are made for signed-in users only, and limited per user.
          const wait = ctx.tenancy.limiter.take(`oauth-cimd:${opts.userId}`, 10);
          if (wait > 0)
            throw new ClientMetadataError("Too many app lookups: wait a minute and try again");
        },
      });
    } catch (err) {
      if (err instanceof ClientMetadataError) throw new PageError(err.message);
      throw err;
    }
    if (!client) {
      if (!opts.fetch && isClientIdUrl(clientId) && !clientIdUrlProblem(clientId)) return null;
      throw new PageError(
        "This app is not registered with Recall (unknown client_id). Remove the connector in the app and add it again.",
      );
    }
    const redirectUri = p.redirect_uri;
    if (!redirectUri) throw new PageError("The request has no redirect_uri.");
    if (!redirectUriAllowed(client.redirectUris, redirectUri))
      throw new PageError(
        "The app asked to send you to an address it did not register (redirect_uri mismatch).",
      );
    const fail = (error: string, description: string) =>
      new RedirectError(redirectUri, error, description, p.state);
    if (p.state !== undefined && p.state.length > 2000)
      throw fail("invalid_request", "state is too long");
    if (p.response_type !== "code")
      throw fail("unsupported_response_type", "Only response_type=code is supported");
    if (p.response_mode !== undefined && p.response_mode !== "query")
      throw fail("invalid_request", "Only response_mode=query is supported");
    if (!p.code_challenge)
      throw fail(
        "invalid_request",
        "PKCE is required: send code_challenge with code_challenge_method=S256",
      );
    if (p.code_challenge_method !== "S256")
      throw fail("invalid_request", "code_challenge_method must be S256");
    if (!CHALLENGE_SHAPE.test(p.code_challenge))
      throw fail("invalid_request", "code_challenge must be a base64url SHA-256 (43 characters)");
    if (!p.resource)
      throw fail("invalid_target", `resource is required (RFC 8707): use ${cfg.resource}`);
    if (canonicalResource(p.resource) !== cfg.resource)
      throw fail("invalid_target", `This server issues tokens only for ${cfg.resource}`);
    if (p.scope !== undefined && p.scope.length > 1000)
      throw fail("invalid_scope", "scope is too long");
    const carry: Record<string, string> = {};
    for (const name of AUTHZ_PARAMS) {
      if (name === "prompt") continue;
      if (p[name] !== undefined) carry[name] = p[name]!;
    }
    return {
      client,
      redirectUri,
      state: p.state,
      codeChallenge: p.code_challenge,
      resource: p.resource,
      carry,
    };
  };

  const toLogin = (c: Context<DashEnv>, p: AuthzParams) =>
    c.redirect(dashPath(`/login?next=${encodeURIComponent(authorizePath(p))}`), 303);

  // Small bodies only (the largest legitimate one is a registration of a few KB).
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        c.json(
          { error: "invalid_request", error_description: "The request body is too large" },
          413,
        ),
    }),
  );

  // ---- authorization endpoint (cookie-authenticated: the dashboard's sessions and CSRF) ----------
  app.use("/authorize", withDashboardBase(ctx.config));
  app.use("/authorize", securityHeaders(ctx.config.hosted.billing.customDomain));
  app.use("/authorize", loadDash(ctx));
  // A suspended account cannot connect apps (their tokens would be refused anyway).
  app.use("/authorize", refuseSuspended(site));
  app.use("/authorize", csrf(ctx));

  const consentKey = ctx.config.hosted.sessionSecret;
  const bindingOf = (dash: DashState, account: string, req: AuthzRequest): ConsentBinding => ({
    sessionId: dash.sessionId,
    account,
    clientId: req.client.id,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    resource: req.resource,
    state: req.state,
  });

  /** The consent screen for a checked request, for the account `wanted` (else the session's). */
  const showConsent = async (
    c: Context<DashEnv>,
    dash: DashState,
    req: AuthzRequest,
    wanted: string | undefined,
    opts: { status?: number; error?: string } = {},
  ) => {
    const accounts = await manageableAccounts(ctx.db, dash.userId);
    if (!accounts.length)
      throw new PageError(
        "Only owners and admins of a Recall account can connect apps to it. Ask an owner to connect the app, or to make you an admin.",
      );
    const account =
      accounts.find((a) => a.id === wanted) ??
      accounts.find((a) => a.id === dash.accountId) ??
      accounts[0]!;
    const workspaces = await workspaceNames(ctx.db, account.id);
    c.set("formAction", formActionSource(req.redirectUri));
    return c.html(
      v.page({
        title: "Connect an app",
        dash,
        site,
        legal: ctx.config.hosted.legal,
        error: opts.error,
        body: consentPage({
          csrf: dash.csrf,
          consent: consentToken(consentKey, bindingOf(dash, account.id, req)),
          email: dash.email,
          client: { id: req.client.id, name: req.client.name, kind: req.client.kind },
          redirectHost: new URL(req.redirectUri).host,
          loopback: isLoopbackRedirect(req.redirectUri),
          params: req.carry,
          accounts,
          account,
          workspaces,
          defaultWorkspace: workspaces[0] ?? "default",
        }),
      }),
      (opts.status ?? 200) as 200,
    );
  };

  app.get("/authorize", async (c) => {
    const p = singleParams(c.req.queries());
    const dash = c.get("dash");
    const req = await check(p, { fetch: !!dash, userId: dash?.userId });
    if (!dash) {
      if (req && p.prompt === "none")
        throw new RedirectError(req.redirectUri, "login_required", "Sign-in is required", p.state);
      return toLogin(c, p);
    }
    if (!req) throw new PageError("This app could not be identified.");
    if (p.prompt === "none")
      throw new RedirectError(req.redirectUri, "consent_required", "Approval is required", p.state);
    return showConsent(c, dash, req, c.req.query("account"));
  });

  app.post("/authorize", async (c) => {
    const f = c.get("form");
    const p: AuthzParams = {};
    for (const name of AUTHZ_PARAMS) if (f[name] !== undefined) p[name] = f[name];
    const dash = c.get("dash");
    if (!dash) return toLogin(c, p);
    const req = (await check(p, { fetch: true, userId: dash.userId }))!;
    if (f.decision !== "allow")
      throw new RedirectError(req.redirectUri, "access_denied", "The user declined", req.state);
    const accounts = await manageableAccounts(ctx.db, dash.userId);
    const account = accounts.find((a) => a.id === f.account);
    if (!account) throw new PageError("You cannot connect apps to that account.");
    // Rendered for this session, account and request, at least a second ago (double-click-jacking).
    const verdict = checkConsentToken(consentKey, f.consent, bindingOf(dash, account.id, req));
    if (verdict === "invalid") throw new CsrfError("consent token");
    if (verdict === "early")
      return showConsent(c, dash, req, account.id, {
        status: 400,
        error:
          "That was quicker than anyone can read the request. Check it, then choose Allow again.",
      });
    const defaultWorkspace = (f.default_workspace ?? "").trim();
    if (!nameOk(defaultWorkspace))
      throw new ApiError(
        422,
        `The default workspace must be ${NAME_RULE}. Go back and correct it.`,
      );
    let workspaces: string[] | null = null;
    if (f.access !== "all") {
      const picked = Object.entries(f)
        .filter(([k]) => /^ws_\d{1,4}$/.test(k))
        .map(([, w]) => w.trim());
      workspaces = [...new Set([defaultWorkspace, ...picked])];
      if (workspaces.length > 100) throw new ApiError(422, "Choose at most 100 workspaces.");
      const bad = workspaces.find((w) => !nameOk(w));
      if (bad !== undefined) throw new ApiError(422, `Workspace names are ${NAME_RULE}.`);
    }
    const peer = (f.default_peer ?? "").trim();
    if (peer && !nameOk(peer))
      throw new ApiError(422, `The default peer must be ${NAME_RULE}. Go back and correct it.`);
    const code = await createAuthorizationCode(
      ctx.db,
      {
        clientId: req.client.id,
        accountId: account.id,
        userId: dash.userId,
        redirectUri: req.redirectUri,
        codeChallenge: req.codeChallenge,
        resource: req.resource,
        scope: SCOPE,
        workspaces,
        defaultWorkspace,
        defaultPeer: peer || null,
        // An unticked checkbox sends nothing; the form renders it ticked.
        autoRemember: f.auto_remember === "1",
      },
      cfg.codeTtlMs,
    );
    ctx.log.info(
      { account: account.id, client: req.client.id, all: workspaces === null },
      "oauth app approved",
    );
    return c.redirect(withParams(req.redirectUri, { code, state: req.state, iss }), 303);
  });

  // ---- token, registration and revocation endpoints (no cookies) ------------------------------
  // A code replay or refresh-token reuse revokes a grant: its cached access tokens go at once.
  const forget = (grantId: string) => ctx.tenancy.oauth.forgetGrant(grantId);

  /**
   * Token endpoint limits (429 with Retry-After): per client network for every token and
   * revocation request, per client for code exchanges, and per grant for refreshes, which also
   * bounds how many rotated tokens a grant can pile up before the daily purge.
   */
  const limit = (key: string, perMin: number, what: string) => {
    const wait = ctx.tenancy.limiter.take(key, perMin);
    if (wait > 0)
      throw new OAuthError("too_many_requests", `Too many ${what}; try again shortly`, 429, {
        "Retry-After": String(Math.max(1, Math.ceil(wait))),
      });
  };
  const networkOf = (c: Context) => {
    const ip = clientIp(c, ctx.config.server.clientIp);
    return ip ? networkKey(ip) : null;
  };
  const limitNetwork = (c: Context) => {
    const network = networkOf(c);
    if (network) limit(`oauth-token:net:${network}`, cfg.tokenRatePerMin, "token requests");
  };

  app.post("/token", async (c) => {
    limitNetwork(c);
    const params = clientIdOf(c, await requestParams(c));
    const grantType = params.grant_type;
    if (!grantType) throw new OAuthError("invalid_request", "grant_type is required");
    let result: Awaited<ReturnType<typeof exchangeCode>>;
    if (grantType === "authorization_code") {
      const p = parseParams(CodeGrant, params);
      // Per client and network: a client id is public and shared by every user of that app (a
      // metadata URL), so a budget per client alone would let one network lock all of them out.
      limit(
        `oauth-token:client:${p.client_id}:${networkOf(c) ?? "unknown"}`,
        cfg.tokenRatePerMin,
        "code exchanges",
      );
      if (canonicalResource(p.resource) !== cfg.resource)
        throw new OAuthError(
          "invalid_target",
          `This server issues tokens only for ${cfg.resource}`,
        );
      result = await exchangeCode(
        ctx.db,
        {
          code: p.code,
          clientId: p.client_id,
          redirectUri: p.redirect_uri,
          verifier: p.code_verifier,
          resource: p.resource,
        },
        cfg,
        forget,
      );
    } else if (grantType === "refresh_token") {
      const p = parseParams(RefreshGrant, params);
      if (p.resource !== undefined && canonicalResource(p.resource) !== cfg.resource)
        throw new OAuthError(
          "invalid_target",
          `This server issues tokens only for ${cfg.resource}`,
        );
      const scopes = (p.scope ?? "").split(" ").filter(Boolean);
      if (scopes.some((s) => s !== SCOPE && s !== "offline_access"))
        throw new OAuthError("invalid_scope", `The only scope is ${SCOPE}`);
      // The grant is read from the token itself (MAC-checked, so nobody can spend another's budget).
      const grantId = refreshTokenGrant(p.refresh_token, cfg.tokenKey);
      if (grantId) limit(`oauth-token:grant:${grantId}`, REFRESHES_PER_GRANT_PER_MIN, "refreshes");
      result = await refreshTokens(
        ctx.db,
        { refreshToken: p.refresh_token, clientId: p.client_id },
        cfg,
        forget,
      );
    } else {
      throw new OAuthError(
        "unsupported_grant_type",
        "Supported grant types: authorization_code, refresh_token",
      );
    }
    return c.json(result.tokens, 200, NO_STORE);
  });

  app.post("/register", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > 20_000)
      throw new OAuthError("invalid_client_metadata", "The registration is too large");
    const text = await c.req.text();
    if (text.length > 20_000)
      throw new OAuthError("invalid_client_metadata", "The registration is too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "The body must be a JSON object");
    }
    const ip = clientIp(c, ctx.config.server.clientIp);
    // Per IPv6 /48: one customer's range should not register as thousands of networks.
    const network = ip ? networkKey(ip, 3) : null;
    const ipHash = network
      ? createHmac("sha256", ctx.config.hosted.sessionSecret)
          .update(`oauth-register:${network}`)
          .digest("hex")
      : null;
    const registration = await registerClient(ctx.db, body, {
      ipHash,
      perHour: cfg.registrationsPerHour,
    });
    ctx.log.info({ client: registration.client_id }, "oauth client registered");
    return c.json(registration, 201, NO_STORE);
  });

  app.post("/revoke", async (c) => {
    limitNetwork(c);
    const p = parseParams(Revocation, clientIdOf(c, await requestParams(c)));
    const grantId = await revokeToken(ctx.db, p.token, p.client_id ?? null);
    if (grantId) ctx.tenancy.oauth.forgetGrant(grantId);
    return c.body(null, 200, NO_STORE);
  });

  return app;
}
