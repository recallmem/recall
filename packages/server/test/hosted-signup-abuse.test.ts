import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBillingRow, ledgerDrift } from "../src/billing/ledger.js";
import { signupCreditSkipReason } from "../src/billing/signup.js";
import { hostedConfig, loadConfig } from "../src/config.js";
import { DISPOSABLE_DOMAINS, isDisposableEmail, parseDomainList } from "../src/core/disposable.js";
import { eraseAccount } from "../src/core/erase.js";
import { signIn } from "../src/core/users.js";
import { rows } from "../src/db/client.js";
import { metrics, renderMetrics } from "../src/lib/metrics.js";
import { networkKey } from "../src/lib/network.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Limits on the hosted welcome credit: disposable email domains are refused for
 * new sign-ups, one credit per client network per 30 days, and a cap on the
 * credit granted per UTC day. Accounts over a limit are still created.
 */

const CREDIT = 5_000_000;
const startOfUtcDay = sql`date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/** Full magic-link sign-up through the dashboard from `ip`; what the account ended up with. */
async function signUp(s: HostedServer, email: string, ip: string) {
  const b = new Browser(s.app, ip);
  await b.signIn(s, email);
  const home = await b.get("/app");
  expect(home.res.status).toBe(200);
  return accountState(s, email);
}

async function accountState(s: HostedServer, email: string) {
  const [m] = await rows<{ account_id: string }>(
    s.ctx.db,
    sql`SELECT m.account_id FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`,
  );
  const accountId = m?.account_id ?? null;
  if (!accountId) return { accountId, balance: null, credited: false };
  const [l] = await rows<{ n: number }>(
    s.ctx.db,
    sql`SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${accountId} AND kind = 'signup_credit'`,
  );
  expect(await ledgerDrift(s.ctx.db, accountId)).toBe(0);
  return {
    accountId,
    balance: (await getBillingRow(s.ctx.db, accountId))?.balance_micros ?? null,
    credited: (l?.n ?? 0) > 0,
  };
}

/** Sign-up without the browser: the same transaction as POST /app/auth/verify, with a chosen network hash. */
const signUpDirect = (s: HostedServer, email: string, ipHash: string | null) =>
  signIn(s.ctx.db, email, {
    allowSignup: true,
    onNewAccount: (tx, accountId) => s.ctx.billing.onSignup(tx, accountId, { ipHash }),
  });

const grants = async (s: HostedServer) =>
  (
    await rows<{ n: number }>(s.ctx.db, sql`SELECT count(*)::int AS n FROM signup_credit_grants`)
  )[0]!.n;

const skipLogs = (s: HostedServer) =>
  s.logs
    .filter((l) => l.includes("sign-up credit skipped"))
    .map((l) => JSON.parse(l) as { reason: string; account: string; level: number });

// ---------------------------------------------------------------------------
describe("disposable domain list", () => {
  it("is the size of a short, well-known list and holds the usual suspects", () => {
    expect(DISPOSABLE_DOMAINS.length).toBeGreaterThanOrEqual(40);
    expect(DISPOSABLE_DOMAINS.length).toBeLessThanOrEqual(65);
    expect(new Set(DISPOSABLE_DOMAINS).size).toBe(DISPOSABLE_DOMAINS.length);
    for (const d of DISPOSABLE_DOMAINS) expect(d).toBe(d.toLowerCase());
    for (const d of [
      "mailinator.com",
      "guerrillamail.com",
      "10minutemail.com",
      "temp-mail.org",
      "yopmail.com",
      "trashmail.com",
      "sharklasers.com",
      "getnada.com",
      "dispostable.com",
      "maildrop.cc",
    ])
      expect(DISPOSABLE_DOMAINS).toContain(d);
  });

  it("matches the domain and its subdomains, in any case, and nothing that merely ends alike", () => {
    for (const email of [
      "a@mailinator.com",
      "A@MAILINATOR.COM",
      "a@eu.mailinator.com",
      "a@x.y.Yopmail.com",
      "a@mailinator.com.",
    ])
      expect(isDisposableEmail(email), email).toBe(true);
    for (const email of [
      "a@gmail.com",
      "a@example.com",
      "a@notmailinator.com",
      "a@mailinator.com.au",
      "a@mailinator.co",
      "mailinator.com@example.com",
    ])
      expect(isDisposableEmail(email), email).toBe(false);
  });

  it("adds operator domains, normalized", () => {
    expect(parseDomainList(" Corp.Test, .bad.example ,@x.org,*.y.net,, corp.test. ")).toEqual([
      "corp.test",
      "bad.example",
      "x.org",
      "y.net",
    ]);
    expect(parseDomainList(undefined)).toEqual([]);
    const extra = parseDomainList("corp.test");
    expect(isDisposableEmail("a@corp.test", extra)).toBe(true);
    expect(isDisposableEmail("a@mail.corp.test", extra)).toBe(true);
    expect(isDisposableEmail("a@corp.test.evil.com", extra)).toBe(false);
    expect(isDisposableEmail("a@corp.test")).toBe(false);
  });
});

describe("client network key", () => {
  it("is the IPv4 address, and the /64 for IPv6", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(networkKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("2001:0DB8:abcd:0012:ffff:0:0:2")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("[2001:db8:abcd:12::1]")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(networkKey("::1")).toBe("0:0:0:0::/64");
    expect(networkKey("64:ff9b::198.51.100.1")).toBe("64:ff9b:0:0::/64");
    expect(networkKey("2001:db8:abcd:13::1")).not.toBe(networkKey("2001:db8:abcd:12::1"));
  });

  it("is null for anything that is not an IP address", () => {
    for (const junk of ["", "unknown", "999.1.1.1", "1.2.3", "example.com", "2001:db8::zz"])
      expect(networkKey(junk), junk).toBeNull();
  });
});

describe("sign-up limits: config", () => {
  const hosted = (extra: Record<string, string> = {}) => {
    const config = loadConfig({ RECALL_DATA_DIR: "memory", ...extra });
    return hostedConfig({ ...config.env, RECALL_HOSTED: true });
  };

  it("defaults to one credit per network, a $50 daily cap and no extra domains", () => {
    const h = hosted();
    expect(h.billing.signupCreditMicros).toBe(CREDIT);
    expect(h.billing.signupCreditPerIp).toBe(1);
    expect(h.billing.signupCreditDailyCapMicros).toBe(50_000_000);
    expect(h.signupBlockedDomains).toEqual([]);
  });

  it("reads the three variables, and an empty value means the default (not 'off')", () => {
    const h = hosted({
      RECALL_SIGNUP_CREDIT_PER_IP: "3",
      RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: "12.5",
      RECALL_SIGNUP_BLOCKED_DOMAINS: "Corp.Test,spam.example",
    });
    expect(h.billing.signupCreditPerIp).toBe(3);
    expect(h.billing.signupCreditDailyCapMicros).toBe(12_500_000);
    expect(h.signupBlockedDomains).toEqual(["corp.test", "spam.example"]);

    const empty = hosted({
      RECALL_SIGNUP_CREDIT_PER_IP: "",
      RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: " ",
      RECALL_SIGNUP_BLOCKED_DOMAINS: "",
    });
    expect(empty.billing.signupCreditPerIp).toBe(1);
    expect(empty.billing.signupCreditDailyCapMicros).toBe(50_000_000);
    expect(empty.signupBlockedDomains).toEqual([]);
  });

  it("rejects values that make no sense", () => {
    expect(() => loadConfig({ RECALL_SIGNUP_CREDIT_PER_IP: "-1" })).toThrow();
    expect(() => loadConfig({ RECALL_SIGNUP_CREDIT_PER_IP: "1.5" })).toThrow();
    expect(() => loadConfig({ RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: "-5" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("disposable domains and one credit per network (end to end)", () => {
  let s: HostedServer;
  beforeAll(async () => {
    // A high daily cap, so only the per-network limit decides in these tests.
    s = await createHostedServer({
      env: {
        RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: "1000",
        RECALL_SIGNUP_BLOCKED_DOMAINS: "Corp.Test, .bad.example",
      },
    });
    s.ctx.log.level = "info";
  });
  afterAll(async () => {
    await s.close();
  });

  const tryLogin = async (email: string, ip: string) => {
    const b = new Browser(s.app, ip);
    await b.get("/app/login");
    return b.post("/app/login", { email });
  };

  describe("disposable domains", () => {
    it("refuses a new address, before any email or token", async () => {
      const mails = s.mailer.outbox.length;
      for (const email of [
        "bob@mailinator.com",
        "Bob@MAILINATOR.com",
        "bob@eu.mailinator.com",
        "bob@mailinator.com.",
        "bob@yopmail.com",
      ]) {
        const r = await tryLogin(email, "198.51.100.10");
        expect(r.res.status, email).toBe(422);
        expect(r.html).toContain("Use a personal or work email address");
        expect(r.html).toContain("disposable addresses can");
        expect(r.html).toContain('name="email"'); // the form is shown again
      }
      expect(s.mailer.outbox.length).toBe(mails);
      expect(
        await rows(s.ctx.db, sql`SELECT 1 FROM login_tokens WHERE email LIKE '%bob@%'`),
      ).toEqual([]);
      expect(await rows(s.ctx.db, sql`SELECT 1 FROM users WHERE email LIKE 'bob@%'`)).toEqual([]);
    });

    it("refuses the operator's extra domains and their subdomains only", async () => {
      for (const email of ["a@corp.test", "a@mail.corp.test", "a@bad.example", "a@x.bad.example"])
        expect((await tryLogin(email, "198.51.100.11")).res.status, email).toBe(422);
      for (const email of ["a@notcorp.test", "a@corp.test.evil.com", "a@example.org"]) {
        const mails = s.mailer.outbox.length;
        expect((await tryLogin(email, "198.51.100.12")).res.status, email).toBe(200);
        expect(s.mailer.outbox.length).toBe(mails + 1);
      }
    });

    it("still lets an existing user on such a domain sign in, and ordinary new users sign up", async () => {
      // Created before the domain mattered (or by an operator): the account exists.
      expect(await signUpDirect(s, "veteran@mailinator.com", null)).toMatchObject({
        created: true,
      });
      expect((await tryLogin("new@mailinator.com", "198.51.100.13")).res.status).toBe(422);

      const b = new Browser(s.app, "198.51.100.14");
      await b.signIn(s, "veteran@mailinator.com");
      const home = await b.get("/app");
      expect(home.res.status).toBe(200);
      expect(home.html).toContain("veteran@mailinator.com");
      // Signed in to the account it already had, not a new one.
      expect(
        await rows(
          s.ctx.db,
          sql`SELECT 1 FROM account_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'veteran@mailinator.com'`,
        ),
      ).toHaveLength(1);

      const fresh = await signUp(s, "newcomer@example.com", "198.51.100.15");
      expect(fresh.accountId).not.toBeNull();
    });
  });

  describe("one welcome credit per network", () => {
    it("a normal sign-up gets the credit, recorded against a hash of its network", async () => {
      const before = await grants(s);
      const first = await signUp(s, "ada@example.com", "203.0.113.50");
      expect(first).toMatchObject({ credited: true, balance: CREDIT });
      expect(await grants(s)).toBe(before + 1);
      const [g] = await rows<{ ip_hash: string; amount_micros: string | number }>(
        s.ctx.db,
        sql`SELECT ip_hash, amount_micros FROM signup_credit_grants ORDER BY id DESC LIMIT 1`,
      );
      expect(Number(g!.amount_micros)).toBe(CREDIT);
      expect(g!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(g)).not.toContain("203.0.113.50");
    });

    it("a second account from the same network is created without the credit, and the skip is logged and counted", async () => {
      const skippedBefore = metrics.signupCreditSkipped.get({ reason: "ip_limit" });
      const logsBefore = skipLogs(s).length;
      const grantsBefore = await grants(s);

      const second = await signUp(s, "mallory@example.com", "203.0.113.50");
      // Created and billed, just empty.
      expect(second.accountId).not.toBeNull();
      expect(second).toMatchObject({ credited: false, balance: 0 });
      expect(await grants(s)).toBe(grantsBefore);

      expect(metrics.signupCreditSkipped.get({ reason: "ip_limit" })).toBe(skippedBefore + 1);
      expect(renderMetrics()).toContain('recall_signup_credit_skipped_total{reason="ip_limit"}');
      const logged = skipLogs(s);
      expect(logged).toHaveLength(logsBefore + 1);
      expect(logged.at(-1)).toMatchObject({
        reason: "ip_limit",
        account: second.accountId,
        level: 30, // info
      });
      expect(JSON.stringify(logged.at(-1))).not.toContain("203.0.113.50");

      // The same person signing in again is not a sign-up: nothing changes.
      await new Browser(s.app, "203.0.113.50").signIn(s, "ada@example.com");
      expect(await grants(s)).toBe(grantsBefore);
      expect(metrics.signupCreditSkipped.get({ reason: "ip_limit" })).toBe(skippedBefore + 1);
    });

    it("a different network still gets the credit", async () => {
      expect(await signUp(s, "grace@example.com", "203.0.113.51")).toMatchObject({
        credited: true,
        balance: CREDIT,
      });
    });

    it("treats an IPv6 /48 and an IPv4-mapped address as one network", async () => {
      expect(await signUp(s, "v6a@example.com", "2001:db8:aaaa:1::10")).toMatchObject({
        credited: true,
      });
      expect(await signUp(s, "v6b@example.com", "2001:db8:aaaa:1:dead:beef:0:99")).toMatchObject({
        credited: false,
      });
      // Another /64 of the same /48 is the same customer's range.
      expect(await signUp(s, "v6c@example.com", "2001:db8:aaaa:2::10")).toMatchObject({
        credited: false,
      });
      expect(await signUp(s, "v6d@example.com", "2001:db8:bbbb:2::10")).toMatchObject({
        credited: true,
      });

      expect(await signUp(s, "v4a@example.com", "203.0.113.60")).toMatchObject({ credited: true });
      expect(await signUp(s, "v4b@example.com", "::ffff:203.0.113.60")).toMatchObject({
        credited: false,
      });
    });

    it("gives one welcome credit per mailbox, whatever alias or network it signs up from", async () => {
      expect(await signUp(s, "jane.doe@gmail.com", "198.51.100.71")).toMatchObject({
        credited: true,
      });
      expect(await signUp(s, "janedoe+recall@googlemail.com", "198.51.100.72")).toMatchObject({
        credited: false,
      });
      expect(await signUp(s, "jane.doe+2@example.org", "198.51.100.73")).toMatchObject({
        credited: true,
      });
      expect(await signUp(s, "jane.doe@example.org", "198.51.100.74")).toMatchObject({
        credited: false,
      });
      // Only keyed hashes are stored, never the address.
      const stored = await rows<{ email_hash: string | null }>(
        s.ctx.db,
        sql`SELECT email_hash FROM signup_credit_grants WHERE email_hash IS NOT NULL`,
      );
      expect(stored.length).toBeGreaterThan(0);
      for (const r of stored) expect(r.email_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("never makes an unknown address a network of its own", async () => {
      // A garbled forwarding header and a missing address both mean "unknown":
      // nobody is limited by them, so every sign-up is granted (subject to the daily cap).
      expect(await signUp(s, "u1@example.com", "unknown")).toMatchObject({ credited: true });
      expect(await signUp(s, "u2@example.com", "unknown")).toMatchObject({ credited: true });
      expect(await signUpDirect(s, "u3@example.com", null)).toMatchObject({ created: true });
      expect(await signUpDirect(s, "u4@example.com", null)).toMatchObject({ created: true });
      expect((await accountState(s, "u3@example.com")).credited).toBe(true);
      expect((await accountState(s, "u4@example.com")).credited).toBe(true);
      const unhashed = await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT count(*)::int AS n FROM signup_credit_grants WHERE ip_hash IS NULL`,
      );
      expect(unhashed[0]!.n).toBeGreaterThanOrEqual(4);
    });

    it("counts a grant for 30 days", async () => {
      expect(await signUp(s, "w1@example.com", "203.0.113.70")).toMatchObject({ credited: true });
      expect(await signUp(s, "w2@example.com", "203.0.113.70")).toMatchObject({ credited: false });
      await s.ctx.db.execute(sql`UPDATE signup_credit_grants SET created_at = now() - interval '29 days'
                                 WHERE created_at > now() - interval '1 hour'`);
      expect(await signUp(s, "w3@example.com", "203.0.113.70")).toMatchObject({ credited: false });
      await s.ctx.db.execute(sql`UPDATE signup_credit_grants SET created_at = now() - interval '31 days'
                                 WHERE created_at > now() - interval '30 days'`);
      expect(await signUp(s, "w4@example.com", "203.0.113.70")).toMatchObject({ credited: true });
    });

    it("keeps counting a grant after its account is deleted", async () => {
      const first = await signUp(s, "eraser@example.com", "203.0.113.80");
      expect(first.credited).toBe(true);
      await eraseAccount(s.ctx, first.accountId!);
      expect((await accountState(s, "eraser@example.com")).accountId).toBeNull();
      // Delete-and-sign-up-again, even with the same address, does not reset the limit.
      expect(await signUp(s, "eraser@example.com", "203.0.113.80")).toMatchObject({
        credited: false,
        balance: 0,
      });
    });

    it("purges grants nobody can still count, and only those", async () => {
      const ancient = "a".repeat(64);
      const recent = "b".repeat(64);
      await s.ctx.db.execute(
        sql`INSERT INTO signup_credit_grants (ip_hash, amount_micros, created_at) VALUES
            (${ancient}, 1, now() - interval '36 days'), (${recent}, 1, now() - interval '33 days')`,
      );
      await s.ctx.billing.sweep();
      const left = await rows<{ ip_hash: string }>(
        s.ctx.db,
        sql`SELECT ip_hash FROM signup_credit_grants WHERE ip_hash IN (${ancient}, ${recent})`,
      );
      expect(left.map((r) => r.ip_hash)).toEqual([recent]);
    });
  });
});

// ---------------------------------------------------------------------------
describe("daily cap", () => {
  let s: HostedServer;
  beforeAll(async () => {
    // $10 a day = two welcome credits. Every sign-up below uses its own network.
    s = await createHostedServer({ env: { RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: "10" } });
    s.ctx.log.level = "info";
  });
  afterAll(async () => {
    await s.close();
  });

  it("stops granting once the day's welcome credits reach the cap", async () => {
    const before = metrics.signupCreditSkipped.get({ reason: "daily_cap" });
    expect(await signUp(s, "c1@example.com", "192.0.2.1")).toMatchObject({ credited: true });
    expect(await signUp(s, "c2@example.com", "192.0.2.2")).toMatchObject({ credited: true });
    expect(metrics.signupCreditSkipped.get({ reason: "daily_cap" })).toBe(before);

    // Accounts are still created and usable, just without the credit.
    const third = await signUp(s, "c3@example.com", "192.0.2.3");
    expect(third.accountId).not.toBeNull();
    expect(third).toMatchObject({ credited: false, balance: 0 });
    expect(await signUp(s, "c4@example.com", "192.0.2.4")).toMatchObject({ credited: false });

    expect(metrics.signupCreditSkipped.get({ reason: "daily_cap" })).toBe(before + 2);
    expect(renderMetrics()).toContain('recall_signup_credit_skipped_total{reason="daily_cap"}');
    expect(skipLogs(s).map((l) => l.reason)).toEqual(["daily_cap", "daily_cap"]);
    expect(skipLogs(s)[0]).toMatchObject({ account: third.accountId, level: 30 });
    expect(await grants(s)).toBe(2);
  });

  it("counts sign-ups whose network is unknown", async () => {
    expect(await signUpDirect(s, "c5@example.com", null)).toMatchObject({ created: true });
    expect((await accountState(s, "c5@example.com")).credited).toBe(false);
  });

  it("starts a new day at UTC midnight", async () => {
    // Move today's grants to the last second of yesterday (UTC): they no longer count.
    await s.ctx.db.execute(
      sql`UPDATE signup_credit_grants SET created_at = ${startOfUtcDay} - interval '1 second'`,
    );
    expect(await signUp(s, "d1@example.com", "192.0.2.11")).toMatchObject({ credited: true });
    expect(await signUp(s, "d2@example.com", "192.0.2.12")).toMatchObject({ credited: true });
    expect(await signUp(s, "d3@example.com", "192.0.2.13")).toMatchObject({ credited: false });
  });

  it("holds under a burst of simultaneous sign-ups", async () => {
    await s.ctx.db.execute(
      sql`UPDATE signup_credit_grants SET created_at = ${startOfUtcDay} - interval '1 second'`,
    );
    const emails = Array.from({ length: 8 }, (_, i) => `burst${i}@example.com`);
    await Promise.all(emails.map((e, i) => signUpDirect(s, e, `burst-network-${i}`)));
    const states = await Promise.all(emails.map((e) => accountState(s, e)));
    expect(states.every((a) => a.accountId)).toBe(true);
    expect(states.filter((a) => a.credited)).toHaveLength(2);
    const [total] = await rows<{ micros: string | number }>(
      s.ctx.db,
      sql`SELECT sum(amount_micros) AS micros FROM signup_credit_grants WHERE created_at >= ${startOfUtcDay}`,
    );
    expect(Number(total!.micros)).toBe(2 * CREDIT);
  });
});

// ---------------------------------------------------------------------------
describe("limits are configurable", () => {
  let s: HostedServer;
  beforeAll(async () => {
    s = await createHostedServer({
      env: { RECALL_SIGNUP_CREDIT_PER_IP: "2", RECALL_SIGNUP_CREDIT_DAILY_CAP_USD: "0" },
    });
  });
  afterAll(async () => {
    await s.close();
  });

  it("allows RECALL_SIGNUP_CREDIT_PER_IP credits per network", async () => {
    expect(await signUp(s, "p1@example.com", "198.18.1.1")).toMatchObject({ credited: true });
    expect(await signUp(s, "p2@example.com", "198.18.1.1")).toMatchObject({ credited: true });
    expect(await signUp(s, "p3@example.com", "198.18.1.1")).toMatchObject({ credited: false });
  });

  it("has no daily cap when it is 0", async () => {
    // $60 of welcome credit in one day, over the $50 default cap.
    for (let i = 0; i < 12; i++) await signUpDirect(s, `free${i}@example.com`, `network-${i}`);
    const credited = await Promise.all(
      Array.from({ length: 12 }, (_, i) => accountState(s, `free${i}@example.com`)),
    );
    expect(credited.every((a) => a.credited)).toBe(true);
  });

  it("treats 0 as no limit in the check itself", async () => {
    const hash = "c".repeat(64);
    await s.ctx.db.execute(
      sql`INSERT INTO signup_credit_grants (ip_hash, amount_micros) SELECT ${hash}, ${CREDIT} FROM generate_series(1, 5)`,
    );
    const check = (perIp: number, dailyCapMicros: number) =>
      s.ctx.db.transaction((tx) =>
        signupCreditSkipReason(tx, { ipHash: hash, perIp, dailyCapMicros }),
      );
    expect(await check(0, 0)).toBeNull();
    expect(await check(5, 0)).toBe("ip_limit");
    expect(await check(6, 0)).toBeNull();
    expect(await check(0, 20_000_000)).toBe("daily_cap");
    expect(await check(5, 20_000_000)).toBe("ip_limit"); // the network is checked first
  });
});
