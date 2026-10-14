import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ledgerDrift } from "../src/billing/ledger.js";
import { rows } from "../src/db/client.js";
import { createTestServer } from "./api-helpers.js";
import { ADMIN, Browser, createHostedServer, csrfOf, type HostedServer } from "./hosted-helpers.js";

/**
 * Hosted onboarding: magic-link sign-up/sign-in, sessions, CSRF, the dashboard
 * pages and actions, GDPR export and deletion, and tenant isolation between
 * two self-serve accounts.
 */

let s: HostedServer;
beforeAll(async () => {
  s = await createHostedServer();
});
afterAll(async () => {
  await s.close();
});

const accountOf = async (email: string) => {
  const [r] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
  );
  return r?.account_id ?? null;
};

describe("magic-link sign-up", () => {
  it("request → logged link → session cookie → dashboard", async () => {
    const b = new Browser(s.app);
    const login = await b.get("/app/login");
    expect(login.res.status).toBe(200);
    expect(login.res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(login.res.headers.get("cache-control")).toBe("no-store");

    const sent = await b.post("/app/login", { email: "Ada@Example.com" });
    expect(sent.res.status).toBe(200);
    expect(sent.html).toContain("Check your email");
    // Dev mode: the link is logged (and kept in the outbox), not sent.
    const logged = s.logs.find((l) => l.includes("/app/auth/verify?token="));
    expect(logged).toBeDefined();
    const link = JSON.parse(logged!).text.match(/https:\/\/\S+/)[0] as string;
    expect(link.startsWith("https://recall.test/app/auth/verify?token=")).toBe(true);
    const token = new URL(link).searchParams.get("token")!;

    // Only a hash is stored.
    const stored = await rows<{ token_hash: string; email: string }>(
      s.ctx.db,
      sql`SELECT token_hash, email FROM login_tokens WHERE email = 'ada@example.com'`,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toContain(token);

    // GET shows a button only (mail scanners cannot use the link up).
    const confirm = await b.get(`/app/auth/verify?token=${token}`);
    expect(confirm.res.status).toBe(200);
    // It names the address the link signs into, so someone else's link cannot pass unnoticed.
    expect(confirm.html).toContain("This link signs you in as <b>ada@example.com</b>");
    expect(confirm.res.headers.get("referrer-policy")).toBe("same-origin");
    expect(
      await rows(s.ctx.db, sql`SELECT 1 FROM users WHERE email = 'ada@example.com'`),
    ).toHaveLength(0);

    const done = await b.post("/app/auth/verify", { token });
    expect(done.res.status).toBe(303);
    expect(done.res.headers.get("location")).toBe("/app");
    const cookie = done.res.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-recall_session="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);

    const home = await b.get("/app");
    expect(home.res.status).toBe(200);
    expect(home.html).toContain("Overview");
    expect(home.html).toContain("ada@example.com");
    expect(home.html).toContain("$5.00"); // sign-up credit

    // A user, an account they own, a billing row and the welcome credit, in one go.
    const accountId = (await accountOf("ada@example.com"))!;
    const [m] = await rows<{ role: string }>(
      s.ctx.db,
      sql`SELECT role FROM account_members WHERE account_id = ${accountId}`,
    );
    expect(m!.role).toBe("owner");
    const ledger = await rows<{ kind: string; amount_micros: string }>(
      s.ctx.db,
      sql`SELECT kind, amount_micros FROM credit_ledger WHERE account_id = ${accountId}`,
    );
    expect(ledger.map((l) => [l.kind, Number(l.amount_micros)])).toEqual([
      ["signup_credit", 5_000_000],
    ]);
    expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);

    // The link is single-use: the page says so, and posting it anyway signs nobody in.
    const again = new Browser(s.app, "203.0.113.8");
    const page = await again.get(`/app/auth/verify?token=${token}`);
    expect(page.res.status).toBe(400);
    expect(page.html).toContain("expired");
    await again.get("/app/login");
    const reused = await again.post("/app/auth/verify", { token });
    expect(reused.res.status).toBe(400);
    expect(reused.html).toContain("expired");
  });

  it("signing in again reuses the account", async () => {
    const b = new Browser(s.app, "203.0.113.9");
    await b.signIn(s, "ada@example.com");
    const accounts = await rows(
      s.ctx.db,
      sql`SELECT 1 FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'ada@example.com'`,
    );
    expect(accounts).toHaveLength(1);
  });

  it("rejects expired links", async () => {
    const b = new Browser(s.app, "203.0.113.10");
    await b.get("/app/login");
    await b.post("/app/login", { email: "late@example.com" });
    const link = s.mailer.outbox.at(-1)!.text.match(/https:\/\/\S+/)![0];
    await s.ctx.db.execute(
      sql`UPDATE login_tokens SET expires_at = now() - interval '1 second' WHERE email = 'late@example.com'`,
    );
    const token = new URL(link).searchParams.get("token")!;
    await b.get(`/app/auth/verify?token=${token}`);
    const r = await b.post("/app/auth/verify", { token });
    expect(r.res.status).toBe(400);
  });

  it("rate-limits links per email and per IP", async () => {
    const b = new Browser(s.app, "198.51.100.1");
    await b.get("/app/login");
    for (let i = 0; i < 3; i++)
      expect((await b.post("/app/login", { email: "spam@example.com" })).res.status).toBe(200);
    expect((await b.post("/app/login", { email: "spam@example.com" })).res.status).toBe(429);
    // The limit counts per network: someone flooding an address does not lock its owner out.
    const owner = new Browser(s.app, "203.0.113.50");
    await owner.get("/app/login");
    expect((await owner.post("/app/login", { email: "spam@example.com" })).res.status).toBe(200);
    // Over a day, one network gets 6 links for an address and all networks together 30.
    await s.ctx.db.execute(
      sql`UPDATE login_tokens SET created_at = now() - interval '1 hour' WHERE email = 'spam@example.com'`,
    );
    for (let i = 0; i < 3; i++)
      expect((await b.post("/app/login", { email: "spam@example.com" })).res.status).toBe(200);
    expect((await b.post("/app/login", { email: "spam@example.com" })).res.status).toBe(429);

    const ip = new Browser(s.app, "198.51.100.2");
    await ip.get("/app/login");
    for (let i = 0; i < 20; i++)
      expect((await ip.post("/app/login", { email: `u${i}@example.com` })).res.status).toBe(200);
    expect((await ip.post("/app/login", { email: "u99@example.com" })).res.status).toBe(429);
  });

  it("rejects malformed addresses", async () => {
    const b = new Browser(s.app, "198.51.100.3");
    await b.get("/app/login");
    expect((await b.post("/app/login", { email: "not-an-email" })).res.status).toBe(422);
  });
});

describe("sessions and CSRF", () => {
  let b: Browser;
  beforeAll(async () => {
    b = new Browser(s.app, "192.0.2.50");
    await b.signIn(s, "csrf@example.com");
  });

  it("rejects a sign-in form without or with a forged token", async () => {
    const anon = new Browser(s.app, "192.0.2.51");
    await anon.get("/app/login");
    expect(
      (await anon.post("/app/login", { email: "x@example.com" }, { csrf: null })).res.status,
    ).toBe(403);
    expect(
      (await anon.post("/app/login", { email: "x@example.com" }, { csrf: "forged" })).res.status,
    ).toBe(403);
    // A token minted for another browser's cookie does not transfer.
    const other = new Browser(s.app, "192.0.2.52");
    await other.get("/app/login");
    expect(
      (await anon.post("/app/login", { email: "x@example.com" }, { csrf: other.lastCsrf })).res
        .status,
    ).toBe(403);
    expect(s.mailer.outbox.some((m) => m.to === "x@example.com")).toBe(false);
  });

  it("rejects state-changing dashboard forms without the session's token", async () => {
    const before = await rows(s.ctx.db, sql`SELECT 1 FROM api_keys`);
    for (const csrf of [null, "nope"]) {
      const r = await b.post("/app/keys", { name: "evil" }, { csrf });
      expect(r.res.status).toBe(403);
    }
    // Cross-origin posts fail even with a valid token.
    const xo = await b.post(
      "/app/keys",
      { name: "evil" },
      { headers: { origin: "https://evil.example" } },
    );
    expect(xo.res.status).toBe(403);
    expect(await rows(s.ctx.db, sql`SELECT 1 FROM api_keys`)).toHaveLength(before.length);
  });

  it("another session's token is not accepted", async () => {
    const other = new Browser(s.app, "192.0.2.53");
    await other.signIn(s, "csrf-other@example.com");
    const r = await b.post(
      "/app/settings/budget",
      { monthly_budget_usd: "1" },
      { csrf: other.lastCsrf },
    );
    expect(r.res.status).toBe(403);
  });

  it("redirects signed-out pages to the login and refuses signed-out actions", async () => {
    const anon = new Browser(s.app, "192.0.2.54");
    for (const p of ["/app", "/app/keys", "/app/usage", "/app/billing", "/app/settings"]) {
      const r = await anon.get(p);
      expect(r.res.status, p).toBe(303);
      expect(r.res.headers.get("location")).toBe("/app/login");
    }
    await anon.get("/app/login");
    expect((await anon.post("/app/keys", { name: "x" })).res.status).toBe(401);
  });

  it("does not extend the API's CORS to dashboard pages", async () => {
    const res = await s.app.request("/app/keys", {
      headers: {
        origin: "https://evil.example",
        cookie: `__Host-recall_session=${b.cookies.get("__Host-recall_session")}`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // The JSON API keeps it.
    const api = await s.app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(api.headers.get("access-control-allow-origin")).toBe("https://evil.example");
  });

  it("ignores a tampered session cookie", async () => {
    const forged = new Browser(s.app, "192.0.2.55");
    const value = b.cookies.get("__Host-recall_session")!;
    forged.cookies.set("__Host-recall_session", `${value.slice(0, -2)}xx`);
    expect((await forged.get("/app")).res.status).toBe(303);
    forged.cookies.set("__Host-recall_session", value);
    expect((await forged.get("/app")).res.status).toBe(200);
  });

  it("sign-out revokes the session server-side", async () => {
    const c = new Browser(s.app, "192.0.2.56");
    await c.signIn(s, "bye@example.com");
    const cookie = c.cookies.get("__Host-recall_session")!;
    const out = await c.post("/app/logout");
    expect(out.res.status).toBe(303);
    const replay = new Browser(s.app, "192.0.2.57");
    replay.cookies.set("__Host-recall_session", cookie);
    expect((await replay.get("/app")).res.status).toBe(303);
  });
});

describe("dashboard actions", () => {
  let b: Browser;
  let accountId: string;
  beforeAll(async () => {
    b = new Browser(s.app, "192.0.2.70");
    await b.signIn(s, "owner@example.com");
    accountId = (await accountOf("owner@example.com"))!;
  });

  it("creates a key shown once (post, redirect, get), which then works, and revokes it after a confirmation", async () => {
    const r = await b.createKey({ name: "agent", workspace_id: "", mode: "live" });
    // The form redirects; the key is on the page it lands on, with a copy button and .env lines.
    expect(r.posted.status).toBe(303);
    expect(r.posted.headers.get("location")).toBe("/app/keys#new-key");
    expect(r.posted.headers.getSetCookie().some((c) => c.startsWith("__Host-recall_flash="))).toBe(
      true,
    );
    const key = r.key!;
    expect(key).toMatch(/^pk_live_/);
    expect(r.html).toContain('<pre class="secret" data-copy tabindex="0">');
    expect(r.html).toContain(`RECALL_API_KEY=${key}`);
    expect(r.html).toContain("RECALL_URL=https://recall.test");
    // Only its hash is stored.
    expect(
      await rows(s.ctx.db, sql`SELECT 1 FROM api_keys WHERE key_hash = ${key} OR prefix = ${key}`),
    ).toHaveLength(0);
    const me = await s.api("GET", "/v3/account", undefined, { authorization: `Bearer ${key}` });
    expect(me.status).toBe(200);
    expect((await me.json()).id).toBe(accountId);
    // Reloading shows the list only: the key is gone, and no second key was made.
    const list = await b.get("/app/keys");
    expect(list.html).not.toContain(key);
    expect(list.html).toContain(key.slice(0, 12));
    const made = await rows(
      s.ctx.db,
      sql`SELECT 1 FROM api_keys WHERE account_id = ${accountId} AND name = 'agent'`,
    );
    expect(made).toHaveLength(1);

    const [row] = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM api_keys WHERE account_id = ${accountId} AND name = 'agent'`,
    );
    // Revoke is a link to a confirmation page; posting without the confirmation only asks.
    expect(list.html).toContain(`href="/app/keys/${row!.id}/revoke"`);
    const ask = await b.get(`/app/keys/${row!.id}/revoke`);
    expect(ask.res.status).toBe(200);
    expect(ask.html).toContain("Revoke “agent”?");
    expect((await b.post(`/app/keys/${row!.id}/revoke`)).res.status).toBe(200);
    expect(
      (await s.api("GET", "/v3/account", undefined, { authorization: `Bearer ${key}` })).status,
    ).toBe(200);
    const revoked = await b.post(`/app/keys/${row!.id}/revoke`, { confirm: "1" });
    expect(revoked.res.status).toBe(303);
    expect(revoked.res.headers.get("location")).toBe("/app/keys?msg=key_revoked");
    const after = await s.api("GET", "/v3/account", undefined, { authorization: `Bearer ${key}` });
    expect(after.status).toBe(401);
  });

  it("shows a new key only to the session that made it", async () => {
    const r = await b.post("/app/keys", { name: "flash-check" });
    expect(r.res.status).toBe(303);
    const flash = r.res.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-recall_flash="))!
      .split(";")[0]!
      .split("=")[1]!;
    // Another signed-in browser holding the cookie sees no key (it is bound to the session).
    const other = new Browser(s.app, "192.0.2.71");
    await other.signIn(s, "owner-two@example.com");
    other.cookies.set("__Host-recall_flash", flash);
    const page = await other.get("/app/keys");
    expect(page.html).not.toMatch(/pk_live_[A-Za-z0-9]{32}/);
    // The owner's own browser still gets it, once.
    expect((await b.get("/app/keys")).html).toMatch(/pk_live_[A-Za-z0-9]{32}/);
    expect((await b.get("/app/keys")).html).not.toMatch(/pk_live_[A-Za-z0-9]{32}/);
  });

  it("creates scoped keys with an expiry and a rate limit, and checks the scope exists", async () => {
    const admin = (await b.createKey({ name: "setup" })).key!;
    const auth = { authorization: `Bearer ${admin}` };
    expect((await s.api("POST", "/v3/workspaces", { id: "ws1" }, auth)).status).toBe(201);
    expect((await s.api("POST", "/v3/workspaces/ws1/peers", { id: "alice" }, auth)).status).toBe(
      201,
    );
    const page = await b.get("/app/keys");
    expect(page.html).toContain('<option value="ws1">ws1</option>');
    expect(page.html).toContain("billed exactly like a live key");

    const r = await b.createKey({
      name: "scoped",
      workspace_id: "ws1",
      peer_id: "alice",
      expires_in: "30",
      rate_limit_per_min: "10",
      mode: "test",
    });
    expect(r.posted.status).toBe(303);
    expect(r.key).toMatch(/^pk_test_/);
    expect(r.html).toContain("RECALL_WORKSPACE_ID=ws1");
    const [row] = await rows<{
      workspace: string;
      peer: string;
      rate_limit_per_min: number;
      expires_at: Date | string;
    }>(
      s.ctx.db,
      sql`SELECT workspace, peer, rate_limit_per_min, expires_at FROM api_keys
          WHERE account_id = ${accountId} AND name = 'scoped'`,
    );
    expect(row).toMatchObject({ workspace: "ws1", peer: "alice", rate_limit_per_min: 10 });
    const days = (new Date(row!.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(r.html).toContain(`expires ${new Date(row!.expires_at).toISOString().slice(0, 10)}`);
    expect(r.html).toContain("10/min");

    // Refused, with the form kept: an unknown workspace or peer, a peer without a workspace,
    // a rate above the default, an expiry not on the list.
    for (const [form, says] of [
      [{ name: "bad", workspace_id: "nope" }, "Pick one of this account"],
      [{ name: "bad", workspace_id: "ws1", peer_id: "bob" }, "There is no peer “bob” in ws1"],
      [{ name: "bad", peer_id: "alice" }, "Pick a workspace"],
      [{ name: "bad", workspace_id: "ws1", session_id: "nope" }, "There is no session “nope”"],
      [{ name: "bad", rate_limit_per_min: "601" }, "from 1 to 600"],
      [{ name: "bad", expires_in: "3" }, "Pick an expiry"],
    ] as const) {
      const bad = await b.createKey(form);
      expect(bad.posted.status, says).toBe(422);
      expect(bad.html).toContain(says);
      expect(bad.html).toContain('value="bad"');
    }
    expect(
      await rows(
        s.ctx.db,
        sql`SELECT 1 FROM api_keys WHERE account_id = ${accountId} AND name = 'bad'`,
      ),
    ).toHaveLength(0);
  });

  it("sets the monthly budget and rotates the webhook secret after typing to confirm", async () => {
    expect((await b.post("/app/settings/budget", { monthly_budget_usd: "12.5" })).res.status).toBe(
      303,
    );
    const [a] = await rows<{ monthly_budget_usd: number; webhook_secret: string }>(
      s.ctx.db,
      sql`SELECT monthly_budget_usd, webhook_secret FROM accounts WHERE id = ${accountId}`,
    );
    expect(a!.monthly_budget_usd).toBe(12.5);
    const secretNow = async () =>
      (
        await rows<{ webhook_secret: string }>(
          s.ctx.db,
          sql`SELECT webhook_secret FROM accounts WHERE id = ${accountId}`,
        )
      )[0]!.webhook_secret;
    // Rotate is a link to a page that asks; posting without the typed word changes nothing.
    const settings = await b.get("/app/settings");
    expect(settings.html).toContain('href="/app/settings/rotate-webhook-secret"');
    const ask = await b.get("/app/settings/rotate-webhook-secret");
    expect(ask.res.status).toBe(200);
    expect(ask.html).toContain("Type <strong>rotate</strong> to confirm");
    expect((await b.post("/app/settings/rotate-webhook-secret")).res.status).toBe(200);
    const wrong = await b.post("/app/settings/rotate-webhook-secret", {
      confirm: "1",
      confirm_text: "yes",
    });
    expect(wrong.res.status).toBe(422);
    expect(await secretNow()).toBe(a!.webhook_secret);
    // Confirmed: it rotates once and redirects, so a reload does not rotate again.
    const rotated = await b.post("/app/settings/rotate-webhook-secret", {
      confirm: "1",
      confirm_text: "rotate",
      next: "settings",
    });
    expect(rotated.res.status).toBe(303);
    expect(rotated.res.headers.get("location")).toBe(
      "/app/settings?msg=secret_rotated#webhook-secret",
    );
    const fresh = await secretNow();
    expect(fresh).not.toBe(a!.webhook_secret);
    const shown = await b.get("/app/settings?msg=secret_rotated");
    expect(shown.html).toContain(fresh);
    expect(shown.html).toContain("<details open>");
    expect(await secretNow()).toBe(fresh);
    // `next` names a page, never a URL.
    const elsewhere = await b.post("/app/settings/rotate-webhook-secret", {
      confirm: "1",
      confirm_text: "rotate",
      next: "https://evil.example/",
    });
    expect(elsewhere.res.headers.get("location")).toBe(
      "/app/settings?msg=secret_rotated#webhook-secret",
    );
    expect((await b.post("/app/settings/budget", { monthly_budget_usd: "" })).res.status).toBe(303);
    expect((await b.post("/app/settings/budget", { monthly_budget_usd: "-3" })).res.status).toBe(
      422,
    );
  });

  it("renders every page", async () => {
    for (const p of ["/app", "/app/keys", "/app/usage", "/app/billing", "/app/settings"]) {
      const r = await b.get(p);
      expect(r.res.status, p).toBe(200);
      expect(r.html).toContain('name="viewport"');
    }
    const css = await b.get("/app/static/app.css");
    expect(css.res.headers.get("content-type")).toContain("text/css");
  });

  it("is styled like the site, within the strict CSP", async () => {
    const css = (await b.get("/app/static/app.css")).html;
    // The site's pixel fonts, tokens and scanlines.
    for (const font of ["Silkscreen", "Pixelify Sans", "Departure Mono", "Geist Mono"])
      expect(css).toContain(`font-family:"${font}"`);
    for (const token of ["--bg:#0c0b0a", "--amber:#ffb000", "--green:#4dff9a", "--cyan:#5fd7ff"])
      expect(css).toContain(token);
    expect(css).toContain("repeating-linear-gradient");
    expect(css).toContain("prefers-reduced-motion:reduce");
    // Self-contained: only same-origin fonts and one inline-SVG data URI, no external hosts.
    // (the SVG namespace inside the data URI is not a request)
    expect(css.replace(/url\("data:image\/svg\+xml,[^"]*"\)/g, "")).not.toMatch(/https?:\/\//);
    expect(css).not.toContain("@import");
    const urls = [...css.matchAll(/url\(("?)([^)"]+)\1\)/g)].map((m) => m[2]!);
    for (const u of urls)
      expect(u.startsWith("/fonts/") || u.startsWith("data:image/svg+xml,")).toBe(true);
    for (const u of urls.filter((u) => u.startsWith("/fonts/")))
      expect((await s.app.request(u)).status, u).toBe(200);
    // No page carries inline styles or inline scripts (the CSP forbids both).
    const anon = new Browser(s.app, "192.0.2.77");
    const pages = [
      ["/app/login", anon],
      ...["/app", "/app/keys", "/app/usage", "/app/billing", "/app/settings"].map(
        (p) => [p, b] as const,
      ),
    ] as const;
    for (const [p, who] of pages) {
      const r = await who.get(p);
      expect(r.res.status, p).toBe(200);
      expect(r.html, p).not.toMatch(/\sstyle="/);
      expect(r.html, p).not.toMatch(/<style[\s>]/);
      expect(r.html, p).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
      expect(r.html, p).toContain('<a class="skip" href="#main">');
    }
  });
});

describe("GDPR export and deletion", () => {
  it("exports everything and deletes the account on confirmation", async () => {
    const b = new Browser(s.app, "192.0.2.80");
    await b.signIn(s, "gdpr@example.com");
    const accountId = (await accountOf("gdpr@example.com"))!;
    const created = await b.createKey({ name: "k" });
    const key = created.html.match(/pk_live_[A-Za-z0-9]{32}/)![0];
    const auth = { authorization: `Bearer ${key}` };
    expect((await s.api("POST", "/v3/workspaces", { id: "diary" }, auth)).status).toBe(201);
    await s.api("POST", "/v3/workspaces/diary/peers", { id: "me" }, auth);
    await s.api("POST", "/v3/workspaces/diary/sessions", { id: "s1", peers: { me: {} } }, auth);
    const msg = await s.api(
      "POST",
      "/v3/workspaces/diary/sessions/s1/messages",
      { messages: [{ peer_id: "me", content: "my secret diary entry" }] },
      auth,
    );
    expect(msg.status).toBe(201);

    const exp = await b.post("/app/settings/export");
    expect(exp.res.status).toBe(200);
    expect(exp.res.headers.get("content-disposition")).toContain("attachment");
    const data = JSON.parse(exp.html);
    expect(data.account.id).toBe(accountId);
    expect(data.members[0].email).toBe("gdpr@example.com");
    expect(data.workspaces.map((w: { name: string }) => w.name)).toEqual(["diary"]);
    expect(data.messages[0].content).toBe("my secret diary entry");
    expect(data.credit_ledger[0].kind).toBe("signup_credit");
    expect(JSON.stringify(data)).not.toContain("webhook_secret");
    expect(JSON.stringify(data)).not.toContain("key_hash");

    // Wrong confirmation: nothing happens.
    expect((await b.post("/app/settings/delete", { confirm: "nope" })).res.status).toBe(422);
    const [acct] = await rows<{ name: string }>(
      s.ctx.db,
      sql`SELECT name FROM accounts WHERE id = ${accountId}`,
    );
    const del = await b.post("/app/settings/delete", { confirm: acct!.name });
    expect(del.res.status).toBe(303);
    expect(del.res.headers.get("location")).toBe("/app/login?msg=deleted");
    for (const table of [
      "accounts",
      "credit_ledger",
      "billing_accounts",
      "user_sessions",
      "account_members",
    ]) {
      const col = table === "accounts" ? "id" : "account_id";
      expect(
        await rows(
          s.ctx.db,
          sql`SELECT 1 FROM ${sql.raw(table)} WHERE ${sql.raw(col)} = ${accountId}`,
        ),
        table,
      ).toHaveLength(0);
    }
    expect(
      await rows(s.ctx.db, sql`SELECT 1 FROM users WHERE email = 'gdpr@example.com'`),
    ).toHaveLength(0);
    expect(
      await rows(s.ctx.db, sql`SELECT 1 FROM messages WHERE content = 'my secret diary entry'`),
    ).toHaveLength(0);
    expect((await s.api("GET", "/v3/account", undefined, auth)).status).toBe(401);
    expect((await b.get("/app")).res.status).toBe(303);
  });
});

describe("tenant isolation", () => {
  let a: Browser;
  let bb: Browser;
  let A: { id: string; name: string; keyId: string; key: string; email: string };
  let B: { id: string; name: string; keyId: string; key: string; email: string };

  const setup = async (browser: Browser, email: string) => {
    await browser.signIn(s, email);
    const id = (await accountOf(email))!;
    const created = await browser.createKey({ name: `key-of-${email}` });
    const key = created.html.match(/pk_live_[A-Za-z0-9]{32}/)![0];
    const [k] = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM api_keys WHERE account_id = ${id}`,
    );
    const [acct] = await rows<{ name: string }>(
      s.ctx.db,
      sql`SELECT name FROM accounts WHERE id = ${id}`,
    );
    const auth = { authorization: `Bearer ${key}` };
    await s.api("POST", "/v3/workspaces", { id: "shared-name", metadata: { owner: email } }, auth);
    return { id, name: acct!.name, keyId: k!.id, key, email };
  };

  beforeAll(async () => {
    a = new Browser(s.app, "192.0.2.90");
    bb = new Browser(s.app, "192.0.2.91");
    A = await setup(a, "alice-iso@example.com");
    B = await setup(bb, "bob-iso@example.com");
  });

  it("no page of A shows anything of B", async () => {
    for (const p of ["/app", "/app/keys", "/app/usage", "/app/billing", "/app/settings"]) {
      const r = await a.get(p);
      expect(r.res.status).toBe(200);
      for (const secret of [B.id, B.email, B.key.slice(0, 12), B.keyId, `key-of-${B.email}`])
        expect(r.html, `${p} leaked ${secret}`).not.toContain(secret);
    }
    const settings = await bb.get("/app/settings");
    const bSecret = settings.html.match(/whsec_[A-Za-z0-9_-]+/)![0];
    expect((await a.get("/app/settings")).html).not.toContain(bSecret);
  });

  it("A cannot revoke B's key", async () => {
    const r = await a.post(`/app/keys/${B.keyId}/revoke`, { confirm: "1" });
    expect(r.res.status).toBe(404);
    const me = await s.api("GET", "/v3/account", undefined, { authorization: `Bearer ${B.key}` });
    expect(me.status).toBe(200);
  });

  it("A's export holds only A's data", async () => {
    const exp = await a.post("/app/settings/export");
    const data = JSON.parse(exp.html);
    expect(data.account.id).toBe(A.id);
    expect(JSON.stringify(data)).not.toContain(B.email);
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].metadata.owner).toBe(A.email);
    expect(data.api_keys.map((k: { id: string }) => k.id)).toEqual([A.keyId]);
  });

  it("A's settings and deletion only touch A", async () => {
    await a.post("/app/settings/budget", { monthly_budget_usd: "7" });
    const [bAcct] = await rows<{ monthly_budget_usd: number | null }>(
      s.ctx.db,
      sql`SELECT monthly_budget_usd FROM accounts WHERE id = ${B.id}`,
    );
    expect(bAcct!.monthly_budget_usd).toBeNull();
    // Typing B's name does not delete B (or A).
    expect((await a.post("/app/settings/delete", { confirm: B.name })).res.status).toBe(422);
    expect(
      await rows(s.ctx.db, sql`SELECT 1 FROM accounts WHERE id IN (${A.id}, ${B.id})`),
    ).toHaveLength(2);
  });

  it("A's checkout and portal use A's Stripe customer", async () => {
    s.mocks.customersCreate.mockClear();
    s.mocks.checkoutCreate.mockClear();
    await a.post("/app/billing/checkout", { amount_usd: "10" });
    expect(s.mocks.customersCreate.mock.calls[0]![0].metadata.account_id).toBe(A.id);
    expect(s.mocks.checkoutCreate.mock.calls[0]![0].metadata.account_id).toBe(A.id);
  });

  it("a session cannot be pointed at another account", async () => {
    // The account comes from the session row; membership is re-checked on every request.
    await s.ctx.db.execute(
      sql`UPDATE user_sessions SET account_id = ${B.id}
          WHERE user_id = (SELECT id FROM users WHERE email = ${A.email})`,
    );
    expect((await a.get("/app")).res.status).toBe(303);
  });
});

describe("sign-up switches", () => {
  it("without billing, sign-up is closed unless enabled, and known users still sign in", async () => {
    const closed = await createHostedServer({ billing: false });
    try {
      const b = new Browser(closed.app);
      await b.get("/app/login");
      const r = await b.post("/app/login", { email: "new@example.com" });
      expect(r.res.status).toBe(200); // same answer, no email
      expect(closed.mailer.outbox).toHaveLength(0);
      // An operator-made membership lets an existing user in.
      const acct = await closed.api(
        "POST",
        "/admin/v1/accounts",
        { name: "acme" },
        { authorization: `Bearer ${ADMIN}` },
      );
      const { id } = await acct.json();
      await closed.ctx.db.execute(
        sql`INSERT INTO users (id, email) VALUES ('usr_1', 'known@example.com')`,
      );
      await closed.ctx.db.execute(
        sql`INSERT INTO account_members (account_id, user_id, role) VALUES (${id}, 'usr_1', 'owner')`,
      );
      await b.signIn(closed, "known@example.com");
      const home = await b.get("/app");
      expect(home.res.status).toBe(200);
      expect(home.html).not.toContain("Credit balance");
      expect((await b.get("/app/billing")).html).toContain("Billing is not enabled");
    } finally {
      await closed.close();
    }
  });

  it("self-hosted mode has no dashboard or billing routes", async () => {
    const plain = await createTestServer();
    try {
      expect((await plain.request("GET", "/app/login")).status).toBe(404);
      expect((await plain.request("POST", "/billing/stripe/webhook", {})).status).toBe(404);
      expect(csrfOf("")).toBe("");
    } finally {
      await plain.close();
    }
  });
});
