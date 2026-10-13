import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { OAuthConfig } from "../config.js";
import { type Db, rows } from "../db/client.js";
import { accountSuspended, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { markFirstApp } from "./milestones.js";
import { OAuthError, textArray } from "./oauth-clients.js";
import { sha256hex } from "./users.js";

/**
 * Authorization codes, grants and tokens of the MCP authorization server.
 *
 * - Codes (`oac_...`) are single use and live 60 seconds. They carry the
 *   consent (account, workspaces, defaults), the PKCE S256 challenge, the exact
 *   redirect URI and the RFC 8707 resource. A replayed code revokes the grant
 *   it produced.
 * - A grant is one approved connection (one token family). Access tokens
 *   (`oat_...`, 1 hour) and refresh tokens (`ort_...`) belong to it; a refresh
 *   token works once, and presenting a used one again revokes the whole grant.
 * - A refresh token names its grant and carries a MAC over both
 *   (`ort_<random>.<grant id>.<mac>`), so a spent one is recognised as this
 *   grant's even after its row is purged (a day after use): reuse detection
 *   does not depend on keeping every used token, and storage per grant stays
 *   small however often a client refreshes.
 * - Everything secret is stored as SHA-256 only. Access tokens resolve to the
 *   same claims an API key of the same reach would carry (see http/auth.ts).
 */

type Executor = Pick<Db, "execute">;

const ACCESS_PREFIX = "oat_";
const REFRESH_PREFIX = "ort_";
const CODE_PREFIX = "oac_";
const SECRET_SHAPE = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
const ACCESS_SHAPE = SECRET_SHAPE(ACCESS_PREFIX);
const CODE_SHAPE = SECRET_SHAPE(CODE_PREFIX);
const REFRESH_SHAPE = /^ort_([A-Za-z0-9_-]{43})\.(og_[A-Za-z0-9_-]{21})\.([A-Za-z0-9_-]{43})$/;
const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

const refreshMac = (key: Buffer, random: string, grantId: string) =>
  createHmac("sha256", key).update(`refresh:${random}.${grantId}`).digest("base64url");

function newRefreshToken(key: Buffer, grantId: string): string {
  const random = randomBytes(32).toString("base64url");
  return `${REFRESH_PREFIX}${random}.${grantId}.${refreshMac(key, random, grantId)}`;
}

/**
 * The grant a refresh token was issued for, when its MAC proves this server
 * issued it (null otherwise). Says nothing about whether it is still valid.
 */
export function refreshTokenGrant(token: string, key: Buffer): string | null {
  const m = REFRESH_SHAPE.exec(token);
  if (!m) return null;
  const given = Buffer.from(m[3]!);
  const expected = Buffer.from(refreshMac(key, m[1]!, m[2]!));
  return given.length === expected.length && timingSafeEqual(given, expected) ? m[2]! : null;
}

export const isOAuthAccessToken = (token: string): boolean => token.startsWith(ACCESS_PREFIX);

/** PKCE (RFC 7636): an S256 challenge is 43 base64url characters; a verifier 43-128 unreserved ones. */
export const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/;

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_SHAPE.test(verifier) || !CHALLENGE_SHAPE.test(challenge)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * An RFC 8707 resource reduced for comparison: origin (lowercased scheme and
 * host, default port dropped) plus path without a trailing slash. A query is
 * allowed only to select the MCP tool profile; fragments and credentials make
 * it invalid (null).
 */
export function canonicalResource(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000 || raw.includes("#"))
    return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (!["", "?profile=full", "?profile=default"].includes(u.search)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

// ---------------------------------------------------------------------------
// Consent → authorization code

export interface Consent {
  clientId: string;
  accountId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  /** null: every workspace of the account (an account-admin key's reach). */
  workspaces: string[] | null;
  defaultWorkspace: string;
  defaultPeer: string | null;
  /** The connection's MCP instructions ask the app to save lasting facts without being asked. */
  autoRemember: boolean;
}

/** Issues a single-use authorization code for an approved request. */
export async function createAuthorizationCode(
  db: Executor,
  consent: Consent,
  ttlMs: number,
): Promise<string> {
  const code = newSecret(CODE_PREFIX);
  await db.execute(
    sql`INSERT INTO oauth_codes (id, code_hash, client_id, account_id, user_id, redirect_uri,
                                 code_challenge, resource, scope, workspaces, default_workspace,
                                 default_peer, auto_remember, expires_at)
        VALUES (${`oc_${newId()}`}, ${sha256hex(code)}, ${consent.clientId}, ${consent.accountId},
                ${consent.userId}, ${consent.redirectUri}, ${consent.codeChallenge},
                ${consent.resource}, ${consent.scope},
                ${consent.workspaces ? textArray(consent.workspaces) : null},
                ${consent.defaultWorkspace}, ${consent.defaultPeer}, ${consent.autoRemember},
                ${new Date(Date.now() + ttlMs)})`,
  );
  await db.execute(
    sql`UPDATE oauth_clients SET last_used_at = now() WHERE id = ${consent.clientId}`,
  );
  return code;
}

// ---------------------------------------------------------------------------
// Token endpoint

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function issueTokens(
  tx: Executor,
  grantId: string,
  scope: string,
  cfg: Pick<OAuthConfig, "accessTtlMs" | "refreshTtlMs" | "tokenKey">,
): Promise<TokenResponse> {
  const access = newSecret(ACCESS_PREFIX);
  const refresh = newRefreshToken(cfg.tokenKey, grantId);
  const now = Date.now();
  await tx.execute(
    sql`INSERT INTO oauth_tokens (id, token_hash, grant_id, kind, expires_at) VALUES
          (${`ot_${newId()}`}, ${sha256hex(access)}, ${grantId}, 'access', ${new Date(now + cfg.accessTtlMs)}),
          (${`ot_${newId()}`}, ${sha256hex(refresh)}, ${grantId}, 'refresh', ${new Date(now + cfg.refreshTtlMs)})`,
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(cfg.accessTtlMs / 1000),
    refresh_token: refresh,
    scope,
  };
}

const MANAGER = sql`m.role IN ('owner', 'admin')`;

async function stillManager(db: Executor, accountId: string, userId: string): Promise<boolean> {
  const found = await rows<{ ok: number }>(
    db,
    sql`SELECT 1 AS ok FROM account_members m
        WHERE m.account_id = ${accountId} AND m.user_id = ${userId} AND ${MANAGER}`,
  );
  return found.length > 0;
}

interface CodeRow {
  id: string;
  client_id: string;
  account_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  workspaces: string[] | null;
  default_workspace: string;
  default_peer: string | null;
  auto_remember: boolean;
  expired: boolean;
}

/**
 * Called with a grant this module has just revoked (code replay, refresh-token
 * reuse), so the caller can drop the grant's cached access tokens at once.
 */
export type OnRevoke = (grantId: string) => void;

/**
 * `grant_type=authorization_code`. The caller has checked that every parameter
 * is present and that `resource` names this server. The code is spent by this
 * call whatever the outcome, so a stolen code tried with a wrong verifier is
 * dead for its rightful owner too (who simply authorizes again).
 */
export async function exchangeCode(
  db: Db,
  p: { code: string; clientId: string; redirectUri: string; verifier: string; resource: string },
  cfg: OAuthConfig,
  onRevoke: OnRevoke = () => {},
): Promise<{ tokens: TokenResponse; grantId: string }> {
  if (!CODE_SHAPE.test(p.code)) throw new OAuthError("invalid_grant", "Unknown authorization code");
  const hash = sha256hex(p.code);
  const [code] = await rows<CodeRow>(
    db,
    sql`UPDATE oauth_codes SET used_at = now() WHERE code_hash = ${hash} AND used_at IS NULL
        RETURNING id, client_id, account_id, user_id, redirect_uri, code_challenge, resource, scope,
                  workspaces, default_workspace, default_peer, auto_remember,
                  expires_at <= now() AS expired`,
  );
  if (!code) {
    // Used before: a replay. Revoke whatever the first use produced (RFC 6749 4.1.2).
    const [spent] = await rows<{ grant_id: string | null }>(
      db,
      sql`UPDATE oauth_codes SET replayed_at = COALESCE(replayed_at, now()) WHERE code_hash = ${hash}
          RETURNING grant_id`,
    );
    if (spent?.grant_id) {
      await revokeGrant(db, spent.grant_id, { reason: "code_replay" });
      onRevoke(spent.grant_id);
    }
    throw new OAuthError(
      "invalid_grant",
      spent ? "The authorization code was already used" : "Unknown authorization code",
    );
  }
  if (code.expired) throw new OAuthError("invalid_grant", "The authorization code has expired");
  if (code.client_id !== p.clientId)
    throw new OAuthError("invalid_grant", "The authorization code was issued to another client");
  if (code.redirect_uri !== p.redirectUri)
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  if (!pkceMatches(p.verifier, code.code_challenge))
    throw new OAuthError("invalid_grant", "code_verifier does not match the code_challenge");
  if (canonicalResource(p.resource) !== canonicalResource(code.resource))
    throw new OAuthError("invalid_target", "resource does not match the authorization request");

  return db.transaction(async (tx: Tx) => {
    if (!(await stillManager(tx, code.account_id, code.user_id)))
      throw new OAuthError("invalid_grant", "The approving user can no longer manage this account");
    const grantId = `og_${newId()}`;
    await tx.execute(
      sql`INSERT INTO oauth_grants (id, account_id, user_id, client_id, redirect_uri, resource, scope,
                                    workspaces, default_workspace, default_peer, auto_remember,
                                    last_used_at)
          VALUES (${grantId}, ${code.account_id}, ${code.user_id}, ${code.client_id},
                  ${code.redirect_uri}, ${code.resource}, ${code.scope},
                  ${code.workspaces ? textArray(code.workspaces) : null}, ${code.default_workspace},
                  ${code.default_peer}, ${code.auto_remember}, now())`,
    );
    // A replay that raced this exchange wins: no grant comes out of a replayed code.
    const [linked] = await rows<{ id: string }>(
      tx,
      sql`UPDATE oauth_codes SET grant_id = ${grantId} WHERE id = ${code.id} AND replayed_at IS NULL
          RETURNING id`,
    );
    if (!linked) throw new OAuthError("invalid_grant", "The authorization code was already used");
    await tx.execute(
      sql`UPDATE oauth_clients SET last_used_at = now() WHERE id = ${code.client_id}`,
    );
    // The account's first connected app, for the operator's activation funnel (grants are purged later).
    await markFirstApp(tx, code.account_id);
    return { tokens: await issueTokens(tx, grantId, code.scope, cfg), grantId };
  });
}

/**
 * `grant_type=refresh_token`, with rotation: the presented token is spent and a
 * new pair is issued. A spent token presented again means two parties hold it,
 * so the whole grant is revoked (OAuth 2.1 4.3.1; RFC 9700 4.14.2).
 */
export async function refreshTokens(
  db: Db,
  p: { refreshToken: string; clientId: string },
  cfg: OAuthConfig,
  onRevoke: OnRevoke = () => {},
): Promise<{ tokens: TokenResponse; grantId: string }> {
  if (!REFRESH_SHAPE.test(p.refreshToken))
    throw new OAuthError("invalid_grant", "Unknown refresh token");
  const hash = sha256hex(p.refreshToken);
  const [spent] = await rows<{ id: string; grant_id: string; expired: boolean }>(
    db,
    sql`UPDATE oauth_tokens SET used_at = now()
        WHERE token_hash = ${hash} AND kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL
        RETURNING id, grant_id, expires_at <= now() AS expired`,
  );
  if (!spent) {
    const [seen] = await rows<{ grant_id: string; used_at: Date | string | null }>(
      db,
      sql`SELECT grant_id, used_at FROM oauth_tokens WHERE token_hash = ${hash} AND kind = 'refresh'`,
    );
    // A used token, still stored or (MAC-verified) purged since: a grant has one unused refresh
    // token at a time, so any other token of it was spent, and two parties hold this one.
    const reused = seen
      ? seen.used_at
        ? seen.grant_id
        : null
      : refreshTokenGrant(p.refreshToken, cfg.tokenKey);
    if (reused && (await revokeGrant(db, reused, { reason: "refresh_token_reuse" }))) {
      onRevoke(reused);
      throw new OAuthError(
        "invalid_grant",
        "This refresh token was already used: the connection has been revoked, authorize again",
      );
    }
    throw new OAuthError("invalid_grant", seen ? "Refresh token revoked" : "Unknown refresh token");
  }
  if (spent.expired) throw new OAuthError("invalid_grant", "The refresh token has expired");

  return db.transaction(async (tx: Tx) => {
    const [grant] = await rows<{
      client_id: string;
      account_id: string;
      user_id: string;
      scope: string;
      revoked_at: Date | string | null;
    }>(
      tx,
      sql`SELECT client_id, account_id, user_id, scope, revoked_at FROM oauth_grants
          WHERE id = ${spent.grant_id} FOR UPDATE`,
    );
    if (!grant || grant.revoked_at)
      throw new OAuthError("invalid_grant", "This connection has been revoked");
    if (grant.client_id !== p.clientId)
      throw new OAuthError("invalid_grant", "The refresh token was issued to another client");
    if (!(await stillManager(tx, grant.account_id, grant.user_id)))
      throw new OAuthError("invalid_grant", "The approving user can no longer manage this account");
    await tx.execute(
      sql`UPDATE oauth_grants SET last_used_at = now() WHERE id = ${spent.grant_id}`,
    );
    return {
      tokens: await issueTokens(tx, spent.grant_id, grant.scope, cfg),
      grantId: spent.grant_id,
    };
  });
}

/**
 * RFC 7009 revocation. A refresh token revokes its grant (and so every access
 * token of it); an access token revokes itself. Unknown tokens are not an
 * error. With `clientId`, the token must have been issued to that client.
 * Returns the affected grant so its cached tokens can be dropped.
 */
export async function revokeToken(
  db: Executor,
  token: string,
  clientId: string | null,
): Promise<string | null> {
  if (!ACCESS_SHAPE.test(token) && !REFRESH_SHAPE.test(token)) return null;
  const [t] = await rows<{
    id: string;
    kind: "access" | "refresh";
    grant_id: string;
    client_id: string;
  }>(
    db,
    sql`SELECT t.id, t.kind, t.grant_id, g.client_id FROM oauth_tokens t
        JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ${sha256hex(token)}`,
  );
  if (!t) return null;
  if (clientId && clientId !== t.client_id)
    throw new OAuthError("invalid_request", "The token was not issued to this client");
  if (t.kind === "refresh") await revokeGrant(db, t.grant_id, { reason: "client_revoked" });
  else
    await db.execute(
      sql`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${t.id}`,
    );
  return t.grant_id;
}

/** Revokes a grant (idempotent). With `accountId`, only a grant of that account. */
export async function revokeGrant(
  db: Executor,
  grantId: string,
  opts: { accountId?: string; reason: string },
): Promise<boolean> {
  const found = await rows<{ id: string }>(
    db,
    sql`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()),
                                revoked_reason = COALESCE(revoked_reason, ${opts.reason})
        WHERE id = ${grantId} ${opts.accountId ? sql`AND account_id = ${opts.accountId}` : sql``}
        RETURNING id`,
  );
  return found.length > 0;
}

// ---------------------------------------------------------------------------
// Dashboard

export interface GrantOut {
  id: string;
  client_id: string;
  client_name: string;
  client_kind: "registered" | "metadata_document";
  redirect_host: string;
  approved_by: string;
  scope: string;
  workspaces: string[] | null;
  default_workspace: string;
  default_peer: string | null;
  auto_remember: boolean;
  created_at: string;
  last_used_at: string | null;
  /** Set on revoked grants, which are kept 30 days (listed only with `includeRevoked`). */
  revoked_at: string | null;
  revoked_reason: string | null;
}

const isoOf = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/**
 * The account's connected apps: grants not revoked, or with `includeRevoked`
 * (the GDPR export) every grant still stored.
 */
export async function listGrants(
  db: Executor,
  accountId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<GrantOut[]> {
  const found = await rows<{
    id: string;
    client_id: string;
    client_name: string;
    client_kind: "registered" | "metadata_document";
    redirect_uri: string;
    email: string | null;
    scope: string;
    workspaces: string[] | null;
    default_workspace: string;
    default_peer: string | null;
    auto_remember: boolean;
    created_at: Date | string;
    last_used_at: Date | string | null;
    revoked_at: Date | string | null;
    revoked_reason: string | null;
  }>(
    db,
    sql`SELECT g.id, g.client_id, c.name AS client_name, c.kind AS client_kind, g.redirect_uri,
               u.email, g.scope, g.workspaces, g.default_workspace, g.default_peer,
               g.auto_remember, g.created_at,
               g.last_used_at, g.revoked_at, g.revoked_reason
        FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
        LEFT JOIN users u ON u.id = g.user_id
        WHERE g.account_id = ${accountId} ${opts.includeRevoked ? sql`` : sql`AND g.revoked_at IS NULL`}
        ORDER BY g.created_at DESC, g.id`,
  );
  return found.map((r) => ({
    id: r.id,
    client_id: r.client_id,
    client_name: r.client_name || hostOf(r.redirect_uri),
    client_kind: r.client_kind,
    redirect_host: hostOf(r.redirect_uri),
    approved_by: r.email ?? "",
    scope: r.scope,
    workspaces: r.workspaces,
    default_workspace: r.default_workspace,
    default_peer: r.default_peer,
    auto_remember: r.auto_remember,
    created_at: isoOf(r.created_at)!,
    last_used_at: isoOf(r.last_used_at),
    revoked_at: isoOf(r.revoked_at),
    revoked_reason: r.revoked_reason,
  }));
}

/** Accounts the user may connect apps to: those they own or administer (who may also create API keys). */
/** Turns "Remember automatically" on or off for one of the account's connected apps. */
export async function setAutoRemember(
  db: Executor,
  accountId: string,
  grantId: string,
  on: boolean,
): Promise<boolean> {
  const updated = await rows<{ id: string }>(
    db,
    sql`UPDATE oauth_grants SET auto_remember = ${on}
        WHERE id = ${grantId} AND account_id = ${accountId} AND revoked_at IS NULL RETURNING id`,
  );
  return updated.length > 0;
}

export async function manageableAccounts(
  db: Executor,
  userId: string,
): Promise<{ id: string; name: string; role: string }[]> {
  return rows<{ id: string; name: string; role: string }>(
    db,
    sql`SELECT a.id, a.name, m.role FROM account_members m JOIN accounts a ON a.id = m.account_id
        WHERE m.user_id = ${userId} AND ${MANAGER} ORDER BY a.name, a.id`,
  );
}

/** Workspace names of an account, for the consent screen. */
export async function workspaceNames(db: Executor, accountId: string, limit = 100) {
  const found = await rows<{ name: string }>(
    db,
    sql`SELECT name FROM workspaces WHERE account_id = ${accountId} ORDER BY name LIMIT ${limit}`,
  );
  return found.map((r) => r.name);
}

/**
 * Housekeeping: spent codes, expired tokens, refresh tokens used more than a
 * day ago (their reuse is still detected through the MAC that ties them to
 * their grant), grants revoked a month ago or with no usable token left, and
 * clients nobody uses (never used after a day, or unused for 90 days with no
 * grant left). With the token endpoint's per-grant rate limit, a grant holds at
 * most one day of rotations.
 */
export async function purgeOAuth(db: Executor): Promise<void> {
  await db.execute(sql`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);
  await db.execute(
    sql`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'
          OR (kind = 'refresh' AND used_at < now() - interval '1 day')`,
  );
  await db.execute(
    sql`DELETE FROM oauth_grants g WHERE g.revoked_at < now() - interval '30 days'
          OR (g.created_at < now() - interval '1 day'
              AND NOT EXISTS (SELECT 1 FROM oauth_tokens t
                              WHERE t.grant_id = g.id AND t.expires_at > now()
                                AND t.used_at IS NULL AND t.revoked_at IS NULL))`,
  );
  await db.execute(
    sql`DELETE FROM oauth_clients c
        WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM oauth_codes x WHERE x.client_id = c.id)
          AND ((c.last_used_at IS NULL AND c.created_at < now() - interval '1 day')
               OR c.last_used_at < now() - interval '90 days')`,
  );
}

// ---------------------------------------------------------------------------
// Resource server: access token verification

/** What /mcp needs from a verified access token. */
export interface VerifiedAccess {
  grantId: string;
  accountId: string;
  clientId: string;
  resource: string;
  workspaces: string[] | null;
  defaultWorkspace: string;
  defaultPeer: string | null;
  autoRemember: boolean;
}

interface CachedAccess {
  access: VerifiedAccess | null;
  expiresAt: number;
  revoked: boolean;
  /** The grant's account is suspended by the operator. */
  suspended: boolean;
  until: number;
}

const TOUCH_EVERY_MS = 60_000;
const MAX_CACHED = 20_000;

/**
 * Verifies `oat_` access tokens: SHA-256 lookup joined with the grant and the
 * approving user's membership, cached in-process like API keys. A revocation
 * from another process is seen within `ttlMs`; in this one immediately.
 */
export class OAuthTokenVerifier {
  private readonly cache = new Map<string, CachedAccess>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Executor,
    private readonly ttlMs: number,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async verify(token: string, now = Date.now()): Promise<VerifiedAccess> {
    if (!ACCESS_SHAPE.test(token)) throw unauthorized("Invalid access token");
    const hash = sha256hex(token);
    let entry = this.cache.get(hash);
    if (!entry || entry.until <= now) {
      const [r] = await rows<{
        grant_id: string;
        account_id: string;
        client_id: string;
        resource: string;
        workspaces: string[] | null;
        default_workspace: string;
        default_peer: string | null;
        auto_remember: boolean;
        expires_at: Date | string;
        revoked: boolean;
        suspended: boolean | null;
      }>(
        this.db,
        sql`SELECT g.id AS grant_id, g.account_id, g.client_id, g.resource, g.workspaces,
                   g.default_workspace, g.default_peer, g.auto_remember, t.expires_at,
                   (SELECT a.suspended_at IS NOT NULL FROM accounts a WHERE a.id = g.account_id) AS suspended,
                   (t.revoked_at IS NOT NULL OR g.revoked_at IS NOT NULL OR NOT EXISTS (
                      SELECT 1 FROM account_members m
                      WHERE m.account_id = g.account_id AND m.user_id = g.user_id AND ${MANAGER}
                   )) AS revoked
            FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
            WHERE t.token_hash = ${hash} AND t.kind = 'access'`,
      );
      entry = r
        ? {
            access: {
              grantId: r.grant_id,
              accountId: r.account_id,
              clientId: r.client_id,
              resource: r.resource,
              workspaces: r.workspaces,
              defaultWorkspace: r.default_workspace,
              defaultPeer: r.default_peer,
              autoRemember: r.auto_remember,
            },
            expiresAt: new Date(r.expires_at).getTime(),
            revoked: !!r.revoked,
            suspended: !!r.suspended,
            until: now + this.ttlMs,
          }
        : { access: null, expiresAt: 0, revoked: false, suspended: false, until: now + this.ttlMs };
      if (this.cache.size >= MAX_CACHED) this.cache.clear();
      if (this.ttlMs > 0) this.cache.set(hash, entry);
    }
    if (!entry.access) throw unauthorized("Invalid access token");
    if (entry.revoked) throw unauthorized("Access token revoked");
    if (entry.expiresAt <= now) throw unauthorized("Access token expired");
    if (entry.suspended) throw accountSuspended();
    this.touch(entry.access.grantId, now);
    return entry.access;
  }

  forgetGrant(grantId: string): void {
    for (const [hash, e] of this.cache) if (e.access?.grantId === grantId) this.cache.delete(hash);
  }

  forgetAccount(accountId: string): void {
    for (const [hash, e] of this.cache)
      if (e.access?.accountId === accountId) this.cache.delete(hash);
  }

  private touch(grantId: string, now: number): void {
    const last = this.touched.get(grantId) ?? 0;
    if (now - last < TOUCH_EVERY_MS) return;
    if (this.touched.size >= MAX_CACHED) this.touched.clear();
    this.touched.set(grantId, now);
    void this.db
      .execute(sql`UPDATE oauth_grants SET last_used_at = now() WHERE id = ${grantId}`)
      .catch(this.onError);
  }
}
