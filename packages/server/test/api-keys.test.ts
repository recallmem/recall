import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthStart } from "../src/core/accounts.js";
import { ApiKeyVerifier, generateApiKey, hashApiKey, revokeApiKey } from "../src/core/apikeys.js";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { RateLimiter } from "../src/lib/ratelimit.js";
import { enqueue } from "../src/queue/enqueue.js";
import { drainQueue } from "../src/queue/worker.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

const SECRET = "keys-jwt-secret";
const ADMIN = "operator-token-0123456789abcdef";
const op = { authorization: `Bearer ${ADMIN}` };
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function json(res: ApiResponse | Promise<ApiResponse>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

const ENV = {
  RECALL_AUTH_ENABLED: "true",
  RECALL_AUTH_SECRET: SECRET,
  RECALL_ADMIN_TOKEN: ADMIN,
};

describe("api keys: format, storage and lifecycle", () => {
  let s: ApiServer;
  let account: string;
  beforeAll(async () => {
    s = await createTestServer(ENV);
    account = (await json(s.request("POST", "/admin/v1/accounts", { name: "Acme" }, op), 201)).id;
  });
  afterAll(() => s.close());

  it("generates pk_live_/pk_test_ keys and stores only a SHA-256 and a display prefix", async () => {
    const g = generateApiKey("test");
    expect(g.key).toMatch(/^pk_test_[A-Za-z0-9]{32}$/);
    expect(g.prefix).toBe(g.key.slice(0, 12));
    expect(g.hash).toBe(hashApiKey(g.key));
    expect(generateApiKey().key).toMatch(/^pk_live_[A-Za-z0-9]{32}$/);

    const created = await json(
      s.request(
        "POST",
        `/admin/v1/accounts/${account}/keys`,
        { name: "ci", workspace_id: "w", rate_limit_per_min: 100 },
        op,
      ),
      201,
    );
    expect(created.key).toMatch(/^pk_live_/);
    expect(created).toMatchObject({
      account_id: account,
      name: "ci",
      mode: "live",
      prefix: created.key.slice(0, 12),
      scope: { workspace_id: "w", peer_id: null, session_id: null },
      admin: false,
      rate_limit_per_min: 100,
      revoked_at: null,
    });
    const [stored] = await rows<Record<string, unknown>>(
      s.ctx.db,
      sql`SELECT * FROM api_keys WHERE id = ${created.id}`,
    );
    expect(stored!.key_hash).toBe(hashApiKey(created.key));
    expect(JSON.stringify(stored)).not.toContain(created.key);

    const listed = await json(
      s.request("GET", `/admin/v1/accounts/${account}/keys`, undefined, op),
    );
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(listed.items.find((k: { id: string }) => k.id === created.id).prefix).toBe(
      created.prefix,
    );

    const test = await json(
      s.request("POST", `/admin/v1/accounts/${account}/keys`, { mode: "test" }, op),
      201,
    );
    expect(test.key).toMatch(/^pk_test_/);
    expect(test.admin).toBe(true);
  });

  it("validates key scope like the JWT claims", async () => {
    const bad = await s.request(
      "POST",
      `/admin/v1/accounts/${account}/keys`,
      { peer_id: "alice" },
      op,
    );
    expect(bad.status).toBe(422);
    const past = await s.request(
      "POST",
      `/admin/v1/accounts/${account}/keys`,
      { workspace_id: "w", expires_at: "2001-01-01T00:00:00Z" },
      op,
    );
    expect(past.status).toBe(422);
    expect((await s.request("POST", "/admin/v1/accounts/acct_nope/keys", {}, op)).status).toBe(404);
  });

  it("authenticates, records last use, and rejects unknown, revoked and expired keys with 401", async () => {
    const k = await json(s.request("POST", `/admin/v1/accounts/${account}/keys`, {}, op), 201);
    expect((await s.request("POST", "/v3/workspaces/list", {}, bearer(k.key))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const [used] = await rows<{ last_used_at: Date | null }>(
      s.ctx.db,
      sql`SELECT last_used_at FROM api_keys WHERE id = ${k.id}`,
    );
    expect(used!.last_used_at).not.toBeNull();

    const unknown = await s.request(
      "POST",
      "/v3/workspaces/list",
      {},
      bearer(generateApiKey().key),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ detail: "Invalid API key" });

    // revocation lands immediately in this process (and within the cache TTL elsewhere)
    const revoked = await json(s.request("DELETE", `/admin/v1/keys/${k.id}`, undefined, op));
    expect(revoked.revoked_at).not.toBeNull();
    const after = await s.request("POST", "/v3/workspaces/list", {}, bearer(k.key));
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ detail: "API key revoked" });

    const soon = await json(
      s.request(
        "POST",
        `/admin/v1/accounts/${account}/keys`,
        { expires_at: new Date(Date.now() + 60_000).toISOString() },
        op,
      ),
      201,
    );
    await s.ctx.db.execute(
      sql`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = ${soon.id}`,
    );
    s.ctx.tenancy.keys.forget(soon.id);
    const expired = await s.request("POST", "/v3/workspaces/list", {}, bearer(soon.key));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ detail: "API key expired" });
  });

  it("another process sees a revocation once its cache entry expires (seconds)", async () => {
    const k = await json(s.request("POST", `/admin/v1/accounts/${account}/keys`, {}, op), 201);
    const other = new ApiKeyVerifier(s.ctx.db, 5_000); // a second API machine
    const t0 = Date.now();
    await other.verify(k.key, t0);
    await json(s.request("DELETE", `/admin/v1/keys/${k.id}`, undefined, op));
    await expect(other.verify(k.key, t0 + 1_000)).resolves.toMatchObject({ id: k.id });
    await expect(other.verify(k.key, t0 + 5_001)).rejects.toMatchObject({ status: 401 });
  });
});

describe("api keys: authorization parity with JWT claims", () => {
  let s: ApiServer;
  let account: string;
  beforeAll(async () => {
    s = await createTestServer(ENV);
    account = (await json(s.request("POST", "/admin/v1/accounts", { name: "Acme" }, op), 201)).id;
    const admin = (await json(s.request("POST", `/admin/v1/accounts/${account}/keys`, {}, op), 201))
      .key;
    // identical data in the default account (JWT) and the hosted account (API key)
    for (const auth of [bearer(signToken({ ad: true }, SECRET)), bearer(admin)]) {
      for (const sid of ["s1", "s2"]) {
        await json(
          s.request(
            "POST",
            `/v3/workspaces/w/sessions/${sid}/messages`,
            { messages: [{ peer_id: "alice", content: "I like tea" }] },
            auth,
          ),
          201,
        );
      }
      await json(s.request("POST", "/v3/workspaces/w/sessions/s2/peers", { bob: {} }, auth));
    }
  });
  afterAll(() => s.close());

  const SCOPES: Record<string, { w?: string; p?: string; s?: string }> = {
    workspace: { w: "w" },
    otherWorkspace: { w: "x" },
    peer: { w: "w", p: "alice" },
    otherPeer: { w: "w", p: "bob" },
    session: { w: "w", s: "s1" },
  };
  const ROUTES: [string, string, unknown?][] = [
    ["POST", "/v3/workspaces/list", {}],
    ["POST", "/v3/workspaces", { id: "w" }],
    ["POST", "/v3/workspaces/w/peers/list", {}],
    ["POST", "/v3/workspaces/w/peers", { id: "alice" }],
    ["POST", "/v3/workspaces/w/peers", { id: "carol" }],
    ["GET", "/v3/workspaces/w/peers/alice/card"],
    ["POST", "/v3/workspaces/w/sessions/list", {}],
    ["POST", "/v3/workspaces/w/sessions", { id: "s1" }],
    ["POST", "/v3/workspaces/w/sessions/s1/messages/list", {}],
    ["POST", "/v3/workspaces/w/sessions/s2/messages/list", {}],
    ["GET", "/v3/workspaces/w/sessions/s1/context"],
    ["GET", "/v3/workspaces/w/sessions/s2/context"],
    ["POST", "/v3/workspaces/w/sessions/s1/search", { query: "tea" }],
    ["POST", "/v3/workspaces/w/search", { query: "tea" }],
    ["POST", "/v3/workspaces/w/peers/alice/search", { query: "tea" }],
    ["GET", "/v3/workspaces/w/queue/status"],
    ["POST", "/v3/keys?workspace_id=w"],
  ];

  it("every scope gets the same status code from a JWT and from an API key", async () => {
    const mismatches: string[] = [];
    for (const [label, claims] of Object.entries(SCOPES)) {
      const jwt = bearer(signToken(claims, SECRET));
      const key = (
        await json(
          s.request(
            "POST",
            `/admin/v1/accounts/${account}/keys`,
            { workspace_id: claims.w, peer_id: claims.p ?? null, session_id: claims.s ?? null },
            op,
          ),
          201,
        )
      ).key;
      for (const [method, path, body] of ROUTES) {
        const a = await s.request(method, path, body, jwt);
        const b = await s.request(method, path, body, bearer(key));
        if (a.status !== b.status)
          mismatches.push(`${label} ${method} ${path}: jwt ${a.status} key ${b.status}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("denials are 401 (never 403) for keys too", async () => {
    const key = (
      await json(
        s.request(
          "POST",
          `/admin/v1/accounts/${account}/keys`,
          { workspace_id: "w", peer_id: "alice" },
          op,
        ),
        201,
      )
    ).key;
    const res = await s.request("POST", "/v3/workspaces/w/sessions/list", {}, bearer(key));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "JWT not permissioned for this resource" });
  });
});

describe("POST /v3/keys with an account-admin API key", () => {
  let s: ApiServer;
  let account: string;
  let adminKey: string;
  beforeAll(async () => {
    s = await createTestServer(ENV);
    account = (await json(s.request("POST", "/admin/v1/accounts", { name: "Acme" }, op), 201)).id;
    adminKey = (
      await json(s.request("POST", `/admin/v1/accounts/${account}/keys`, { mode: "test" }, op), 201)
    ).key;
  });
  afterAll(() => s.close());

  it("mints a scoped API key for the same account, in the caller's mode", async () => {
    const minted = await json(
      s.request("POST", "/v3/keys?workspace_id=w&peer_id=alice", undefined, bearer(adminKey)),
    );
    expect(minted.key).toMatch(/^pk_test_/);
    const [row] = await rows<{ account_id: string; workspace: string; peer: string }>(
      s.ctx.db,
      sql`SELECT account_id, workspace, peer FROM api_keys WHERE key_hash = ${hashApiKey(minted.key)}`,
    );
    expect(row).toEqual({ account_id: account, workspace: "w", peer: "alice" });
    // the minted key works within its scope only
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers", { id: "alice" }, bearer(minted.key)))
        .status,
    ).toBe(201);
    expect(
      (await s.request("GET", "/v3/workspaces/w/peers/alice/card", undefined, bearer(minted.key)))
        .status,
    ).toBe(200);
    expect(
      (await s.request("POST", "/v3/workspaces/w/sessions/list", {}, bearer(minted.key))).status,
    ).toBe(401);
    // a scoped key cannot mint, and admin keys are never minted
    expect(
      (await s.request("POST", "/v3/keys?workspace_id=w", undefined, bearer(minted.key))).status,
    ).toBe(401);
    expect((await s.request("POST", "/v3/keys", undefined, bearer(adminKey))).status).toBe(422);
  });

  it("revokes the keys a key minted when that key is revoked", async () => {
    const parent = await json(
      s.request("POST", `/admin/v1/accounts/${account}/keys`, { mode: "test" }, op),
      201,
    );
    const child = await json(
      s.request("POST", "/v3/keys?workspace_id=w", undefined, bearer(parent.key)),
    );
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers", { id: "bob" }, bearer(child.key))).status,
    ).toBe(201);
    const [p] = await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM api_keys WHERE key_hash = ${hashApiKey(parent.key)}`,
    );
    await revokeApiKey(s.ctx.db, p!.id);
    s.ctx.tenancy.keys.forgetAccount(account);
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers", { id: "carol" }, bearer(child.key)))
        .status,
    ).toBe(401);
  });

  it("still mints JWTs for JWT callers (self-hosted behaviour)", async () => {
    const res = await json(
      s.request(
        "POST",
        "/v3/keys?workspace_id=w",
        undefined,
        bearer(signToken({ ad: true }, SECRET)),
      ),
    );
    expect(res.key.split(".")).toHaveLength(3);
  });
});

describe("rate limiting", () => {
  it("token bucket: bursts to the limit, then refills at limit/60 per second", () => {
    const rl = new RateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rl.take("k", 3, t)).toBe(0);
    const wait = rl.take("k", 3, t);
    expect(wait).toBeCloseTo(20, 5); // 1 token / (3/60 per s)
    expect(rl.take("k", 3, t + 20_000)).toBe(0);
    expect(rl.take("other", 3, t)).toBe(0);
    expect(rl.take("k", 0, t)).toBe(0); // 0 = unlimited
  });

  it("answers 429 with Retry-After and a detail body once a key's limit is used up", async () => {
    const s = await createTestServer(ENV);
    try {
      const account = (await json(s.request("POST", "/admin/v1/accounts", { name: "A" }, op), 201))
        .id;
      const k = await json(
        s.request("POST", `/admin/v1/accounts/${account}/keys`, { rate_limit_per_min: 2 }, op),
        201,
      );
      const other = await json(
        s.request("POST", `/admin/v1/accounts/${account}/keys`, {}, op),
        201,
      );
      for (let i = 0; i < 2; i++)
        expect((await s.request("POST", "/v3/workspaces/list", {}, bearer(k.key))).status).toBe(
          200,
        );
      const limited = await s.request("POST", "/v3/workspaces/list", {}, bearer(k.key));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect((await limited.json()).detail).toMatch(/Rate limit exceeded/);
      // limits are per key
      expect((await s.request("POST", "/v3/workspaces/list", {}, bearer(other.key))).status).toBe(
        200,
      );
    } finally {
      await s.close();
    }
  });
});

describe("admin control plane", () => {
  it("is off (404) without RECALL_ADMIN_TOKEN and rejects a wrong token with 401", async () => {
    const off = await createTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: SECRET,
    });
    try {
      expect((await off.request("GET", "/admin/v1/accounts", undefined, op)).status).toBe(404);
    } finally {
      await off.close();
    }
    const s = await createTestServer(ENV);
    try {
      expect((await s.request("GET", "/admin/v1/accounts")).status).toBe(401);
      expect(
        (await s.request("GET", "/admin/v1/accounts", undefined, bearer(`${ADMIN}x`))).status,
      ).toBe(401);
      // a customer's admin key or the admin JWT is not the operator token
      expect(
        (
          await s.request(
            "GET",
            "/admin/v1/accounts",
            undefined,
            bearer(signToken({ ad: true }, SECRET)),
          )
        ).status,
      ).toBe(401);
      const list = await json(s.request("GET", "/admin/v1/accounts", undefined, op));
      expect(list.items.map((a: { id: string }) => a.id)).toEqual(["default"]);
    } finally {
      await s.close();
    }
  });

  it("creates, reads, updates and lists accounts; usage per account", async () => {
    const s = await createTestServer(ENV);
    try {
      const a = await json(
        s.request("POST", "/admin/v1/accounts", { name: "Acme", monthly_budget_usd: 25 }, op),
        201,
      );
      expect(a).toMatchObject({ name: "Acme", monthly_budget_usd: 25 });
      expect(a.id).toMatch(/^acct_/);
      expect(a.webhook_secret).toMatch(/^whsec_/);
      const got = await json(s.request("GET", `/admin/v1/accounts/${a.id}`, undefined, op));
      expect(got.webhook_secret).toBe(a.webhook_secret);
      const patched = await json(
        s.request(
          "PATCH",
          `/admin/v1/accounts/${a.id}`,
          { monthly_budget_usd: null, name: "Acme BV" },
          op,
        ),
      );
      expect(patched).toMatchObject({ name: "Acme BV", monthly_budget_usd: null });
      expect(patched.webhook_secret).toBeUndefined();
      const rotated = await json(
        s.request("PATCH", `/admin/v1/accounts/${a.id}`, { rotate_webhook_secret: true }, op),
      );
      expect(rotated.webhook_secret).toMatch(/^whsec_/);
      expect(rotated.webhook_secret).not.toBe(a.webhook_secret);
      const list = await json(s.request("GET", "/admin/v1/accounts", undefined, op));
      expect(list.items.map((x: { id: string }) => x.id)).toEqual(["default", a.id]);
      expect(JSON.stringify(list)).not.toContain("whsec_");
      const usage = await json(s.request("GET", `/admin/v1/accounts/${a.id}/usage`, undefined, op));
      expect(usage.total).toEqual({ calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
      expect((await s.request("GET", "/admin/v1/accounts/acct_nope", undefined, op)).status).toBe(
        404,
      );
    } finally {
      await s.close();
    }
  });
});

describe("spend caps and account usage", () => {
  let s: ApiServer;
  let account: string;
  let key: Record<string, string>;
  let wsId: string;
  beforeAll(async () => {
    s = await createTestServer({
      ...ENV,
      RECALL_BUDGET_CACHE_TTL_MS: "0",
      RECALL_REASONER_MAX_DELAY_MS: "0",
    });
    account = (
      await json(
        s.request("POST", "/admin/v1/accounts", { name: "Capped", monthly_budget_usd: 1 }, op),
        201,
      )
    ).id;
    key = bearer(
      (await json(s.request("POST", `/admin/v1/accounts/${account}/keys`, {}, op), 201)).key,
    );
    await json(
      s.request(
        "POST",
        "/v3/workspaces/w/sessions/s/messages",
        { messages: [{ peer_id: "alice", content: "I live in Utrecht" }] },
        key,
      ),
      201,
    );
    await drainQueue(s.ctx);
    wsId = (
      await rows<{ id: string }>(
        s.ctx.db,
        sql`SELECT id FROM workspaces WHERE account_id = ${account} AND name = 'w'`,
      )
    )[0]!.id;
  });
  afterAll(() => s.close());

  const spend = (usd: number, at = new Date()) =>
    s.ctx.db.execute(
      sql`INSERT INTO llm_usage (workspace_id, account_id, task, provider, model, input_tokens, cost_usd, created_at)
          VALUES (${wsId}, ${account}, 'chat_low', 'mock', 'm', 1000, ${usd}, ${at})`,
    );
  const chat = () =>
    s.request("POST", "/v3/workspaces/w/peers/alice/chat", { query: "where does alice live" }, key);

  it("GET /v3/usage reports the account's month by workspace and task, for admin keys only", async () => {
    await spend(0.25);
    await spend(5, new Date(monthStart().getTime() - 86_400_000)); // last month: not counted
    const usage = await json(s.request("GET", "/v3/usage", undefined, key));
    expect(usage.account_id).toBe(account);
    expect(usage.total.cost_usd).toBeCloseTo(0.25 + 0, 2);
    expect(
      usage.by_workspace.find((x: { workspace_id: string }) => x.workspace_id === "w"),
    ).toBeTruthy();
    expect(usage.by_task.chat_low.cost_usd).toBeCloseTo(0.25, 5);
    expect(usage.budget).toMatchObject({ monthly_budget_usd: 1, exceeded: false });
    expect(usage.budget.month_to_date_usd).toBeCloseTo(0.25, 5);
    const scoped = (
      await json(
        s.request("POST", `/admin/v1/accounts/${account}/keys`, { workspace_id: "w" }, op),
        201,
      )
    ).key;
    expect((await s.request("GET", "/v3/usage", undefined, bearer(scoped))).status).toBe(401);
  });

  it("returns 402 for chat and pauses background reasoning once the month's budget is spent", async () => {
    expect((await chat()).status).toBe(200);
    await spend(1);
    const blocked = await chat();
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({ detail: "Monthly budget exceeded" });

    // background work for the account is rescheduled, never dropped or failed
    await json(
      s.request(
        "POST",
        "/v3/workspaces/w/sessions/s/messages",
        { messages: [{ peer_id: "alice", content: "I work at Acme" }] },
        key,
      ),
      201,
    );
    await enqueue(s.ctx.db, {
      kind: "dream",
      workKey: `dream:test:${wsId}`,
      workspaceId: wsId,
      payload: {},
    });
    await drainQueue(s.ctx);
    const paused = await rows<{
      kind: string;
      status: string;
      attempts: number;
      later: boolean;
      by_budget: boolean;
    }>(
      s.ctx.db,
      sql`SELECT kind, status, attempts, run_after > now() AS later,
                 payload ? 'budget_paused_at' AS by_budget
          FROM jobs WHERE workspace_id = ${wsId} AND status <> 'done' ORDER BY id`,
    );
    expect(paused.map((j) => j.kind).sort()).toEqual(["dream", "reason"]);
    for (const j of paused)
      expect(j).toMatchObject({ status: "pending", attempts: 0, later: true, by_budget: true });

    // another account is not affected
    const other = await json(s.request("POST", "/admin/v1/accounts", { name: "Free" }, op), 201);
    const otherKey = bearer(
      (await json(s.request("POST", `/admin/v1/accounts/${other.id}/keys`, {}, op), 201)).key,
    );
    // Chat reads and never creates, so the other account's peer is made first.
    await json(s.request("POST", "/v3/workspaces/w/peers", { id: "alice" }, otherKey), 201);
    expect(
      (await s.request("POST", "/v3/workspaces/w/peers/alice/chat", { query: "hi" }, otherKey))
        .status,
    ).toBe(200);

    // raising the budget resumes everything
    await json(
      s.request("PATCH", `/admin/v1/accounts/${account}`, { monthly_budget_usd: 100 }, op),
    );
    expect((await chat()).status).toBe(200);
    await s.ctx.db.execute(
      sql`UPDATE jobs SET run_after = now() WHERE workspace_id = ${wsId} AND status = 'pending'`,
    );
    await drainQueue(s.ctx);
    const left = await rows<{ kind: string; status: string; last_error: string | null }>(
      s.ctx.db,
      sql`SELECT kind, status, last_error FROM jobs WHERE workspace_id = ${wsId} AND status <> 'done'`,
    );
    expect(left).toEqual([]);
  });

  it("keeps the month's spend when a workspace is deleted", async () => {
    const before = (await json(s.request("GET", "/v3/usage", undefined, key))).budget
      .month_to_date_usd;
    const { handleDeleteWorkspace } = await import("../src/core/jobs.js");
    await handleDeleteWorkspace(s.ctx, {
      id: 0,
      kind: "delete_workspace",
      workKey: "x",
      workspaceId: wsId,
      sessionId: null,
      payload: {},
      attempts: 1,
    });
    const after = (await json(s.request("GET", "/v3/usage", undefined, key))).budget
      .month_to_date_usd;
    expect(after).toBeCloseTo(before, 5);
  });
});
