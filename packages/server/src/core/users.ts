import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, isUniqueViolation, rows } from "../db/client.js";
import type { MemberRole } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { createAccount } from "./accounts.js";

/**
 * Dashboard identities: users (one per email), their account memberships, the
 * single-use magic-link tokens they sign in with, and their sessions. Only
 * SHA-256 hashes of tokens are stored.
 */

type Executor = Pick<Db, "execute">;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
/**
 * Sign-in links. Per address the limits count per requesting network, so one network asking for
 * someone else's address cannot lock the owner out from theirs; a daily total per address caps
 * how many links anyone can make it receive.
 */
export const LOGIN_LIMIT_PER_EMAIL = 3; // per address and network, 15 minutes
export const LOGIN_LIMIT_PER_EMAIL_NETWORK_DAY = 6; // per address and network, 24 hours
export const LOGIN_LIMIT_PER_EMAIL_DAY = 30; // per address, all networks, 24 hours
export const LOGIN_LIMIT_PER_IP = 20; // per network, all addresses, 1 hour

export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

/** Lowercased, trimmed address, or null when it does not look like one. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export type IssueResult = { token: string } | { limited: "email" | "ip" };

/**
 * Creates a magic-link token unless this email or IP asked too often recently.
 * `next` is where to continue after signing in (validated by the caller).
 */
export async function issueLoginToken(
  db: Executor,
  email: string,
  ipHash: string | null,
  ttlMs = LOGIN_TOKEN_TTL_MS,
  next: string | null = null,
  /** Which browser asked (see `browserBinding`): only it is sent on to `next`. */
  browser: string | null = null,
): Promise<IssueResult> {
  // An unknown network counts as one network of its own for the per-address limits.
  const sameNetwork = ipHash === null ? sql`ip_hash IS NULL` : sql`ip_hash = ${ipHash}`;
  const [counts] = await rows<{ recent: number; day_here: number; day: number; by_ip: number }>(
    db,
    sql`SELECT
          count(*) FILTER (WHERE ${sameNetwork} AND created_at > now() - interval '15 minutes')::int AS recent,
          count(*) FILTER (WHERE ${sameNetwork})::int AS day_here,
          count(*)::int AS day,
          (SELECT count(*)::int FROM login_tokens
             WHERE ${ipHash}::text IS NOT NULL AND ip_hash = ${ipHash}
               AND created_at > now() - interval '1 hour') AS by_ip
        FROM login_tokens WHERE email = ${email} AND created_at > now() - interval '24 hours'`,
  );
  if (
    (counts?.recent ?? 0) >= LOGIN_LIMIT_PER_EMAIL ||
    (counts?.day_here ?? 0) >= LOGIN_LIMIT_PER_EMAIL_NETWORK_DAY ||
    (counts?.day ?? 0) >= LOGIN_LIMIT_PER_EMAIL_DAY
  )
    return { limited: "email" };
  if ((counts?.by_ip ?? 0) >= LOGIN_LIMIT_PER_IP) return { limited: "ip" };
  const token = randomToken();
  await db.execute(
    sql`INSERT INTO login_tokens (id, token_hash, email, ip_hash, expires_at, next_path, next_browser)
        VALUES (${`lt_${newId()}`}, ${sha256hex(token)}, ${email}, ${ipHash},
                ${new Date(Date.now() + ttlMs)}, ${next}, ${next ? browser : null})`,
  );
  return { token };
}

/** The address a sign-in link is for, without using it up; null when unknown, used or expired. */
export async function peekLogin(db: Executor, token: string): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const [r] = await rows<{ email: string }>(
    db,
    sql`SELECT email FROM login_tokens
        WHERE token_hash = ${sha256hex(token)} AND used_at IS NULL AND expires_at > now()`,
  );
  return r?.email ?? null;
}

/** Marks a token used and returns its email and where to continue; null when unknown, used or expired. */
export async function consumeLogin(
  db: Executor,
  token: string,
): Promise<{ email: string; next: string | null; browser: string | null } | null> {
  if (!token || token.length > 200) return null;
  const [r] = await rows<{ email: string; next_path: string | null; next_browser: string | null }>(
    db,
    sql`UPDATE login_tokens SET used_at = now()
        WHERE token_hash = ${sha256hex(token)} AND used_at IS NULL AND expires_at > now()
        RETURNING email, next_path, next_browser`,
  );
  return r ? { email: r.email, next: r.next_path, browser: r.next_browser } : null;
}

/** True when `email` already belongs to a user with an account, so signing in will not create one. */
export async function hasAccount(db: Executor, email: string): Promise<boolean> {
  const found = await rows<{ ok: number }>(
    db,
    sql`SELECT 1 AS ok FROM users u JOIN account_members m ON m.user_id = u.id
        WHERE u.email = ${email} LIMIT 1`,
  );
  return found.length > 0;
}

export interface SignIn {
  userId: string;
  accountId: string;
  /** True when this sign-in created the account. */
  created: boolean;
}

/**
 * Finds the user for `email` and the account they sign into (owned first), or,
 * when allowed, creates the user and a new account they own. `onNewAccount`
 * runs in the same transaction (billing row and sign-up credit).
 */
export async function signIn(
  db: Db,
  email: string,
  opts: {
    allowSignup: boolean;
    onNewAccount?: (tx: Tx, accountId: string) => Promise<void>;
    /** The terms version the person agreed to by continuing; recorded when it changes. */
    termsVersion?: string;
    /** The GitHub account that signs a new user up; tied to the user it creates. */
    github?: GithubIdentity;
  },
): Promise<SignIn | null> {
  const terms = opts.termsVersion ?? null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`signin:${email}`}))`);
    let [user] = await rows<{ id: string }>(tx, sql`SELECT id FROM users WHERE email = ${email}`);
    const [membership] = user
      ? await rows<{ account_id: string }>(
          tx,
          sql`SELECT account_id FROM account_members WHERE user_id = ${user.id}
              ORDER BY (role = 'owner') DESC, created_at, account_id LIMIT 1`,
        )
      : [];
    if (membership) {
      await tx.execute(
        sql`UPDATE users SET last_login_at = now(),
              terms_accepted_at = CASE WHEN ${terms}::text IS NOT NULL AND terms_version IS DISTINCT FROM ${terms}
                                       THEN now() ELSE terms_accepted_at END,
              terms_version = COALESCE(${terms}, terms_version)
            WHERE id = ${user!.id}`,
      );
      return { userId: user!.id, accountId: membership.account_id, created: false };
    }
    if (!opts.allowSignup) return null;
    if (!user) {
      [user] = await rows<{ id: string }>(
        tx,
        sql`INSERT INTO users (id, email, last_login_at, terms_version, terms_accepted_at, github_id, github_login)
            VALUES (${`usr_${newId()}`}, ${email}, now(), ${terms}, ${terms ? sql`now()` : null},
                    ${opts.github?.id ?? null}, ${opts.github?.login ?? null})
            RETURNING id`,
      );
    } else if (terms) {
      await tx.execute(
        sql`UPDATE users SET terms_version = ${terms}, terms_accepted_at = now() WHERE id = ${user.id}`,
      );
    }
    const account = await createAccount(tx, {
      name: email.split("@")[0]!.slice(0, 200) || email,
      metadata: { signup_email: email, signup: "self_serve" },
    });
    await addMember(tx, account.id, user!.id, "owner");
    await opts.onNewAccount?.(tx, account.id);
    return { userId: user!.id, accountId: account.id, created: true };
  });
}

/** A GitHub account tied to a user: its numeric id (what sign-in goes by) and username. */
export interface GithubIdentity {
  id: number;
  login: string;
}

/** The user a GitHub account is tied to, with the username GitHub reports now (kept up to date). */
export async function userByGithub(
  db: Executor,
  github: GithubIdentity,
): Promise<{ id: string; email: string } | null> {
  const [u] = await rows<{ id: string; email: string }>(
    db,
    sql`UPDATE users SET github_login = ${github.login} WHERE github_id = ${github.id}
        RETURNING id, email`,
  );
  return u ?? null;
}

/** The user of an email address, and whether a GitHub account is tied to them. */
export async function userByEmail(
  db: Executor,
  email: string,
): Promise<{ id: string; githubLinked: boolean } | null> {
  const [u] = await rows<{ id: string; linked: boolean }>(
    db,
    sql`SELECT id, github_id IS NOT NULL AS linked FROM users WHERE email = ${email}`,
  );
  return u ? { id: u.id, githubLinked: u.linked } : null;
}

/** The GitHub account tied to a user, if any. */
export async function githubOf(db: Executor, userId: string): Promise<GithubIdentity | null> {
  const [u] = await rows<{ id: string | number | null; login: string | null }>(
    db,
    sql`SELECT github_id AS id, github_login AS login FROM users WHERE id = ${userId}`,
  );
  return u?.id != null ? { id: Number(u.id), login: u.login ?? "" } : null;
}

/**
 * Ties a GitHub account to a user (replacing one tied before). "taken" when it is tied to another
 * user already: one GitHub account signs in as one user.
 */
export async function connectGithub(
  db: Db,
  userId: string,
  github: GithubIdentity,
): Promise<"connected" | "taken"> {
  try {
    const [other] = await rows<{ id: string }>(
      db,
      sql`SELECT id FROM users WHERE github_id = ${github.id} AND id <> ${userId}`,
    );
    if (other) return "taken";
    await db.execute(
      sql`UPDATE users SET github_id = ${github.id}, github_login = ${github.login} WHERE id = ${userId}`,
    );
    return "connected";
  } catch (err) {
    if (isUniqueViolation(err)) return "taken";
    throw err;
  }
}

export async function disconnectGithub(db: Executor, userId: string): Promise<void> {
  await db.execute(
    sql`UPDATE users SET github_id = NULL, github_login = NULL WHERE id = ${userId}`,
  );
}

export async function addMember(
  db: Executor,
  accountId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO account_members (account_id, user_id, role) VALUES (${accountId}, ${userId}, ${role})
        ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
  );
}

export async function ownerEmails(db: Executor, accountId: string): Promise<string[]> {
  const found = await rows<{ email: string }>(
    db,
    sql`SELECT u.email FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = ${accountId} AND m.role = 'owner' ORDER BY u.email`,
  );
  return found.map((r) => r.email);
}

export async function accountMembers(db: Executor, accountId: string) {
  return rows<{ email: string; role: MemberRole; created_at: Date | string }>(
    db,
    sql`SELECT u.email, m.role, m.created_at FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = ${accountId} ORDER BY m.created_at, u.email`,
  );
}

/** After an account is deleted: remove users who no longer belong to any account. */
export async function deleteOrphanUsers(db: Executor, userIds: string[]): Promise<void> {
  for (const id of userIds) {
    await db.execute(
      sql`DELETE FROM login_tokens WHERE email = (SELECT u.email FROM users u WHERE u.id = ${id}
            AND NOT EXISTS (SELECT 1 FROM account_members m WHERE m.user_id = u.id))`,
    );
    await db.execute(
      sql`DELETE FROM users u WHERE u.id = ${id}
          AND NOT EXISTS (SELECT 1 FROM account_members m WHERE m.user_id = u.id)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sessions

export interface DashSession {
  sessionId: string;
  userId: string;
  email: string;
  accountId: string;
  accountName: string;
  role: MemberRole;
  lastSeenAt: Date;
  /** The account is suspended by the operator: the dashboard shows only a notice. */
  suspended: boolean;
}

export async function createSession(
  db: Executor,
  userId: string,
  accountId: string,
  ttlMs: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.execute(
    sql`INSERT INTO user_sessions (id, token_hash, user_id, account_id, expires_at)
        VALUES (${`ses_${newId()}`}, ${sha256hex(token)}, ${userId}, ${accountId}, ${expiresAt})`,
  );
  return { token, expiresAt };
}

/** A live session whose user is still a member of its account. */
export async function loadSession(db: Executor, token: string): Promise<DashSession | null> {
  const [r] = await rows<{
    id: string;
    user_id: string;
    email: string;
    account_id: string;
    account_name: string;
    role: MemberRole;
    last_seen_at: Date | string;
    suspended: boolean;
  }>(
    db,
    sql`SELECT s.id, s.user_id, u.email, s.account_id, a.name AS account_name, m.role, s.last_seen_at,
               a.suspended_at IS NOT NULL AS suspended
        FROM user_sessions s
        JOIN users u ON u.id = s.user_id
        JOIN account_members m ON m.account_id = s.account_id AND m.user_id = s.user_id
        JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ${sha256hex(token)} AND s.revoked_at IS NULL AND s.expires_at > now()`,
  );
  if (!r) return null;
  return {
    sessionId: r.id,
    userId: r.user_id,
    email: r.email,
    accountId: r.account_id,
    accountName: r.account_name,
    role: r.role,
    lastSeenAt: new Date(r.last_seen_at),
    suspended: !!r.suspended,
  };
}

export async function touchSession(db: Executor, sessionId: string): Promise<void> {
  await db.execute(sql`UPDATE user_sessions SET last_seen_at = now() WHERE id = ${sessionId}`);
}

export async function revokeSession(db: Executor, sessionId: string): Promise<void> {
  await db.execute(
    sql`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${sessionId}`,
  );
}

/** Housekeeping: expired magic links and sessions. */
export async function purgeExpiredLogins(db: Executor): Promise<void> {
  await db.execute(sql`DELETE FROM login_tokens WHERE created_at < now() - interval '1 day'`);
  await db.execute(
    sql`DELETE FROM user_sessions WHERE expires_at < now() - interval '1 day'
          OR revoked_at < now() - interval '1 day'`,
  );
}
