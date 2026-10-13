import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { hashPassword, verifyPassword } from "../src/lib/passwords.js";
import { ADMIN, Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Password sign-in for the one app-directory reviewer (RECALL_REVIEWER_*): directory reviews
 * need a login without email links. Everyone else keeps signing in with an email link.
 */

const EMAIL = "review@recallmem.test";
const PASSWORD = "correct horse battery staple 42";
const admin = { authorization: `Bearer ${ADMIN}` };

let s: HostedServer;

beforeAll(async () => {
  s = await createHostedServer({
    env: {
      RECALL_SIGNUP_ENABLED: "false",
      RECALL_REVIEWER_EMAIL: "Review@RecallMem.test",
      RECALL_REVIEWER_PASSWORD_HASH: hashPassword(PASSWORD, 1024),
    },
  });
  // The reviewer account exists before review (made by the operator).
  const acct = await (
    await s.api("POST", "/admin/v1/accounts", { name: "Directory review" }, admin)
  ).json();
  const link = await s.api(
    "POST",
    "/admin/v1/login-links",
    { email: EMAIL, account_id: acct.id },
    admin,
  );
  expect(link.status).toBe(201);
}, 60_000);
afterAll(async () => {
  await s.close();
});

const signInWith = async (b: Browser, email: string, password: string, next?: string) => {
  await b.get(`/app/login/password${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  return b.post("/app/login/password", { email, password, ...(next ? { next } : {}) });
};

describe("reviewer password sign-in", () => {
  it("hashes and checks passwords, refusing malformed hashes", () => {
    const h = hashPassword("a long enough password", 1024);
    expect(verifyPassword("a long enough password", h)).toBe(true);
    expect(verifyPassword("a long enough passworD", h)).toBe(false);
    expect(verifyPassword("x", "scrypt$1000$AAAA$AAAA")).toBe(false);
    expect(verifyPassword("x", "plain")).toBe(false);
  });

  it("signs the reviewer in with the right password, and only then", async () => {
    const b = new Browser(s.app);
    const wrong = await signInWith(b, EMAIL, "not the password at all");
    expect(wrong.res.status).toBe(401);
    expect(wrong.html).toContain("do not match");
    const other = await signInWith(b, "someone@recallmem.test", PASSWORD);
    expect(other.res.status).toBe(401);
    const ok = await signInWith(b, EMAIL, PASSWORD);
    expect(ok.res.status).toBe(303);
    expect((await b.get("/app")).html).toContain("Directory review");
  });

  it("continues an app connection (OAuth) after signing in, and nowhere else", async () => {
    const next = "/oauth/authorize?client_id=c1&response_type=code";
    const b = new Browser(s.app);
    const login = await b.get(`/app/login?next=${encodeURIComponent(next)}`);
    expect(login.html).toContain("App directory reviewer? Sign in with a password");
    const ok = await signInWith(b, EMAIL, PASSWORD, next);
    expect(ok.res.headers.get("location")).toBe(next);
    const b2 = new Browser(s.app);
    const offsite = await signInWith(b2, EMAIL, PASSWORD, "https://evil.example/");
    expect(offsite.res.headers.get("location")).toBe("/app");
  });

  it("throttles repeated failures", async () => {
    const b = new Browser(s.app);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await signInWith(b, EMAIL, `wrong ${i}`)).res.status;
    expect(last).toBe(429);
  });

  it("does not exist unless configured, and needs both settings", async () => {
    const plain = await createHostedServer();
    try {
      const b = new Browser(plain.app);
      expect((await b.get("/app/login/password")).res.status).toBe(404);
      expect((await b.get("/app/login")).html).not.toContain("Sign in with a password");
    } finally {
      await plain.close();
    }
    const base = {
      RECALL_HOSTED: "true",
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: "hosted-test-auth-secret",
      RECALL_ADMIN_TOKEN: "operator-token-0123456789abcdef",
      RECALL_DATABASE_URL: "postgres://recall@localhost/recall",
    };
    expect(() => loadConfig({ ...base, RECALL_REVIEWER_EMAIL: EMAIL })).toThrow(/RECALL_REVIEWER/);
    expect(() =>
      loadConfig({ ...base, RECALL_REVIEWER_EMAIL: EMAIL, RECALL_REVIEWER_PASSWORD_HASH: "plain" }),
    ).toThrow(/RECALL_REVIEWER_PASSWORD_HASH/);
  });
});
