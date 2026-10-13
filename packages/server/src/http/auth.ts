import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../context.js";
import { isApiKeyToken } from "../core/apikeys.js";
import { canonicalResource, isOAuthAccessToken } from "../core/oauth.js";
import { DEFAULT_ACCOUNT_ID, type WsKey, wsIs } from "../core/tenancy.js";
import { rows } from "../db/client.js";
import { ApiError, tooManyRequests, unauthorized } from "../lib/errors.js";
import { networkKey } from "../lib/network.js";
import { clientIp } from "./common.js";

/** JWT claims (Honcho-compatible short names). */
export interface Claims {
  t?: string;
  exp?: number;
  ad?: boolean;
  w?: string;
  p?: string;
  s?: string;
}

export interface AuthState {
  /**
   * True when auth is disabled or the credential is an admin one (an `ad` JWT,
   * or an API key without scope). Admin rights never reach beyond `account`.
   */
  admin: boolean;
  /** Scope (w/p/s); API keys carry the same claims as the JWT they replace. */
  claims: Claims;
  /** The tenant every workspace lookup of this request is scoped to. */
  account: string;
  /**
   * How the caller authenticated. "dashboard": a signed-in /app user, acting with
   * the rights of an unscoped key of their own account (never another's).
   * "oauth": an OAuth access token (MCP endpoint only), with the claims an API
   * key of the same reach would carry.
   */
  via: "open" | "jwt" | "api_key" | "dashboard" | "oauth";
  /** The API key's id and mode when `via` is "api_key". */
  keyId?: string;
  keyMode?: "live" | "test";
  /** OAuth: the grant (approved connection) the token belongs to. */
  grantId?: string;
  /**
   * OAuth grant for several workspaces: all of them (`claims.w` is the default
   * one). Unset for every other credential, whose reach is `claims` alone.
   */
  workspaces?: string[];
  /** OAuth: the connection defaults chosen on the consent screen. */
  defaults?: { workspace: string; peer: string | null; autoRemember: boolean };
}

/** May this caller act on workspace `name` (of its own account)? */
export function canUseWorkspace(auth: AuthState, name: string): boolean {
  return auth.admin || auth.claims.w === name || !!auth.workspaces?.includes(name);
}

/** The workspace named in the route (`:workspace_id`), within the caller's account. */
export function wsOf(c: Context<AppEnv>, name: string = c.req.param("workspace_id") ?? ""): WsKey {
  return { account: c.get("auth").account, name };
}

export type AppEnv = { Variables: { auth: AuthState } };

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function signToken(claims: Claims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const clean = Object.fromEntries(Object.entries(claims).filter(([, v]) => v != null));
  const payload = b64url(JSON.stringify(clean));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token: string, secret: string): Claims {
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized("Invalid JWT");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: Claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    throw unauthorized("Invalid JWT");
  }
  if (header.alg !== "HS256") throw unauthorized("Invalid JWT");
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw unauthorized("Invalid JWT");
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now())
    throw unauthorized("JWT expired");
  for (const k of ["w", "p", "s"] as const) if (claims[k] === "") delete claims[k];
  if ((claims.p || claims.s) && !claims.w) {
    throw unauthorized("Invalid JWT scope: peer/session token missing workspace");
  }
  return claims;
}

export interface RoutePolicy {
  /** Admin-only route (e.g. POST /v3/keys, POST /v3/workspaces/list). */
  admin?: boolean;
  /** Handler compares claims against body data itself (the three get-or-create routes). */
  selfAuthorizing?: boolean;
  /** Read-only session route a peer token may use for sessions it is an active member of. */
  memberRead?: boolean;
  /** Accepts OAuth access tokens (the MCP endpoint, which they are audience-bound to). */
  oauth?: boolean;
}

async function isActiveMember(app: AppContext, workspace: WsKey, session: string, peer: string) {
  const found = await rows<{ ok: number }>(
    app.db,
    sql`SELECT 1 AS ok FROM session_peers sp
        JOIN sessions s ON s.id = sp.session_id
        JOIN peers p ON p.id = sp.peer_id
        JOIN workspaces w ON w.id = s.workspace_id
        WHERE ${wsIs(workspace)} AND s.name = ${session} AND p.name = ${peer} AND sp.left_at IS NULL
        LIMIT 1`,
  );
  return found.length > 0;
}

/**
 * An OAuth access token: only where the route accepts them, only for this
 * server's MCP resource (RFC 8707 audience), rate limited per grant like a key.
 * A grant for every workspace is an account-admin key's reach; otherwise the
 * token is scoped to its default workspace, plus any others in the grant.
 */
async function authenticateOAuth(
  app: AppContext,
  token: string,
  policy: RoutePolicy,
): Promise<AuthState> {
  if (!policy.oauth)
    throw unauthorized("OAuth access tokens are accepted only at the MCP endpoint");
  const access = await app.tenancy.oauth.verify(token);
  if (canonicalResource(access.resource) !== app.config.hosted.oauth.resource)
    throw unauthorized("This access token was issued for another resource");
  const limit = app.config.tenancy.keyRateLimitPerMin;
  const wait = app.tenancy.limiter.take(`oauth:${access.grantId}`, limit);
  if (wait > 0) throw tooManyRequests(wait, `Rate limit exceeded (${limit} requests per minute)`);
  const all = access.workspaces === null;
  const extra = access.workspaces?.filter((w) => w !== access.defaultWorkspace) ?? [];
  return {
    admin: all,
    claims: all ? { ad: true } : { w: access.defaultWorkspace },
    account: access.accountId,
    via: "oauth",
    grantId: access.grantId,
    ...(extra.length ? { workspaces: [access.defaultWorkspace, ...extra] } : {}),
    defaults: {
      workspace: access.defaultWorkspace,
      peer: access.defaultPeer,
      autoRemember: access.autoRemember,
    },
  };
}

/**
 * Resolves the bearer credential: `pk_...` is a customer API key (account from
 * the key, per-key rate limit), `oat_...` an OAuth access token (hosted MCP
 * endpoint only), anything else the Honcho-compatible JWT (the default
 * account). With auth disabled every caller is admin of the default account.
 */
export async function authenticate(
  app: AppContext,
  c: Context<AppEnv>,
  policy: RoutePolicy = {},
): Promise<AuthState> {
  if (!app.config.auth.enabled) {
    return { admin: true, claims: { ad: true }, account: DEFAULT_ACCOUNT_ID, via: "open" };
  }
  const header = c.req.header("authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) throw unauthorized("No access token provided");
  // OAuth access tokens are left out of the failure budget: an expired one is how a client
  // learns to refresh, and connector traffic shares a few networks (Anthropic's, OpenAI's).
  if (app.config.hosted.oauth.enabled && isOAuthAccessToken(token))
    return authenticateOAuth(app, token, policy);
  return limitFailures(app, c, "api", () => verifyCredential(app, token));
}

/** An API key or Honcho JWT (OAuth tokens are handled before). */
async function verifyCredential(app: AppContext, token: string): Promise<AuthState> {
  if (!isApiKeyToken(token)) {
    const claims = verifyToken(token, app.config.auth.secret!);
    return { admin: !!claims.ad, claims, account: DEFAULT_ACCOUNT_ID, via: "jwt" };
  }
  const key = await app.tenancy.keys.verify(token);
  const limit = key.rateLimitPerMin ?? app.config.tenancy.keyRateLimitPerMin;
  const wait = app.tenancy.limiter.take(key.id, limit);
  if (wait > 0) throw tooManyRequests(wait, `Rate limit exceeded (${limit} requests per minute)`);
  const claims: Claims = {
    ...(key.workspace ? { w: key.workspace } : {}),
    ...(key.peer ? { p: key.peer } : {}),
    ...(key.session ? { s: key.session } : {}),
  };
  const admin = !key.workspace && !key.peer && !key.session;
  return {
    admin,
    claims: admin ? { ...claims, ad: true } : claims,
    account: key.accountId,
    via: "api_key",
    keyId: key.id,
    keyMode: key.mode,
  };
}

/**
 * Route authorization, reproducing Honcho's resolution order exactly: every
 * denial is a 401 (never 403) so existing SDK error handling keeps working.
 * API key scopes go through the same rules as JWT claims.
 */
export function guard(app: AppContext, policy: RoutePolicy = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = await authenticate(app, c, policy);
    c.set("auth", auth);
    if (auth.admin) return next();
    const { claims } = auth;
    if (policy.admin) throw unauthorized("Resource requires admin privileges");
    if (policy.selfAuthorizing) return next();

    const workspace = c.req.param("workspace_id");
    const peer = c.req.param("peer_id");
    const session = c.req.param("session_id");
    if (workspace !== undefined && claims.w !== workspace) throw unauthorized();
    if (claims.s) {
      if (session !== undefined && session === claims.s) return next();
      throw unauthorized();
    }
    if (claims.p) {
      if (peer !== undefined && peer === claims.p) return next();
      if (
        policy.memberRead &&
        workspace &&
        session &&
        (await isActiveMember(app, wsOf(c, workspace), session, claims.p))
      ) {
        return next();
      }
      throw unauthorized();
    }
    if (claims.w) return next();
    throw unauthorized();
  };
}

/** For self-authorizing handlers: may this request act on `workspace` (and optionally a peer/session id)? */
export function assertScope(
  c: Context<AppEnv>,
  workspace: string,
  opts: { peer?: string; session?: string } = {},
) {
  const { admin, claims } = c.get("auth");
  if (admin) return;
  if (claims.w !== workspace) throw unauthorized();
  if (claims.s) {
    if (opts.session !== claims.s) throw unauthorized();
    return;
  }
  if (claims.p && opts.peer !== claims.p) throw unauthorized();
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Failed operator-token attempts (admin API, metrics) per minute per client network. */
export const OPERATOR_FAILURES_PER_MIN = 10;

/**
 * Runs a credential check under a per-network budget of failures: each 401 it
 * throws spends one, and once the budget is spent further failures are answered
 * 429 (with Retry-After) until it refills. Unknown addresses are not limited.
 *
 * API credentials are always checked, so bad keys sent from a shared network (an office
 * NAT, a serverless platform, a connector's egress) cannot lock out the valid keys used
 * there; guessing stays pointless at 190 bits. The operator token is not checked at all
 * while its budget is spent.
 */
export async function limitFailures<T>(
  app: AppContext,
  c: Context,
  kind: "api" | "operator",
  check: () => T | Promise<T>,
): Promise<T> {
  const perMin =
    kind === "operator" ? OPERATOR_FAILURES_PER_MIN : app.config.tenancy.authFailuresPerMin;
  const ip = perMin > 0 ? clientIp(c, app.config.server.clientIp) : null;
  const network = ip ? networkKey(ip) : null;
  const key = network ? `auth-fail:${kind}:${network}` : null;
  const failures = app.tenancy.failures;
  const refuse = (wait: number) =>
    tooManyRequests(wait, "Too many failed authentication attempts; try again later");
  if (key && kind === "operator") {
    const wait = failures.peek(key, perMin);
    if (wait > 0) throw refuse(wait);
  }
  try {
    return await check();
  } catch (err) {
    if (key && err instanceof ApiError && err.status === 401) {
      const spent = failures.peek(key, perMin);
      if (spent > 0) throw refuse(spent);
      failures.take(key, perMin);
    }
    throw err;
  }
}

/**
 * The per-credential ceiling on chat (the LLM-heavy calls), so a leaked key
 * cannot spend an account's credit in seconds: per API key, OAuth connection or
 * dashboard account. Honcho JWTs (self-hosted) are not limited.
 */
export function limitChat(app: AppContext, auth: AuthState): void {
  const perMin = app.config.tenancy.chatRateLimitPerMin;
  const who = auth.keyId
    ? `key:${auth.keyId}`
    : auth.grantId
      ? `oauth:${auth.grantId}`
      : auth.via === "dashboard"
        ? `dashboard:${auth.account}`
        : null;
  if (!who || perMin <= 0) return;
  const wait = app.tenancy.limiter.take(`chat:${who}`, perMin);
  if (wait > 0)
    throw tooManyRequests(wait, `Chat rate limit exceeded (${perMin} questions per minute)`);
}

/** The operator's credential: `Authorization: Bearer $RECALL_ADMIN_TOKEN` (401 otherwise). */
export async function requireOperator(app: AppContext, c: Context): Promise<void> {
  const expected = app.config.tenancy.adminToken;
  const given = c.req
    .header("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!given) throw unauthorized("No access token provided");
  await limitFailures(app, c, "operator", () => {
    if (!expected || !safeEqual(given, expected)) throw unauthorized("Invalid admin token");
  });
}
