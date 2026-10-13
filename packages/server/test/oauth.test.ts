import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/core/apikeys.js";
import { OAuthTokenVerifier, purgeOAuth } from "../src/core/oauth.js";
import {
  type DocumentTransport,
  redirectUriAllowed,
  setClientMetadataNetwork,
} from "../src/core/oauth-clients.js";
import { rows } from "../src/db/client.js";
import { type AuthState, verifyToken } from "../src/http/auth.js";
import { mintForCaller } from "../src/http/routes/keys.js";
import { CONSENT_MIN_MS } from "../src/http/routes/oauth.js";
import { RateLimiter } from "../src/lib/ratelimit.js";
import { createTestServer } from "./api-helpers.js";
import {
  ADMIN,
  Browser,
  createHostedServer,
  type HostedServer,
  PUBLIC_URL,
} from "./hosted-helpers.js";

/**
 * OAuth 2.1 for the hosted MCP endpoint: discovery (RFC 9728, RFC 8414),
 * dynamic registration (RFC 7591), client ID metadata documents, the
 * authorization code flow with PKCE and RFC 8707 resources, refresh-token
 * rotation with reuse detection, revocation (RFC 7009), the dashboard's
 * connected apps, and the negative cases around each of them.
 */

const RESOURCE = `${PUBLIC_URL}/mcp`;
const CALLBACK = "https://client.example/callback";

let s: HostedServer;
beforeAll(async () => {
  s = await createHostedServer({
    billing: false,
    env: { RECALL_SIGNUP_ENABLED: "true", RECALL_OAUTH_REGISTRATIONS_PER_HOUR: "5" },
  });
});
afterAll(async () => {
  await s.close();
});
afterEach(() => {
  setClientMetadataNetwork({ resolver: null, transport: null });
});

// ---------------------------------------------------------------------------
// helpers

const b64url = (buf: Buffer) => buf.toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
const randomIp = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

async function register(body: Record<string, unknown>, ip = randomIp()) {
  const res = await s.app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose test JSON
  return { status: res.status, json: (await res.json()) as any };
}

async function newClient(redirectUris = [CALLBACK], name = "Test Client") {
  const r = await register({ client_name: name, redirect_uris: redirectUris });
  expect(r.status).toBe(201);
  return r.json.client_id as string;
}

async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await s.app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose test JSON
  return { status: res.status, headers: res.headers, json: (await res.json()) as any };
}

async function mcp(
  bearer: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  path = "/mcp",
) {
  const res = await s.app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: loose test JSON
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json };
}

async function callTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(bearer, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.json.result as { isError?: boolean; content: { text: string }[] };
  return { isError: !!result.isError, text: result.content[0]!.text };
}

const unescapeHtml = (v: string) =>
  v
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The hidden fields of the consent form (the POST one). */
function consentFields(html: string): Record<string, string> {
  const form = html.slice(html.indexOf('<form method="post" action="/oauth/authorize">'));
  const end = form.indexOf("</form>");
  const out: Record<string, string> = {};
  for (const m of form
    .slice(0, end)
    .matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g))
    if (m[1] !== "_csrf") out[m[1]!] = unescapeHtml(m[2]!);
  return out;
}

/**
 * An authorization error shown on our page (never redirected automatically before the user
 * acted): the error that the "Return to" link would hand back to the app.
 */
function returnedError(page: { res: Response; html: string }) {
  expect(page.res.status).toBe(400);
  expect(page.res.headers.get("location")).toBeNull();
  const href = unescapeHtml(page.html.match(/href="([^"]+)" rel="noreferrer">Return to/)![1]!);
  const u = new URL(href);
  return { target: `${u.origin}${u.pathname}`, params: u.searchParams };
}

function authorizeUrl(p: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, v);
  return `/oauth/authorize?${q.toString()}`;
}

interface FlowOpts {
  clientId: string;
  redirectUri?: string;
  state?: string;
  resource?: string | undefined;
  challenge: string;
  form?: Record<string, string>;
  csrf?: string | null;
}

function baseParams(o: FlowOpts) {
  return {
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri ?? CALLBACK,
    state: o.state ?? "st-123",
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    resource: "resource" in o ? o.resource : RESOURCE,
    scope: "memory",
  };
}

/**
 * Runs `fn` with the clock set back, so that a consent page rendered inside it may be
 * approved at once ("Allow" is accepted only CONSENT_MIN_MS after the page was rendered).
 */
async function earlier<T>(fn: () => Promise<T>, ms = CONSENT_MIN_MS + 100): Promise<T> {
  const realNow = Date.now.bind(Date);
  const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() - ms);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** GET the consent page (rendered long enough ago to approve), then POST the decision. */
async function approve(b: Browser, o: FlowOpts) {
  const page = await earlier(() => b.get(authorizeUrl(baseParams(o))));
  expect(page.res.status).toBe(200);
  const fields = consentFields(page.html);
  const res = await b.post(
    "/oauth/authorize",
    { ...fields, default_workspace: "main", decision: "allow", ...o.form },
    { csrf: o.csrf },
  );
  return { page, res: res.res, html: res.html, location: res.res.headers.get("location") };
}

/** Full flow for a signed-in browser: returns tokens. */
async function connect(b: Browser, clientId: string, form: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const { location } = await approve(b, { clientId, challenge, form });
  const code = new URL(location!).searchParams.get("code")!;
  const t = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  expect(t.status).toBe(200);
  return t.json as { access_token: string; refresh_token: string; expires_in: number };
}

let signedIn: Browser;
let signedInEmail: string;
async function owner(): Promise<Browser> {
  if (signedIn) return signedIn;
  signedInEmail = "owner@oauth.example";
  signedIn = new Browser(s.app);
  await signedIn.signIn(s, signedInEmail);
  return signedIn;
}

const accountOf = async (email: string) => {
  const [r] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
  );
  return r!.account_id;
};

// ---------------------------------------------------------------------------

describe("oauth: discovery", () => {
  it("serves protected resource metadata at the root and path-suffixed URLs", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await s.app.request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(RESOURCE);
      expect(body.authorization_servers).toEqual([PUBLIC_URL]);
      expect(body.scopes_supported).toEqual(["memory"]);
    }
    const full = await s.app.request("/.well-known/oauth-protected-resource/mcp?profile=full");
    expect(((await full.json()) as { resource: string }).resource).toBe(`${RESOURCE}?profile=full`);
  });

  it("serves authorization server metadata, also where OpenID clients look", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const res = await s.app.request(path, { headers: { origin: "https://inspector.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://inspector.example");
      const m = (await res.json()) as Record<string, unknown>;
      expect(m.issuer).toBe(PUBLIC_URL);
      expect(m.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
      expect(m.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
      expect(m.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
      expect(m.revocation_endpoint).toBe(`${PUBLIC_URL}/oauth/revoke`);
      expect(m.code_challenge_methods_supported).toEqual(["S256"]);
      expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(m.client_id_metadata_document_supported).toBe(true);
      expect(m.authorization_response_iss_parameter_supported).toBe(true);
      expect(m.response_types_supported).toEqual(["code"]);
    }
  });

  it("challenges /mcp without a token with a pointer to the metadata", async () => {
    const r = await mcp(null, "tools/list");
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate")!;
    expect(h).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(h).toContain('scope="memory"');
    expect(h).not.toContain("error=");
    expect(r.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
    const full = await mcp(null, "tools/list", {}, {}, "/mcp?profile=full");
    expect(full.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp?profile=full",
    );
    // A refused token gets error="invalid_token", so clients refresh or sign in again.
    const bad = await mcp(`oat_${"x".repeat(43)}`, "tools/list");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("oauth: dynamic client registration", () => {
  it("registers public clients only, whatever they ask for", async () => {
    const r = await register({
      client_name: "Claude‮ evil",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      unknown_field: 1,
    });
    expect(r.status).toBe(201);
    expect(r.json.client_id).toMatch(/^rc_/);
    expect(r.json.token_endpoint_auth_method).toBe("none");
    expect(r.json.client_secret).toBeUndefined();
    expect(r.json.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(r.json.client_name).toBe("Claude evil"); // bidi override stripped
    expect(r.json.redirect_uris).toEqual([CALLBACK]);
  });

  it("refuses disallowed redirect schemes and keeps only the acceptable URIs", async () => {
    for (const bad of [
      "javascript:alert(1)",
      "http://evil.example/cb",
      "myapp://callback",
      "data:text/html,hi",
      "https://client.example/cb#frag",
      "https://user:pw@client.example/cb",
      "relative/path",
    ]) {
      const r = await register({ client_name: "x", redirect_uris: [bad] });
      expect(r.status, bad).toBe(400);
      expect(r.json.error).toBe("invalid_redirect_uri");
    }
    const mixed = await register({
      client_name: "Editor",
      redirect_uris: ["cursor://anysphere/cb", "http://127.0.0.1:8787/cb", CALLBACK],
    });
    expect(mixed.status).toBe(201);
    expect(mixed.json.redirect_uris).toEqual(["http://127.0.0.1:8787/cb", CALLBACK]);
    const noRedirects = await register({ client_name: "x" });
    expect(noRedirects.json.error).toBe("invalid_redirect_uri");
    const implicit = await register({ redirect_uris: [CALLBACK], grant_types: ["implicit"] });
    expect(implicit.json.error).toBe("invalid_client_metadata");
  });

  it("refuses redirect URIs that a browser would resolve against Recall's own origin", async () => {
    // Without "//" (or with backslashes) after the scheme, new URL() alone reads a host
    // ("https:/app/keys" is host "app"), but a Location header is resolved against the
    // consent page: the browser goes to https://recall.test/app/keys instead, so the consent
    // screen would name a host the code is never sent to.
    expect(new URL("https:/app/keys", `${PUBLIC_URL}/oauth/authorize`).origin).toBe(PUBLIC_URL);
    for (const bad of [
      "https:/app/keys",
      "https:client.example/callback",
      "https:\\client.example/callback",
      "https:\\\\client.example/callback",
      "https://client.example\\callback",
      "http:/127.0.0.1/callback",
    ]) {
      const r = await register({ client_name: "x", redirect_uris: [bad] });
      expect(r.status, bad).toBe(400);
      expect(r.json.error, bad).toBe("invalid_redirect_uri");
    }
    expect(redirectUriAllowed(["http://127.0.0.1/cb"], "http:/127.0.0.1:5000/cb")).toBe(false);
    expect(redirectUriAllowed(["http://127.0.0.1/cb"], "http://127.0.0.1:5000/cb")).toBe(true);
    // The scheme's case is not the problem: browsers resolve these as written.
    const upper = await register({
      client_name: "x",
      redirect_uris: ["HTTPS://client.example/cb"],
    });
    expect(upper.status).toBe(201);
  });

  it("rate limits registrations per client network", async () => {
    const ip = "192.0.2.200";
    for (let i = 0; i < 5; i++)
      expect((await register({ redirect_uris: [CALLBACK] }, ip)).status).toBe(201);
    const limited = await register({ redirect_uris: [CALLBACK] }, ip);
    expect(limited.status).toBe(429);
    expect((await register({ redirect_uris: [CALLBACK] }, "192.0.2.201")).status).toBe(201);
  });

  it("purges clients that were never used, and keeps used ones", async () => {
    const unused = await newClient();
    const used = await newClient();
    const b = await owner();
    await connect(b, used);
    await s.ctx.db.execute(
      sql`UPDATE oauth_clients SET created_at = now() - interval '2 days' WHERE id IN (${unused}, ${used})`,
    );
    await purgeOAuth(s.ctx.db);
    const left = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM oauth_clients WHERE id IN (${unused}, ${used})`,
    );
    expect(left.map((r) => r.id)).toEqual([used]);
  });
});

describe("oauth: the full flow", () => {
  it("metadata → register → sign in → consent → token → MCP → refresh → reuse → revoke", async () => {
    const clientId = await newClient([CALLBACK], "Claude");
    const { verifier, challenge } = pkce();

    // Signed out: the authorization request goes through the magic-link sign-in and comes back.
    const b = new Browser(s.app);
    const params = baseParams({ clientId, challenge, state: "xyz-1" });
    const first = await b.get(authorizeUrl(params));
    expect(first.res.status).toBe(303);
    const login = first.res.headers.get("location")!;
    expect(login.startsWith("/app/login?next=")).toBe(true);
    const next = new URL(login, PUBLIC_URL).searchParams.get("next")!;
    expect(next).toBe(authorizeUrl(params));
    const loginPage = await b.get(login);
    expect(loginPage.html).toContain(`name="next"`);
    await b.post("/app/login", { email: "flow@oauth.example", next });
    const mail = s.mailer.outbox.filter((m) => m.to === "flow@oauth.example").at(-1)!;
    const link = new URL(mail.text.match(/https:\/\/\S+/)![0]);
    expect(link.searchParams.has("next")).toBe(false); // kept server-side, the link stays short
    await b.get(`${link.pathname}${link.search}`);
    const verified = await b.post("/app/auth/verify", { token: link.searchParams.get("token")! });
    expect(verified.res.status).toBe(303);
    expect(verified.res.headers.get("location")).toBe(next);

    // Consent screen: client name, redirect host, account, what it gets, CSP allowing the redirect.
    const consent = await earlier(() => b.get(next));
    expect(consent.res.status).toBe(200);
    expect(consent.html).toContain("Claude");
    expect(consent.html).toContain("client.example");
    expect(consent.html).toContain("name not verified");
    expect(consent.html).toContain("flow@oauth.example");
    const csp = consent.res.headers.get("content-security-policy")!;
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("https://client.example");
    expect(csp).toContain("frame-ancestors 'none'");
    const fields = consentFields(consent.html);
    expect(fields).toMatchObject({ client_id: clientId, state: "xyz-1", resource: RESOURCE });

    const decided = await b.post("/oauth/authorize", {
      ...fields,
      default_workspace: "notes",
      default_peer: "ada",
      decision: "allow",
    });
    expect(decided.res.status).toBe(303);
    const back = new URL(decided.res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("xyz-1");
    expect(back.searchParams.get("iss")).toBe(PUBLIC_URL);
    const code = back.searchParams.get("code")!;
    expect(code).toMatch(/^oac_/);
    const stored = await rows<{ code_hash: string }>(
      s.ctx.db,
      sql`SELECT code_hash FROM oauth_codes`,
    );
    expect(stored.some((r) => r.code_hash.includes(code))).toBe(false);

    // Token exchange.
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(t.status).toBe(200);
    expect(t.headers.get("cache-control")).toBe("no-store");
    expect(t.json).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "memory" });
    expect(t.json.access_token).toMatch(/^oat_/);
    expect(t.json.refresh_token).toMatch(/^ort_/);
    const hashes = await rows<{ token_hash: string }>(
      s.ctx.db,
      sql`SELECT token_hash FROM oauth_tokens`,
    );
    expect(hashes.some((r) => r.token_hash === t.json.access_token)).toBe(false);

    // MCP with the token: the grant's default workspace and peer apply.
    const listed = await mcp(t.json.access_token, "tools/list");
    expect(listed.status).toBe(200);
    expect(listed.json.result.tools.length).toBe(8);
    const wrote = await callTool(t.json.access_token, "add_messages_to_session", {
      session_id: "s1",
      messages: [{ content: "I like tea" }],
    });
    expect(wrote.isError).toBe(false);
    const [ws] = await rows<{ name: string; peer: string; account_id: string }>(
      s.ctx.db,
      sql`SELECT w.name, p.name AS peer, w.account_id FROM messages m
          JOIN workspaces w ON w.id = m.workspace_id JOIN peers p ON p.id = m.peer_id
          WHERE m.content = 'I like tea'`,
    );
    expect(ws).toMatchObject({
      name: "notes",
      peer: "ada",
      account_id: await accountOf("flow@oauth.example"),
    });
    // Scoped to its workspace: another one is refused, by argument and by header.
    const other = await callTool(t.json.access_token, "add_messages_to_session", {
      workspace_id: "elsewhere",
      session_id: "s1",
      messages: [{ content: "x" }],
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("cannot access workspace 'elsewhere'");
    // A valid token outside its grant: 403 insufficient_scope, not a 401 that sends the client
    // back to sign in.
    const outside = await mcp(
      t.json.access_token,
      "tools/list",
      {},
      { "x-recall-workspace-id": "elsewhere" },
    );
    expect(outside.status).toBe(403);
    expect(outside.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(outside.headers.get("www-authenticate")).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    // The REST API does not accept OAuth tokens (they are bound to the MCP endpoint).
    const rest = await s.api(
      "POST",
      "/v3/workspaces/list",
      {},
      {
        authorization: `Bearer ${t.json.access_token}`,
      },
    );
    expect(rest.status).toBe(401);
    expect((await rest.json()).detail).toContain("only at the MCP endpoint");

    // The dashboard lists the connection.
    const keys = await b.get("/app/keys");
    expect(keys.html).toContain("Connected apps");
    expect(keys.html).toContain("Claude");
    expect(keys.html).toContain("notes · peer ada");

    // Refresh: rotation.
    const r1 = await token({
      grant_type: "refresh_token",
      refresh_token: t.json.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.json.refresh_token);
    expect((await mcp(r1.json.access_token, "tools/list")).status).toBe(200);

    // Reuse of the spent refresh token: the whole family is revoked.
    const reuse = await token({
      grant_type: "refresh_token",
      refresh_token: t.json.refresh_token,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe("invalid_grant");
    expect((await mcp(r1.json.access_token, "tools/list")).status).toBe(401);
    expect((await mcp(t.json.access_token, "tools/list")).status).toBe(401);
    const afterReuse = await token({
      grant_type: "refresh_token",
      refresh_token: r1.json.refresh_token,
      client_id: clientId,
    });
    expect(afterReuse.json.error).toBe("invalid_grant");
    expect((await b.get("/app/keys")).html).not.toContain("notes · peer ada");

    // A new connection, revoked by the client (RFC 7009): the refresh token ends the grant.
    const again = await connect(b, clientId);
    expect((await mcp(again.access_token, "tools/list")).status).toBe(200);
    const revoked = await s.app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: again.refresh_token, client_id: clientId }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect((await mcp(again.access_token, "tools/list")).status).toBe(401);
    const unknown = await s.app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "not-a-token" }).toString(),
    });
    expect(unknown.status).toBe(200);

    // And one revoked from the dashboard.
    const third = await connect(b, clientId);
    const page = await b.get("/app/keys");
    const grantId = page.html.match(/\/app\/connected-apps\/([^/]+)\/revoke/)![1]!;
    const out = await b.post(`/app/connected-apps/${grantId}/revoke`, { confirm: "1" });
    expect(out.res.status).toBe(303);
    expect((await mcp(third.access_token, "tools/list")).status).toBe(401);
    const refreshAfter = await token({
      grant_type: "refresh_token",
      refresh_token: third.refresh_token,
      client_id: clientId,
    });
    expect(refreshAfter.json.error).toBe("invalid_grant");
  });

  it("an access token expires", async () => {
    const clientId = await newClient();
    const t = await connect(await owner(), clientId);
    await s.ctx.db.execute(
      sql`UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'`,
    );
    const r = await mcp(t.access_token, "tools/list");
    expect(r.status).toBe(401);
    expect(r.json.detail).toBe("Access token expired");
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("a grant for all workspaces acts like an account-admin key, within its own account", async () => {
    const b = await owner();
    const t = await connect(b, await newClient(), { access: "all", default_workspace: "home" });
    const r = await mcp(t.access_token, "tools/list", {}, { "x-recall-workspace-id": "anything" });
    expect(r.status).toBe(200);

    // Another account has a workspace "shared" with data in it.
    const otherAccount = await accountOf("flow@oauth.example");
    const { key } = await createApiKey(s.ctx.db, { accountId: otherAccount });
    const write = await s.api(
      "POST",
      "/v3/workspaces/shared/sessions/x/messages",
      { messages: [{ peer_id: "bob", content: "bob secret" }] },
      { authorization: `Bearer ${key}` },
    );
    expect(write.status).toBeLessThan(300);
    // The owner's token reaches its own account only: "shared" does not exist there.
    const search = await callTool(t.access_token, "search", {
      workspace_id: "shared",
      query: "secret",
    });
    expect(search.isError).toBe(false);
    expect(search.text).not.toContain("bob secret");
    expect(JSON.parse(search.text)).toMatchObject({ messages: [], conclusions: [] });
  });

  it("a grant for several workspaces allows exactly those", async () => {
    const b = await owner();
    const accountId = await accountOf(signedInEmail);
    const { key } = await createApiKey(s.ctx.db, { accountId });
    for (const w of ["alpha", "beta", "gamma"])
      await s.api("POST", "/v3/workspaces", { id: w }, { authorization: `Bearer ${key}` });
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const page = await earlier(() => b.get(authorizeUrl(baseParams({ clientId, challenge }))));
    expect(page.html).toContain('value="alpha"');
    const boxes = [...page.html.matchAll(/name="(ws_\d+)" value="([^"]+)"/g)];
    const beta = boxes.find((m) => m[2] === "beta")![1]!;
    const res = await b.post("/oauth/authorize", {
      ...consentFields(page.html),
      default_workspace: "alpha",
      access: "selected",
      [beta]: "beta",
      decision: "allow",
    });
    const code = new URL(res.res.headers.get("location")!).searchParams.get("code")!;
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    const at = t.json.access_token as string;
    expect((await mcp(at, "tools/list", {}, { "x-recall-workspace-id": "beta" })).status).toBe(200);
    expect((await mcp(at, "tools/list", {}, { "x-recall-workspace-id": "gamma" })).status).toBe(
      403,
    );
    const listed = await mcp(
      at,
      "tools/call",
      { name: "list_workspaces", arguments: {} },
      {},
      "/mcp?profile=full",
    );
    const names = JSON.parse(listed.json.result.content[0].text).items.map(
      (w: { id: string }) => w.id,
    );
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });

  it("the spend cap applies to OAuth callers", async () => {
    const b = await owner();
    const t = await connect(b, await newClient(), { default_peer: "ada" });
    const accountId = await accountOf(signedInEmail);
    await s.ctx.db.execute(sql`UPDATE accounts SET monthly_budget_usd = 0 WHERE id = ${accountId}`);
    try {
      await callTool(t.access_token, "add_messages_to_session", {
        session_id: "cap",
        messages: [{ content: "hello" }],
      });
      const chat = await callTool(t.access_token, "chat", { query: "what do I like?" });
      expect(chat.isError).toBe(true);
      expect(chat.text).toContain("budget");
    } finally {
      await s.ctx.db.execute(
        sql`UPDATE accounts SET monthly_budget_usd = NULL WHERE id = ${accountId}`,
      );
    }
  });

  it("accepts loopback redirects on any port and warns about them", async () => {
    const clientId = await newClient(["http://127.0.0.1/callback"]);
    const b = await owner();
    const { verifier, challenge } = pkce();
    const redirectUri = "http://127.0.0.1:43123/callback";
    const page = await earlier(() =>
      b.get(authorizeUrl(baseParams({ clientId, challenge, redirectUri }))),
    );
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("Any program on this device could pose as it");
    expect(page.res.headers.get("content-security-policy")).toContain("http://127.0.0.1:43123");
    const res = await b.post("/oauth/authorize", {
      ...consentFields(page.html),
      default_workspace: "main",
      decision: "allow",
    });
    const loc = new URL(res.res.headers.get("location")!);
    expect(loc.port).toBe("43123");
    const t = await token({
      grant_type: "authorization_code",
      code: loc.searchParams.get("code")!,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(t.status).toBe(200);
    const wrongPath = await b.get(
      authorizeUrl(
        baseParams({ clientId, challenge, redirectUri: "http://127.0.0.1:43123/other" }),
      ),
    );
    expect(wrongPath.res.status).toBe(400);
  });

  it("lets a user with several accounts pick the one to connect", async () => {
    const email = "multi@oauth.example";
    const b = new Browser(s.app);
    await b.signIn(s, email);
    const created = await s.api(
      "POST",
      "/admin/v1/accounts",
      { name: "Second Co" },
      { authorization: `Bearer ${ADMIN}` },
    );
    const second = (await created.json()).id as string;
    const linked = await s.api(
      "POST",
      "/admin/v1/login-links",
      { email, account_id: second },
      { authorization: `Bearer ${ADMIN}` },
    );
    expect(linked.status).toBe(201);
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const params = baseParams({ clientId, challenge });
    const page = await b.get(authorizeUrl(params));
    expect(page.html).toContain('name="account" data-autosubmit');
    expect(page.html).toContain("Second Co");
    const switched = await earlier(() => b.get(`${authorizeUrl(params)}&account=${second}`));
    expect(consentFields(switched.html).account).toBe(second);
    const res = await b.post("/oauth/authorize", {
      ...consentFields(switched.html),
      default_workspace: "main",
      decision: "allow",
    });
    const t = await token({
      grant_type: "authorization_code",
      code: new URL(res.res.headers.get("location")!).searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    await callTool(t.json.access_token, "add_messages_to_session", {
      session_id: "s",
      messages: [{ peer_id: "me", content: "second account note" }],
    });
    const [row] = await rows<{ account_id: string }>(
      s.ctx.db,
      sql`SELECT w.account_id FROM messages m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.content = 'second account note'`,
    );
    expect(row!.account_id).toBe(second);
  });

  it("only owners and admins can connect apps, and a demoted user's connections stop", async () => {
    const email = "demoted@oauth.example";
    const b = new Browser(s.app);
    await b.signIn(s, email);
    const t = await connect(b, await newClient());
    expect((await mcp(t.access_token, "tools/list")).status).toBe(200);
    const accountId = await accountOf(email);
    await s.ctx.db.execute(
      sql`UPDATE account_members SET role = 'member' WHERE account_id = ${accountId}`,
    );
    const r = await mcp(t.access_token, "tools/list");
    expect(r.status).toBe(401);
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "x" }))
        .json.error,
    ).toBe("invalid_grant");
    const page = await b.get(
      authorizeUrl(baseParams({ clientId: await newClient(), challenge: pkce().challenge })),
    );
    expect(page.res.status).toBe(400);
    expect(page.html).toContain("Only owners and admins");
  });

  it("denying sends access_denied back to the client", async () => {
    const clientId = await newClient();
    const res = await approve(await owner(), {
      clientId,
      challenge: pkce().challenge,
      form: { decision: "deny" },
    });
    const loc = new URL(res.location!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(loc.searchParams.has("code")).toBe(false);
  });

  it("the account export lists every stored connection, and erasure removes them", async () => {
    const email = "export@oauth.example";
    const b = new Browser(s.app);
    await b.signIn(s, email);
    const accountId = await accountOf(email);
    const clientId = await newClient([CALLBACK], "Exported App");
    const live = await connect(b, clientId, { default_workspace: "kept" });
    const gone = await connect(b, clientId, { default_workspace: "dropped" });
    // Revoke the second connection (the dashboard lists the newest first).
    const page = await b.get("/app/keys");
    const [newest] = [...page.html.matchAll(/\/app\/connected-apps\/([^/]+)\/revoke/g)];
    await b.post(`/app/connected-apps/${newest![1]}/revoke`, { confirm: "1" });
    expect((await mcp(gone.access_token, "tools/list")).status).toBe(401);

    // A revoked connection stays stored (30 days, for reuse detection): the export shows it too,
    // as it shows revoked API keys.
    const exp = await b.post("/app/settings/export");
    expect(exp.res.status).toBe(200);
    const data = JSON.parse(exp.html) as {
      connected_apps: { default_workspace: string; revoked_at: string | null }[];
    };
    const byWs = Object.fromEntries(data.connected_apps.map((a) => [a.default_workspace, a]));
    expect(Object.keys(byWs).sort()).toEqual(["dropped", "kept"]);
    expect(byWs.kept!.revoked_at).toBeNull();
    expect(byWs.dropped!.revoked_at).not.toBeNull();
    expect(exp.html).not.toContain(live.access_token);
    expect(exp.html).not.toContain(live.refresh_token);
    expect(exp.html).not.toContain("token_hash");
    expect(exp.html).not.toContain("code_challenge");

    // Erasure: the account's codes, connections and tokens go with it.
    const [acct] = await rows<{ name: string }>(
      s.ctx.db,
      sql`SELECT name FROM accounts WHERE id = ${accountId}`,
    );
    expect((await b.post("/app/settings/delete", { confirm: acct!.name })).res.status).toBe(303);
    expect((await mcp(live.access_token, "tools/list")).status).toBe(401);
    for (const table of ["oauth_codes", "oauth_grants"]) {
      const left = await rows(
        s.ctx.db,
        sql`SELECT 1 FROM ${sql.identifier(table)} WHERE account_id = ${accountId}`,
      );
      expect(left, table).toHaveLength(0);
    }
    const tokens = await rows(
      s.ctx.db,
      sql`SELECT 1 FROM oauth_tokens t WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = t.grant_id)`,
    );
    expect(tokens).toHaveLength(0);
  });
});

describe("oauth: negative cases", () => {
  it("a wrong PKCE verifier fails, and spends the code", async () => {
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId, challenge });
    const code = new URL(location!).searchParams.get("code")!;
    const base = {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      resource: RESOURCE,
    };
    const wrong = await token({ ...base, code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");
    expect((await token({ ...base, code_verifier: verifier })).json.error).toBe("invalid_grant");
    const missing = await token(base);
    expect(missing.json.error).toBe("invalid_request");
  });

  it("refuses a redirect_uri that was not registered, without redirecting", async () => {
    const clientId = await newClient();
    const b = await owner();
    const { challenge } = pkce();
    for (const redirectUri of [
      "https://attacker.example/callback",
      "https://client.example/callback/../evil",
      `${CALLBACK}?x=1`,
    ]) {
      const page = await b.get(authorizeUrl(baseParams({ clientId, challenge, redirectUri })));
      expect(page.res.status).toBe(400);
      expect(page.res.headers.get("location")).toBeNull();
      expect(page.html).toContain("redirect_uri mismatch");
    }
    const unknownClient = await b.get(
      authorizeUrl(baseParams({ clientId: "rc_doesnotexist", challenge })),
    );
    expect(unknownClient.res.status).toBe(400);
    expect(unknownClient.res.headers.get("location")).toBeNull();
  });

  it("a redirect_uri at the token endpoint must match the authorization request", async () => {
    const clientId = await newClient([CALLBACK, "https://client.example/other"]);
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId, challenge });
    const t = await token({
      grant_type: "authorization_code",
      code: new URL(location!).searchParams.get("code")!,
      redirect_uri: "https://client.example/other",
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(t.json.error).toBe("invalid_grant");
  });

  it("requires the resource to be this server's MCP endpoint", async () => {
    const clientId = await newClient();
    const b = await owner();
    const { verifier, challenge } = pkce();
    for (const resource of [undefined, "https://other.example/mcp", `${PUBLIC_URL}/v3`]) {
      const page = await b.get(authorizeUrl(baseParams({ clientId, challenge, resource })));
      const back = returnedError(page);
      expect(back.target).toBe(CALLBACK);
      expect(back.params.get("error")).toBe("invalid_target");
      expect(back.params.get("state")).toBe("st-123");
      expect(back.params.get("iss")).toBe(PUBLIC_URL);
    }
    // Case and a trailing slash do not matter.
    const variant = await b.get(
      authorizeUrl(baseParams({ clientId, challenge, resource: "HTTPS://RECALL.TEST/mcp/" })),
    );
    expect(variant.res.status).toBe(200);
    // At the token endpoint too.
    const { location } = await approve(b, { clientId, challenge });
    const code = new URL(location!).searchParams.get("code")!;
    const base = {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    };
    expect((await token(base)).json.error).toBe("invalid_request");
    expect((await token({ ...base, resource: "https://other.example/mcp" })).json.error).toBe(
      "invalid_target",
    );
    // Neither attempt reached the code, which still works.
    expect((await token({ ...base, resource: RESOURCE })).status).toBe(200);
  });

  it("requires PKCE with S256", async () => {
    const clientId = await newClient();
    const b = await owner();
    const { challenge } = pkce();
    for (const override of [
      { code_challenge: undefined },
      { code_challenge_method: "plain" },
      { code_challenge_method: undefined },
      { code_challenge: "short" },
    ]) {
      const page = await b.get(
        authorizeUrl({ ...baseParams({ clientId, challenge }), ...override }),
      );
      expect(returnedError(page).params.get("error")).toBe("invalid_request");
    }
  });

  it("an expired code fails", async () => {
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId, challenge });
    const code = new URL(location!).searchParams.get("code")!;
    const [row] = await rows<{ ttl: number }>(
      s.ctx.db,
      sql`SELECT EXTRACT(EPOCH FROM expires_at - created_at)::float8 AS ttl FROM oauth_codes
          ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row!.ttl).toBeLessThanOrEqual(60);
    await s.ctx.db.execute(
      sql`UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`,
    );
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(t.json.error).toBe("invalid_grant");
    expect(t.json.error_description).toContain("expired");
  });

  it("a reused code fails and revokes what the first use issued", async () => {
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId, challenge });
    const params = {
      grant_type: "authorization_code",
      code: new URL(location!).searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    };
    const first = await token(params);
    expect(first.status).toBe(200);
    const second = await token(params);
    expect(second.json.error).toBe("invalid_grant");
    expect((await mcp(first.json.access_token, "tools/list")).status).toBe(401);
  });

  it("racing one code or one refresh token leaves nothing usable", async () => {
    const works = async (at: string | undefined) =>
      at !== undefined && (await mcp(at, "tools/list")).status === 200;
    const clientId = await newClient();
    // Two exchanges of one code at once: whatever the interleaving, the code counts as replayed.
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId, challenge });
    const exchange = {
      grant_type: "authorization_code",
      code: new URL(location!).searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    };
    const codes = await Promise.all([token(exchange), token(exchange)]);
    expect(codes.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    for (const r of codes) {
      expect(await works(r.json.access_token)).toBe(false);
      if (r.json.refresh_token)
        expect(
          (
            await token({
              grant_type: "refresh_token",
              refresh_token: r.json.refresh_token,
              client_id: clientId,
            })
          ).status,
        ).toBe(400);
    }

    // Two refreshes with one refresh token at once: one of them is a reuse, so the family ends.
    const t = await connect(await owner(), clientId);
    const refresh = {
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: clientId,
    };
    const both = await Promise.all([token(refresh), token(refresh)]);
    expect(both.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(both.some((r) => r.json.error === "invalid_grant")).toBe(true);
    expect(await works(t.access_token)).toBe(false);
    for (const r of both) {
      expect(await works(r.json.access_token)).toBe(false);
      if (r.json.refresh_token)
        expect(
          (
            await token({
              grant_type: "refresh_token",
              refresh_token: r.json.refresh_token,
              client_id: clientId,
            })
          ).json.error,
        ).toBe("invalid_grant");
    }
  });

  it("a code issued to one client cannot be redeemed by another", async () => {
    const clientId = await newClient();
    const otherId = await newClient();
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId, challenge });
    const t = await token({
      grant_type: "authorization_code",
      code: new URL(location!).searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: otherId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(t.json.error).toBe("invalid_grant");
  });

  it("refuses a consent POST without (or with a wrong) CSRF token", async () => {
    const clientId = await newClient();
    const before = await rows(s.ctx.db, sql`SELECT 1 FROM oauth_codes`);
    for (const csrf of [null, "forged"]) {
      const res = await approve(await owner(), { clientId, challenge: pkce().challenge, csrf });
      expect(res.res.status).toBe(403);
      expect(res.location).toBeNull();
    }
    // Nor from another origin with a valid token.
    const b = await owner();
    const page = await b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge })));
    const cross = await b.post(
      "/oauth/authorize",
      { ...consentFields(page.html), default_workspace: "main", decision: "allow" },
      { headers: { origin: "https://attacker.example" } },
    );
    expect(cross.res.status).toBe(403);
    expect(await rows(s.ctx.db, sql`SELECT 1 FROM oauth_codes`)).toHaveLength(before.length);
  });

  it("cannot connect an app to another user's account", async () => {
    const clientId = await newClient();
    const victim = await accountOf("flow@oauth.example");
    const res = await approve(await owner(), {
      clientId,
      challenge: pkce().challenge,
      form: { account: victim },
    });
    expect(res.res.status).toBe(400);
    expect(res.location).toBeNull();
    expect(res.html).toContain("cannot connect apps to that account");
  });

  it("refuses bad workspace names on the consent form", async () => {
    const clientId = await newClient();
    const res = await approve(await owner(), {
      clientId,
      challenge: pkce().challenge,
      form: { default_workspace: "../etc" },
    });
    expect(res.res.status).toBe(422);
    expect(res.location).toBeNull();
  });

  it("answers OAuth errors at the token endpoint", async () => {
    expect((await token({ grant_type: "password", username: "a" })).json.error).toBe(
      "unsupported_grant_type",
    );
    expect((await token({})).json.error).toBe("invalid_request");
    const json = await s.app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "grant_type=refresh_token",
    });
    expect(json.status).toBe(400);
    const unknown = await token({
      grant_type: "refresh_token",
      refresh_token: `ort_${"a".repeat(43)}`,
      client_id: "rc_x",
    });
    expect(unknown.json.error).toBe("invalid_grant");
  });

  it("prompt=none never shows the consent screen", async () => {
    const clientId = await newClient();
    const signedOut = new Browser(s.app);
    const params = { ...baseParams({ clientId, challenge: pkce().challenge }), prompt: "none" };
    const out = await signedOut.get(authorizeUrl(params));
    expect(returnedError(out).params.get("error")).toBe("login_required");
    const inside = await (await owner()).get(authorizeUrl(params));
    expect(returnedError(inside).params.get("error")).toBe("consent_required");
  });

  it("is not an open redirector: a registered attacker URI gets no automatic redirect", async () => {
    const evil = await newClient(["https://attacker.example/landing"], "Totally Legit");
    const victim = new Browser(s.app);
    const page = await victim.get(
      authorizeUrl({
        ...baseParams({ clientId: evil, challenge: pkce().challenge }),
        redirect_uri: "https://attacker.example/landing",
        response_type: "token",
      }),
    );
    const back = returnedError(page);
    expect(back.target).toBe("https://attacker.example/landing");
    expect(back.params.get("error")).toBe("unsupported_response_type");
  });

  it("sends a sign-in link on to its consent screen only in the browser that asked for it", async () => {
    const clientId = await newClient([CALLBACK], "Phisher");
    const { challenge } = pkce();
    const next = authorizeUrl(baseParams({ clientId, challenge, state: "lure" }));
    // Someone else requests a link for the victim's address, with their app as the next page.
    const attacker = new Browser(s.app);
    await attacker.get(`/app/login?next=${encodeURIComponent(next)}`);
    await attacker.post("/app/login", { email: "victim@oauth.example", next });
    const mail = s.mailer.outbox.filter((m) => m.to === "victim@oauth.example").at(-1)!;
    const link = new URL(mail.text.match(/https:\/\/\S+/)![0]);
    // The victim opens the genuine email in their own browser: they land on their dashboard.
    const victim = new Browser(s.app);
    await victim.get(`${link.pathname}${link.search}`);
    const verified = await victim.post("/app/auth/verify", {
      token: link.searchParams.get("token")!,
    });
    expect(verified.res.status).toBe(303);
    expect(verified.res.headers.get("location")).toBe("/app");
  });

  it("ignores a next parameter that is not an authorization request", async () => {
    const b = new Browser(s.app);
    await b.get("/app/login?next=https://evil.example/");
    for (const next of ["https://evil.example/", "//evil.example/", "/app/settings"]) {
      const page = await b.get(`/app/login?next=${encodeURIComponent(next)}`);
      expect(page.html).not.toContain('name="next"');
    }
  });
});

describe("oauth: revocation with the production token cache", () => {
  // The suite runs with RECALL_KEY_CACHE_TTL_MS=0; production caches verified tokens (5 s), and
  // a revocation in this process must still take effect at once.
  let uncached: OAuthTokenVerifier;
  beforeEach(() => {
    uncached = s.ctx.tenancy.oauth;
    s.ctx.tenancy.oauth = new OAuthTokenVerifier(s.ctx.db, 60_000);
  });
  afterEach(() => {
    s.ctx.tenancy.oauth = uncached;
  });

  it("refresh-token reuse ends the family's cached access tokens at once", async () => {
    const clientId = await newClient();
    const t = await connect(await owner(), clientId);
    const r1 = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: clientId,
    });
    expect(r1.status).toBe(200);
    // Both access tokens of the family are now in the verifier's cache.
    expect((await mcp(t.access_token, "tools/list")).status).toBe(200);
    expect((await mcp(r1.json.access_token, "tools/list")).status).toBe(200);
    const reuse = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: clientId,
    });
    expect(reuse.json.error).toBe("invalid_grant");
    expect((await mcp(t.access_token, "tools/list")).status).toBe(401);
    expect((await mcp(r1.json.access_token, "tools/list")).status).toBe(401);
  });

  it("a replayed authorization code ends the cached tokens it issued at once", async () => {
    const clientId = await newClient();
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId, challenge });
    const params = {
      grant_type: "authorization_code",
      code: new URL(location!).searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    };
    const first = await token(params);
    expect((await mcp(first.json.access_token, "tools/list")).status).toBe(200);
    expect((await token(params)).json.error).toBe("invalid_grant");
    expect((await mcp(first.json.access_token, "tools/list")).status).toBe(401);
  });

  it("client and dashboard revocations end cached tokens at once", async () => {
    const clientId = await newClient();
    const b = await owner();
    const a = await connect(b, clientId);
    expect((await mcp(a.access_token, "tools/list")).status).toBe(200);
    const revoked = await s.app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: a.access_token }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect((await mcp(a.access_token, "tools/list")).status).toBe(401);

    const d = await connect(b, clientId);
    expect((await mcp(d.access_token, "tools/list")).status).toBe(200);
    const page = await b.get("/app/keys");
    const grantIds = [...page.html.matchAll(/\/app\/connected-apps\/([^/]+)\/revoke/g)].map(
      (m) => m[1]!,
    );
    for (const id of grantIds) await b.post(`/app/connected-apps/${id}/revoke`, { confirm: "1" });
    expect((await mcp(d.access_token, "tools/list")).status).toBe(401);
  });
});

describe("oauth: client ID metadata documents", () => {
  const DOC_URL = "https://app.example/oauth/client.json";
  // Document fetches are limited per user and minute; each test starts with a fresh allowance.
  beforeEach(() => {
    s.ctx.tenancy.limiter = new RateLimiter();
  });
  const doc = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      client_id: DOC_URL,
      client_name: "Metadata App",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      ...over,
    });

  function network(body: string, address = "93.184.216.34", headers: Record<string, string> = {}) {
    const transport = vi.fn<DocumentTransport>(async () => ({
      status: 200,
      contentType: "application/json",
      cacheControl: headers["cache-control"] ?? null,
      body,
    }));
    setClientMetadataNetwork({ resolver: async () => [address], transport });
    return transport;
  }

  it("fetches the document after sign-in, then caches it", async () => {
    await s.ctx.db.execute(sql`DELETE FROM oauth_clients WHERE id = ${DOC_URL}`);
    const transport = network(doc(), "93.184.216.34", { "cache-control": "max-age=600" });
    const { verifier, challenge } = pkce();
    // Signed out: no fetch yet, straight to sign-in.
    const out = await new Browser(s.app).get(
      authorizeUrl(baseParams({ clientId: DOC_URL, challenge })),
    );
    expect(out.res.status).toBe(303);
    expect(transport).not.toHaveBeenCalled();
    const b = await owner();
    const { page, location } = await approve(b, { clientId: DOC_URL, challenge });
    expect(page.html).toContain("Metadata App");
    expect(page.html).toContain("app.example");
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, address] = transport.mock.calls[0]!;
    expect(url.toString()).toBe(DOC_URL);
    expect(address).toBe("93.184.216.34");
    const t = await token({
      grant_type: "authorization_code",
      code: new URL(location!).searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: DOC_URL,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(t.status).toBe(200);
    expect((await mcp(t.json.access_token, "tools/list")).status).toBe(200);
  });

  it("serves a client that prefers private_key_jwt but also supports none (ChatGPT)", async () => {
    await s.ctx.db.execute(sql`DELETE FROM oauth_clients WHERE id = ${DOC_URL}`);
    network(
      doc({
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        token_endpoint_auth_signing_alg: "RS256",
        jwks_uri: "https://app.example/oauth/jwks.json",
      }),
    );
    const { verifier, challenge } = pkce();
    const { location } = await approve(await owner(), { clientId: DOC_URL, challenge });
    const t = await token({
      grant_type: "authorization_code",
      code: new URL(location!).searchParams.get("code")!,
      redirect_uri: CALLBACK,
      client_id: DOC_URL,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(t.status).toBe(200);
  });

  it("refuses documents that do not describe themselves", async () => {
    const b = await owner();
    const cases: [string, string][] = [
      [doc({ client_id: "https://other.example/client.json" }), "client_id other than its own URL"],
      [doc({ client_name: undefined }), "no client_name"],
      [doc({ token_endpoint_auth_method: "client_secret_basic" }), "public clients"],
      [
        doc({
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
        }),
        "public clients",
      ],
      [doc({ redirect_uris: ["javascript:alert(1)"] }), "no acceptable redirect URI"],
      ["not json", "not valid JSON"],
    ];
    for (const [body, message] of cases) {
      await s.ctx.db.execute(sql`DELETE FROM oauth_clients WHERE id = ${DOC_URL}`);
      network(body);
      const page = await b.get(
        authorizeUrl(baseParams({ clientId: DOC_URL, challenge: pkce().challenge })),
      );
      expect(page.res.status, message).toBe(400);
      expect(page.html, message).toContain(message);
    }
  });

  it("never fetches from private, loopback or reserved addresses (SSRF)", async () => {
    const b = await owner();
    const transport = vi.fn<DocumentTransport>();
    const resolve: Record<string, string[]> = {
      "internal.example": ["10.1.2.3"],
      "metadata.example": ["169.254.169.254"],
      "mixed.example": ["93.184.216.34", "192.168.1.10"],
      "v6.example": ["fd00::1"],
      "mapped.example": ["::ffff:127.0.0.1"],
    };
    setClientMetadataNetwork({
      resolver: async (host) => resolve[host] ?? ["93.184.216.34"],
      transport,
    });
    for (const clientId of [
      "https://127.0.0.1/client.json",
      "https://10.0.0.8/client.json",
      "https://[::1]/client.json",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/client.json",
      "https://printer.local/client.json",
      "https://internal.example/client.json",
      "https://metadata.example/client.json",
      "https://mixed.example/client.json",
      "https://v6.example/client.json",
      "https://mapped.example/client.json",
    ]) {
      s.ctx.tenancy.limiter = new RateLimiter();
      const page = await b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge })));
      expect(page.res.status, clientId).toBe(400);
      expect(page.html, clientId).toContain("private, loopback or reserved");
    }
    // Not https, or no path: refused before any lookup.
    for (const clientId of [
      "https://app.example",
      "https://app.example/",
      "https://app.example/a/../b",
    ]) {
      const page = await b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge })));
      expect(page.res.status, clientId).toBe(400);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("limits document fetches per user", async () => {
    await s.ctx.db.execute(sql`DELETE FROM oauth_clients WHERE kind = 'metadata_document'`);
    const transport = network(doc(), "93.184.216.34", { "cache-control": "no-store" });
    const b = await owner();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const clientId = `https://app.example/oauth/client-${i}.json`;
      transport.mockImplementation(async () => ({
        status: 200,
        contentType: "application/json",
        cacheControl: null,
        body: doc({ client_id: clientId }),
      }));
      const page = await b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge })));
      if (page.html.includes("Too many app lookups")) limited++;
    }
    expect(transport).toHaveBeenCalledTimes(10);
    expect(limited).toBe(2);
  });
});

describe("oauth: consent screen hardening", () => {
  const codes = async () => (await rows(s.ctx.db, sql`SELECT 1 FROM oauth_codes`)).length;

  it("refuses an Allow that comes sooner than a second after the page was shown", async () => {
    const clientId = await newClient();
    const b = await owner();
    const page = await b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge })));
    expect(page.html).toMatch(/<input type="hidden" name="consent" value="\d{13}\.[\w-]{43}"/);
    const before = await codes();
    const quick = await b.post("/oauth/authorize", {
      ...consentFields(page.html),
      default_workspace: "main",
      decision: "allow",
    });
    // Shown again (with a fresh token), nothing issued, no redirect to the app.
    expect(quick.res.status).toBe(400);
    expect(quick.res.headers.get("location")).toBeNull();
    expect(quick.html).toContain("quicker than anyone can read the request");
    expect(quick.html).toContain("data-consent>Allow</button>");
    expect(await codes()).toBe(before);
    // Declining needs no wait.
    const deny = await b.post("/oauth/authorize", {
      ...consentFields(page.html),
      default_workspace: "main",
      decision: "deny",
    });
    expect(new URL(deny.res.headers.get("location")!).searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("refuses a missing, altered, expired or borrowed consent token", async () => {
    const clientId = await newClient();
    const b = await owner();
    const page = await earlier(() =>
      b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge }))),
    );
    const fields = consentFields(page.html);
    const [at, mac] = fields.consent!.split(".") as [string, string];
    const otherClient = await newClient();
    const other = await earlier(() =>
      b.get(authorizeUrl(baseParams({ clientId: otherClient, challenge: pkce().challenge }))),
    );
    const before = await codes();
    for (const consent of [
      undefined,
      `${Number(at) - 5_000}.${mac}`, // backdated: the MAC covers the time
      consentFields(other.html).consent, // rendered for another request
      "garbage",
    ]) {
      const { consent: _drop, ...rest } = fields;
      const res = await b.post("/oauth/authorize", {
        ...rest,
        ...(consent === undefined ? {} : { consent }),
        default_workspace: "main",
        decision: "allow",
      });
      expect(res.res.status, String(consent)).toBe(403);
      expect(res.res.headers.get("location")).toBeNull();
    }
    // Older than an hour.
    const stale = await earlier(
      () => b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge }))),
      61 * 60_000,
    );
    const late = await b.post("/oauth/authorize", {
      ...consentFields(stale.html),
      default_workspace: "main",
      decision: "allow",
    });
    expect(late.res.status).toBe(403);
    expect(await codes()).toBe(before);
  });

  it("isolates the app's name and flags look-alike names", async () => {
    const b = await owner();
    const show = async (name: string) => {
      const clientId = await newClient([CALLBACK], name);
      return (await b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge }))))
        .html;
    };
    const plain = await show("Claude");
    expect(plain).toContain("<bdi>Claude</bdi>");
    expect(plain).toContain("name not verified");
    expect(plain).not.toContain("data-name-warning");
    // A Cyrillic С in front of Latin letters.
    const mixed = await show("\u0421laude");
    expect(mixed).toContain("<bdi>\u0421laude</bdi>");
    expect(mixed).toContain("data-name-warning");
    expect(mixed).toContain("mixes alphabets (Latin, Cyrillic)");
    expect(mixed).toContain("name not verified");
    const foreign = await show("\u041a\u043b\u043e\u0434");
    expect(foreign).toContain("data-name-warning");
    expect(foreign).toContain("outside plain ASCII");
    expect(foreign).not.toContain("mixes alphabets");
  });
});

describe("oauth: token endpoint limits and refresh-token storage", () => {
  beforeEach(() => {
    s.ctx.tenancy.limiter = new RateLimiter();
  });

  it("limits token requests per client network (429 with Retry-After)", async () => {
    const cfg = s.ctx.config.hosted.oauth;
    const saved = cfg.tokenRatePerMin;
    cfg.tokenRatePerMin = 5;
    try {
      const ask = (ip: string) =>
        token(
          { grant_type: "refresh_token", refresh_token: "nope", client_id: "rc_x" },
          { "x-forwarded-for": ip },
        );
      for (let i = 0; i < 5; i++) expect((await ask("192.0.2.90")).status).toBe(400);
      const limited = await ask("192.0.2.90");
      expect(limited.status).toBe(429);
      expect(limited.json.error).toBe("too_many_requests");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await ask("192.0.2.91")).status).toBe(400); // another network is unaffected
    } finally {
      cfg.tokenRatePerMin = saved;
    }
  });

  it("limits refreshes per grant, before the refresh token is spent", async () => {
    const clientId = await newClient();
    let t = await connect(await owner(), clientId);
    const refresh = (rt: string) =>
      token({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId });
    for (let i = 0; i < 10; i++) {
      const r = await refresh(t.refresh_token);
      expect(r.status).toBe(200);
      t = r.json;
    }
    const limited = await refresh(t.refresh_token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    // The refused request did not spend the token: it works once the limit allows again.
    s.ctx.tenancy.limiter = new RateLimiter();
    expect((await refresh(t.refresh_token)).status).toBe(200);
  });

  it("purges used refresh tokens after a day and still detects their reuse", async () => {
    const clientId = await newClient();
    const first = await connect(await owner(), clientId);
    const refresh = (rt: string) =>
      token({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId });
    const second = (await refresh(first.refresh_token)).json;
    const third = (await refresh(second.refresh_token)).json;
    const [grant] = await rows<{ grant_id: string }>(
      s.ctx.db,
      sql`SELECT grant_id FROM oauth_tokens WHERE token_hash = ${createHash("sha256").update(third.refresh_token).digest("hex")}`,
    );
    const grantId = grant!.grant_id;
    expect(first.refresh_token).toContain(`.${grantId}.`);
    const refreshRows = async () =>
      (
        await rows(
          s.ctx.db,
          sql`SELECT 1 FROM oauth_tokens WHERE grant_id = ${grantId} AND kind = 'refresh'`,
        )
      ).length;
    expect(await refreshRows()).toBe(3);
    await s.ctx.db.execute(
      sql`UPDATE oauth_tokens SET used_at = now() - interval '2 days'
          WHERE grant_id = ${grantId} AND used_at IS NOT NULL`,
    );
    await purgeOAuth(s.ctx.db);
    expect(await refreshRows()).toBe(1); // only the live one is left
    expect((await mcp(third.access_token, "tools/list")).status).toBe(200);

    // A forged token naming the grant (wrong MAC) is just unknown: the grant stays.
    const forged = `ort_${"A".repeat(43)}.${grantId}.${"B".repeat(43)}`;
    const unknown = await refresh(forged);
    expect(unknown.json.error_description).toBe("Unknown refresh token");
    expect((await mcp(third.access_token, "tools/list")).status).toBe(200);

    // The purged first token is still recognised as this grant's, and its reuse ends the grant.
    const reuse = await refresh(first.refresh_token);
    expect(reuse.json.error).toBe("invalid_grant");
    expect(reuse.json.error_description).toContain("already used");
    expect((await mcp(third.access_token, "tools/list")).status).toBe(401);
    expect((await refresh(third.refresh_token)).json.error).toBe("invalid_grant");
  });
});

describe("POST /v3/keys", () => {
  const auth = (via: AuthState["via"]): AuthState => ({
    admin: true,
    claims: { ad: true },
    account: "acct_somebody",
    via,
  });

  it("mints a JWT only for a JWT (or open) caller, never for a dashboard or OAuth one", async () => {
    const minted = await mintForCaller(s.ctx, auth("jwt"), { workspace_id: "w" });
    expect(verifyToken(minted.key, s.ctx.config.auth.secret!)).toMatchObject({ w: "w" });
    for (const via of ["dashboard", "oauth"] as const) {
      await expect(mintForCaller(s.ctx, auth(via), { workspace_id: "w" })).rejects.toMatchObject({
        status: 401,
      });
    }
  });
});

describe("oauth: off unless hosted with a public URL", () => {
  it("self-hosted servers have no OAuth surface and an unchanged /mcp challenge", async () => {
    const plain = await createTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: "plain-secret",
    });
    try {
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
      ])
        expect((await plain.request("GET", path)).status).toBe(404);
      expect(
        (await plain.request("POST", "/oauth/register", { redirect_uris: [CALLBACK] })).status,
      ).toBe(404);
      const res = await plain.app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://x.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="recall"');
      expect(res.headers.get("access-control-expose-headers")).toBeNull();
    } finally {
      await plain.close();
    }
  });

  it("RECALL_OAUTH_ENABLED=false switches it off in hosted mode", async () => {
    const off = await createHostedServer({
      billing: false,
      env: { RECALL_OAUTH_ENABLED: "false" },
    });
    try {
      expect((await off.app.request("/.well-known/oauth-authorization-server")).status).toBe(404);
      const res = await off.api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="recall"');
    } finally {
      await off.close();
    }
  });
});

describe("oauth: remember automatically", () => {
  const init = async (accessToken: string): Promise<string> => {
    const r = await mcp(accessToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    return r.json.result.instructions as string;
  };

  it("is ticked on the consent page, and the dashboard turns it off for one app", async () => {
    const b = await owner();
    const clientId = await newClient();
    const page = await earlier(() =>
      b.get(authorizeUrl(baseParams({ clientId, challenge: pkce().challenge }))),
    );
    expect(page.html).toContain('<input type="checkbox" name="auto_remember" value="1" checked />');

    // A browser sends the ticked box; the app is told to save lasting facts unasked.
    const t = await connect(b, clientId, { auto_remember: "1" });
    expect(await init(t.access_token)).toContain("without being asked");

    const keys = await b.get("/app/keys");
    expect(keys.html).toContain("Remember automatically");
    const grantId = keys.html.match(/\/app\/connected-apps\/([^/]+)\/auto-remember/)![1]!;
    const off = await b.post(`/app/connected-apps/${grantId}/auto-remember`, { on: "0" });
    expect(off.res.status).toBe(303);
    const instructions = await init(t.access_token);
    expect(instructions).not.toContain("without being asked");
    expect(instructions).toContain("save what the user asks you to remember");

    // Unticked at consent: off from the start.
    const t2 = await connect(b, await newClient());
    expect(await init(t2.access_token)).not.toContain("without being asked");
  });
});
