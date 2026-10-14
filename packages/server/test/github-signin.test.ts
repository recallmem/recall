import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { rows } from "../src/db/client.js";
import { signState } from "../src/http/dashboard/github.js";
import { browserBinding } from "../src/http/dashboard/session.js";
import { Browser, createHostedServer, type HostedServer, PUBLIC_URL } from "./hosted-helpers.js";

/**
 * "Continue with GitHub": a GitHub account signs in as the user it is tied to by its numeric id.
 * It creates a new user with its verified email address (the same sign-up rules as an emailed
 * link), or the signed-in user connects it under Settings; the address alone never opens an
 * existing user. GitHub itself is stubbed (the token exchange, the user and emails endpoints).
 */

const GITHUB = { RECALL_GITHUB_CLIENT_ID: "Iv1.testclient", RECALL_GITHUB_CLIENT_SECRET: "s3cret" };
const CALLBACK = `${PUBLIC_URL}/app/auth/github/callback`;

type Email = { email: string; primary?: boolean; verified: boolean };

/** Stubs GitHub: the token exchange accepts `code-ok`, for the account `user` with `emails`. */
function stubGithub(emails: Email[], user: { id: number; login: string } = nextUser()) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: headers.get("authorization") });
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json(
        body?.code === "code-ok"
          ? { access_token: "gho_test", token_type: "bearer", scope: "user:email" }
          : { error: "bad_verification_code" },
      );
    if (headers.get("authorization") !== "Bearer gho_test")
      return new Response("Bad credentials", { status: 401 });
    if (url === "https://api.github.com/user/emails") return Response.json(emails);
    if (url === "https://api.github.com/user") return Response.json({ ...user, type: "User" });
    return new Response("not stubbed", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

let ids = 5000;
const nextUser = () => ({ id: ++ids, login: `dev${ids}` });

/** Starts at the sign-in page and follows "Continue with GitHub"; the state GitHub would get. */
async function start(b: Browser, next?: string) {
  const page = await b.get(`/app/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  expect(page.html).toContain("Continue with GitHub");
  const href = page.html.match(/href="(\/app\/auth\/github[^"]*)"/)![1]!.replaceAll("&#38;", "&");
  const res = (await b.get(href)).res;
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  return { to, state: to.searchParams.get("state")! };
}

const accountOf = async (s: HostedServer, email: string) =>
  (
    await rows<{ account_id: string }>(
      s.ctx.db,
      sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
    )
  )[0]?.account_id ?? null;

let s: HostedServer;
beforeAll(async () => {
  s = await createHostedServer({ env: GITHUB });
});
afterAll(async () => {
  await s.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Continue with GitHub", () => {
  it("is only offered when both settings are there", async () => {
    expect(() =>
      loadConfig({ RECALL_DATA_DIR: "memory", RECALL_GITHUB_CLIENT_ID: "only-the-id" }),
    ).toThrow(/RECALL_GITHUB_CLIENT_SECRET/);
    const plain = await createHostedServer();
    try {
      const page = await new Browser(plain.app).get("/app/login");
      expect(page.html).not.toContain("Continue with GitHub");
      expect((await new Browser(plain.app).get("/app/auth/github")).res.status).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it("sends the browser to GitHub with only the email scope and this server's callback", async () => {
    const { to, state } = await start(new Browser(s.app, "198.51.100.10"));
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe(GITHUB.RECALL_GITHUB_CLIENT_ID);
    expect(to.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(to.searchParams.get("scope")).toBe("user:email");
    expect(state.length).toBeGreaterThan(40);
  });

  it("creates an account for the verified primary address, with the welcome credit", async () => {
    const calls = stubGithub(
      [
        { email: "old@example.org", primary: false, verified: true },
        { email: "New.Dev@Example.com", primary: true, verified: true },
      ],
      { id: 4242, login: "new-dev" },
    );
    const b = new Browser(s.app, "198.51.100.11");
    const { state } = await start(b);
    const res = (
      await b.get(`/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`)
    ).res;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app");
    expect((await b.get("/app")).html).toContain("Overview");

    const account = await accountOf(s, "new.dev@example.com");
    expect(account).not.toBeNull();
    const [credit] = await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${account} AND kind = 'signup_credit'`,
    );
    expect(credit!.n).toBe(1);
    // The code went to GitHub with this app's secret and callback; the token only to the API.
    expect(calls[0]).toMatchObject({
      url: "https://github.com/login/oauth/access_token",
      body: {
        client_id: GITHUB.RECALL_GITHUB_CLIENT_ID,
        client_secret: GITHUB.RECALL_GITHUB_CLIENT_SECRET,
        code: "code-ok",
        redirect_uri: CALLBACK,
      },
    });
    expect(calls.slice(1).map((c) => [c.url, c.auth])).toEqual([
      ["https://api.github.com/user", "Bearer gho_test"],
      ["https://api.github.com/user/emails", "Bearer gho_test"],
    ]);
    expect(s.logs.some((l) => l.includes("gho_test"))).toBe(false);
    // The new user is tied to the GitHub account by its id.
    const [u] = await rows<{ github_id: string; github_login: string }>(
      s.ctx.db,
      sql`SELECT github_id::text, github_login FROM users WHERE email = 'new.dev@example.com'`,
    );
    expect(u).toEqual({ github_id: "4242", github_login: "new-dev" });
  });

  it("opens an existing address's account only once that user connects GitHub", async () => {
    const b = new Browser(s.app, "198.51.100.12");
    await b.signIn(s, "existing@example.com");
    const before = await accountOf(s, "existing@example.com");
    const github = { id: 777, login: "existing-dev" };
    stubGithub([{ email: "Existing@Example.com", primary: true, verified: true }], github);
    const fresh = new Browser(s.app, "198.51.100.13");
    let { state } = await start(fresh);
    const refused = await fresh.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`,
    );
    expect(refused.res.status).toBe(409);
    expect(refused.html).toContain("connect GitHub under Settings");
    expect(fresh.cookies.has("__Host-recall_session")).toBe(false);

    // Signed in with the emailed link, the person connects GitHub from Settings.
    const settings = await b.get("/app/settings");
    expect(settings.html).toContain("Connect GitHub");
    expect(settings.res.headers.get("content-security-policy")).toContain("https://github.com");
    const go = await b.post("/app/settings/github");
    expect(go.res.status).toBe(303);
    const to = new URL(go.res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
    const linkState = to.searchParams.get("state")!;
    // The connect state belongs to that session: another browser cannot finish it.
    expect(
      (
        await fresh.get(
          `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(linkState)}`,
        )
      ).res.status,
    ).toBe(400);
    const back = await b.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(linkState)}`,
    );
    expect(back.res.headers.get("location")).toBe("/app/settings?msg=github_connected#signin");
    expect((await b.get("/app/settings")).html).toContain("@existing-dev");

    // Now GitHub signs in as that user, even after the address on GitHub changed.
    stubGithub([{ email: "someone.else@example.net", primary: true, verified: true }], github);
    ({ state } = await start(fresh));
    const ok = await fresh.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`,
    );
    expect(ok.res.status).toBe(303);
    expect((await fresh.get("/app")).html).toContain("Overview");
    expect(await accountOf(s, "existing@example.com")).toBe(before);
    expect(await accountOf(s, "someone.else@example.net")).toBeNull();

    // Another GitHub account with the same address is refused; one GitHub account, one user.
    stubGithub([{ email: "existing@example.com", primary: true, verified: true }]);
    const third = new Browser(s.app, "198.51.100.22");
    ({ state } = await start(third));
    const other = await third.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`,
    );
    expect(other.res.status).toBe(409);
    expect(other.html).toContain("connected to a different GitHub account");

    // Disconnected, GitHub no longer signs in as this user.
    expect((await b.post("/app/settings/github/disconnect")).res.status).toBe(303);
    expect((await b.get("/app/settings")).html).toContain("Connect GitHub");
    stubGithub([{ email: "someone.else@example.net", primary: true, verified: true }], github);
    const gone = new Browser(s.app, "198.51.100.19");
    ({ state } = await start(gone));
    await gone.get(`/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`);
    // It signs up the GitHub account's own address instead, as a new account.
    const signedUp = await accountOf(s, "someone.else@example.net");
    expect(signedUp).not.toBeNull();
    expect(signedUp).not.toBe(before);
  });

  it("will not connect a GitHub account that already signs in as someone else", async () => {
    const github = { id: 888, login: "taken-dev" };
    stubGithub([{ email: "first@example.com", primary: true, verified: true }], github);
    const first = new Browser(s.app, "198.51.100.20");
    const { state } = await start(first);
    expect(
      (await first.get(`/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`))
        .res.status,
    ).toBe(303);
    const second = new Browser(s.app, "198.51.100.21");
    await second.signIn(s, "second@example.com");
    await second.get("/app/settings");
    const go = await second.post("/app/settings/github");
    const linkState = new URL(go.res.headers.get("location")!).searchParams.get("state")!;
    const back = await second.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(linkState)}`,
    );
    expect(back.res.headers.get("location")).toBe("/app/settings?msg=github_taken#signin");
    const [u] = await rows<{ github_id: string | null }>(
      s.ctx.db,
      sql`SELECT github_id::text FROM users WHERE email = 'second@example.com'`,
    );
    expect(u!.github_id).toBeNull();
  });

  it("continues to an app's authorization request after signing in", async () => {
    stubGithub([{ email: "connector@example.com", primary: true, verified: true }]);
    const next = "/oauth/authorize?client_id=abc&response_type=code";
    const b = new Browser(s.app, "198.51.100.14");
    const { state } = await start(b, next);
    const res = (
      await b.get(`/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`)
    ).res;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(next);
  });

  it("refuses a state from another browser, an expired one, and a forged one, before calling GitHub", async () => {
    const calls = stubGithub([{ email: "victim@example.com", primary: true, verified: true }]);
    const attacker = new Browser(s.app, "198.51.100.15");
    const { state } = await start(attacker);
    const victim = new Browser(s.app, "198.51.100.16");
    await victim.get("/app/login");
    const other = await victim.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`,
    );
    expect(other.res.status).toBe(400);
    expect(other.html).toContain("started in another browser");

    // A state signed for this browser, but 11 minutes old.
    const anon = victim.cookies.get("__Host-recall_csrf")!;
    const request = new Request(PUBLIC_URL, { headers: { cookie: `__Host-recall_csrf=${anon}` } });
    const binding = browserBinding(
      { req: { raw: request } } as never,
      s.ctx.config.hosted.sessionSecret,
    );
    const old = signState(
      s.ctx.config.hosted.sessionSecret,
      binding!,
      null,
      Date.now() - 11 * 60_000,
    );
    expect(
      (await victim.get(`/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(old)}`))
        .res.status,
    ).toBe(400);
    expect(
      (await victim.get("/app/auth/github/callback?code=code-ok&state=forged.state")).res.status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await accountOf(s, "victim@example.com")).toBeNull();
  });

  it("explains a cancelled sign-in, a failed exchange and an account without a verified email", async () => {
    stubGithub([{ email: "unverified@example.com", primary: true, verified: false }]);
    const b = new Browser(s.app, "198.51.100.17");

    let { state } = await start(b);
    const cancelled = await b.get(
      `/app/auth/github/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(cancelled.res.status).toBe(400);
    expect(cancelled.html).toContain("GitHub sign-in was cancelled.");

    ({ state } = await start(b));
    const failed = await b.get(
      `/app/auth/github/callback?code=code-bad&state=${encodeURIComponent(state)}`,
    );
    expect(failed.res.status).toBe(502);
    expect(failed.html).toContain("sign in with an email link");

    ({ state } = await start(b));
    const unverified = await b.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`,
    );
    expect(unverified.res.status).toBe(422);
    expect(unverified.html).toContain("no verified email address");
    expect(await accountOf(s, "unverified@example.com")).toBeNull();
    // Each page offers the way back in.
    expect(unverified.html).toContain("Continue with GitHub");
  });

  it("is not a way into an operator's account", async () => {
    const ops = await createHostedServer({
      env: { ...GITHUB, RECALL_OPERATOR_EMAILS: "ops@example.com" },
    });
    try {
      stubGithub([{ email: "ops@example.com", primary: true, verified: true }]);
      const b = new Browser(ops.app, "198.51.100.30");
      const page = await b.get("/app/login");
      const href = page.html.match(/href="(\/app\/auth\/github[^"]*)"/)![1]!;
      const state = new URL((await b.get(href)).res.headers.get("location")!).searchParams.get(
        "state",
      )!;
      const res = await b.get(
        `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`,
      );
      expect(res.res.status).toBe(403);
      expect(res.html).toContain("signs in with an email link only");
    } finally {
      await ops.close();
    }
  });

  it("refuses a new account for a disposable address, like the email form", async () => {
    stubGithub([{ email: "someone@mailinator.com", primary: true, verified: true }]);
    const b = new Browser(s.app, "198.51.100.18");
    const { state } = await start(b);
    const res = await b.get(
      `/app/auth/github/callback?code=code-ok&state=${encodeURIComponent(state)}`,
    );
    expect(res.res.status).toBe(422);
    expect(res.html).toContain("disposable addresses can");
    expect(await accountOf(s, "someone@mailinator.com")).toBeNull();
  });
});
