import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { labelString } from "../src/lib/metrics.js";
import { drainQueue } from "../src/queue/worker.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";
import { createHostedServer } from "./hosted-helpers.js";

/** GET /metrics: Prometheus text format, route-pattern labels, queue/LLM/ledger series, auth. */

const TOKEN = "metrics-token-0123456789";

/** The value of one sample line, or undefined. */
function sample(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (want.every((w) => line.includes(w))) return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return undefined;
}

describe("/metrics (self-hosted)", () => {
  let s: ApiServer;
  beforeAll(async () => {
    s = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "0" });
  });
  afterAll(() => s.close());

  it("is open without a token and reports HTTP, LLM and queue series", async () => {
    await s.request("POST", "/v3/workspaces", { id: "w" });
    await s.request("POST", "/v3/workspaces/w/peers", { id: "p" });
    await s.request("POST", "/v3/workspaces/w/sessions", { id: "s", peers: { p: {} } });
    await s.request("POST", "/v3/workspaces/w/sessions/s/messages", {
      messages: [{ peer_id: "p", content: "I ride my bicycle to the office every day." }],
    });
    await drainQueue(s.ctx);
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers/p/chat", { query: "how do I commute?" }))
        .status,
    ).toBe(200);
    // A job that cannot run: counted as a final failure.
    await s.ctx.db.execute(sql`INSERT INTO jobs (kind, work_key) VALUES ('bogus', 'bogus:1')`);
    await drainQueue(s.ctx);

    const res = await s.app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const text = await res.text();
    expect(text).toContain("# TYPE recall_http_requests_total counter");
    expect(text).toContain("# TYPE recall_http_request_duration_seconds histogram");
    // Route patterns, not raw paths (bounded cardinality).
    expect(
      sample(text, "recall_http_requests_total", {
        method: "POST",
        route: "/v3/workspaces/:workspace_id/peers/:peer_id/chat",
        status: "200",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain('route="/v3/workspaces/w/peers/p/chat"');
    expect(
      sample(text, "recall_http_request_duration_seconds_count", {
        route: "/v3/workspaces/:workspace_id/peers/:peer_id/chat",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(sample(text, "recall_llm_calls_total", { task: "reasoner" })).toBeGreaterThanOrEqual(1);
    expect(
      sample(text, "recall_llm_tokens_total", { task: "reasoner", type: "input" }),
    ).toBeGreaterThan(0);
    expect(sample(text, "recall_job_failures_total", { kind: "bogus", final: "true" })).toBe(1);
    expect(sample(text, "recall_queue_jobs", { kind: "bogus", status: "failed" })).toBe(1);
    expect(text).toContain("# TYPE recall_queue_due_jobs gauge");
    expect(sample(text, "recall_queue_budget_paused_jobs")).toBe(0);
    expect(sample(text, "process_resident_memory_bytes")).toBeGreaterThan(0);
    // Unknown paths are one series.
    await s.request("GET", "/no/such/path/123");
    const again = await (await s.app.request("/metrics")).text();
    expect(
      sample(again, "recall_http_requests_total", { route: "unmatched", status: "404" }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("requires the token when one is configured", async () => {
    const t = await createTestServer({ RECALL_METRICS_TOKEN: TOKEN });
    try {
      expect((await t.app.request("/metrics")).status).toBe(401);
      expect(
        (
          await t.app.request("/metrics", {
            headers: { authorization: "Bearer wrong-token-000000" },
          })
        ).status,
      ).toBe(401);
      const ok = await t.app.request("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe("/metrics (hosted)", () => {
  it("is off without a token, and reports ledger and billing series with one", async () => {
    const off = await createHostedServer();
    try {
      expect((await off.app.request("/metrics")).status).toBe(404);
    } finally {
      await off.close();
    }
    const on = await createHostedServer({ env: { RECALL_METRICS_TOKEN: TOKEN } });
    try {
      const acct = await on.api(
        "POST",
        "/admin/v1/accounts",
        { name: "m" },
        {
          authorization: "Bearer operator-token-0123456789abcdef",
        },
      );
      const { id } = await acct.json();
      await on.ctx.billing.grant(id, 2_500_000, "metrics-grant", null);
      const text = await (
        await on.app.request("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } })
      ).text();
      expect(
        sample(text, "recall_ledger_credits_usd_total", { kind: "grant" }),
      ).toBeGreaterThanOrEqual(2.5);
      expect(
        sample(text, "recall_ledger_entries_total", { kind: "grant", direction: "credit" }),
      ).toBeGreaterThanOrEqual(1);
      expect(sample(text, "recall_billing_accounts")).toBe(1);
      expect(sample(text, "recall_billing_outstanding_credit_usd")).toBe(2.5);
    } finally {
      await on.close();
    }
  });

  it("escapes label values", () => {
    expect(labelString({ a: 'x"y\\z\n' })).toBe('{a="x\\"y\\\\z\\n"}');
  });
});
