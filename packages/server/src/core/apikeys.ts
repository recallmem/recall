import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, rows } from "../db/client.js";
import { accountSuspended, notFound, unauthorized, unprocessable } from "../lib/errors.js";
import { NAME_MAX, NAME_PATTERN, newId } from "../lib/ids.js";

/**
 * Customer API keys: `pk_live_<32 base62>` (or `pk_test_...`). The key is shown
 * once, at creation; the database keeps only its SHA-256 and a display prefix.
 * Scope mirrors the JWT claims: workspace (w), peer (p), session (s). A key with
 * no scope is an account-admin key (full access within its account).
 */

export type KeyMode = "live" | "test";
type Executor = Pick<Db, "execute">;

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_LEN = 32;
const PREFIX_LEN = 12; // "pk_live_" + 4 characters of the secret

export const isApiKeyToken = (token: string): boolean => token.startsWith("pk_");
const KEY_SHAPE = /^pk_(live|test)_[A-Za-z0-9]{32}$/;
export const hashApiKey = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

/** Uniform base62 by rejection sampling (bytes >= 248 are discarded). */
function randomBase62(len: number): string {
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += BASE62[b % 62];
    }
  }
  return out;
}

export function generateApiKey(mode: KeyMode = "live"): {
  key: string;
  hash: string;
  prefix: string;
} {
  const key = `pk_${mode}_${randomBase62(SECRET_LEN)}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, PREFIX_LEN) };
}

export interface ApiKeyRow {
  id: string;
  account_id: string;
  name: string;
  prefix: string;
  mode: KeyMode;
  workspace: string | null;
  peer: string | null;
  session: string | null;
  rate_limit_per_min: number | null;
  created_at: Date | string;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

const KEY_COLS = sql`id, account_id, name, prefix, mode, workspace, peer, session, rate_limit_per_min,
  created_at, last_used_at, expires_at, revoked_at`;

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

/** Public view of a key (never the secret or its hash). */
export function apiKeyOut(r: ApiKeyRow) {
  return {
    id: r.id,
    account_id: r.account_id,
    name: r.name,
    prefix: r.prefix,
    mode: r.mode,
    scope: {
      workspace_id: r.workspace,
      peer_id: r.peer,
      session_id: r.session,
    },
    admin: !r.workspace && !r.peer && !r.session,
    rate_limit_per_min: r.rate_limit_per_min,
    created_at: iso(r.created_at),
    last_used_at: iso(r.last_used_at),
    expires_at: iso(r.expires_at),
    revoked_at: iso(r.revoked_at),
  };
}
export type ApiKeyOut = ReturnType<typeof apiKeyOut>;

export interface NewApiKey {
  accountId: string;
  name?: string | null;
  mode?: KeyMode;
  workspace?: string | null;
  peer?: string | null;
  session?: string | null;
  rateLimitPerMin?: number | null;
  expiresAt?: Date | null;
  /** The key minting this one (POST /v3/keys): revoking it revokes this key too. */
  mintedBy?: string | null;
}

function checkScopeName(label: string, v: string | null | undefined): string | null {
  if (v == null || v === "") return null;
  if (v.length > NAME_MAX || !NAME_PATTERN.test(v))
    throw unprocessable(`${label} must be 1-${NAME_MAX} characters of a-z, A-Z, 0-9, _ and -`);
  return v;
}

/** Creates a key and returns the plaintext once, alongside its stored record. */
export async function createApiKey(
  db: Executor,
  input: NewApiKey,
): Promise<{ key: string; record: ApiKeyOut }> {
  const workspace = checkScopeName("workspace_id", input.workspace);
  const peer = checkScopeName("peer_id", input.peer);
  const session = checkScopeName("session_id", input.session);
  if ((peer || session) && !workspace)
    throw unprocessable("workspace_id is required when scoping a key to a peer or session");
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now())
    throw unprocessable("expires_at must be in the future");
  if (input.rateLimitPerMin != null && input.rateLimitPerMin < 1)
    throw unprocessable("rate_limit_per_min must be at least 1");
  const { key, hash, prefix } = generateApiKey(input.mode ?? "live");
  const [row] = await rows<ApiKeyRow>(
    db,
    sql`INSERT INTO api_keys (id, account_id, name, key_hash, prefix, mode, workspace, peer, session,
                              rate_limit_per_min, expires_at, minted_by)
        VALUES (${`key_${newId()}`}, ${input.accountId}, ${input.name ?? ""}, ${hash}, ${prefix},
                ${input.mode ?? "live"}, ${workspace}, ${peer}, ${session},
                ${input.rateLimitPerMin ?? null}, ${input.expiresAt ?? null}, ${input.mintedBy ?? null})
        RETURNING ${KEY_COLS}`,
  );
  return { key, record: apiKeyOut(row!) };
}

export async function listApiKeys(db: Executor, accountId: string): Promise<ApiKeyOut[]> {
  const found = await rows<ApiKeyRow>(
    db,
    sql`SELECT ${KEY_COLS} FROM api_keys WHERE account_id = ${accountId} ORDER BY created_at, id`,
  );
  return found.map(apiKeyOut);
}

/** An account's newest keys first, at most `limit` (the operator console). */
export async function recentApiKeys(
  db: Executor,
  accountId: string,
  limit: number,
): Promise<ApiKeyOut[]> {
  const found = await rows<ApiKeyRow>(
    db,
    sql`SELECT ${KEY_COLS} FROM api_keys WHERE account_id = ${accountId}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
  );
  return found.map(apiKeyOut);
}

/** Revokes a key (idempotent). With `accountId`, the key must belong to that account. */
export async function revokeApiKey(
  db: Executor,
  keyId: string,
  accountId?: string,
): Promise<ApiKeyOut> {
  // The key and every key minted from it, at any depth.
  const revoked = await rows<ApiKeyRow>(
    db,
    sql`WITH RECURSIVE tree AS (
          SELECT id FROM api_keys
          WHERE id = ${keyId} ${accountId ? sql`AND account_id = ${accountId}` : sql``}
          UNION
          SELECT k.id FROM api_keys k JOIN tree t ON k.minted_by = t.id
        )
        UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
        WHERE id IN (SELECT id FROM tree)
        RETURNING ${KEY_COLS}`,
  );
  const row = revoked.find((r) => r.id === keyId);
  if (!row) throw notFound("API key");
  return apiKeyOut(row);
}

/** What the auth guard needs from a verified key. */
export interface VerifiedKey {
  id: string;
  accountId: string;
  mode: KeyMode;
  workspace: string | null;
  peer: string | null;
  session: string | null;
  rateLimitPerMin: number | null;
  expiresAt: number | null;
  revoked: boolean;
  /** The key's account is suspended by the operator: requests get 403. */
  suspended: boolean;
}

const LAST_USED_EVERY_MS = 60_000;
const MAX_CACHED = 20_000;

/**
 * Verifies bearer API keys: SHA-256 lookup with a short in-process cache
 * (unknown keys are cached too, so a flood of bad keys does not reach the
 * database). A revocation is seen by every process within `ttlMs`; in this
 * process immediately (`forget`). `last_used_at` is written at most once a
 * minute per key, off the request path.
 */
export class ApiKeyVerifier {
  private readonly cache = new Map<string, { key: VerifiedKey | null; until: number }>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Executor,
    private readonly ttlMs: number,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async verify(token: string, now = Date.now()): Promise<VerifiedKey> {
    // Malformed tokens never reach the database.
    if (!KEY_SHAPE.test(token)) throw unauthorized("Invalid API key");
    const hash = hashApiKey(token);
    let entry = this.cache.get(hash);
    if (!entry || entry.until <= now) {
      const [r] = await rows<{
        id: string;
        account_id: string;
        mode: KeyMode;
        workspace: string | null;
        peer: string | null;
        session: string | null;
        rate_limit_per_min: number | null;
        expires_at: Date | string | null;
        revoked_at: Date | string | null;
        suspended: boolean | null;
      }>(
        this.db,
        sql`SELECT k.id, k.account_id, k.mode, k.workspace, k.peer, k.session, k.rate_limit_per_min,
                   k.expires_at, k.revoked_at, a.suspended_at IS NOT NULL AS suspended
            FROM api_keys k LEFT JOIN accounts a ON a.id = k.account_id
            WHERE k.key_hash = ${hash}`,
      );
      const key: VerifiedKey | null = r
        ? {
            id: r.id,
            accountId: r.account_id,
            mode: r.mode,
            workspace: r.workspace,
            peer: r.peer,
            session: r.session,
            rateLimitPerMin: r.rate_limit_per_min,
            expiresAt: r.expires_at == null ? null : new Date(r.expires_at).getTime(),
            revoked: r.revoked_at != null,
            suspended: !!r.suspended,
          }
        : null;
      if (this.cache.size >= MAX_CACHED) this.cache.clear();
      entry = { key, until: now + this.ttlMs };
      if (this.ttlMs > 0) this.cache.set(hash, entry);
    }
    const key = entry.key;
    if (!key) throw unauthorized("Invalid API key");
    if (key.revoked) throw unauthorized("API key revoked");
    if (key.expiresAt !== null && key.expiresAt <= now) throw unauthorized("API key expired");
    // After the 401s: a suspended account's valid key is told why, without spending a failure.
    if (key.suspended) throw accountSuspended();
    this.touch(key.id, now);
    return key;
  }

  /** Drops cached entries for a key id (after a revocation in this process). */
  forget(keyId: string): void {
    for (const [hash, e] of this.cache) if (e.key?.id === keyId) this.cache.delete(hash);
  }

  /** Drops every cached key of an account (after the account is deleted). */
  forgetAccount(accountId: string): void {
    for (const [hash, e] of this.cache) if (e.key?.accountId === accountId) this.cache.delete(hash);
  }

  private touch(id: string, now: number): void {
    const last = this.touched.get(id) ?? 0;
    if (now - last < LAST_USED_EVERY_MS) return;
    if (this.touched.size >= MAX_CACHED) this.touched.clear();
    this.touched.set(id, now);
    void this.db
      .execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`)
      .catch(this.onError);
  }
}
