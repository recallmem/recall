import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportAccount } from "../src/core/export.js";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { drainQueue } from "../src/queue/worker.js";
import { webhookSecretFor } from "../src/webhooks/index.js";
import { type ApiResponse, type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * Tenant isolation: two hosted accounts (A, B) and the self-hosted default
 * account (D, reached with a JWT) all use the SAME workspace, peer and session
 * names. Every read, write, search, chat, list, MCP call, background job and
 * webhook must stay inside the caller's account.
 */

const SECRET = "tenancy-jwt-secret";
const ADMIN = "operator-token-0123456789abcdef";
const WS = "default";

interface Tenant {
  tag: "A" | "B" | "D";
  tea: string;
  auth: Record<string, string>;
  accountId: string;
  messageIds: string[];
  conclusionId: string;
  webhookId: string;
}

let s: ApiServer;
const T: Record<"A" | "B" | "D", Tenant> = {} as never;
const op = { authorization: `Bearer ${ADMIN}` };
const OTHER: Record<string, string[]> = {
  A: ["matcha", "rooibos"],
  B: ["oolong", "rooibos"],
  D: ["oolong", "matcha"],
};

async function json(res: ApiResponse | Promise<ApiResponse>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

/** Everything in `body` mentions the tenant's tea, and nothing mentions another tenant's. */
function onlyOwn(t: Tenant, body: unknown) {
  const text = JSON.stringify(body);
  for (const other of OTHER[t.tag]!) expect(text, `${t.tag} saw ${other}`).not.toContain(other);
}

async function seed(t: Tenant) {
  const req = (m: string, p: string, b?: unknown) => s.request(m, p, b, t.auth);
  expect((await req("POST", "/v3/workspaces", { id: WS, metadata: { owner: t.tag } })).status).toBe(
    201,
  );
  await json(
    req("POST", `/v3/workspaces/${WS}/peers`, { id: "alice", metadata: { owner: t.tag } }),
    201,
  );
  await json(
    req("POST", `/v3/workspaces/${WS}/sessions`, {
      id: "s1",
      metadata: { owner: t.tag },
      peers: { alice: {}, bob: {} },
    }),
    201,
  );
  const msgs = await json(
    req("POST", `/v3/workspaces/${WS}/sessions/s1/messages`, {
      messages: [
        { peer_id: "alice", content: `I drink ${t.tea} tea every morning` },
        { peer_id: "bob", content: `I think ${t.tea} tea is too bitter` },
      ],
    }),
    201,
  );
  t.messageIds = msgs.map((m: { id: string }) => m.id);
  const [c] = await json(
    req("POST", `/v3/workspaces/${WS}/conclusions`, {
      conclusions: [
        { content: `alice prefers ${t.tea} tea`, observer_id: "alice", observed_id: "alice" },
      ],
    }),
    201,
  );
  t.conclusionId = c.id;
  await json(
    req("POST", `/v3/workspaces/${WS}/scopes`, { id: "team", metadata: { owner: t.tag } }),
    201,
  );
  const hook = await json(
    req("POST", `/v3/workspaces/${WS}/webhooks`, { url: `https://example.com/${t.tea}` }),
    201,
  );
  t.webhookId = hook.id;
}

beforeAll(async () => {
  s = await createTestServer({
    RECALL_AUTH_ENABLED: "true",
    RECALL_AUTH_SECRET: SECRET,
    RECALL_ADMIN_TOKEN: ADMIN,
    RECALL_WEBHOOK_SECRET: "global-webhook-secret",
    RECALL_KEY_CACHE_TTL_MS: "0",
    RECALL_REASONER_MAX_DELAY_MS: "0",
  });
  for (const [tag, tea] of [
    ["A", "oolong"],
    ["B", "matcha"],
  ] as const) {
    const acct = await json(
      s.request("POST", "/admin/v1/accounts", { name: `acct ${tag}` }, op),
      201,
    );
    const key = await json(s.request("POST", `/admin/v1/accounts/${acct.id}/keys`, {}, op), 201);
    T[tag] = {
      tag,
      tea,
      auth: { authorization: `Bearer ${key.key}` },
      accountId: acct.id,
      messageIds: [],
      conclusionId: "",
      webhookId: "",
    };
  }
  T.D = {
    tag: "D",
    tea: "rooibos",
    auth: { authorization: `Bearer ${signToken({ ad: true }, SECRET)}` },
    accountId: "default",
    messageIds: [],
    conclusionId: "",
    webhookId: "",
  };
  for (const t of [T.A, T.B, T.D]) await seed(t);
  await drainQueue(s.ctx);
}, 60_000);
afterAll(() => s.close());

const tenants = () => [T.A, T.B, T.D];
const r = (t: Tenant, method: string, path: string, body?: unknown, headers = {}) =>
  s.request(method, path, body, { ...t.auth, ...headers });

describe("tenancy: names are per account", () => {
  it("lets every account own a workspace with the same name, each with its own data", async () => {
    const found = await rows<{ account_id: string }>(
      s.ctx.db,
      sql`SELECT account_id FROM workspaces WHERE name = ${WS} ORDER BY account_id`,
    );
    expect(found.map((x) => x.account_id).sort()).toEqual(
      [T.A.accountId, T.B.accountId, "default"].sort(),
    );
    // get-or-create sees the caller's own existing workspace
    for (const t of tenants()) {
      const res = await r(t, "POST", "/v3/workspaces", { id: WS });
      expect(res.status).toBe(200);
      expect((await res.json()).metadata).toEqual({ owner: t.tag });
    }
  });
});

describe("tenancy: list endpoints", () => {
  it("/v3/workspaces/list shows only the caller's account", async () => {
    await json(r(T.A, "POST", "/v3/workspaces", { id: "only-a" }), 201);
    const a = await json(r(T.A, "POST", "/v3/workspaces/list", {}));
    const b = await json(r(T.B, "POST", "/v3/workspaces/list", {}));
    const d = await json(r(T.D, "POST", "/v3/workspaces/list", {}));
    expect(a.items.map((w: { id: string }) => w.id).sort()).toEqual([WS, "only-a"]);
    expect(b.items.map((w: { id: string }) => w.id)).toEqual([WS]);
    expect(d.items.map((w: { id: string }) => w.id)).toEqual([WS]);
    for (const [t, page] of [
      [T.A, a],
      [T.B, b],
      [T.D, d],
    ] as const) {
      for (const w of page.items) if (w.id === WS) expect(w.metadata).toEqual({ owner: t.tag });
    }
    // filters cannot widen the listing
    const filtered = await json(
      r(T.B, "POST", "/v3/workspaces/list", { filters: { id: "only-a" } }),
    );
    expect(filtered.items).toEqual([]);
  });

  it("peers, sessions, messages, conclusions, scopes and webhooks list only own rows", async () => {
    for (const t of tenants()) {
      const peers = await json(r(t, "POST", `/v3/workspaces/${WS}/peers/list`, {}));
      expect(peers.items.find((p: { id: string }) => p.id === "alice").metadata).toEqual({
        owner: t.tag,
      });
      const sessions = await json(r(t, "POST", `/v3/workspaces/${WS}/sessions/list`, {}));
      expect(sessions.items.map((x: { metadata: unknown }) => x.metadata)).toEqual([
        { owner: t.tag },
      ]);
      const peerSessions = await json(
        r(t, "POST", `/v3/workspaces/${WS}/peers/alice/sessions`, {}),
      );
      expect(peerSessions.items.map((x: { metadata: unknown }) => x.metadata)).toEqual([
        { owner: t.tag },
      ]);
      const messages = await json(
        r(t, "POST", `/v3/workspaces/${WS}/sessions/s1/messages/list`, {}),
      );
      expect(messages.items.map((m: { id: string }) => m.id).sort()).toEqual(
        [...t.messageIds].sort(),
      );
      onlyOwn(t, messages);
      const conclusions = await json(r(t, "POST", `/v3/workspaces/${WS}/conclusions/list`, {}));
      expect(conclusions.items.length).toBeGreaterThan(0);
      onlyOwn(t, conclusions);
      const query = await json(
        r(t, "POST", `/v3/workspaces/${WS}/conclusions/query`, {
          query: "tea",
          filters: { observer_id: "alice", observed_id: "alice" },
        }),
      );
      onlyOwn(t, query);
      const scopes = await json(r(t, "POST", `/v3/workspaces/${WS}/scopes/list`, {}));
      expect(scopes.items.map((x: { metadata: unknown }) => x.metadata)).toEqual([
        { owner: t.tag },
      ]);
      const hooks = await json(r(t, "GET", `/v3/workspaces/${WS}/webhooks`));
      expect(hooks.items.map((h: { id: string }) => h.id)).toEqual([t.webhookId]);
      const members = await json(r(t, "GET", `/v3/workspaces/${WS}/sessions/s1/peers`));
      expect(members.items.map((p: { id: string }) => p.id).sort()).toEqual(["alice", "bob"]);
    }
  });
});

describe("tenancy: objects of another account are unreachable by id", () => {
  it("messages, conclusions and webhook endpoints answer 404 across accounts and stay intact", async () => {
    const path = (id: string) => `/v3/workspaces/${WS}/sessions/s1/messages/${id}`;
    expect((await r(T.A, "GET", path(T.B.messageIds[0]!))).status).toBe(404);
    expect(
      (await r(T.A, "PUT", path(T.B.messageIds[0]!), { metadata: { hacked: true } })).status,
    ).toBe(404);
    expect(
      (await r(T.A, "GET", `/v3/workspaces/${WS}/conclusions/${T.B.conclusionId}`)).status,
    ).toBe(404);
    expect(
      (await r(T.A, "DELETE", `/v3/workspaces/${WS}/conclusions/${T.B.conclusionId}`)).status,
    ).toBe(404);
    expect((await r(T.A, "DELETE", `/v3/workspaces/${WS}/webhooks/${T.B.webhookId}`)).status).toBe(
      404,
    );
    expect(
      (await r(T.D, "GET", `/v3/workspaces/${WS}/conclusions/${T.A.conclusionId}`)).status,
    ).toBe(404);

    // B still has all of it
    const msg = await json(r(T.B, "GET", path(T.B.messageIds[0]!)));
    expect(msg.metadata).toEqual({});
    expect(
      (await r(T.B, "GET", `/v3/workspaces/${WS}/conclusions/${T.B.conclusionId}`)).status,
    ).toBe(200);
    const hooks = await json(r(T.B, "GET", `/v3/workspaces/${WS}/webhooks`));
    expect(hooks.items).toHaveLength(1);
  });

  it("a workspace that exists only in another account is not found (or is created empty)", async () => {
    // only-a exists in A; for B it does not exist, so reads are 404 / empty.
    expect((await r(T.B, "GET", "/v3/workspaces/only-a/queue/status")).status).toBe(404);
    const sessions = await json(r(T.B, "POST", "/v3/workspaces/only-a/sessions/list", {}));
    expect(sessions.items).toEqual([]);
  });
});

describe("tenancy: search, chat, representation and context", () => {
  it("search at workspace, peer and session level returns only own messages", async () => {
    for (const t of tenants()) {
      for (const path of [
        `/v3/workspaces/${WS}/search`,
        `/v3/workspaces/${WS}/peers/alice/search`,
        `/v3/workspaces/${WS}/sessions/s1/search`,
      ]) {
        const hits = await json(r(t, "POST", path, { query: "tea morning bitter" }));
        expect(hits.length, path).toBeGreaterThan(0);
        expect(JSON.stringify(hits)).toContain(t.tea);
        onlyOwn(t, hits);
      }
    }
  });

  it("chat (peer and workspace) answers only from the caller's memory", async () => {
    for (const t of tenants()) {
      const peer = await json(
        r(t, "POST", `/v3/workspaces/${WS}/peers/alice/chat`, {
          query: "what tea does alice drink",
          include_evidence: true,
        }),
      );
      expect(JSON.stringify(peer)).toContain(t.tea);
      onlyOwn(t, peer);
      const wide = await json(
        r(t, "POST", `/v3/workspaces/${WS}/chat`, {
          query: "what tea does alice drink",
          include_evidence: true,
        }),
      );
      onlyOwn(t, wide);
    }
  });

  it("representation, peer context, card, session context and summaries stay inside the account", async () => {
    for (const t of tenants()) {
      onlyOwn(t, await json(r(t, "POST", `/v3/workspaces/${WS}/peers/alice/representation`, {})));
      onlyOwn(t, await json(r(t, "GET", `/v3/workspaces/${WS}/peers/alice/context`)));
      onlyOwn(t, await json(r(t, "GET", `/v3/workspaces/${WS}/peers/alice/card`)));
      const ctx = await json(r(t, "GET", `/v3/workspaces/${WS}/sessions/s1/context`));
      expect(JSON.stringify(ctx)).toContain(t.tea);
      onlyOwn(t, ctx);
      onlyOwn(t, await json(r(t, "GET", `/v3/workspaces/${WS}/sessions/s1/summaries`)));
      const status = await json(r(t, "GET", `/v3/workspaces/${WS}/queue/status`));
      expect(status.total_work_units).toBeGreaterThan(0);
      await json(r(t, "GET", `/v3/workspaces/${WS}/usage`));
    }
  });
});

describe("tenancy: writes stay in the caller's account", () => {
  it("turn writes into the caller's session and returns only its context", async () => {
    const before = await json(r(T.B, "POST", `/v3/workspaces/${WS}/sessions/s1/messages/list`, {}));
    const turn = await json(
      r(T.A, "POST", `/v3/workspaces/${WS}/sessions/s1/turn`, {
        messages: [{ peer_id: "alice", content: "alice also likes oolong biscuits" }],
      }),
      201,
    );
    expect(JSON.stringify(turn.context)).toContain("oolong biscuits");
    onlyOwn(T.A, turn);
    const after = await json(r(T.B, "POST", `/v3/workspaces/${WS}/sessions/s1/messages/list`, {}));
    expect(after.total).toBe(before.total);
    onlyOwn(T.B, after);
  });

  it("updates and deletes in one account leave the same names in others untouched", async () => {
    await json(r(T.A, "PUT", `/v3/workspaces/${WS}`, { metadata: { owner: "A", v: 2 } }));
    await json(r(T.A, "PUT", `/v3/workspaces/${WS}/peers/alice`, { metadata: { v: 2 } }));
    await json(r(T.A, "PUT", `/v3/workspaces/${WS}/peers/alice/card`, { peer_card: ["A card"] }));
    const ws = await json(r(T.B, "POST", "/v3/workspaces", { id: WS }));
    expect(ws.metadata).toEqual({ owner: "B" });
    const card = await json(r(T.B, "GET", `/v3/workspaces/${WS}/peers/alice/card`));
    expect(JSON.stringify(card)).not.toContain("A card");

    await json(r(T.A, "POST", `/v3/workspaces/${WS}/sessions`, { id: "tmp" }), 201);
    await json(r(T.B, "POST", `/v3/workspaces/${WS}/sessions`, { id: "tmp" }), 201);
    expect((await r(T.A, "DELETE", `/v3/workspaces/${WS}/sessions/tmp`)).status).toBe(202);
    const bSessions = await json(r(T.B, "POST", `/v3/workspaces/${WS}/sessions/list`, {}));
    expect(bSessions.items.map((x: { id: string }) => x.id).sort()).toEqual(["s1", "tmp"]);
  });
});

describe("tenancy: scoped credentials", () => {
  it("workspace-, peer- and session-scoped API keys resolve inside their own account", async () => {
    const mk = async (t: Tenant, body: Record<string, unknown>) => {
      const k = await json(
        s.request("POST", `/admin/v1/accounts/${t.accountId}/keys`, body, op),
        201,
      );
      return { authorization: `Bearer ${k.key}` };
    };
    for (const t of [T.A, T.B]) {
      const wKey = await mk(t, { workspace_id: WS });
      const msgs = await json(
        s.request("POST", `/v3/workspaces/${WS}/sessions/s1/messages/list`, {}, wKey),
      );
      onlyOwn(t, msgs);
      expect(JSON.stringify(msgs)).toContain(t.tea);
      // not an admin key
      expect((await s.request("POST", "/v3/workspaces/list", {}, wKey)).status).toBe(401);
      expect((await s.request("GET", "/v3/usage", undefined, wKey)).status).toBe(401);

      const pKey = await mk(t, { workspace_id: WS, peer_id: "alice" });
      onlyOwn(
        t,
        await json(s.request("GET", `/v3/workspaces/${WS}/peers/alice/context`, undefined, pKey)),
      );
      expect((await s.request("POST", `/v3/workspaces/${WS}/sessions/list`, {}, pKey)).status).toBe(
        401,
      );

      const sKey = await mk(t, { workspace_id: WS, session_id: "s1" });
      onlyOwn(
        t,
        await json(s.request("GET", `/v3/workspaces/${WS}/sessions/s1/context`, undefined, sKey)),
      );
    }
  });

  it("JWTs act on the default account only", async () => {
    const wJwt = { authorization: `Bearer ${signToken({ w: WS }, SECRET)}` };
    const msgs = await json(
      s.request("POST", `/v3/workspaces/${WS}/sessions/s1/messages/list`, {}, wJwt),
    );
    expect(JSON.stringify(msgs)).toContain("rooibos");
    onlyOwn(T.D, msgs);
    // the admin JWT cannot reach a hosted account's workspace
    expect((await r(T.D, "GET", "/v3/workspaces/only-a/queue/status")).status).toBe(404);
  });
});

describe("tenancy: MCP", () => {
  async function mcp(t: Tenant, name: string, args: Record<string, unknown>) {
    const res = await s.request(
      "POST",
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      { ...t.auth, accept: "application/json, text/event-stream", "x-recall-workspace-id": WS },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    return body.result as { isError?: boolean; content: { text: string }[] };
  }

  it("tools only see the caller's account", async () => {
    for (const t of tenants()) {
      const search = await mcp(t, "search", { query: "tea", peer_id: "alice" });
      expect(search.isError).toBeFalsy();
      expect(search.content[0]!.text).toContain(t.tea);
      onlyOwn(t, search);
      const list = await mcp(t, "list_conclusions", { peer_id: "alice" });
      expect(list.content[0]!.text).toContain(t.tea);
      onlyOwn(t, list);
      const chat = await mcp(t, "chat", { query: "what tea does alice drink", peer_id: "alice" });
      onlyOwn(t, chat);
      const ctx = await mcp(t, "get_session_context", { session_id: "s1" });
      onlyOwn(t, ctx);
    }
  });

  it("deleting another account's conclusion through MCP fails and changes nothing", async () => {
    const res = await mcp(T.A, "delete_conclusion", { conclusion_id: T.B.conclusionId });
    expect(res.isError).toBe(true);
    expect(
      (await r(T.B, "GET", `/v3/workspaces/${WS}/conclusions/${T.B.conclusionId}`)).status,
    ).toBe(200);
  });
});

describe("tenancy: background jobs and webhooks", () => {
  it("reasoning files conclusions only into the workspace whose messages produced them", async () => {
    await drainQueue(s.ctx);
    const derived = await rows<{ account_id: string; content: string; msg_account: string | null }>(
      s.ctx.db,
      sql`SELECT w.account_id, c.content,
                 (SELECT mw.account_id FROM messages m JOIN workspaces mw ON mw.id = m.workspace_id
                   WHERE m.id = ANY(c.message_ids) LIMIT 1) AS msg_account
          FROM conclusions c JOIN workspaces w ON w.id = c.workspace_id
          WHERE cardinality(c.message_ids) > 0`,
    );
    expect(derived.length).toBeGreaterThan(0);
    const tenantOf: Record<string, Tenant> = {
      [T.A.accountId]: T.A,
      [T.B.accountId]: T.B,
      default: T.D,
    };
    for (const d of derived) {
      expect(d.msg_account).toBe(d.account_id);
      for (const other of OTHER[tenantOf[d.account_id]!.tag]!)
        expect(d.content).not.toContain(other);
    }
    // every job ran against a workspace of a known account
    const orphan = await rows<{ n: number }>(
      s.ctx.db,
      sql`SELECT count(*)::int AS n FROM jobs j WHERE j.workspace_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = j.workspace_id)`,
    );
    expect(orphan[0]!.n).toBe(0);
  });

  it("webhook events go only to the account's own endpoints, signed with its own secret", async () => {
    await s.ctx.db.execute(sql`DELETE FROM jobs WHERE kind = 'webhook'`);
    expect((await r(T.B, "GET", `/v3/workspaces/${WS}/webhooks/test`)).ok).toBe(true);
    const jobs = await rows<{ payload: { endpoint_id: string; url: string } }>(
      s.ctx.db,
      sql`SELECT payload FROM jobs WHERE kind = 'webhook'`,
    );
    expect(jobs.map((j) => j.payload.endpoint_id)).toEqual([T.B.webhookId]);

    const wsId = async (t: Tenant) =>
      (
        await rows<{ id: string }>(
          s.ctx.db,
          sql`SELECT id FROM workspaces WHERE account_id = ${t.accountId} AND name = ${WS}`,
        )
      )[0]!.id;
    const secretA = await webhookSecretFor(s.ctx, await wsId(T.A));
    const secretB = await webhookSecretFor(s.ctx, await wsId(T.B));
    expect(secretA).toMatch(/^whsec_/);
    expect(secretB).toMatch(/^whsec_/);
    expect(secretA).not.toBe(secretB);
    expect(await webhookSecretFor(s.ctx, await wsId(T.D))).toBe("global-webhook-secret");
    const acctA = await json(r(T.A, "GET", "/v3/account"));
    expect(acctA.webhook_secret).toBe(secretA);
  });
});

describe("tenancy: what an account sees of itself", () => {
  it("GET /v3/account and the data export leave out the operator's notes on the account", async () => {
    const operatorNotes = {
      llm_key: "eval",
      answer_model_override: true,
      models: { chat_low: "acme/hidden-model-9b" },
      signup: "self_serve",
    };
    const acct = await json(
      s.request(
        "POST",
        "/admin/v1/accounts",
        { name: "acct C", monthly_budget_usd: 25, metadata: operatorNotes },
        op,
      ),
      201,
    );
    const key = await json(s.request("POST", `/admin/v1/accounts/${acct.id}/keys`, {}, op), 201);
    const me = await json(
      s.request("GET", "/v3/account", undefined, { authorization: `Bearer ${key.key}` }),
    );
    expect(Object.keys(me).sort()).toEqual(
      ["created_at", "id", "monthly_budget_usd", "name", "webhook_secret"].sort(),
    );
    expect(me).toMatchObject({ id: acct.id, name: "acct C", monthly_budget_usd: 25 });
    expect(me.webhook_secret).toBe(acct.webhook_secret);
    const text = JSON.stringify(me);
    for (const hidden of ["llm_key", "eval", "answer_model_override", "hidden-model", "models"])
      expect(text).not.toContain(hidden);

    // The export a customer downloads leaves them out the same way.
    let exported = "";
    for await (const chunk of exportAccount(s.ctx.db, acct.id)) exported += chunk;
    const { webhook_secret: _secret, ...plain } = me;
    expect(JSON.parse(exported).account).toEqual(plain);

    // The operator still sees and manages them.
    const seen = await json(s.request("GET", `/admin/v1/accounts/${acct.id}`, undefined, op));
    expect(seen.metadata).toEqual(operatorNotes);
    expect(
      (await json(s.request("GET", "/admin/v1/accounts", undefined, op))).items.find(
        (a: { id: string }) => a.id === acct.id,
      ).metadata,
    ).toEqual(operatorNotes);
  });
});

describe("tenancy: account deletion (GDPR)", () => {
  it("removes every row of the account, revokes its keys at once, and leaves others intact", async () => {
    const [{ id: bWs }] = (await rows<{ id: string }>(
      s.ctx.db,
      sql`SELECT id FROM workspaces WHERE account_id = ${T.B.accountId}`,
    )) as [{ id: string }];
    await s.ctx.db.execute(
      sql`INSERT INTO llm_usage (workspace_id, account_id, task, provider, model, cost_usd)
          VALUES (${bWs}, ${T.B.accountId}, 'chat_low', 'mock', 'm', 0.5)`,
    );
    expect((await r(T.B, "GET", "/v3/usage")).status).toBe(200);

    expect(
      (await s.request("DELETE", `/admin/v1/accounts/${T.B.accountId}`, undefined, op)).status,
    ).toBe(204);
    expect((await r(T.B, "GET", "/v3/usage")).status).toBe(401);
    for (const table of [
      "peers",
      "sessions",
      "session_peers",
      "messages",
      "collections",
      "conclusions",
      "summary_blocks",
      "webhook_endpoints",
      "jobs",
      "llm_usage",
    ]) {
      const [n] = await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE workspace_id = ${bWs}`,
      );
      expect(n!.n, table).toBe(0);
    }
    for (const table of ["workspaces", "api_keys", "llm_usage"]) {
      const [n] = await rows<{ n: number }>(
        s.ctx.db,
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE account_id = ${T.B.accountId}`,
      );
      expect(n!.n, table).toBe(0);
    }
    // A and D are intact
    for (const t of [T.A, T.D]) {
      const msgs = await json(r(t, "POST", `/v3/workspaces/${WS}/sessions/s1/messages/list`, {}));
      expect(JSON.stringify(msgs)).toContain(t.tea);
    }
    expect((await s.request("DELETE", "/admin/v1/accounts/default", undefined, op)).status).toBe(
      409,
    );
    expect(
      (await s.request("DELETE", `/admin/v1/accounts/${T.B.accountId}`, undefined, op)).status,
    ).toBe(404);
  });
});
