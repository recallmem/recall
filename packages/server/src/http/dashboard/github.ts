import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cleanTag, type SignupSource } from "../../core/signup-source.js";

/**
 * "Continue with GitHub" for the dashboard (RECALL_GITHUB_CLIENT_ID and _SECRET, a GitHub OAuth
 * app). A Recall user is tied to one GitHub account by its numeric id, never by the email address
 * GitHub reports: a GitHub account creates a new user (with its verified primary email address,
 * under the same sign-up rules as an emailed link), or the signed-in user connects it under
 * Settings. An address that already has a Recall user is not opened through GitHub until that
 * user connects it, so an address left verified on someone's GitHub account after they lost the
 * mailbox does not open the account. The GitHub token is used for the requests that read the
 * account and is not kept.
 *
 * Login CSRF: the `state` sent to GitHub is signed and bound to this browser's anonymous cookie
 * (see `browserBinding`), or, to connect an account, to the dashboard session that asked; a
 * callback carrying someone else's code is refused.
 */

export interface GithubApp {
  clientId: string;
  clientSecret: string;
}

/** How long the round trip through GitHub may take. */
export const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

const sign = (secret: Buffer, payload: string, binding: string) =>
  createHmac("sha256", secret).update(`github-state:${payload}:${binding}`).digest("base64url");

/** The binding of a `state` that connects GitHub to the signed-in user of a dashboard session. */
export const linkBinding = (sessionId: string) => `link:${sessionId}`;

/**
 * A signed `state` carrying where to continue after sign-in (`next`, already checked), or, with
 * `link`, that the round trip connects GitHub to the signed-in user.
 */
export function signState(
  secret: Buffer,
  binding: string,
  next: string | null,
  now = Date.now(),
  link = false,
  /** Where the visit came from, for a sign-up (core/signup-source.ts). */
  source: SignupSource | null = null,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      n: next,
      t: now,
      r: randomBytes(9).toString("base64url"),
      ...(link ? { l: 1 } : {}),
      ...(source ? { s: source.source, c: source.campaign } : {}),
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload, binding)}`;
}

/** What a valid, fresh `state` carries for this binding; undefined when it is not valid. */
export function verifyState(
  secret: Buffer,
  binding: string | null,
  state: string | undefined,
  now = Date.now(),
): { next: string | null; link: boolean; source: SignupSource | null } | undefined {
  if (!binding || !state || state.length > 6000) return undefined;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const payload = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1));
  const want = Buffer.from(sign(secret, payload, binding));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      n?: unknown;
      t?: unknown;
      l?: unknown;
      s?: unknown;
      c?: unknown;
    };
    if (typeof p.t !== "number" || now - p.t > STATE_TTL_MS || p.t > now + 60_000) return undefined;
    const source = cleanTag(p.s);
    return {
      next: typeof p.n === "string" ? p.n : null,
      link: p.l === 1,
      source: source ? { source, campaign: cleanTag(p.c) } : null,
    };
  } catch {
    return undefined;
  }
}

/** GitHub's authorization page for this app: only the scope that reads email addresses. */
export function authorizeUrl(app: GithubApp, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    scope: "user:email",
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${q}`;
}

/** A GitHub account: its numeric id, username and verified email address (null when none). */
export interface GithubUser {
  id: number;
  login: string;
  email: string | null;
}

/**
 * Exchanges the authorization `code` and reads the GitHub account: its id and username, and its
 * verified primary email address (or, when the primary one is not verified, the first verified one).
 */
export async function githubUser(
  app: GithubApp,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubUser | { error: "exchange" }> {
  const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const token = tokenRes.ok
    ? ((await tokenRes.json().catch(() => null)) as { access_token?: unknown } | null)
    : null;
  if (typeof token?.access_token !== "string" || !token.access_token) return { error: "exchange" };
  const get = (path: string) =>
    fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.access_token}`,
        "User-Agent": "Recall",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const [userRes, emailsRes] = await Promise.all([get("/user"), get("/user/emails")]);
  if (!userRes.ok || !emailsRes.ok) return { error: "exchange" };
  const account = (await userRes.json().catch(() => null)) as { id?: unknown; login?: unknown };
  if (!Number.isSafeInteger(account?.id) || (account.id as number) <= 0)
    return { error: "exchange" };
  const login = typeof account.login === "string" ? account.login.slice(0, 100) : "";
  const list = (await emailsRes.json().catch(() => null)) as unknown;
  const emails = (Array.isArray(list) ? list : []).filter(
    (e): e is { email: string; primary?: boolean; verified: true } =>
      !!e &&
      typeof e === "object" &&
      typeof (e as { email?: unknown }).email === "string" &&
      (e as { verified?: unknown }).verified === true,
  );
  const pick = emails.find((e) => e.primary) ?? emails[0];
  return { id: account.id as number, login, email: pick?.email ?? null };
}
