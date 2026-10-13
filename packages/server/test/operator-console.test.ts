import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBillingRow, postEntry } from "../src/billing/ledger.js";
import { createAuthorizationCode } from "../src/core/oauth.js";
import { rows } from "../src/db/client.js";
import { SUSPENDED_DETAIL } from "../src/lib/errors.js";
import {
  ADMIN,
  Browser,
  createHostedServer,
  type HostedServer,
  PUBLIC_URL,
} from "./hosted-helpers.js";

/**
 * The operator console (<dashboard>/admin): open only to RECALL_OPERATOR_EMAILS,
 * a 404 like any unknown page for everyone else; overview, accounts and account
 * pages from real ledger, usage and queue rows; credit grants (idempotent per
 * form), key revocation, and suspension, which refuses the account's API keys,
 * OAuth tokens and dashboard sessions with 403 until it is lifted (also through
 * the admin API).
 */

let s: HostedServer;
let ops: Browser;
let cust: Browser;
let opsAccount: string;
let custAccount: string;
let custKey: Record<string, string>;
const admin = { authorization: `Bearer ${ADMIN}` };

const accountOf = async (email: string) => {
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
  );
  return m!.account_id;
};
const balance = async (id: string) => (await getBillingRow(s.ctx.db, id))!.balance_micros;
const listWorkspaces = () => s.api("POST", "/v3/workspaces/list", {}, custKey);
const page = (id: string) => `/app/admin/accounts/${id}`;

beforeAll(async () => {
  s = await createHostedServer({
    env: {
      RECALL_OPERATOR_EMAILS: " Ops@Example.com, second@example.com",
      RECALL_SIGNUP_CREDIT_USD: "5",
      RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: "50",
    },
  });
  ops = new Browser(s.app, "203.0.113.10");
  await ops.signIn(s, "ops@example.com");
  cust = new Browser(s.app, "203.0.113.20");
  await cust.signIn(s, "cust@example.com");
  opsAccount = await accountOf("ops@example.com");
  custAccount = await accountOf("cust@example.com");
  const key = (await cust.createKey({ name: "app" })).html.match(/pk_live_[A-Za-z0-9]{32}/)![0];
  custKey = { authorization: `Bearer ${key}` };

  // Money and model cost for the customer: a $25 top-up, $3 of billed usage, $1.50 of provider
  // cost; and $0.50 of model cost on the unbilled built-in account.
  const db = s.ctx.db;
  await postEntry(db, {
    account: custAccount,
    amountMicros: 25_000_000,
    kind: "topup",
    key: "topup:pi_1",
  });
  await postEntry(db, {
    account: custAccount,
    amountMicros: -2_500_000,
    kind: "ingest",
    key: "ingest:b1",
  });
  await postEntry(db, {
    account: custAccount,
    amountMicros: -500_000,
    kind: "chat_low",
    key: "chat:r1",
  });
  await db.execute(
    sql`INSERT INTO llm_usage (account_id, task, provider, model, input_tokens, output_tokens, cost_usd)
        VALUES (${custAccount}, 'reasoner', 'mock', 'mock-1', 12000, 3000, 1.25),
               (${custAccount}, 'chat_low', 'mock', 'mock-1', 4000, 500, 0.25),
               ('default', 'reasoner', 'mock', 'mock-1', 100, 10, 0.5)`,
  );
  // An old pending job, due in an hour (not part of the due backlog).
  await db.execute(
    sql`INSERT INTO jobs (kind, work_key, status, run_after, created_at)
        VALUES ('webhook', 'console-test', 'pending', now() + interval '1 hour', now() - interval '3 hours')`,
  );
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("access", () => {
  it("answers 404 to everyone but operators, exactly like an unknown page", async () => {
    const unknown = await cust.get("/app/no-such-page");
    expect(unknown.res.status).toBe(404);
    for (const path of ["/app/admin", "/app/admin/accounts", page(custAccount), page(opsAccount)]) {
      const r = await cust.get(path);
      expect(r.res.status, path).toBe(404);
      expect(r.html, path).toBe(unknown.html);
      const anon = await new Browser(s.app).get(path);
      expect(anon.res.status, path).toBe(404);
      expect(anon.html).not.toContain("Console");
    }
    // A browser asking for HTML gets the same page an unknown path gets.
    const htmlHeaders = { accept: "text/html" };
    const a = await s.app.request("/app/admin", { headers: htmlHeaders });
    const b = await s.app.request("/app/nope", { headers: htmlHeaders });
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it("refuses non-operators' action posts like an unknown page, even with a valid form", async () => {
    await cust.get("/app/keys"); // a fresh CSRF token for the customer's session
    const before = await balance(custAccount);
    const grant = await cust.post(`${page(custAccount)}/credits`, {
      amount_usd: "100",
      confirm: "1",
      nonce: "abcdefghijkl",
    });
    expect(grant.res.status).toBe(404);
    const suspend = await cust.post(`${page(custAccount)}/suspend`, {
      reason: "x",
      confirm: custAccount,
    });
    expect(suspend.res.status).toBe(404);
    expect(await balance(custAccount)).toBe(before);
    expect((await listWorkspaces()).status).toBe(200);
  });

  it("shows the console link to operators only", async () => {
    expect((await ops.get("/app")).html).toContain('href="/app/admin"');
    expect((await cust.get("/app")).html).not.toContain('href="/app/admin"');
  });
});

describe("pages", () => {
  it("overview: sign-ups, welcome credit, money, the 14-day table and the queue", async () => {
    const r = await ops.get("/app/admin");
    expect(r.res.status).toBe(200);
    const h = r.html;
    expect(h).toContain("Operator console");
    // Two accounts, both new today, each with a $5 welcome credit against the $50 cap.
    expect(h).toMatch(/Accounts<\/span><span class="value">2</);
    expect(h).toMatch(/New, 24 h<\/span><span class="value">2</);
    expect(h).toMatch(/Welcome credit today<\/span><span class="value">\$10\.00</);
    expect(h).toContain("of $50.00 daily cap");
    // 30 days: $25 top-ups, $3 billed, $1.50 cost of billed accounts, $1.50 margin (50%), $2 cost overall.
    const month = h.match(/<tr><td>Last 30 days<\/td>.*?<\/tr>/s)![0];
    expect(month).toContain("$25.00");
    expect(month).toContain("$3.00");
    expect(month).toContain("$1.50 (50%)");
    expect(month).toContain("$2.00");
    // Today's row of the 14-day table.
    const today = new Date().toISOString().slice(0, 10);
    const row = h.match(new RegExp(`<tr><td>${today}</td>.*?</tr>`, "s"))![0];
    expect(row).toContain('<td class="num">2</td>');
    expect(row).toContain("$25.00");
    expect(row).toContain("$3.00");
    expect(row).toContain("$2.00");
    // The queue: one pending webhook job, not yet due, three hours old.
    const job = h.match(/<tr><td><code>webhook<\/code>.*?<\/tr>/s)![0];
    expect(job).toBe(
      '<tr><td><code>webhook</code></td><td class="num">1</td><td class="num">0</td><td class="num">0</td><td class="num">0</td><td class="num">3 h</td></tr>',
    );
  });

  it("accounts: newest first, search by email, name or id, with 30-day figures", async () => {
    const all = await ops.get("/app/admin/accounts");
    expect(all.res.status).toBe(200);
    expect(all.html.indexOf(custAccount)).toBeLessThan(all.html.indexOf(opsAccount));
    const row = all.html.match(
      new RegExp(
        `<tr><td><a class="table-link" href="/app/admin/accounts/${custAccount}">.*?</tr>`,
        "s",
      ),
    )![0];
    expect(row).toContain("cust@example.com");
    expect(row).toContain("billed");
    // Balance: $5 welcome + $25 top-up - $3 usage.
    expect(row).toContain("$27.00");
    expect(row).toContain("$3.00");
    expect(row).toContain("$1.50 (50%)");

    const byEmail = await ops.get("/app/admin/accounts?q=CUST%40example");
    expect(byEmail.html).toContain(custAccount);
    expect(byEmail.html).not.toContain(`href="/app/admin/accounts/${opsAccount}"`);
    const byId = await ops.get(`/app/admin/accounts?q=${opsAccount}`);
    expect(byId.html).toContain(`href="/app/admin/accounts/${opsAccount}"`);
    expect(byId.html).not.toContain(`href="/app/admin/accounts/${custAccount}"`);
    const none = await ops.get("/app/admin/accounts?q=%25");
    expect(none.html).toContain("No account matches this search.");
  });

  it("pages through accounts 50 at a time", async () => {
    await s.ctx.db.execute(
      sql`INSERT INTO accounts (id, name, created_at)
          SELECT 'acct_bulk_' || lpad(i::text, 3, '0'), 'bulk ' || i, now() - (i || ' days')::interval
          FROM generate_series(1, 55) AS i`,
    );
    const first = await ops.get("/app/admin/accounts");
    const ids = (h: string) =>
      [...h.matchAll(/href="\/app\/admin\/accounts\/(acct_[^"?]+)"/g)].map((m) => m[1]);
    expect(ids(first.html)).toHaveLength(50);
    const next = first.html.match(/href="(\/app\/admin\/accounts\?after=[^"]+)"/)![1]!;
    const second = await ops.get(next.replaceAll("&amp;", "&"));
    const rest = ids(second.html);
    expect(rest).toHaveLength(7);
    expect(new Set([...ids(first.html), ...rest]).size).toBe(57);
    expect(rest.at(-1)).toBe("acct_bulk_055");
    await s.ctx.db.execute(sql`DELETE FROM accounts WHERE id LIKE 'acct_bulk_%'`);
  });

  it("account: members, keys, usage by task, billed by kind, ledger and the Stripe link", async () => {
    await s.ctx.db.execute(
      sql`UPDATE billing_accounts SET stripe_customer_id = 'cus_console_1' WHERE account_id = ${custAccount}`,
    );
    const r = await ops.get(page(custAccount));
    expect(r.res.status).toBe(200);
    const h = r.html;
    expect(h).toContain("cust@example.com");
    expect(h).toMatch(/<code>pk_live_[A-Za-z0-9]{4}…<\/code>/);
    expect(h).toContain('href="https://dashboard.stripe.com/customers/cus_console_1"');
    const reasoner = h.match(/<tr><td><code>reasoner<\/code>.*?<\/tr>/s)![0];
    expect(reasoner).toContain("12,000");
    expect(reasoner).toContain("$1.25");
    expect(h).toMatch(/Learning \(ingest\)<\/td><td class="num">1<\/td><td class="num">\$2\.50/);
    expect(h).toContain("Top-up");
    expect(h).toContain("Welcome credit");
    expect(h).toContain("Top-ups and withdrawals");
    // Without a Stripe customer there is no link.
    expect((await ops.get(page(opsAccount))).html).not.toContain("dashboard.stripe.com");
    expect((await ops.get("/app/admin/accounts/acct_missing")).res.status).toBe(404);
  });
});

describe("actions", () => {
  it("grants credit once per form, with a confirmation, and records the operator", async () => {
    s.ctx.log.level = "info";
    const form = await ops.get(page(custAccount));
    const nonce = form.html.match(/name="nonce" value="([^"]+)"/)![1]!;
    const before = await balance(custAccount);
    const unconfirmed = await ops.post(`${page(custAccount)}/credits`, { amount_usd: "10", nonce });
    expect(unconfirmed.res.status).toBe(422);
    expect(await balance(custAccount)).toBe(before);

    const fields = { amount_usd: "10", note: "goodwill", confirm: "1", nonce };
    const first = await ops.post(`${page(custAccount)}/credits`, fields);
    expect(first.res.status).toBe(303);
    expect(first.res.headers.get("location")).toBe(`${page(custAccount)}?msg=credit_granted`);
    expect(await balance(custAccount)).toBe(before + 10_000_000);
    const again = await ops.post(`${page(custAccount)}/credits`, fields);
    expect(again.res.headers.get("location")).toBe(`${page(custAccount)}?msg=credit_duplicate`);
    expect(await balance(custAccount)).toBe(before + 10_000_000);

    const [entry] = await rows<{ amount_micros: string; detail: Record<string, unknown> }>(
      s.ctx.db,
      sql`SELECT amount_micros, detail FROM credit_ledger WHERE account_id = ${custAccount} AND kind = 'grant'`,
    );
    expect(Number(entry!.amount_micros)).toBe(10_000_000);
    expect(entry!.detail).toEqual({ note: "goodwill", by: "ops@example.com" });
    expect(s.logs.join("")).toMatch(/"operator":"ops@example.com".*credit granted/);
    const shown = await ops.get(`${page(custAccount)}?msg=credit_granted`);
    expect(shown.html).toContain("Credit granted.");
    expect(shown.html).toContain("goodwill · by ops@example.com");
    s.ctx.log.level = "warn";
  });

  it("requires the CSRF token on every action", async () => {
    await ops.get(page(custAccount));
    const before = await balance(custAccount);
    for (const [path, form] of [
      ["/credits", { amount_usd: "5", confirm: "1", nonce: "csrf-test-nonce" }],
      ["/suspend", { reason: "x", confirm: custAccount }],
      ["/unsuspend", { confirm: "1" }],
      ["/keys/key_nope/revoke", { confirm: "1" }],
    ] as const) {
      const r = await ops.post(`${page(custAccount)}${path}`, form, { csrf: null });
      expect(r.res.status, path).toBe(403);
      expect(r.html).toContain("This form expired");
      const forged = await ops.post(`${page(custAccount)}${path}`, form, {
        headers: { origin: "https://evil.example" },
      });
      expect(forged.res.status, path).toBe(403);
    }
    expect(await balance(custAccount)).toBe(before);
    expect((await listWorkspaces()).status).toBe(200);
  });

  it("suspends: the key gets 403, the dashboard a notice; unsuspending restores both", async () => {
    const url = `${page(custAccount)}/suspend`;
    await ops.get(page(custAccount));
    const wrong = await ops.post(url, { reason: "credit farming", confirm: "acct_other" });
    expect(wrong.res.status).toBe(422);
    expect((await listWorkspaces()).status).toBe(200);

    const done = await ops.post(url, { reason: "credit farming", confirm: custAccount });
    expect(done.res.status).toBe(303);
    const res = await listWorkspaces();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: SUSPENDED_DETAIL });
    // Every dashboard page, the OAuth consent screen and the dashboard's forms.
    for (const path of ["/app", "/app/keys", "/app/memory", "/app/billing", "/oauth/authorize"]) {
      const r = await cust.get(path);
      expect(r.res.status, path).toBe(403);
      expect(r.html).toContain("This account is suspended");
      expect(r.html).not.toContain("credit farming");
    }
    // The console still looks like any unknown path to them.
    const hidden = await cust.get("/app/admin");
    const unknown = await cust.get("/app/no-such-page");
    expect([hidden.res.status, hidden.html]).toEqual([unknown.res.status, unknown.html]);
    const keyPost = await cust.post("/app/keys", { name: "while suspended" });
    expect(keyPost.res.status).toBe(403);
    const [made] = await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n FROM api_keys WHERE name = 'while suspended'`,
    );
    expect(made!.n).toBe(0);
    // Their data can still be downloaded (the right of access outlasts a suspension).
    const exported = await cust.post("/app/settings/export", {});
    expect(exported.res.status).toBe(200);
    expect(exported.res.headers.get("content-type")).toContain("application/json");
    const shown = await ops.get(page(custAccount));
    expect(shown.html).toContain("credit farming");
    expect((await ops.get("/app/admin/accounts")).html).toContain("suspended");
    // Signing out still works.
    const out = await cust.post("/app/logout", {});
    expect(out.res.status).toBe(303);
    await cust.signIn(s, "cust@example.com").catch(() => undefined);
    expect((await cust.get("/app")).res.status).toBe(403);

    await ops.get(page(custAccount));
    const lifted = await ops.post(`${page(custAccount)}/unsuspend`, { confirm: "1" });
    expect(lifted.res.status).toBe(303);
    expect((await listWorkspaces()).status).toBe(200);
    expect((await cust.get("/app")).res.status).toBe(200);
  });

  it("keeps the console open to an operator whose own account is suspended", async () => {
    const r = await s.api(
      "POST",
      `/admin/v1/accounts/${opsAccount}/suspend`,
      { reason: "testing" },
      admin,
    );
    expect(r.status).toBe(200);
    expect((await ops.get("/app")).res.status).toBe(403);
    expect((await ops.get("/app/admin")).res.status).toBe(200);
    expect((await ops.get(page(custAccount))).res.status).toBe(200);
    await s.api("POST", `/admin/v1/accounts/${opsAccount}/unsuspend`, {}, admin);
    expect((await ops.get("/app")).res.status).toBe(200);
  });

  it("revokes a key with a confirmation", async () => {
    const extra = (await cust.createKey({ name: "spare" })).html.match(
      /pk_live_[A-Za-z0-9]{32}/,
    )![0];
    const [k] = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM api_keys WHERE account_id = ${custAccount} AND name = 'spare'`,
    );
    const auth = { authorization: `Bearer ${extra}` };
    await ops.get(page(custAccount));
    const url = `${page(custAccount)}/keys/${k!.id}/revoke`;
    expect((await ops.post(url, {})).res.status).toBe(422);
    expect((await s.api("POST", "/v3/workspaces/list", {}, auth)).status).toBe(200);
    expect((await ops.post(url, { confirm: "1" })).res.status).toBe(303);
    expect((await s.api("POST", "/v3/workspaces/list", {}, auth)).status).toBe(401);
    // Another account's key cannot be revoked through this account's page.
    expect(
      (await ops.post(`${page(opsAccount)}/keys/${k!.id}/revoke`, { confirm: "1" })).res.status,
    ).toBe(404);
  });
});

describe("admin API suspension", () => {
  it("suspends and unsuspends with the operator token", async () => {
    const url = `/admin/v1/accounts/${custAccount}`;
    expect((await s.api("POST", `${url}/suspend`, { reason: "x" })).status).toBe(401);
    expect((await s.api("POST", `${url}/suspend`, {}, admin)).status).toBe(422);
    expect(
      (await s.api("POST", "/admin/v1/accounts/acct_nope/suspend", { reason: "x" }, admin)).status,
    ).toBe(404);
    expect(
      (await s.api("POST", "/admin/v1/accounts/default/suspend", { reason: "x" }, admin)).status,
    ).toBe(409);

    const r = await s.api("POST", `${url}/suspend`, { reason: "chargeback" }, admin);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.suspended_reason).toBe("chargeback");
    expect(Date.parse(body.suspended_at)).toBeGreaterThan(0);
    expect((await (await s.api("GET", url, undefined, admin)).json()).suspended_reason).toBe(
      "chargeback",
    );
    const refused = await listWorkspaces();
    expect(refused.status).toBe(403);
    expect((await refused.json()).detail).toBe(SUSPENDED_DETAIL);
    expect((await cust.get("/app")).res.status).toBe(403);

    const lifted = await s.api("POST", `${url}/unsuspend`, {}, admin);
    expect(lifted.status).toBe(200);
    expect((await lifted.json()).suspended_at).toBeNull();
    expect((await listWorkspaces()).status).toBe(200);
    expect((await cust.get("/app")).res.status).toBe(200);
  });

  it("refuses the account's OAuth access tokens at the MCP endpoint while suspended", async () => {
    const reg = await s.app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
      body: JSON.stringify({
        client_name: "Console test",
        redirect_uris: ["https://client.example/cb"],
      }),
    });
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const verifier = randomBytes(48).toString("base64url");
    const [user] = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM users WHERE email = 'cust@example.com'`,
    );
    const code = await createAuthorizationCode(
      s.ctx.db,
      {
        clientId,
        accountId: custAccount,
        userId: user!.id,
        redirectUri: "https://client.example/cb",
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        resource: `${PUBLIC_URL}/mcp`,
        scope: "memory",
        workspaces: null,
        defaultWorkspace: "default",
        defaultPeer: null,
        autoRemember: true,
      },
      60_000,
    );
    const tok = await s.app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "https://client.example/cb",
        code_verifier: verifier,
        resource: `${PUBLIC_URL}/mcp`,
      }).toString(),
    });
    expect(tok.status).toBe(200);
    const access = ((await tok.json()) as { access_token: string }).access_token;
    const mcp = () =>
      s.app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${access}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    expect((await mcp()).status).toBe(200);
    await s.api("POST", `/admin/v1/accounts/${custAccount}/suspend`, { reason: "x" }, admin);
    const refused = await mcp();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ detail: SUSPENDED_DETAIL });
    await s.api("POST", `/admin/v1/accounts/${custAccount}/unsuspend`, {}, admin);
    expect((await mcp()).status).toBe(200);
  });
});

describe("on a dashboard host of its own", () => {
  it("serves operators at /admin and answers everyone else as if it did not exist", async () => {
    const APP = "https://app.recall.test";
    const split = await createHostedServer({
      billing: false,
      env: {
        RECALL_PUBLIC_URL: "https://api.recall.test",
        RECALL_DASHBOARD_URL: APP,
        RECALL_SIGNUP_ENABLED: "true",
        RECALL_OPERATOR_EMAILS: "ops@example.com",
      },
    });
    try {
      const op = new Browser(split.app, "203.0.113.30", APP);
      await op.signIn(split, "ops@example.com");
      const home = await op.get("/admin");
      expect(home.res.status).toBe(200);
      expect(home.html).toContain('href="/admin/accounts"');
      expect((await op.get("/admin/accounts")).res.status).toBe(200);

      const user = new Browser(split.app, "203.0.113.31", APP);
      await user.signIn(split, "user@example.com");
      // What the same paths answer on the API host, where no dashboard is served.
      for (const b of [user, new Browser(split.app, "203.0.113.32", APP)]) {
        for (const path of ["/admin", "/admin/accounts"]) {
          const hidden = await b.get(path);
          const other = await split.app.request(`https://api.recall.test${path}`);
          expect(hidden.res.status, path).toBe(other.status);
          expect(hidden.html, path).toBe(await other.text());
          expect(hidden.res.headers.get("content-type")).toBe(other.headers.get("content-type"));
        }
      }
    } finally {
      await split.close();
    }
  });
});
