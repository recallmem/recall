import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * STRIPE_CUSTOM_DOMAIN: with a Stripe custom domain, Checkout and portal links point there, and the
 * billing forms' redirect is only followed when the dashboard's CSP form-action allows that host.
 */

const base = {
  RECALL_HOSTED: "true",
  RECALL_AUTH_ENABLED: "true",
  RECALL_AUTH_SECRET: "hosted-test-auth-secret",
  RECALL_ADMIN_TOKEN: "operator-token-0123456789abcdef",
  RECALL_DATABASE_URL: "postgres://recall@localhost/recall",
};

let s: HostedServer;
let b: Browser;

beforeAll(async () => {
  s = await createHostedServer({ env: { STRIPE_CUSTOM_DOMAIN: " Pay.Example.com " } });
  b = new Browser(s.app);
  await b.signIn(s, "domain@example.com");
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("Stripe custom domain", () => {
  it("lets the billing forms redirect to it, next to Stripe's own hosts", async () => {
    const csp = (await b.get("/app/billing")).res.headers.get("content-security-policy")!;
    const formAction = csp.split("; ").find((d) => d.startsWith("form-action"));
    expect(formAction).toBe(
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com https://pay.example.com",
    );
  });

  it("must be a host name, not a URL", () => {
    expect(
      loadConfig({ ...base, STRIPE_CUSTOM_DOMAIN: "pay.example.com" }).hosted.billing.customDomain,
    ).toBe("pay.example.com");
    for (const bad of [
      "https://pay.example.com",
      "pay.example.com/c",
      "pay example.com",
      "localhost",
    ])
      expect(() => loadConfig({ ...base, STRIPE_CUSTOM_DOMAIN: bad }), bad).toThrow(
        /STRIPE_CUSTOM_DOMAIN/,
      );
  });
});
