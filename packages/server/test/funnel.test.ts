import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postEntry } from "../src/billing/ledger.js";
import { loadConfig } from "../src/config.js";
import { funnel, funnelPeriod, testEmails } from "../src/core/funnel.js";
import {
  funnelReportRecipients,
  reportWeek,
  sendWeeklyFunnelReport,
} from "../src/core/funnel-report.js";
import { createAuthorizationCode } from "../src/core/oauth.js";
import { migrate, openDatabase, rows } from "../src/db/client.js";
import type { Mailer, MailMessage } from "../src/lib/mailer.js";
import { hashPassword } from "../src/lib/passwords.js";
import {
  ADMIN,
  Browser,
  createHostedServer,
  type HostedServer,
  PUBLIC_URL,
} from "./hosted-helpers.js";

/**
 * The operator's activation funnel: each step read from the account's own records (an API key or
 * an OAuth connection, the first stored message, a chat answer, a paid top-up, recent use), with
 * operator-created and test accounts left out; the console's Funnel page, open to operators only;
 * and the weekly report email, sent once per week from Monday 08:00 Amsterdam time.
 */

let s: HostedServer;
let ops: Browser;
let cust: Browser;
const admin = { authorization: `Bearer ${ADMIN}` };
const ids: Record<string, string> = {};
let ip = 40;

const accountOf = async (email: string) => {
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
  );
  return m!.account_id;
};
async function signUp(email: string): Promise<Browser> {
  const b = new Browser(s.app, `203.0.113.${ip++}`);
  await b.signIn(s, email);
  ids[email] = await accountOf(email);
  return b;
}
const keyOf = async (b: Browser) => {
  const key = (await b.createKey({ name: "app" })).key!;
  return { authorization: `Bearer ${key}` };
};
const firstMessageAt = async (account: string) => {
  const [r] = await rows<{ first_message_at: Date | string | null; created_at: Date | string }>(
    s.ctx.db,
    sql`SELECT first_message_at, created_at FROM accounts WHERE id = ${account}`,
  );
  const at = r!.first_message_at == null ? null : new Date(r!.first_message_at);
  return { at, created: new Date(r!.created_at) };
};

/** Connects an OAuth app for the account the way the token endpoint does. */
async function connectApp(email: string): Promise<void> {
  const reg = await s.app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.80" },
    body: JSON.stringify({
      client_name: "Funnel test",
      redirect_uris: ["https://client.example/cb"],
    }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(48).toString("base64url");
  const [user] = await rows<{ id: string }>(
    s.ctx.db,
    sql`SELECT id FROM users WHERE email = ${email}`,
  );
  const code = await createAuthorizationCode(
    s.ctx.db,
    {
      clientId,
      accountId: ids[email]!,
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
}

beforeAll(async () => {
  s = await createHostedServer({
    env: {
      RECALL_OPERATOR_EMAILS: "Ops@Example.com",
      RECALL_REVIEWER_EMAIL: "reviewer@example.com",
      RECALL_REVIEWER_PASSWORD_HASH: hashPassword("a long enough reviewer password", 1024),
      RECALL_SIGNUP_CREDIT_USD: "5",
    },
  });
  ops = await signUp("ops@example.com");

  // full: a key, messages (dated by the client in 2020), a chat answer, a paid top-up, recent use.
  cust = await signUp("full@example.com");
  const auth = await keyOf(cust);
  await s.api("POST", "/v3/workspaces", { id: "main" }, auth);
  await s.api("POST", "/v3/workspaces/main/peers", { id: "alice" }, auth);
  const stored = await s.api(
    "POST",
    "/v3/workspaces/main/sessions/s1/messages",
    {
      messages: [
        { peer_id: "alice", content: "I drink oolong tea", created_at: "2020-01-01T00:00:00Z" },
      ],
    },
    auth,
  );
  expect(stored.status).toBeLessThan(300);
  await s.api(
    "POST",
    "/v3/workspaces/main/conclusions",
    {
      conclusions: [
        { content: "alice drinks oolong tea", observer_id: "alice", observed_id: "alice" },
      ],
    },
    auth,
  );
  const chat = await s.api(
    "POST",
    "/v3/workspaces/main/peers/alice/chat",
    { query: "What does alice drink?", reasoning_level: "low" },
    auth,
  );
  expect(chat.status).toBe(200);
  await chat.text();
  await postEntry(s.ctx.db, {
    account: ids["full@example.com"]!,
    amountMicros: 10_000_000,
    kind: "topup",
    key: "topup:pi_funnel_1",
  });

  // idle: signed up, nothing else.
  await signUp("idle@example.com");

  // app: connected an app over OAuth; the grant is purged later.
  await signUp("app@example.com");
  await connectApp("app@example.com");
  await s.ctx.db.execute(
    sql`DELETE FROM oauth_grants WHERE account_id = ${ids["app@example.com"]!}`,
  );

  // old: signed up 40 days ago with a key (in the 90-day funnel, not the 30-day one).
  const old = await signUp("old@example.com");
  await keyOf(old);
  await s.ctx.db.execute(
    sql`UPDATE accounts SET created_at = now() - interval '40 days' WHERE id = ${ids["old@example.com"]!}`,
  );

  // Left out: the reviewer, a benchmark account, one marked as a test, and one the operator made.
  await signUp("reviewer@example.com");
  await signUp("bench@example.com");
  await signUp("marked@example.com");
  for (const [email, extra] of [
    ["bench@example.com", { llm_key: "eval" }],
    ["marked@example.com", { test_account: true }],
  ] as const) {
    const r = await s.api(
      "PATCH",
      `/admin/v1/accounts/${ids[email]}`,
      { metadata: { signup: "self_serve", signup_email: email, ...extra } },
      admin,
    );
    expect(r.status).toBe(200);
  }
  const made = await s.api("POST", "/admin/v1/accounts", { name: "Operator made" }, admin);
  expect(made.status).toBe(201);
  ids.operatorMade = ((await made.json()) as { id: string }).id;
  await s.ctx.usage.flush();
}, 60_000);
afterAll(async () => {
  await s.close();
});

const exclusions = () => testEmails(s.ctx.config.hosted);

describe("step derivation", () => {
  it("reads each step from the account's own records", async () => {
    const f = await funnel(s.ctx.db, { days: 30, testEmails: exclusions() });
    expect(f.total.signups).toBe(3);
    expect(f.total.reached).toEqual({
      signed_up: 3,
      connected: 2, // full's key, app's OAuth connection
      message: 1,
      answer: 1,
      topup: 1,
      active: 1,
    });
    const steps = Object.fromEntries(f.recent.map((r) => [r.email, r.reached]));
    expect(steps).toEqual({
      "full@example.com": ["signed_up", "connected", "message", "answer", "topup", "active"],
      "idle@example.com": ["signed_up"],
      "app@example.com": ["signed_up", "connected"],
    });
    expect(f.recent.find((r) => r.email === "full@example.com")!.furthest).toBe("active");
    expect(f.recent.find((r) => r.email === "app@example.com")!.furthest).toBe("connected");
    expect(f.total.medianAnswerMs).not.toBeNull();

    const quarter = await funnel(s.ctx.db, { days: 90, testEmails: exclusions() });
    expect(quarter.total.signups).toBe(4);
    expect(quarter.total.reached.connected).toBe(3);
    expect(quarter.recent.at(-1)!.email).toBe("old@example.com");
  });

  it("leaves out operator-created, operator, reviewer, benchmark and marked test accounts", async () => {
    const f = await funnel(s.ctx.db, { days: 30, testEmails: exclusions() });
    const shown = new Set(f.recent.map((r) => r.id));
    for (const left of [
      "ops@example.com",
      "reviewer@example.com",
      "bench@example.com",
      "marked@example.com",
      "operatorMade",
    ])
      expect(shown.has(ids[left]!), left).toBe(false);
    expect(f.leftOut).toEqual({ operatorCreated: 1, test: 4 });
    expect(exclusions()).toEqual(["ops@example.com", "reviewer@example.com"]);
  });

  it("stamps when the first message was stored, once, whatever created_at the client sent", async () => {
    const full = ids["full@example.com"]!;
    const first = await firstMessageAt(full);
    expect(first.at).not.toBeNull();
    expect(first.at!.getTime()).toBeGreaterThanOrEqual(first.created.getTime());
    const auth = await keyOf(cust);
    const again = await s.api(
      "POST",
      "/v3/workspaces/main/sessions/s2/messages",
      { messages: [{ peer_id: "alice", content: "and green tea" }] },
      auth,
    );
    expect(again.status).toBeLessThan(300);
    expect((await firstMessageAt(full)).at!.getTime()).toBe(first.at!.getTime());

    // Messages deleted later still leave the step reached.
    await s.ctx.db.execute(
      sql`DELETE FROM messages WHERE workspace_id IN (SELECT id FROM workspaces WHERE account_id = ${full})`,
    );
    const f = await funnel(s.ctx.db, { days: 30, testEmails: exclusions() });
    expect(f.total.reached.message).toBe(1);
  });

  it("stamps the first app connection, which outlives the purged grant", async () => {
    const [r] = await rows<{ first_app_at: Date | string | null }>(
      s.ctx.db,
      sql`SELECT first_app_at FROM accounts WHERE id = ${ids["app@example.com"]!}`,
    );
    expect(r!.first_app_at).not.toBeNull();
    const [g] = await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n FROM oauth_grants WHERE account_id = ${ids["app@example.com"]!}`,
    );
    expect(g!.n).toBe(0);
  });

  it("groups by sign-up week, counts billed answers not given back, and takes the median wait", async () => {
    // A fixed, earlier period of its own: Wednesday 12 March 2025, 30 days back.
    const now = new Date("2025-03-12T12:00:00Z");
    const at = (iso: string) => new Date(iso);
    const db = s.ctx.db;
    const add = (id: string, created: string) =>
      db.execute(
        sql`INSERT INTO accounts (id, name, metadata, created_at)
            VALUES (${id}, ${id}, '{"signup": "self_serve"}'::jsonb, ${at(created)})`,
      );
    await add("acct_w1a", "2025-03-10T09:00:00Z");
    await add("acct_w1b", "2025-03-11T10:00:00Z");
    await add("acct_w2a", "2025-03-04T10:00:00Z");
    await add("acct_before", "2025-01-01T10:00:00Z");
    // w1a: a key, a message, an answer from a model call 2 h after sign-up.
    await db.execute(
      sql`INSERT INTO api_keys (id, account_id, key_hash, prefix, created_at)
          VALUES ('key_w1a', 'acct_w1a', 'x', 'pk_live_w1a', ${at("2025-03-10T10:00:00Z")})`,
    );
    await db.execute(
      sql`UPDATE accounts SET first_message_at = ${at("2025-03-10T10:30:00Z")} WHERE id = 'acct_w1a'`,
    );
    await db.execute(
      sql`INSERT INTO llm_usage (account_id, task, provider, model, created_at)
          VALUES ('acct_w1a', 'reasoner', 'mock', 'm', ${at("2025-03-10T10:45:00Z")}),
                 ('acct_w1a', 'chat_low', 'mock', 'm', ${at("2025-03-10T11:00:00Z")})`,
    );
    // w1b: a billed answer (a cached one makes no model call) 4 h after sign-up, and a top-up.
    // w2a: a billed chat that was given back (no answer), and welcome credit (not a top-up).
    const entry = (account: string, micros: number, kind: string, key: string, when: string) =>
      db.execute(
        sql`INSERT INTO credit_ledger (account_id, amount_micros, kind, idempotency_key, balance_after_micros, created_at)
            VALUES (${account}, ${micros}, ${kind}, ${key}, 0, ${at(when)})`,
      );
    await entry("acct_w1b", -5000, "chat_low", "chat:a", "2025-03-11T14:00:00Z");
    await entry("acct_w1b", 25_000_000, "topup", "topup:pi_w1b", "2025-03-11T15:00:00Z");
    await entry("acct_w2a", -5000, "chat_low", "chat:b", "2025-03-04T11:00:00Z");
    await entry("acct_w2a", 5000, "chat_low", "chat:b:released", "2025-03-04T11:00:01Z");
    await entry("acct_w2a", 5_000_000, "signup_credit", "signup:acct_w2a", "2025-03-04T10:00:00Z");

    try {
      const f = await funnel(db, { days: 30, now, testEmails: [] });
      expect(f.weeks.map((w) => w.key)).toEqual([
        "2025-03-10",
        "2025-03-03",
        "2025-02-24",
        "2025-02-17",
        "2025-02-10",
      ]);
      expect(f.weeks.map((w) => w.signups)).toEqual([2, 1, 0, 0, 0]);
      expect(f.total.signups).toBe(3);
      expect(f.total.reached).toEqual({
        signed_up: 3,
        connected: 1,
        message: 1,
        answer: 2,
        topup: 1,
        active: 1,
      });
      // Waits of 2 h and 4 h: the median is 3 h.
      expect(f.total.medianAnswerMs).toBe(3 * 3_600_000);
      expect(f.weeks[0]!.medianAnswerMs).toBe(3 * 3_600_000);
      expect(f.weeks[1]!.medianAnswerMs).toBeNull();
      expect(f.recent.map((r) => [r.id, r.furthest])).toEqual([
        ["acct_w1b", "topup"],
        ["acct_w1a", "active"],
        ["acct_w2a", "signed_up"],
      ]);
      // Seven days back from the same moment: only that week's two.
      const week = await funnel(db, { days: 7, now, testEmails: [] });
      expect(week.total.signups).toBe(2);
      expect(week.weeks.map((w) => w.key)).toEqual(["2025-03-10", "2025-03-03"]);
    } finally {
      await db.execute(
        sql`DELETE FROM accounts WHERE id IN ('acct_w1a', 'acct_w1b', 'acct_w2a', 'acct_before')`,
      );
    }
  });
});

describe("migration 0018", () => {
  it("backfills the first app and first message of existing accounts", async () => {
    const config = loadConfig({ RECALL_DATA_DIR: "memory" });
    const d = await openDatabase(config);
    try {
      const dir = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const before = readdirSync(dir)
        .filter((f) => f.endsWith(".sql") && f < "0018")
        .sort();
      await d.db.execute(sql`CREATE TABLE recall_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const file of before) {
        const body = readFileSync(`${dir}/${file}`, "utf8").replaceAll(
          "__EMBEDDING_DIM__",
          String(config.embedding.dimensions),
        );
        for (const stmt of body.split(/;\s*\n/))
          if (stmt.replace(/--.*$/gm, "").trim()) await d.db.execute(sql.raw(stmt));
        await d.db.execute(sql`INSERT INTO recall_migrations (name) VALUES (${file})`);
      }
      const x = d.db;
      await x.execute(sql`INSERT INTO accounts (id, name, created_at) VALUES
        ('a_msg', 'm', '2026-05-01T00:00:00Z'), ('a_app', 'o', '2026-05-01T00:00:00Z'),
        ('a_billed', 'b', '2026-05-01T00:00:00Z'), ('a_none', 'n', '2026-05-01T00:00:00Z')`);
      // a_msg: messages dated by the client before the account existed, and one later.
      await x.execute(
        sql`INSERT INTO workspaces (id, account_id, name) VALUES ('w1', 'a_msg', 'w')`,
      );
      await x.execute(sql`INSERT INTO sessions (id, workspace_id, name) VALUES ('s1', 'w1', 's')`);
      await x.execute(sql`INSERT INTO peers (id, workspace_id, name) VALUES ('p1', 'w1', 'p')`);
      await x.execute(sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, token_count, created_at)
        VALUES ('m1', 'w1', 's1', 'p1', 1, 'x', 1, '2020-01-01T00:00:00Z'),
               ('m2', 'w1', 's1', 'p1', 2, 'y', 1, '2026-06-01T00:00:00Z')`);
      // a_app: an OAuth grant; a_billed: learning billed, its messages since deleted.
      await x.execute(sql`INSERT INTO users (id, email) VALUES ('u1', 'u@example.com')`);
      await x.execute(sql`INSERT INTO oauth_clients (id, kind, name, redirect_uris)
        VALUES ('c1', 'registered', 'c', ARRAY['https://c.example/cb'])`);
      await x.execute(sql`INSERT INTO oauth_grants (id, account_id, user_id, client_id, redirect_uri, resource, scope, default_workspace, created_at)
        VALUES ('g1', 'a_app', 'u1', 'c1', 'https://c.example/cb', 'https://r/mcp', 'memory', 'default', '2026-05-03T00:00:00Z')`);
      await x.execute(sql`INSERT INTO credit_ledger (account_id, amount_micros, kind, idempotency_key, balance_after_micros, created_at)
        VALUES ('a_billed', -10, 'ingest', 'ingest:1', 0, '2026-05-04T00:00:00Z')`);

      expect(await migrate(d.db, config.embedding.dimensions)).toEqual([
        "0018_activation_funnel.sql",
      ]);
      const got = await rows<{
        id: string;
        first_app_at: Date | null;
        first_message_at: Date | null;
      }>(
        d.db,
        sql`SELECT id, first_app_at, first_message_at FROM accounts WHERE id LIKE 'a\\_%' ORDER BY id`,
      );
      const iso = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());
      expect(got.map((r) => [r.id, iso(r.first_app_at), iso(r.first_message_at)])).toEqual([
        ["a_app", "2026-05-03T00:00:00.000Z", null],
        ["a_billed", null, "2026-05-04T00:00:00.000Z"],
        // Never before the account was created.
        ["a_msg", null, "2026-05-01T00:00:00.000Z"],
        ["a_none", null, null],
      ]);
    } finally {
      await d.close();
    }
  });
});

describe("console page", () => {
  it("answers 404 to everyone but operators, exactly like an unknown page", async () => {
    for (const b of [cust, new Browser(s.app, "203.0.113.200")]) {
      const unknown = await b.get("/app/no-such-page");
      const r = await b.get("/app/admin/funnel?days=90");
      expect(r.res.status).toBe(404);
      expect(r.html).toBe(unknown.html);
      expect(r.html).not.toContain("Funnel");
    }
  });

  it("shows operators the steps, the sign-up weeks and the recent sign-ups", async () => {
    const r = await ops.get("/app/admin/funnel");
    expect(r.res.status).toBe(200);
    const h = r.html;
    expect(h).toContain('href="/app/admin/funnel"');
    expect(h).toMatch(
      /<a href="\/app\/admin\/funnel\?days=30" aria-current="page">Last 30 days<\/a>/,
    );
    expect(h).toMatch(/Signed up<\/span><span class="value">3</);
    expect(h).toMatch(
      /API key or app<\/span><span class="value">2<\/span><span class="sub">67% of sign-ups/,
    );
    expect(h).toMatch(
      /Paid top-up<\/span><span class="value">1<\/span><span class="sub">33% of sign-ups/,
    );
    expect(h).toContain("<strong>All 30 days</strong>");
    expect(h).toContain("Left out: 1 operator-created account and 4 test accounts");
    const recent = h.slice(h.indexOf("<h2>Recent sign-ups</h2>"));
    const row = (email: string) =>
      recent.match(new RegExp(`<tr><td>(?:(?!<tr>).)*?${email}.*?</tr>`, "s"))?.[0] ?? "";
    expect(row("full@example.com")).toContain("Active, last 7 days");
    expect(row("full@example.com")).toContain("key or app · message · answer · top-up · active");
    expect(row("idle@example.com")).toContain("<td>Signed up</td>");
    expect(row("app@example.com")).toContain("<td>API key or app</td>");
    for (const hidden of ["ops@example.com", "reviewer@example.com", "bench@example.com"])
      expect(recent).not.toContain(hidden);
    // The console's own navigation links to it.
    expect((await ops.get("/app/admin")).html).toContain('href="/app/admin/funnel"');
  });

  it("offers 7, 30 and 90 days; anything else is 30", async () => {
    const q = await ops.get("/app/admin/funnel?days=90");
    expect(q.html).toMatch(/aria-current="page">Last 90 days</);
    expect(q.html).toMatch(/Signed up<\/span><span class="value">4</);
    expect(q.html).toContain("old@example.com");
    for (const bad of ["12", "abc", "-7", "90.5"]) {
      const r = await ops.get(`/app/admin/funnel?days=${encodeURIComponent(bad)}`);
      expect(r.res.status).toBe(200);
      expect(r.html).toMatch(/aria-current="page">Last 30 days</);
    }
    expect(funnelPeriod("7")).toBe(7);
    expect(funnelPeriod(undefined)).toBe(30);
  });
});

describe("weekly report", () => {
  const outbox = () => s.mailer.outbox.filter((m) => m.subject.startsWith("Recall funnel"));

  it("is due from Monday 08:00 Amsterdam time, summer and winter", () => {
    // 12 October 2026 is a Monday (CEST, UTC+2); 26 October is in CET (UTC+1).
    expect(reportWeek(new Date("2026-10-12T05:59:00Z"))).toEqual({
      week: "2026-10-12",
      due: false,
    });
    expect(reportWeek(new Date("2026-10-12T06:00:00Z"))).toEqual({ week: "2026-10-12", due: true });
    expect(reportWeek(new Date("2026-10-18T21:59:00Z"))).toEqual({ week: "2026-10-12", due: true });
    expect(reportWeek(new Date("2026-10-18T22:00:00Z"))).toEqual({
      week: "2026-10-19",
      due: false,
    });
    expect(reportWeek(new Date("2026-10-26T06:59:00Z"))).toEqual({
      week: "2026-10-26",
      due: false,
    });
    expect(reportWeek(new Date("2026-10-26T07:00:00Z"))).toEqual({ week: "2026-10-26", due: true });
  });

  it("is sent once per week, also when several checks run at once", async () => {
    const before = outbox().length;
    expect(await sendWeeklyFunnelReport(s.ctx, new Date("2026-10-12T05:59:00Z"))).toBe("not_due");
    expect(await sendWeeklyFunnelReport(s.ctx, new Date("2026-10-12T06:00:00Z"))).toBe("sent");
    expect(await sendWeeklyFunnelReport(s.ctx, new Date("2026-10-12T09:00:00Z"))).toBe(
      "already_sent",
    );
    expect(await sendWeeklyFunnelReport(s.ctx, new Date("2026-10-15T12:00:00Z"))).toBe(
      "already_sent",
    );
    expect(outbox().length).toBe(before + 1);
    expect(outbox().at(-1)!.to).toBe("ops@example.com");

    // The next week: three checks at once (workers, serverless instances) send one email.
    const next = new Date("2026-10-19T06:05:00Z");
    const results = await Promise.all([1, 2, 3].map(() => sendWeeklyFunnelReport(s.ctx, next)));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "already_sent")).toHaveLength(2);
    expect(outbox().length).toBe(before + 2);
    // Another process (no memory of it) finds the week claimed in the database.
    const other = { ...s.ctx, db: Object.create(s.ctx.db) as typeof s.ctx.db };
    expect(await sendWeeklyFunnelReport(other, next)).toBe("already_sent");
    const [claims] = await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n FROM operator_reports WHERE report = 'funnel_weekly'`,
    );
    expect(claims!.n).toBe(2);
  });

  it("holds numbers only, the console link, and goes to the alert address when set", async () => {
    const hosted = { ...s.ctx.config.hosted, email: { ...s.ctx.config.hosted.email } };
    hosted.email.alertTo = "alerts@example.com";
    const deps = { ...s.ctx, config: { ...s.ctx.config, hosted } };
    expect(funnelReportRecipients(deps.config)).toEqual(["alerts@example.com"]);
    // Monday 17 March 2025, 08:00 CET: the week of the fixed 2025 sign-ups below.
    const db = s.ctx.db;
    await db.execute(
      sql`INSERT INTO accounts (id, name, metadata, created_at)
          VALUES ('acct_r1', 'acct_r1', '{"signup": "self_serve"}'::jsonb, '2025-03-11T10:00:00Z'),
                 ('acct_r2', 'acct_r2', '{"signup": "self_serve"}'::jsonb, '2025-03-12T10:00:00Z')`,
    );
    await db.execute(
      sql`INSERT INTO llm_usage (account_id, task, provider, model, created_at)
          VALUES ('acct_r1', 'chat_low', 'mock', 'm', '2025-03-11T10:30:00Z')`,
    );
    try {
      expect(await sendWeeklyFunnelReport(deps, new Date("2025-03-17T07:00:00Z"))).toBe("sent");
      const mail = outbox().at(-1) as MailMessage;
      expect(mail.to).toBe("alerts@example.com");
      expect(mail.subject).toBe("Recall funnel, week of 2025-03-17: 2 sign-ups in 7 days");
      expect(mail.text).toContain("Self-serve sign-ups in the last 7 days:");
      expect(mail.text).toMatch(/First chat answer\s+1\s+50%/);
      expect(mail.text).toContain("Median time from sign-up to first answer: 30 min");
      expect(mail.text).toContain(`Console: ${PUBLIC_URL}/app/admin/funnel?days=30`);
      expect(mail.html).toContain(`href="${PUBLIC_URL}/app/admin/funnel?days=30"`);
      expect(mail.html).toContain("<td");
      // Numbers only: no names or addresses of anyone.
      for (const body of [mail.text, mail.html]) {
        expect(body).not.toContain("@");
        expect(body).not.toContain("acct_r1");
      }
    } finally {
      await db.execute(sql`DELETE FROM accounts WHERE id IN ('acct_r1', 'acct_r2')`);
    }
  });

  it("gives the week back when no email went out, so the next check sends it", async () => {
    const failing: Mailer = {
      live: true,
      send: async () => {
        throw new Error("mail is down");
      },
    };
    const week = new Date("2026-11-02T08:00:00Z");
    const before = outbox().length;
    expect(await sendWeeklyFunnelReport({ ...s.ctx, mailer: failing }, week)).toBe("failed");
    const [claim] = await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n FROM operator_reports WHERE period = '2026-11-02'`,
    );
    expect(claim!.n).toBe(0);
    expect(await sendWeeklyFunnelReport(s.ctx, week)).toBe("sent");
    expect(outbox().length).toBe(before + 1);
  });

  it("is off with RECALL_FUNNEL_REPORT_ENABLED=false or without anyone to send it to", async () => {
    const off = (patch: Partial<typeof s.ctx.config.hosted>) => ({
      ...s.ctx,
      config: { ...s.ctx.config, hosted: { ...s.ctx.config.hosted, ...patch } },
    });
    const monday = new Date("2026-11-09T08:00:00Z");
    expect(await sendWeeklyFunnelReport(off({ funnelReport: false }), monday)).toBe("off");
    expect(await sendWeeklyFunnelReport(off({ operatorEmails: [] }), monday)).toBe("off");
    const env = { RECALL_DATA_DIR: "memory" };
    expect(loadConfig(env).hosted.funnelReport).toBe(true);
    expect(loadConfig({ ...env, RECALL_FUNNEL_REPORT_ENABLED: "false" }).hosted.funnelReport).toBe(
      false,
    );
  });
});
