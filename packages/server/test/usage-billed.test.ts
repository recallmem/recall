import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { createTestServer } from "./helpers.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Usage as a customer of the hosted service sees it: what each workspace was charged and the
 * billable units behind it (message tokens learned, questions per level), never our provider cost
 * or model-level detail on the dashboard. A self-hosted server keeps showing the provider cost.
 */

let s: HostedServer;
let b: Browser;
let key: Record<string, string>;
let accountId: string;
const ws: Record<string, string> = {};

const ZERO = { questions: 0, billed_usd: 0 };

beforeAll(async () => {
  s = await createHostedServer({ env: { RECALL_OPENROUTER_LIVE_PRICES: "false" } });
  b = new Browser(s.app, "198.51.100.41");
  await b.signIn(s, "usage@example.com");
  const created = await b.createKey({ name: "k" });
  key = { authorization: `Bearer ${created.key}` };
  for (const name of ["main", "side", "quiet"]) {
    expect((await s.api("POST", "/v3/workspaces", { id: name }, key)).status).toBe(201);
  }
  for (const r of await rows<{ id: string; name: string; account_id: string }>(
    s.ctx.db,
    sql`SELECT id, name, account_id FROM workspaces WHERE name IN ('main', 'side', 'quiet')`,
  )) {
    ws[r.name] = r.id;
    accountId = r.account_id;
  }
  const billing = s.ctx.billing;
  // Learning: 2 messages in "main", one under the 50-token minimum: 50 + 199,950 = 200,000
  // billed tokens at $1 per 1M (the test price) = $0.20.
  await billing.debitIngest(s.ctx.db, {
    workspaceId: ws.main!,
    sessionId: "s1",
    messageIds: ["m1", "m2"],
    tokenCounts: [10, 199_950],
  });
  // Storage in "quiet": 100,000 tokens kept without learning at $0.25 per 1M = $0.025.
  await billing.debitStore(s.ctx.db, {
    workspaceId: ws.quiet!,
    source: "messages",
    keyIds: ["m3"],
    tokenCounts: [100_000],
  });
  // Chat in "main": two questions at low, one given back (no answer came): one charged, $0.005.
  for (const k of ["q1", "q2"]) {
    const r = await billing.reserveChat({ accountId, workspaceId: ws.main!, level: "low", key: k });
    expect(r).toBe("applied");
  }
  await billing.releaseChat({
    accountId,
    workspaceId: ws.main!,
    level: "low",
    key: "q2",
    reason: "failed",
  });
  // "side": one question at high ($0.05), answered from the cache, so no model call at all.
  await billing.reserveChat({ accountId, workspaceId: ws.side!, level: "high", key: "q3" });
  // Model calls (our cost side) in "main" and "quiet".
  for (const [w, task, cost] of [
    [ws.main!, "reasoner", 0.004],
    [ws.main!, "chat_low", 0.009],
    [ws.quiet!, "dream", 0.002],
  ] as const) {
    await s.ctx.db.execute(
      sql`INSERT INTO llm_usage (workspace_id, account_id, task, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd)
          VALUES (${w}, ${accountId}, ${task}, 'openrouter', 'acme/answer-large-1', 240, 12, 900, ${cost})`,
    );
  }
}, 60_000);
afterAll(() => s?.close());

describe("usage API on the hosted service", () => {
  it("reports what a workspace was charged, with its billable units", async () => {
    const res = await s.api("GET", "/v3/workspaces/main/usage", undefined, key);
    expect(res.status).toBe(200);
    const usage = await res.json();
    expect(usage.billed).toEqual({
      billed_usd: 0.205,
      learning: { message_tokens: 200_000, billed_usd: 0.2 },
      storage: { tokens: 0, billed_usd: 0 },
      chat: {
        questions: 1,
        billed_usd: 0.005,
        by_level: {
          minimal: ZERO,
          low: { questions: 1, billed_usd: 0.005 },
          medium: ZERO,
          high: ZERO,
          max: ZERO,
        },
      },
    });
    // Model calls are still listed, but no provider cost is shown, not even as 0.
    expect(usage.total.calls).toBe(2);
    const text = JSON.stringify(usage);
    expect(text).not.toMatch(/cost_usd|unpriced|provider|openrouter|acme/);

    const side = await (await s.api("GET", "/v3/workspaces/side/usage", undefined, key)).json();
    expect(side.total.calls).toBe(0);
    expect(side.billed.chat.by_level.high).toEqual({ questions: 1, billed_usd: 0.05 });
    expect(side.billed.billed_usd).toBe(0.05);
    // A period with no charges.
    const later = new Date(Date.now() + 60_000).toISOString();
    const none = await (
      await s.api("GET", `/v3/workspaces/main/usage?since=${later}`, undefined, key)
    ).json();
    expect(none.billed.billed_usd).toBe(0);
    expect(none.billed.learning.message_tokens).toBe(0);
  });

  it("reports the account's charges in total and per workspace", async () => {
    const usage = await (await s.api("GET", "/v3/usage", undefined, key)).json();
    expect(usage.billed.billed_usd).toBe(0.28);
    expect(usage.billed.storage).toEqual({ tokens: 100_000, billed_usd: 0.025 });
    expect(usage.billed.chat.questions).toBe(2);
    expect(usage.billed.learning.message_tokens).toBe(200_000);
    const byWs = usage.by_workspace.map(
      (w: { workspace_id: string; calls: number; billed: { billed_usd: number } }) => [
        w.workspace_id,
        w.calls,
        w.billed.billed_usd,
      ],
    );
    // Most charged first; a workspace charged without model calls, or with calls but no charge, is listed.
    expect(byWs).toEqual([
      ["main", 2, 0.205],
      ["side", 0, 0.05],
      ["quiet", 1, 0.025],
    ]);
    expect(JSON.stringify(usage)).not.toMatch(/cost_usd|unpriced|provider|openrouter|acme/);
    // The budget counts what was charged.
    expect(usage.budget.month_to_date_usd).toBeCloseTo(0.28, 6);
  });
});

describe("usage page on the hosted service", () => {
  it("shows billable units next to the charges, and no model calls or model tokens", async () => {
    const { res, html } = await b.get("/app/usage");
    expect(res.status).toBe(200);
    expect(html).toMatch(/<span class="chart-title">Charged<\/span>/);
    expect(html).toMatch(/<span class="chart-title">Questions answered<\/span>/);
    expect(html).toMatch(/<title>[A-Z][a-z]{2} \d+ · \$[\d.]+ charged<\/title>/);
    // Units by charge: learning in message tokens, chat in questions per level.
    const cells = html.replace(/ data-label="[^"]*"/g, "");
    expect(cells).toContain(
      '<td>Learning (ingest)</td><td class="num">200,000 message tokens</td><td class="num">$0.20</td>',
    );
    expect(cells).toContain(
      '<td>Chat · low</td><td class="num">1 question</td><td class="num">$0.005</td>',
    );
    expect(cells).toContain(
      '<td>Chat · high</td><td class="num">1 question</td><td class="num">$0.05</td>',
    );
    expect(cells).toContain(
      '<td>Storage</td><td class="num">100,000 tokens stored</td><td class="num">$0.03</td>',
    );
    // Sub-cent amounts keep their digits; amounts from a cent up have two decimals.
    expect(cells).toContain('<td class="num" colspan="2"><strong>$0.28</strong></td>');
    // By day: the day, tokens learned, questions answered and the charge.
    expect(cells).toMatch(
      /<td><time datetime="\d{4}-\d\d-\d\d">[A-Z][a-z]{2} \d+<\/time><\/td><td class="num">200,000<\/td><td class="num">2<\/td><td class="num">\$0.28<\/td>/,
    );
    expect(html).toContain("<th>Tokens learned</th>");
    for (const gone of ["Model calls", "Input tokens", "Output tokens", "model call"]) {
      expect(html, gone).not.toContain(gone);
    }
    expect(html).not.toMatch(/openrouter|acme|cost_usd/i);
  });

  it("shows billed units instead of model usage on the overview", async () => {
    const { html } = await b.get("/app");
    expect(html).toContain("Charges this month by task");
    expect(html).toContain("<th>Billed units</th>");
    expect(html).toContain("200,000 message tokens");
    expect(html).not.toContain("Model usage this month");
    expect(html).not.toContain("Input tokens");
  });
});

describe("usage page of an account that is not billed", () => {
  it("shows units without charges", async () => {
    const free = await createHostedServer({
      billing: false,
      env: { RECALL_SIGNUP_ENABLED: "true" },
    });
    try {
      const browser = new Browser(free.app, "198.51.100.42");
      await browser.signIn(free, "free@example.com");
      const { res, html } = await browser.get("/app/usage");
      expect(res.status).toBe(200);
      expect(html).toContain("This account is not billed.");
      expect(html).toMatch(/<span class="chart-title">Tokens learned<\/span>/);
      expect(html).not.toContain("Charged");
      expect(html).not.toContain("Model calls");

      // Its spend would be our provider cost: the overview and the usage API leave it out.
      const overview = await browser.get("/app");
      expect(overview.html).toContain("Not billed");
      expect(overview.html).not.toContain("Spend this month");
      expect(overview.html).not.toMatch(/used \(\d+%\)/);
      const key = (await browser.createKey({ name: "k" })).html.match(
        /pk_live_[A-Za-z0-9]{32}/,
      )![0];
      const usage = await free.api("GET", "/v3/usage", undefined, {
        authorization: `Bearer ${key}`,
      });
      expect(usage.status).toBe(200);
      const body = await usage.json();
      expect(body.budget).toHaveProperty("resets_at");
      expect(body.budget).not.toHaveProperty("month_to_date_usd");
      expect(body.budget).not.toHaveProperty("remaining_usd");
    } finally {
      await free.close();
    }
  });
});

describe("usage API on a self-hosted server", () => {
  it("keeps the provider cost and has no charges", async () => {
    const plain = await createTestServer();
    try {
      expect((await plain.request("POST", "/v3/workspaces", { id: "w" })).status).toBe(201);
      const [w] = await rows<{ id: string }>(
        plain.ctx.db,
        sql`SELECT id FROM workspaces WHERE name = 'w'`,
      );
      await plain.ctx.db.execute(
        sql`INSERT INTO llm_usage (workspace_id, task, provider, model, input_tokens, cost_usd)
            VALUES (${w!.id}, 'chat_low', 'openrouter', 'acme/answer-large-1', 100, 0.001)`,
      );
      const usage = (await (await plain.request("GET", "/v3/workspaces/w/usage")).json()) as Record<
        string,
        unknown
      > & { total: { cost_usd: number } };
      expect(usage.total.cost_usd).toBe(0.001);
      expect(usage).not.toHaveProperty("billed");
      const account = (await (await plain.request("GET", "/v3/usage")).json()) as Record<
        string,
        unknown
      >;
      expect(account).not.toHaveProperty("billed");
    } finally {
      await plain.close();
    }
  });
});
