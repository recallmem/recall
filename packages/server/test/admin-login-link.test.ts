import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { LlmError } from "../src/llm/types.js";
import { ADMIN, Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

let s: HostedServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const admin = { authorization: `Bearer ${ADMIN}` };

describe("admin sign-in links", () => {
  it("makes an address owner of an account and signs it in with the link", async () => {
    s = await createHostedServer({ env: { RECALL_SIGNUP_ENABLED: "false" } });
    const acct = await (await s.api("POST", "/admin/v1/accounts", { name: "acme" }, admin)).json();
    const res = await s.api(
      "POST",
      "/admin/v1/login-links",
      { email: "Owner@Example.com", account_id: acct.id },
      admin,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ email: "owner@example.com", account_id: acct.id });
    expect(body.expires_in_seconds).toBe(900);

    const b = new Browser(s.app);
    const u = new URL(body.url);
    await b.get(`${u.pathname}${u.search}`);
    const done = await b.post("/app/auth/verify", { token: u.searchParams.get("token")! });
    expect(done.res.status).toBe(303);
    expect((await b.get("/app")).html).toContain("acme");
    // Operator-made accounts hold no credit balance: free, and the billing page says so.
    expect((await b.get("/app/billing")).html).toContain("This account is not billed");
  });

  it("needs the operator token and a known account", async () => {
    s = await createHostedServer();
    expect((await s.api("POST", "/admin/v1/login-links", { email: "a@b.co" })).status).toBe(401);
    const missing = await s.api(
      "POST",
      "/admin/v1/login-links",
      { email: "a@b.co", account_id: "acct_nope" },
      admin,
    );
    expect(missing.status).toBe(404);
  });
});

describe("startup without a model key", () => {
  it("starts with a pinned provider and fails model calls with a clear error", async () => {
    const config = loadConfig({ RECALL_DEFAULT_PROVIDER: "openai", RECALL_DATA_DIR: "memory" });
    expect(config.models.chat_low).toBe("openai/gpt-6-luna");
    expect(config.embedding.model).toBe("openai/text-embedding-3-small");
    const ctx = await createContext(config);
    try {
      const err = await ctx.embeddings.embed(["hello"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe("config");
      expect(String((err as Error).message)).toContain("missing API key");
    } finally {
      await ctx.close();
    }
  });
});
