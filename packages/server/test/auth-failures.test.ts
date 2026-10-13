import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/lib/ratelimit.js";
import { ADMIN, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Failure budgets: bad credentials from a shared network are throttled without locking out the
 * valid keys used there, and a flood of new keys cannot empty the budgets being enforced.
 */

let s: HostedServer;
let key: string;
const from = (ip: string, token: string) =>
  s.app.request("/v3/workspaces/list", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: "{}",
  });
const junk = (i: number) => `pk_live_${String(i).padStart(32, "x")}`;

beforeAll(async () => {
  s = await createHostedServer({ billing: false, env: { RECALL_AUTH_FAILURE_LIMIT: "5" } });
  const op = { authorization: `Bearer ${ADMIN}` };
  const acct = await (await s.api("POST", "/admin/v1/accounts", { name: "shared-nat" }, op)).json();
  key = (await (await s.api("POST", `/admin/v1/accounts/${acct.id}/keys`, {}, op)).json()).key;
}, 60_000);
afterAll(async () => {
  await s.close();
});

describe("failure budgets", () => {
  it("throttles bad keys from a network but still lets a valid key from it in", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await from("203.0.113.9", junk(i))).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    expect((await from("203.0.113.9", key)).status).toBe(200);
  });

  it("keeps a fail-closed budget when flooded with new keys", () => {
    const l = new RateLimiter(3, { failClosed: true });
    const now = 1_000_000;
    // Spend the budget of the network under attack.
    for (let i = 0; i < 2; i++) l.take("victim", 2, now);
    expect(l.peek("victim", 2, now)).toBeGreaterThan(0);
    // Flood with new keys: none of them may push the spent budget out.
    for (let i = 0; i < 100; i++) l.take(`flood-${i}`, 2, now + 1);
    expect(l.peek("victim", 2, now + 2)).toBeGreaterThan(0);
  });

  it("evicts the least recently used bucket when an ordinary limiter is full", () => {
    const l = new RateLimiter(10);
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) l.take(`k${i}`, 1, now);
    l.take("k0", 1, now + 1); // k0 is now the most recently used (and spent)
    l.take("new", 1, now + 2); // evicts the oldest: k1, not k0
    expect(l.peek("k0", 1, now + 3)).toBeGreaterThan(0);
  });
});
