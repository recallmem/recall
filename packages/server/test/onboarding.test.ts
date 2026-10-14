import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatUsd } from "../src/billing/ledger.js";
import { loadConfig } from "../src/config.js";
import {
  sendOnboardingEmails,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/core/onboarding.js";
import { migrate, openDatabase, rows } from "../src/db/client.js";
import { LogMailer, type Mailer, type MailMessage, ResendMailer } from "../src/lib/mailer.js";
import { createTestServer } from "./helpers.js";
import {
  ADMIN,
  Browser,
  createHostedServer,
  type HostedServer,
  PUBLIC_URL,
} from "./hosted-helpers.js";

/**
 * Onboarding emails to new self-serve accounts: a welcome once after sign-up, one reminder from
 * 48 hours on for accounts nothing has used (never after 14 days), each claimed once in the
 * database; an unsubscribe link that needs no sign-in; nothing for accounts that existed before
 * migration 0019, in self-hosted mode or without a live mailer.
 */

/** A live mailer (as Resend is) that keeps what it sends. */
class Outbox implements Mailer {
  readonly live = true;
  readonly outbox: MailMessage[] = [];
  fail = false;
  async send(msg: MailMessage): Promise<void> {
    if (this.fail) throw new Error("mail is down");
    this.outbox.push(msg);
  }
  to(address: string): MailMessage[] {
    return this.outbox.filter((m) => m.to === address);
  }
}

let s: HostedServer;
const mail = new Outbox();
const deps = () => ({ ...s.ctx, mailer: mail });
let ip = 10;

const accountOf = async (email: string) => {
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
  );
  return m!.account_id;
};

/** Signs up through the dashboard (each from its own network, so each gets the welcome credit). */
async function signUp(email: string, from = `203.0.113.${ip++}`) {
  const browser = new Browser(s.app, from);
  await browser.signIn(s, email);
  return { browser, account: await accountOf(email) };
}

/** Moves an account's sign-up, and the emails it got, `hours` into the past. */
async function age(account: string, hours: number) {
  const by = sql`make_interval(hours => ${hours}::int)`;
  await s.ctx.db.execute(
    sql`UPDATE accounts SET created_at = created_at - ${by},
          welcome_email_at = welcome_email_at - ${by}, nudge_email_at = nudge_email_at - ${by}
        WHERE id = ${account}`,
  );
}

const marks = async (account: string) => {
  const [r] = await rows<{
    welcome_email_at: Date | null;
    nudge_email_at: Date | null;
    onboarding_emails_off_at: Date | null;
  }>(
    s.ctx.db,
    sql`SELECT welcome_email_at, nudge_email_at, onboarding_emails_off_at FROM accounts WHERE id = ${account}`,
  );
  return r!;
};

const unsubscribeLink = (m: MailMessage) =>
  new URL(m.text.match(/Turn them off: (https:\/\/\S+)/)![1]!);

beforeAll(async () => {
  // No daily cap on welcome credits: every sign-up below gets one.
  s = await createHostedServer({ env: { RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: "0" } });
});
afterAll(async () => {
  await s.close();
});

describe("welcome email", () => {
  it("goes to the new owner once, with three ways to start, the links and the welcome credit", async () => {
    const { account } = await signUp("welcome@example.com");
    const first = await sendOnboardingEmails(deps());
    expect(first).toMatchObject({ welcome: 1 });
    // Later checks, one after another, send nothing more.
    await sendOnboardingEmails(deps());
    await sendOnboardingEmails(deps());
    const got = mail.to("welcome@example.com");
    expect(got).toHaveLength(1);
    const m = got[0]!;
    expect((await marks(account)).welcome_email_at).not.toBeNull();

    expect(m.subject).toBe("Welcome to Recall");
    expect(m.replyTo).toBe("support@recallmem.dev");
    const credit = formatUsd(s.ctx.config.hosted.billing.signupCreditMicros);
    expect(credit).toBe("$5.00");
    for (const part of [
      `We added ${credit} of free credit to your account`,
      "Three ways to start:",
      "/plugin marketplace add recallmem/recall-plugin",
      "/plugin install recall-memory@recall",
      "npm install @recall-memory/sdk",
      "pip install recall-mem",
      `${PUBLIC_URL}/mcp`,
      `${PUBLIC_URL}/app/keys`,
      `${PUBLIC_URL}/docs#quickstart`,
      `${PUBLIC_URL}/guides`,
      "Reply to this email: a person reads every reply. Or write to support@recallmem.dev.",
    ])
      expect(m.text).toContain(part);
    // The links are links in the HTML part; commands are code blocks.
    expect(m.html).toContain(`<a href="${PUBLIC_URL}/app/keys"`);
    expect(m.html).toContain(`<a href="${PUBLIC_URL}/docs#quickstart"`);
    expect(m.html).toMatch(/<pre[^>]*>\/plugin marketplace add recallmem\/recall-plugin\n/);

    // Every onboarding email can be turned off, also with one click in the mail client.
    const link = unsubscribeLink(m);
    expect(link.origin + link.pathname).toBe(`${PUBLIC_URL}/app/unsubscribe`);
    expect(
      verifyUnsubscribeToken(s.ctx.config.hosted.sessionSecret, link.searchParams.get("t")!),
    ).toBe(account);
    expect(m.html).toContain(`href="${link.href.replaceAll("&", "&#38;")}"`);
    expect(m.headers).toEqual({
      "List-Unsubscribe": `<${link.href}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("does not mention a welcome credit the account did not get", async () => {
    // The second sign-up from one network gets no welcome credit (RECALL_SIGNUP_CREDIT_PER_IP=1).
    await signUp("first-on-net@example.com", "198.51.100.33");
    await signUp("second-on-net@example.com", "198.51.100.33");
    await sendOnboardingEmails(deps());
    const [m] = mail.to("second-on-net@example.com");
    expect(m!.text).not.toContain("free credit");
    expect(m!.text).toContain("Your account has no credit yet.");
    expect(mail.to("first-on-net@example.com")[0]!.text).toContain("of free credit");
  });

  it("says a welcome credit held back by the day's cap is on its way", async () => {
    await signUp("held-first@example.com", "198.51.100.44");
    const { account } = await signUp("held-later@example.com", "198.51.100.44");
    await s.ctx.db.execute(
      sql`INSERT INTO signup_credit_pending (account_id, amount_micros) VALUES (${account}, 5000000)`,
    );
    await sendOnboardingEmails(deps());
    const [m] = mail.to("held-later@example.com");
    expect(m!.text).toContain(`Your ${formatUsd(5_000_000)} of free credit is on its way.`);
    expect(m!.text).not.toContain("no credit yet");
  });

  it("is not sent once the account is a day old, nor to accounts made through the admin API", async () => {
    const { account } = await signUp("late@example.com");
    await age(account, 25);
    await sendOnboardingEmails(deps());
    expect(mail.to("late@example.com")).toHaveLength(0);
    const before = mail.outbox.length;
    const res = await s.api(
      "POST",
      "/admin/v1/accounts",
      { name: "operator-made" },
      {
        authorization: `Bearer ${ADMIN}`,
      },
    );
    expect(res.status).toBeLessThan(300);
    await sendOnboardingEmails(deps());
    expect(mail.outbox.length).toBe(before);
  });
});

describe("nudge", () => {
  it("goes out once from 48 hours after sign-up, only to accounts nothing has used", async () => {
    const idle = await signUp("idle@example.com");
    const keyed = await signUp("key-used@example.com");
    const keyMade = await signUp("key-made@example.com");
    const messaged = await signUp("messaged@example.com");
    const app = await signUp("app@example.com");
    await sendOnboardingEmails(deps()); // the welcome emails

    // A key that was used; a key that was only created; a message stored; an app connected.
    const key = (await keyed.browser.createKey({ name: "app" })).key!;
    const used = await s.api("GET", "/v3/account", undefined, { authorization: `Bearer ${key}` });
    expect(used.status).toBe(200);
    await vi.waitFor(async () => {
      const [k] = await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT count(*)::int AS n FROM api_keys WHERE account_id = ${keyed.account} AND last_used_at IS NOT NULL`,
      );
      expect(k!.n).toBe(1);
    });
    expect((await keyMade.browser.createKey({ name: "unused" })).key).toBeTruthy();
    await s.ctx.db.execute(
      sql`UPDATE accounts SET first_message_at = now() WHERE id = ${messaged.account}`,
    );
    await s.ctx.db.execute(sql`UPDATE accounts SET first_app_at = now() WHERE id = ${app.account}`);

    const all = [idle, keyed, keyMade, messaged, app];
    for (const a of all) await age(a.account, 47);
    await sendOnboardingEmails(deps());
    expect(mail.outbox.filter((m) => m.subject.startsWith("Stuck?"))).toHaveLength(0);

    for (const a of all) await age(a.account, 2);
    await sendOnboardingEmails(deps());
    await sendOnboardingEmails(deps());
    const nudges = mail.outbox.filter((m) => m.subject.startsWith("Stuck?"));
    expect(nudges.map((m) => m.to).sort()).toEqual(["idle@example.com", "key-made@example.com"]);

    const m = mail.to("idle@example.com").at(-1)!;
    expect(m.subject).toBe("Stuck? Here's the 2-minute start");
    expect(m.replyTo).toBe("support@recallmem.dev");
    expect(m.text).toContain(`1. Create an API key at ${PUBLIC_URL}/app/keys.`);
    expect(m.text).toContain(
      `    curl ${PUBLIC_URL}/v3/workspaces/my-app/sessions/chat-1/messages \\`,
    );
    expect(m.text).toContain(`    curl ${PUBLIC_URL}/v3/workspaces/my-app/peers/alice/chat \\`);
    expect(m.text).toContain("Tell us what you tried and we will help.");
    expect(m.text).toContain("It is the last getting-started email we send.");
    expect(m.text).not.toContain("no credit");
    expect(unsubscribeLink(m).searchParams.get("t")).toBe(
      unsubscribeToken(s.ctx.config.hosted.sessionSecret, idle.account),
    );
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect((await marks(idle.account)).nudge_email_at).not.toBeNull();
    expect((await marks(keyed.account)).nudge_email_at).toBeNull();
  });

  it("has a snippet that works as written", async () => {
    const { browser, account } = await signUp("snippet@example.com");
    await sendOnboardingEmails(deps());
    await age(account, 49);
    await sendOnboardingEmails(deps());
    const m = mail.to("snippet@example.com").find((x) => x.subject.startsWith("Stuck?"))!;
    const key = (await browser.createKey({ name: "snippet" })).key!;
    const calls = [...m.text.matchAll(/curl (\S+) \\\n.*\n\s+-d '(.*)'/g)];
    expect(calls).toHaveLength(2);
    const statuses: number[] = [];
    for (const [, url, body] of calls) {
      const res = await s.api("POST", new URL(url!).pathname, JSON.parse(body!), {
        authorization: `Bearer ${key}`,
      });
      statuses.push(res.status);
      if (statuses.length === 2) expect(typeof (await res.json()).content).toBe("string");
    }
    expect(statuses).toEqual([201, 200]); // stored, then answered
  });

  it("is never sent to accounts older than 14 days", async () => {
    const young = await signUp("thirteen-days@example.com");
    const old = await signUp("fifteen-days@example.com");
    await sendOnboardingEmails(deps());
    await age(young.account, 13 * 24 + 20);
    await age(old.account, 14 * 24 + 4);
    await sendOnboardingEmails(deps());
    expect(mail.to("thirteen-days@example.com").map((m) => m.subject)).toEqual([
      "Welcome to Recall",
      "Stuck? Here's the 2-minute start",
    ]);
    expect(mail.to("fifteen-days@example.com").map((m) => m.subject)).toEqual([
      "Welcome to Recall",
    ]);
  });
});

describe("sent once", () => {
  it("of several checks running at once, one sends each email", async () => {
    const { account } = await signUp("concurrent@example.com");
    const results = await Promise.all([1, 2, 3, 4].map(() => sendOnboardingEmails(deps())));
    expect(results.reduce((n, r) => n + (r === "off" ? 0 : r.welcome), 0)).toBe(1);
    expect(mail.to("concurrent@example.com")).toHaveLength(1);

    await age(account, 49);
    const again = await Promise.all([1, 2, 3, 4].map(() => sendOnboardingEmails(deps())));
    expect(again.reduce((n, r) => n + (r === "off" ? 0 : r.nudge), 0)).toBe(1);
    expect(mail.to("concurrent@example.com").map((m) => m.subject)).toEqual([
      "Welcome to Recall",
      "Stuck? Here's the 2-minute start",
    ]);
  });

  it("gives an email back when it reached nobody, so the next check sends it", async () => {
    const { account } = await signUp("retry@example.com");
    mail.fail = true;
    try {
      await sendOnboardingEmails(deps());
    } finally {
      mail.fail = false;
    }
    expect((await marks(account)).welcome_email_at).toBeNull();
    await sendOnboardingEmails(deps());
    expect(mail.to("retry@example.com")).toHaveLength(1);
  });
});

describe("unsubscribe", () => {
  it("from the link: a GET only asks, the button turns the emails off, no sign-in needed", async () => {
    const { account } = await signUp("unsub@example.com");
    await sendOnboardingEmails(deps());
    const link = unsubscribeLink(mail.to("unsub@example.com")[0]!);
    const stranger = new Browser(s.app, "192.0.2.50");
    const asked = await stranger.get(`${link.pathname}${link.search}`);
    expect(asked.res.status).toBe(200);
    expect(asked.html).toContain("Stop getting-started emails?");
    expect((await marks(account)).onboarding_emails_off_at).toBeNull();

    const done = await stranger.post(
      link.pathname,
      { t: link.searchParams.get("t")! },
      {
        csrf: null,
      },
    );
    expect(done.res.status).toBe(200);
    expect(done.html).toContain("You are unsubscribed");
    expect((await marks(account)).onboarding_emails_off_at).not.toBeNull();

    await age(account, 49);
    await sendOnboardingEmails(deps());
    expect(mail.to("unsub@example.com").map((m) => m.subject)).toEqual(["Welcome to Recall"]);

    // Sign-in links (and other account email) still arrive.
    const before = s.mailer.outbox.length;
    await new Browser(s.app, "192.0.2.51").signIn(s, "unsub@example.com");
    expect(s.mailer.outbox.length).toBe(before + 1);
    expect(s.mailer.outbox.at(-1)!.subject).toBe("Your Recall sign-in link");
  });

  it("with one click in the mail client (RFC 8058), without cookies or a form token", async () => {
    const { account } = await signUp("one-click@example.com");
    await sendOnboardingEmails(deps());
    const header = mail.to("one-click@example.com")[0]!.headers!["List-Unsubscribe"]!;
    const url = new URL(header.slice(1, -1));
    const res = await s.app.request(`${url.pathname}${url.search}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect((await marks(account)).onboarding_emails_off_at).not.toBeNull();
    await age(account, 49);
    await sendOnboardingEmails(deps());
    expect(mail.to("one-click@example.com")).toHaveLength(1);
  });

  it("refuses a link that is not ours, and a token for one account cannot name another", async () => {
    const { account } = await signUp("tamper@example.com");
    const token = unsubscribeToken(s.ctx.config.hosted.sessionSecret, account);
    const other = await signUp("victim@example.com");
    const forged = `${other.account}.${token.split(".")[1]}`;
    for (const t of ["", "nonsense", forged, `${token}x`]) {
      const b = new Browser(s.app, "192.0.2.60");
      const asked = await b.get(`/app/unsubscribe?t=${encodeURIComponent(t)}`);
      expect(asked.res.status).toBe(400);
      expect(asked.html).toContain("This link does not work");
      const posted = await b.post("/app/unsubscribe", { t }, { csrf: null });
      expect(posted.res.status).toBe(400);
    }
    expect((await marks(other.account)).onboarding_emails_off_at).toBeNull();
    expect((await marks(account)).onboarding_emails_off_at).toBeNull();
  });
});

describe("off", () => {
  it("without a live mailer, with RECALL_ONBOARDING_EMAILS_ENABLED=false, and self-hosted", async () => {
    const { account } = await signUp("not-live@example.com");
    // The development mailer only logs: nothing is claimed, so nothing is lost either.
    expect(
      await sendOnboardingEmails({ ...s.ctx, mailer: new LogMailer(pino({ level: "silent" })) }),
    ).toBe("off");
    const hosted = { ...s.ctx.config.hosted, onboardingEmails: false };
    expect(await sendOnboardingEmails({ ...deps(), config: { ...s.ctx.config, hosted } })).toBe(
      "off",
    );
    expect((await marks(account)).welcome_email_at).toBeNull();
    expect(
      loadConfig({ RECALL_DATA_DIR: "memory", RECALL_ONBOARDING_EMAILS_ENABLED: "false" }).hosted
        .onboardingEmails,
    ).toBe(false);

    // Self-hosted (not hosted mode): a self-serve-looking account with an owner gets nothing.
    const self = await createTestServer();
    try {
      const db = self.ctx.db;
      await db.execute(sql`INSERT INTO accounts (id, name, metadata)
        VALUES ('acct_self', 'self', '{"signup": "self_serve"}'::jsonb)`);
      await db.execute(sql`INSERT INTO users (id, email) VALUES ('usr_self', 'self@example.com')`);
      await db.execute(sql`INSERT INTO account_members (account_id, user_id, role)
        VALUES ('acct_self', 'usr_self', 'owner')`);
      const box = new Outbox();
      expect(await sendOnboardingEmails({ ...self.ctx, mailer: box })).toBe("off");
      expect(box.outbox).toHaveLength(0);
    } finally {
      await self.close();
    }
  });
});

describe("migration 0019", () => {
  it("marks every existing account as sent, so deploying it emails nobody", async () => {
    const config = loadConfig({ RECALL_DATA_DIR: "memory" });
    const d = await openDatabase(config);
    try {
      const dir = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const before = readdirSync(dir)
        .filter((f) => f.endsWith(".sql") && f < "0019")
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
      // Self-serve accounts with owners, unused: one an hour old, one three days old.
      const x = d.db;
      await x.execute(sql`INSERT INTO accounts (id, name, metadata, created_at) VALUES
        ('a_new', 'n', '{"signup": "self_serve"}'::jsonb, now() - interval '1 hour'),
        ('a_idle', 'i', '{"signup": "self_serve"}'::jsonb, now() - interval '3 days')`);
      await x.execute(sql`INSERT INTO users (id, email) VALUES
        ('u_new', 'new@example.com'), ('u_idle', 'idle@example.com')`);
      await x.execute(sql`INSERT INTO account_members (account_id, user_id, role) VALUES
        ('a_new', 'u_new', 'owner'), ('a_idle', 'u_idle', 'owner')`);

      expect((await migrate(d.db, config.embedding.dimensions))[0]).toBe(
        "0019_onboarding_emails.sql",
      );
      const got = await rows<{ id: string; welcome: boolean; nudge: boolean; off: boolean }>(
        d.db,
        sql`SELECT id, welcome_email_at IS NOT NULL AS welcome, nudge_email_at IS NOT NULL AS nudge,
                   onboarding_emails_off_at IS NOT NULL AS off
            FROM accounts WHERE id LIKE 'a\\_%' ORDER BY id`,
      );
      expect(got).toEqual([
        { id: "a_idle", welcome: true, nudge: true, off: false },
        { id: "a_new", welcome: true, nudge: true, off: false },
      ]);
      // With onboarding on (hosted, dashboard, live mailer), these accounts get nothing.
      const box = new Outbox();
      const out = await sendOnboardingEmails({
        config: s.ctx.config,
        db: d.db,
        log: pino({ level: "silent" }),
        mailer: box,
      });
      expect(out).toEqual({ welcome: 0, nudge: 0 });
      expect(box.outbox).toHaveLength(0);
    } finally {
      await d.close();
    }
  });
});

describe("Resend", () => {
  it("passes the reply-to address and the extra headers on", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const mailer = new ResendMailer("re_test", "Recall <hi@mail.example.com>", fetchImpl);
    await mailer.send({
      to: "a@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      replyTo: "support@recallmem.dev",
      headers: { "List-Unsubscribe": "<https://x.example/u>" },
    });
    await mailer.send({ to: "b@example.com", subject: "s", text: "t", html: "<p>t</p>" });
    expect(calls[0]!.body).toMatchObject({
      to: ["a@example.com"],
      reply_to: "support@recallmem.dev",
      headers: { "List-Unsubscribe": "<https://x.example/u>" },
    });
    expect(calls[1]!.body).not.toHaveProperty("reply_to");
    expect(calls[1]!.body).not.toHaveProperty("headers");
  });
});
