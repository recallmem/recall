import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inlineScriptHashes, siteCsp } from "../src/http/security.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Three hosts, one deployment: the API (RECALL_PUBLIC_URL, the OAuth issuer), the
 * dashboard at the root of its own host (RECALL_DASHBOARD_URL) and the site
 * (RECALL_SITE_URL). Plus the security headers and request limits every route gets.
 */

const API = "https://api.recall.test";
const APP = "https://app.recall.test";
const SITE = "https://recall.test";
const CALLBACK = "https://client.example/callback";

let s: HostedServer;
beforeAll(async () => {
  s = await createHostedServer({
    billing: false,
    env: {
      RECALL_PUBLIC_URL: API,
      RECALL_DASHBOARD_URL: APP,
      RECALL_SITE_URL: SITE,
      RECALL_SIGNUP_ENABLED: "true",
    },
  });
});
afterAll(async () => {
  await s.close();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  s.app.request(url, { headers, redirect: "manual" });

describe("three hosts", () => {
  it("redirects to the host each thing lives on, and never moves the API", async () => {
    const cases: [string, number, string][] = [
      [`${SITE}/app/keys?x=1`, 302, `${APP}/keys?x=1`],
      [`${API}/app`, 302, `${APP}/`],
      [`${APP}/app/keys?x=1`, 308, `${APP}/keys?x=1`],
      [`${API}/oauth/authorize?a=1`, 302, `${APP}/oauth/authorize?a=1`],
      [`${API}/docs`, 308, `${SITE}/docs`],
      [`${API}/`, 308, `${SITE}/`],
      [`${APP}/docs`, 308, `${SITE}/docs`],
      // A deployment URL goes to the canonical host of what was asked for.
      ["https://recall-abc.vercel.app/v3/workspaces/list", 308, `${API}/v3/workspaces/list`],
      ["https://recall-abc.vercel.app/app/keys", 308, `${APP}/keys`],
      ["https://recall-abc.vercel.app/docs", 308, `${SITE}/docs`],
    ];
    for (const [url, status, location] of cases) {
      const res = await get(url);
      expect(res.status, url).toBe(status);
      expect(res.headers.get("location"), url).toBe(location);
    }
    for (const url of [
      `${API}/health`,
      `${SITE}/`,
      `${SITE}/docs`,
      `${APP}/favicon.svg`,
      `${APP}/fonts/departure-mono.woff2`,
      "https://recall-abc.vercel.app/health",
      `${API}/.well-known/oauth-authorization-server`,
    ])
      expect((await get(url)).status, url).toBe(200);
    expect((await get("https://recall-abc.vercel.app/internal/tick")).status).not.toBe(308);
    // The API still answers on the site's host (an alias), and on its own.
    for (const base of [API, SITE]) {
      const res = await s.app.request(`${base}/v3/workspaces/list`, { method: "POST" });
      expect(res.status, base).toBe(401);
    }
  });

  it("shows browsers a 404 page and API clients a JSON 404", async () => {
    for (const base of [SITE, APP, API]) {
      const page = await s.app.request(`${base}/no-such-page`, {
        headers: { accept: "text/html" },
      });
      expect(page.status, base).toBe(404);
      expect(page.headers.get("content-type"), base).toContain("text/html");
      expect(await page.text(), base).toContain("404 · Never formed");
    }
    const api = await s.app.request(`${API}/v3/no-such-thing`, {
      headers: { accept: "application/json" },
    });
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ detail: "Not Found" });
  });

  it("puts the issuer on the API host and the authorization endpoint on the dashboard host", async () => {
    const m = (await (await get(`${API}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      string
    >;
    expect(m.issuer).toBe(API);
    expect(m.authorization_endpoint).toBe(`${APP}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${API}/oauth/token`);
    expect(m.registration_endpoint).toBe(`${API}/oauth/register`);
    const r = (await (await get(`${API}/.well-known/oauth-protected-resource/mcp`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(r).toMatchObject({ resource: `${API}/mcp`, authorization_servers: [API] });
  });

  it("serves the dashboard at its host's root, with sign-in links, links and cookies to match", async () => {
    const b = new Browser(s.app, "203.0.113.70", APP);
    const link = await b.signIn(s, "hosts@example.com");
    expect(link.startsWith(`${APP}/auth/verify?token=`)).toBe(true);
    const home = await b.get("/");
    expect(home.res.status).toBe(200);
    expect(home.html).toContain('href="/keys"');
    expect(home.html).toContain('src="/static/app.js"');
    expect(home.html).not.toContain('href="/app');
    // Onboarding snippets point at the API's host, the MCP endpoint and the dashboard's own keys page.
    expect(home.html).toContain(`curl ${API}/v3/workspaces/my-app/sessions/s1/messages`);
    expect(home.html).toContain(`&quot;url&quot;: &quot;${API}/mcp&quot;`);
    expect(home.html).toContain(`create a key at ${APP}/keys`);
    expect(home.html).toContain('href="/?connect=ts#connect"');
    // A trailing slash is the page without it.
    const slash = await b.get("/keys/");
    expect(slash.res.status).toBe(308);
    expect(slash.res.headers.get("location")).toBe("/keys");
    // Host-only cookies, and none of the API's CORS on cookie-authenticated pages.
    const login = await s.app.request(`${APP}/login`, {
      headers: { origin: "https://evil.example" },
    });
    for (const c of login.headers.getSetCookie()) {
      expect(c).toMatch(/^__Host-/);
      expect(c).not.toMatch(/domain=/i);
    }
    expect(login.headers.get("access-control-allow-origin")).toBeNull();
    // Forms from another origin (the API's or the site's host) are refused.
    const cross = await b.post("/keys", { name: "x" }, { headers: { origin: SITE } });
    expect(cross.res.status).toBe(403);
    // Signed out, the brand links to the site's host.
    const out = await new Browser(s.app, "203.0.113.71", APP).get("/login");
    expect(out.html).toContain(`href="${SITE}/"`);
  });

  it("connects an MCP client across the hosts", async () => {
    const reg = await s.app.request(`${API}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Hosts", redirect_uris: [CALLBACK] }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${API}/mcp`,
      state: "s1",
    });
    const b = new Browser(s.app, "203.0.113.72", APP);
    const signedOut = await b.get(`/oauth/authorize?${q}`);
    expect(signedOut.res.headers.get("location")).toMatch(/^\/login\?next=%2Foauth%2Fauthorize/);
    await b.signIn(s, "connect@example.com");
    const realNow = Date.now;
    Date.now = () => realNow() - 1500; // render the consent page "earlier" than the click
    const page = await b.get(`/oauth/authorize?${q}`).finally(() => {
      Date.now = realNow;
    });
    const fields = Object.fromEntries(
      [...page.html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)]
        .filter((m) => m[1] !== "_csrf")
        .map((m) => [m[1]!, m[2]!.replaceAll("&amp;", "&")]),
    );
    const decided = await b.post("/oauth/authorize", {
      ...fields,
      default_workspace: "main",
      decision: "allow",
    });
    const back = new URL(decided.res.headers.get("location")!);
    expect(back.searchParams.get("iss")).toBe(API);
    const t = await s.app.request(`${API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${API}/mcp`,
      }).toString(),
    });
    expect(t.status).toBe(200);
    const { access_token } = (await t.json()) as { access_token: string };
    const listed = await s.app.request(`${API}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
  });

  it("fills the docs' API URL with this deployment's", async () => {
    const docs = await (await get(`${SITE}/docs`)).text();
    expect(docs).toContain(`<meta name="recall-api" content="${API}" data-site="${SITE}" />`);
  });
});

describe("security headers and limits", () => {
  it("sends the site's CSP on its pages, a strict one on the API, and keeps the dashboard's", async () => {
    const page = await get(`${SITE}/docs`);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(page.headers.get("permissions-policy")).toContain("camera=()");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self' 'sha256-");
    const api = await s.app.request(`${API}/v3/workspaces/list`, { method: "POST" });
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(api.headers.get("content-security-policy")).toContain("default-src 'none'");
    const dash = await get(`${APP}/login`);
    expect(dash.headers.get("content-security-policy")).toContain("https://checkout.stripe.com");
    // no-referrer would make browsers post forms with `Origin: null`, which the CSRF check refuses.
    expect(dash.headers.get("referrer-policy")).toBe("same-origin");
    // Sign-in may run in an OAuth popup: no COOP that would cut it off from its opener.
    expect(dash.headers.get("cross-origin-opener-policy")).toBe("unsafe-none");
  });

  it("vercel.json gives the static pages the same headers, and the pages use no inline styles", () => {
    const pub = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const csp = siteCsp(["home.html", "docs.html"].flatMap((f) => inlineScriptHashes(pub(f))));
    const pageRules = vercel.headers.filter(
      (r) => r.source === "/" || r.source.includes("docs") || r.source.startsWith("/guides/"),
    );
    expect(pageRules.length).toBe(3);
    for (const r of pageRules)
      expect(r.headers.find((h) => h.key === "Content-Security-Policy")?.value).toBe(csp);
    for (const f of ["home.html", "docs.html"]) expect(pub(f)).not.toContain('style="');
  });

  it("refuses oversized bodies with 413", async () => {
    const res = await s.app.request(`${API}/v3/workspaces/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(11 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it("answers 429 after repeated failed credentials or admin tokens from one network", async () => {
    const tryKey = (ip: string) =>
      s.app.request(`${API}/v3/workspaces/list`, {
        method: "POST",
        headers: { authorization: "Bearer pk_live_wrong", "x-forwarded-for": ip },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await tryKey("192.0.2.150")).status);
    expect(statuses.slice(0, 30).every((st) => st === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    expect((await tryKey("192.0.2.151")).status).toBe(401);
    const admin: number[] = [];
    for (let i = 0; i < 11; i++)
      admin.push(
        (
          await s.app.request(`${API}/admin/v1/accounts`, {
            headers: {
              authorization: "Bearer wrong-admin-token",
              "x-forwarded-for": "192.0.2.152",
            },
          })
        ).status,
      );
    expect(admin.slice(0, 10).every((st) => st === 401)).toBe(true);
    expect(admin[10]).toBe(429);
  });
});
