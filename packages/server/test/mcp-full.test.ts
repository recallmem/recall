import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * The opt-in `full` MCP profile: the reference's 40 tools, selected with
 * `X-Recall-MCP-Profile: full` or `?profile=full`.
 */

type Served = { server: ApiServer; url: string; stop: () => Promise<void> };

async function startServer(env: Record<string, string> = {}): Promise<Served> {
  const server = await createTestServer(env);
  const http = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const { port } = http.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}/mcp`,
    stop: async () => {
      http.close();
      await server.close();
    },
  };
}

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  );
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: tool output is loosely typed on purpose
type Result = { isError?: boolean; text: string; json: any };

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = res.content[0]!.text;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { isError: res.isError, text, json } as Result;
}

/** Every tool of the reference's MCP server: its required arguments and all argument names. */
const SPEC: Record<string, { required: string[]; args: string[] }> = {
  list_workspaces: { required: [], args: ["page", "size"] },
  create_workspace: { required: ["workspace_id"], args: ["metadata"] },
  inspect_workspace: { required: [], args: [] },
  search: {
    required: ["query"],
    args: [
      "peer_id",
      "session_id",
      "scope",
      "message_limit",
      "message_filters",
      "conclusion_top_k",
      "conclusion_filters",
    ],
  },
  workspace_chat: {
    required: ["query"],
    args: ["session_id", "scope", "reasoning_level", "include_evidence"],
  },
  get_metadata: { required: [], args: ["peer_id", "session_id"] },
  set_metadata: { required: ["metadata"], args: ["peer_id", "session_id"] },
  create_peer: { required: ["peer_id"], args: ["configuration"] },
  list_peers: { required: [], args: ["page", "size", "reverse"] },
  chat: {
    required: ["peer_id", "query"],
    args: [
      "target_peer_id",
      "session_id",
      "scope",
      "sessions",
      "reasoning_level",
      "include_evidence",
    ],
  },
  get_peer_card: { required: ["peer_id"], args: ["target_peer_id"] },
  set_peer_card: { required: ["peer_id", "peer_card"], args: ["target_peer_id"] },
  get_peer_context: {
    required: ["peer_id"],
    args: ["target_peer_id", "search_query", "max_conclusions"],
  },
  get_representation: {
    required: ["peer_id"],
    args: ["target_peer_id", "session_id", "scope", "sessions", "search_query", "max_conclusions"],
  },
  create_session: { required: ["session_id"], args: ["scopes"] },
  list_sessions: { required: [], args: ["page", "size", "reverse"] },
  delete_session: { required: ["session_id"], args: [] },
  clone_session: { required: ["session_id"], args: ["message_id"] },
  add_peers_to_session: { required: ["peers"], args: ["session_id"] },
  remove_peers_from_session: { required: ["peer_ids"], args: ["session_id"] },
  get_session_peers: { required: ["session_id"], args: [] },
  inspect_session: { required: ["session_id"], args: [] },
  add_messages_to_session: { required: ["messages"], args: ["session_id"] },
  get_session_messages: {
    required: [],
    args: ["session_id", "filters", "page", "size", "reverse"],
  },
  get_session_message: { required: ["session_id", "message_id"], args: [] },
  get_session_context: {
    required: [],
    args: [
      "session_id",
      "summary",
      "tokens",
      "peer_target",
      "peer_perspective",
      "scope",
      "limit_to_session",
    ],
  },
  list_scopes: { required: [], args: ["page", "size"] },
  create_scope: { required: ["scope_id"], args: ["metadata"] },
  add_sessions_to_scope: { required: ["scope_id", "session_ids"], args: [] },
  remove_session_from_scope: { required: ["scope_id", "session_id"], args: [] },
  get_scope_status: { required: ["scope_id"], args: [] },
  get_scope_sessions: { required: ["scope_id"], args: ["page", "size"] },
  list_conclusions: {
    required: ["peer_id"],
    args: ["target_peer_id", "session_id", "filters", "page", "size", "reverse"],
  },
  query_conclusions: {
    required: ["peer_id", "query"],
    args: ["target_peer_id", "top_k", "filters"],
  },
  get_conclusions: { required: ["conclusion_ids"], args: [] },
  get_derived_conclusions: { required: ["conclusion_id"], args: ["page", "size"] },
  create_conclusions: {
    required: ["peer_id", "target_peer_id", "conclusions"],
    args: ["session_id"],
  },
  delete_conclusion: { required: ["peer_id", "target_peer_id", "conclusion_id"], args: [] },
  schedule_dream: { required: ["peer_id"], args: ["target_peer_id", "session_id"] },
  get_queue_status: { required: [], args: [] },
};

const READ_ONLY = [
  "list_workspaces",
  "inspect_workspace",
  "search",
  "workspace_chat",
  "get_metadata",
  "list_peers",
  "chat",
  "get_peer_card",
  "get_peer_context",
  "get_representation",
  "list_sessions",
  "get_session_peers",
  "inspect_session",
  "get_session_messages",
  "get_session_message",
  "get_session_context",
  "list_scopes",
  "get_scope_status",
  "get_scope_sessions",
  "list_conclusions",
  "query_conclusions",
  "get_conclusions",
  "get_derived_conclusions",
  "get_queue_status",
];
const DESTRUCTIVE = [
  "set_metadata",
  "set_peer_card",
  "delete_session",
  "remove_peers_from_session",
  "remove_session_from_scope",
  "delete_conclusion",
  "schedule_dream",
];
const ALL = Object.keys(SPEC).sort();

describe("mcp full profile: selection and catalogue", () => {
  let s: Served;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  it("knows all 40 tools of the reference", () => {
    expect(ALL).toHaveLength(40);
    expect(READ_ONLY).toHaveLength(24);
    expect(DESTRUCTIVE).toHaveLength(7);
  });

  it("serves the curated eight by default and all 40 on request (header or query)", async () => {
    const plain = await connect(s.url);
    const viaHeader = await connect(s.url, { "X-Recall-MCP-Profile": "full" });
    const viaQuery = await connect(`${s.url}?profile=full`);
    const explicitDefault = await connect(s.url, { "X-Recall-MCP-Profile": "default" });
    try {
      expect((await plain.listTools()).tools).toHaveLength(8);
      expect((await explicitDefault.listTools()).tools).toHaveLength(8);
      for (const client of [viaHeader, viaQuery]) {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(ALL);
        expect(client.getServerVersion()?.name).toBe("Recall");
        expect(client.getInstructions()).toContain("get_queue_status");
      }
      expect(plain.getInstructions()).not.toContain("get_queue_status");
    } finally {
      await Promise.all([
        plain.close(),
        viaHeader.close(),
        viaQuery.close(),
        explicitDefault.close(),
      ]);
    }
  });

  it("lets the header win over the query and rejects unknown profiles", async () => {
    const both = await connect(`${s.url}?profile=full`, { "X-Recall-MCP-Profile": "default" });
    try {
      expect((await both.listTools()).tools).toHaveLength(8);
    } finally {
      await both.close();
    }
    const rpc = (url: string, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const badHeader = await rpc(s.url, { "x-recall-mcp-profile": "everything" });
    expect(badHeader.status).toBe(400);
    expect(((await badHeader.json()) as { detail: string }).detail).toContain(
      "Unknown MCP profile",
    );
    expect((await rpc(`${s.url}?profile=nope`)).status).toBe(400);
    // Case does not matter.
    const loud = await rpc(s.url, { "X-Recall-MCP-Profile": " FULL " });
    expect(loud.status).toBe(200);
    expect(((await loud.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(40);
  });

  it("refuses JSON-RPC batches, which would multiply the per-request rate limit", async () => {
    const batch = await fetch(s.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(
        Array.from({ length: 50 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/list" })),
      ),
    });
    expect(batch.status).toBe(400);
    expect(((await batch.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("matches the reference's argument names and required arguments, with truthful annotations", async () => {
    const client = await connect(s.url, { "X-Recall-MCP-Profile": "full" });
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const spec = SPEC[tool.name]!;
        const props = Object.keys(tool.inputSchema.properties ?? {});
        expect([...(tool.inputSchema.required ?? [])].sort(), tool.name).toEqual(
          [...spec.required].sort(),
        );
        for (const arg of spec.args) expect(props, `${tool.name}.${arg}`).toContain(arg);
        if (tool.name !== "list_workspaces" && tool.name !== "create_workspace") {
          expect(props, `${tool.name}.workspace_id`).toContain("workspace_id");
        }
        expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
        expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(
          READ_ONLY.includes(tool.name),
        );
        if (!READ_ONLY.includes(tool.name)) {
          expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(
            DESTRUCTIVE.includes(tool.name),
          );
        }
      }
    } finally {
      await client.close();
    }
  });
});

describe("mcp full profile: every tool, end to end", () => {
  let s: Served;
  let client: Client;
  const called = new Set<string>();
  const call = (name: string, args: Record<string, unknown> = {}) => {
    called.add(name);
    return callTool(client, name, args);
  };
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await call(name, args);
    expect(out.isError, `${name}: ${out.text}`).toBeFalsy();
    return out;
  };

  beforeAll(async () => {
    s = await startServer();
    client = await connect(s.url, {
      "X-Recall-MCP-Profile": "full",
      "X-Recall-Workspace-ID": "acme",
    });
  });
  afterAll(async () => {
    await client.close();
    await s.stop();
  });

  let aliceMsg = "";
  let parentId = "";
  let childId = "";

  it("workspaces: create, list, inspect, metadata", async () => {
    const made = await ok("create_workspace", { workspace_id: "acme", metadata: { tier: "gold" } });
    expect(made.json).toMatchObject({ id: "acme", metadata: { tier: "gold" }, created: true });
    const again = await ok("create_workspace", { workspace_id: "acme", metadata: { tier: "no" } });
    expect(again.json).toMatchObject({ created: false, metadata: { tier: "gold" } });

    const list = await ok("list_workspaces", {});
    expect(list.json.items.map((w: { id: string }) => w.id)).toEqual(["acme"]);
    expect(list.json).toMatchObject({ total: 1, page: 1 });

    expect((await ok("get_metadata")).json).toEqual({ tier: "gold" });
    const set = await ok("set_metadata", { metadata: { tier: "silver", region: "eu" } });
    expect(set.json).toEqual({ workspace_id: "acme", metadata: { tier: "silver", region: "eu" } });
    // Replaces, does not merge.
    expect((await ok("get_metadata")).json).toEqual({ tier: "silver", region: "eu" });
  });

  it("peers and sessions: create, join, record", async () => {
    const alice = await ok("create_peer", { peer_id: "alice" });
    expect(alice.json).toMatchObject({ id: "alice", workspace_id: "acme", created: true });
    const bot = await ok("create_peer", { peer_id: "bot", configuration: { observeMe: false } });
    expect(bot.json.configuration).toEqual({ observe_me: false });
    const peers = await ok("list_peers", {});
    expect(peers.json.items.map((p: { id: string }) => p.id).sort()).toEqual(["alice", "bot"]);

    const session = await ok("create_session", { session_id: "s1" });
    expect(session.json).toMatchObject({ id: "s1", created: true });
    const added = await ok("add_peers_to_session", {
      session_id: "s1",
      peers: ["alice", { peer_id: "bot", observe_me: false, observe_others: false }],
    });
    expect(added.json).toEqual({ session_id: "s1", added: ["alice", "bot"] });
    const members = await ok("get_session_peers", { session_id: "s1" });
    expect(members.json.items.map((p: { id: string }) => p.id).sort()).toEqual(["alice", "bot"]);

    const args = {
      session_id: "s1",
      messages: [
        { peer_id: "alice", content: "I just moved to Utrecht and I love cycling." },
        { peer_id: "bot", content: "Welcome to Utrecht!", metadata: { turn: 1 } },
      ],
      idempotency_key: "full-1",
    };
    const first = await ok("add_messages_to_session", args);
    expect(first.json).toMatchObject({ session_id: "s1", stored: 2, replayed: false });
    aliceMsg = first.json.messages[0].id;
    const retry = await ok("add_messages_to_session", args);
    expect(retry.json.replayed).toBe(true);
    expect(retry.json.messages[0].id).toBe(aliceMsg);

    const messages = await ok("get_session_messages", { session_id: "s1" });
    expect(messages.json.items.map((m: { content: string }) => m.content)).toEqual([
      "I just moved to Utrecht and I love cycling.",
      "Welcome to Utrecht!",
    ]);
    const byPeer = await ok("get_session_messages", {
      session_id: "s1",
      filters: { peer_id: "bot" },
      reverse: true,
    });
    expect(byPeer.json.items).toHaveLength(1);
    const one = await ok("get_session_message", { session_id: "s1", message_id: aliceMsg });
    expect(one.json).toMatchObject({ id: aliceMsg, peer_id: "alice", session_id: "s1" });

    const sessions = await ok("list_sessions", {});
    expect(sessions.json.items.map((x: { id: string }) => x.id)).toEqual(["s1"]);
    expect(
      (await ok("set_metadata", { session_id: "s1", metadata: { topic: "moving" } })).json,
    ).toEqual({
      session_id: "s1",
      metadata: { topic: "moving" },
    });
    expect((await ok("get_metadata", { session_id: "s1" })).json).toEqual({ topic: "moving" });
    expect((await ok("set_metadata", { peer_id: "alice", metadata: { vip: true } })).json).toEqual({
      peer_id: "alice",
      metadata: { vip: true },
    });
    expect((await ok("get_metadata", { peer_id: "alice" })).json).toEqual({ vip: true });
  });

  it("conclusions: create, list, query, fetch, derive, delete", async () => {
    const made = await ok("create_conclusions", {
      peer_id: "alice",
      target_peer_id: "alice",
      conclusions: ["Alice lives in Utrecht", "Alice loves cycling"],
      session_id: "s1",
    });
    expect(made.json.created).toBe(2);
    parentId = made.json.conclusions[0].id;
    childId = made.json.conclusions[1].id;

    const list = await ok("list_conclusions", { peer_id: "alice", size: 50 });
    expect(list.json.total).toBe(2);
    const bySession = await ok("list_conclusions", {
      peer_id: "alice",
      session_id: "s1",
      filters: { level: "explicit" },
    });
    expect(bySession.json.total).toBe(2);
    const query = await ok("query_conclusions", { peer_id: "alice", query: "cycling", top_k: 1 });
    expect(query.json.items).toHaveLength(1);
    expect(query.json.items[0].content).toBe("Alice loves cycling");

    const fetched = await ok("get_conclusions", { conclusion_ids: [parentId, "missing-id"] });
    expect(fetched.json.conclusions.map((c: { id: string }) => c.id)).toEqual([parentId]);
    expect(fetched.json.not_found).toEqual(["missing-id"]);

    expect((await ok("get_derived_conclusions", { conclusion_id: parentId })).json.total).toBe(0);
    // A derived conclusion is one whose sources include the parent.
    await s.server.ctx.db.execute(
      sql`UPDATE conclusions SET source_ids = ARRAY[${parentId}]::text[] WHERE id = ${childId}`,
    );
    const derived = await ok("get_derived_conclusions", { conclusion_id: parentId });
    expect(derived.json.items.map((c: { id: string }) => c.id)).toEqual([childId]);

    // The pair must match.
    const wrong = await call("delete_conclusion", {
      peer_id: "bot",
      target_peer_id: "alice",
      conclusion_id: childId,
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("is not held by 'bot' about 'alice'");
  });

  it("cards, context, representation, search and chat", async () => {
    expect((await ok("get_peer_card", { peer_id: "alice" })).json.peer_card).toBeNull();
    const card = await ok("set_peer_card", { peer_id: "alice", peer_card: ["Lives in Utrecht"] });
    expect(card.json).toEqual({
      peer_id: "alice",
      target_peer_id: "alice",
      peer_card: ["Lives in Utrecht"],
    });
    expect((await ok("get_peer_card", { peer_id: "alice" })).json.peer_card).toEqual([
      "Lives in Utrecht",
    ]);

    const peerCtx = await ok("get_peer_context", {
      peer_id: "alice",
      search_query: "where does alice live",
    });
    expect(peerCtx.json.peer_card).toEqual(["Lives in Utrecht"]);
    expect(peerCtx.json.representation).toContain("Utrecht");

    const rep = await ok("get_representation", { peer_id: "alice", session_id: "s1" });
    expect(rep.text).toContain("Utrecht");
    const exclusive = await call("get_representation", {
      peer_id: "alice",
      session_id: "s1",
      sessions: ["s1"],
    });
    expect(exclusive.isError).toBe(true);
    expect(exclusive.text).toContain("mutually exclusive");

    const sessionCtx = await ok("get_session_context", {
      session_id: "s1",
      peer_target: "alice",
      summary: false,
      tokens: 4000,
    });
    expect(sessionCtx.json.messages).toHaveLength(2);
    expect(sessionCtx.json.peer_card).toEqual(["Lives in Utrecht"]);
    expect(sessionCtx.json.peer_representation).toContain("Utrecht");

    const found = await ok("search", { query: "Utrecht", peer_id: "alice" });
    expect(found.json.messages.length).toBeGreaterThan(0);
    expect(found.json.conclusions.map((c: { content: string }) => c.content)).toContain(
      "Alice lives in Utrecht",
    );
    const inSession = await ok("search", {
      query: "Utrecht",
      session_id: "s1",
      peer_id: "alice",
      conclusion_filters: { level: "deductive" },
    });
    expect(inSession.json.conclusions).toEqual([]);
    expect(
      inSession.json.messages.every((m: { session_id: string }) => m.session_id === "s1"),
    ).toBe(true);
    const clash = await call("search", { query: "x", session_id: "s1", scope: "team" });
    expect(clash.isError).toBe(true);
    const badFilter = await call("search", {
      query: "x",
      peer_id: "alice",
      conclusion_filters: { nonsense: 1 },
    });
    expect(badFilter.isError).toBe(true);

    const answer = await ok("chat", { peer_id: "alice", query: "Where does Alice live?" });
    expect(answer.text).toContain("Utrecht");
    const withEvidence = await ok("chat", {
      peer_id: "alice",
      query: "Where does Alice live?",
      include_evidence: true,
      reasoning_level: "minimal",
      sessions: ["s1"],
    });
    expect(withEvidence.json.content).toContain("Utrecht");
    expect(withEvidence.json.evidence).toBeTruthy();
    const wide = await ok("workspace_chat", { query: "Where does Alice live?" });
    expect(wide.text).toContain("Utrecht");
    const wideIn = await ok("workspace_chat", { query: "Where?", session_id: "s1" });
    expect(wideIn.text.length).toBeGreaterThan(0);
  });

  it("scopes: create, fill, inspect, empty", async () => {
    const scope = await ok("create_scope", { scope_id: "team", metadata: { owner: "ops" } });
    expect(scope.json).toMatchObject({ id: "team", created: true, metadata: { owner: "ops" } });
    expect((await ok("create_scope", { scope_id: "team" })).json.created).toBe(false);
    const added = await ok("add_sessions_to_scope", { scope_id: "team", session_ids: ["s1"] });
    expect(added.json).toEqual({ scope_id: "team", added: ["s1"] });
    expect((await ok("list_scopes", {})).json.items.map((x: { id: string }) => x.id)).toEqual([
      "team",
    ]);
    const inScope = await ok("get_scope_sessions", { scope_id: "team" });
    expect(inScope.json.items.map((x: { id: string }) => x.id)).toEqual(["s1"]);
    expect((await ok("get_scope_status", { scope_id: "team" })).json).toHaveProperty(
      "backfill_status",
    );
    const scoped = await ok("search", { query: "Utrecht", scope: "team", peer_id: "alice" });
    expect(scoped.json.messages.every((m: { peer_id: string }) => m.peer_id === "alice")).toBe(
      true,
    );

    // Scopes narrow chat and representations too (and cannot be combined with a session).
    const scopedChat = await call("chat", {
      peer_id: "alice",
      query: "Where does Alice live?",
      scope: "team",
    });
    expect(scopedChat.isError, scopedChat.text).toBeFalsy();
    expect(
      (await call("get_representation", { peer_id: "alice", scope: "team" })).isError,
    ).toBeFalsy();
    const both = await call("chat", {
      peer_id: "alice",
      query: "x",
      scope: "team",
      session_id: "s1",
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("mutually exclusive");

    expect(
      (await ok("remove_session_from_scope", { scope_id: "team", session_id: "s1" })).json,
    ).toEqual({ scope_id: "team", removed: "s1" });
    expect((await ok("get_scope_sessions", { scope_id: "team" })).json.items).toEqual([]);
    const missing = await call("get_scope_status", { scope_id: "nope" });
    expect(missing.isError).toBe(true);
  });

  it("session lifecycle: inspect, clone, leave, delete; workspace overview; system", async () => {
    const inspected = await ok("inspect_session", { session_id: "s1" });
    expect(inspected.json).toMatchObject({
      session_id: "s1",
      metadata: { topic: "moving" },
      peer_count: 2,
      message_count: 2,
    });
    expect(inspected.json.peers.map((p: { id: string }) => p.id).sort()).toEqual(["alice", "bot"]);
    expect(inspected.json.summaries).toHaveProperty("short_summary");

    const clone = await ok("clone_session", { session_id: "s1", message_id: aliceMsg });
    const cloneId = clone.json.id as string;
    expect(cloneId).toBeTruthy();
    expect((await ok("get_session_messages", { session_id: cloneId })).json.total).toBe(1);

    const left = await ok("remove_peers_from_session", { session_id: "s1", peer_ids: ["bot"] });
    expect(left.json).toEqual({ session_id: "s1", removed: ["bot"] });
    expect(
      (await ok("get_session_peers", { session_id: "s1" })).json.items.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual(["alice"]);

    expect((await ok("delete_session", { session_id: cloneId })).json).toEqual({
      deleted: cloneId,
    });
    expect((await call("inspect_session", { session_id: cloneId })).isError).toBe(true);

    const overview = await ok("inspect_workspace", {});
    expect(overview.json).toMatchObject({
      workspace_id: "acme",
      metadata: { tier: "silver", region: "eu" },
      peer_count: 2,
      session_count: 1,
    });
    expect(overview.json.sessions).toEqual([{ id: "s1" }]);

    const queue = await ok("get_queue_status", {});
    expect(queue.json).toHaveProperty("total_work_units");
    expect(queue.json).toHaveProperty("pending_work_units");

    const dream = await ok("schedule_dream", { peer_id: "alice", session_id: "s1" });
    expect(dream.json).toEqual({
      scheduled: true,
      observer_id: "alice",
      observed_id: "alice",
      session_id: "s1",
    });
    const [{ n }] = (await rows<{ n: number }>(
      s.server.ctx.db,
      sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'dream'`,
    )) as [{ n: number }];
    expect(n).toBeGreaterThan(0);
    expect((await call("schedule_dream", { peer_id: "ghost" })).isError).toBe(true);
  });

  it("deletes a conclusion and reports a repeat as an error", async () => {
    const removed = await ok("delete_conclusion", {
      peer_id: "alice",
      target_peer_id: "alice",
      conclusion_id: childId,
    });
    expect(removed.json).toEqual({ deleted: childId });
    expect((await ok("list_conclusions", { peer_id: "alice" })).json.total).toBe(1);
    const again = await call("delete_conclusion", {
      peer_id: "alice",
      target_peer_id: "alice",
      conclusion_id: childId,
    });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/^Failed to delete the conclusion: /);
  });

  it("covered every one of the 40 tools", () => {
    expect([...called].sort()).toEqual(ALL);
  });

  it("falls back to the connection's session header", async () => {
    const withSession = await connect(s.url, {
      "X-Recall-MCP-Profile": "full",
      "X-Recall-Workspace-ID": "acme",
      "X-Recall-Session-ID": "s1",
      "X-Recall-User-Name": "alice",
    });
    try {
      const msgs = await callTool(withSession, "get_session_messages", {});
      expect(msgs.json.total).toBe(2);
      const noSession = await connect(s.url, {
        "X-Recall-MCP-Profile": "full",
        "X-Recall-Workspace-ID": "acme",
      });
      try {
        const out = await callTool(noSession, "get_session_messages", {});
        expect(out.isError).toBe(true);
        expect(out.text).toContain("session_id is required");
      } finally {
        await noSession.close();
      }
    } finally {
      await withSession.close();
    }
  });
});

describe("mcp full profile: read-only tools never create anything", () => {
  let s: Served;
  let client: Client;
  beforeAll(async () => {
    s = await startServer();
    client = await connect(s.url, {
      "X-Recall-MCP-Profile": "full",
      "X-Recall-Workspace-ID": "ghost",
    });
  });
  afterAll(async () => {
    await client.close();
    await s.stop();
  });

  const census = async () =>
    (
      await rows<{ n: number }>(
        s.server.ctx.db,
        sql`SELECT (SELECT count(*) FROM workspaces) + (SELECT count(*) FROM peers) + (SELECT count(*) FROM sessions)
                  + (SELECT count(*) FROM collections) + (SELECT count(*) FROM messages)
                  + (SELECT count(*) FROM conclusions) + (SELECT count(*) FROM jobs)
                  + (SELECT count(*) FROM session_peers) AS n`,
      )
    )[0]!.n;

  /** Arguments that name things which do not exist. */
  const ARGS: Record<string, Record<string, unknown>> = {
    inspect_workspace: {},
    search: { query: "anything", peer_id: "nobody" },
    workspace_chat: { query: "who?" },
    get_metadata: { peer_id: "nobody" },
    list_peers: {},
    chat: { peer_id: "nobody", query: "who?" },
    get_peer_card: { peer_id: "nobody" },
    get_peer_context: { peer_id: "nobody" },
    get_representation: { peer_id: "nobody" },
    list_sessions: {},
    get_session_peers: { session_id: "nope" },
    inspect_session: { session_id: "nope" },
    get_session_messages: { session_id: "nope" },
    get_session_message: { session_id: "nope", message_id: "m1" },
    get_session_context: { session_id: "nope" },
    list_scopes: {},
    get_scope_status: { scope_id: "nope" },
    get_scope_sessions: { scope_id: "nope" },
    list_conclusions: { peer_id: "nobody" },
    query_conclusions: { peer_id: "nobody", query: "x" },
    get_conclusions: { conclusion_ids: ["c1"] },
    get_derived_conclusions: { conclusion_id: "c1" },
    get_queue_status: {},
  };

  it("reports an unknown workspace instead of creating it", async () => {
    const before = await census();
    for (const name of READ_ONLY.filter((n) => n !== "list_workspaces")) {
      const out = await callTool(client, name, ARGS[name]);
      expect(out.isError, `${name}: ${out.text}`).toBe(true);
      expect(out.text, name).toMatch(/not found/i);
    }
    const listed = await callTool(client, "list_workspaces", {});
    expect(listed.json.items).toEqual([]);
    expect(await census()).toBe(before);
  });

  it("reports unknown peers, sessions and scopes inside a real workspace", async () => {
    const real = await connect(s.url, {
      "X-Recall-MCP-Profile": "full",
      "X-Recall-Workspace-ID": "real",
    });
    try {
      await callTool(real, "add_messages_to_session", {
        session_id: "only",
        messages: [{ peer_id: "someone", content: "hello there" }],
      });
      const before = await census();
      for (const name of READ_ONLY) {
        if (
          [
            "list_workspaces",
            "inspect_workspace",
            "list_peers",
            "list_sessions",
            "list_scopes",
            "get_queue_status",
            "workspace_chat",
            "get_metadata",
            "search", // searching for an unknown peer's facts is just empty; see below
          ].includes(name)
        ) {
          continue;
        }
        if (["get_conclusions", "get_derived_conclusions"].includes(name)) continue;
        const out = await callTool(real, name, ARGS[name]);
        expect(out.isError, `${name}: ${out.text}`).toBe(true);
        expect(out.text, name).toMatch(/not found/i);
      }
      // Searching for facts of a peer that does not exist yet is just empty.
      expect(
        (await callTool(real, "search", { query: "hello", peer_id: "nobody" })).json,
      ).toMatchObject({
        conclusions: [],
      });
      expect((await callTool(real, "get_metadata", { session_id: "ghost" })).isError).toBe(true);
      expect((await callTool(real, "get_metadata", { peer_id: "ghost" })).isError).toBe(true);
      expect(
        (await callTool(real, "workspace_chat", { query: "hi?", session_id: "ghost" })).isError,
      ).toBeFalsy();
      expect((await callTool(real, "get_conclusions", { conclusion_ids: ["c1"] })).json).toEqual({
        conclusions: [],
        not_found: ["c1"],
      });
      expect(
        (await callTool(real, "get_derived_conclusions", { conclusion_id: "c1" })).isError,
      ).toBe(true);
      // Writes that need an existing target do not conjure it either.
      for (const [name, args] of [
        ["set_metadata", { peer_id: "ghost", metadata: { a: 1 } }],
        ["set_metadata", { session_id: "ghost", metadata: { a: 1 } }],
        ["clone_session", { session_id: "ghost" }],
        ["delete_session", { session_id: "ghost" }],
        ["add_sessions_to_scope", { scope_id: "ghost", session_ids: ["only"] }],
        ["schedule_dream", { peer_id: "ghost" }],
      ] as [string, Record<string, unknown>][]) {
        const out = await callTool(real, name, args);
        expect(out.isError, `${name}: ${out.text}`).toBe(true);
      }
      expect(await census()).toBe(before);
    } finally {
      await real.close();
    }
  });
});

describe("mcp full profile: tenancy and tokens", () => {
  const SECRET = "mcp-full-secret";
  const ADMIN = "operator-token-0123456789abcdef";
  let s: Served;
  const keys: Record<"A" | "B", string> = { A: "", B: "" };
  const headers = (t: "A" | "B") => ({
    Authorization: `Bearer ${keys[t]}`,
    "X-Recall-MCP-Profile": "full",
    "X-Recall-Workspace-ID": "shared",
  });
  beforeAll(async () => {
    s = await startServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: SECRET,
      RECALL_ADMIN_TOKEN: ADMIN,
      RECALL_KEY_CACHE_TTL_MS: "0",
    });
    for (const t of ["A", "B"] as const) {
      const acct = (await (
        await s.server.request(
          "POST",
          "/admin/v1/accounts",
          { name: `acct ${t}` },
          {
            authorization: `Bearer ${ADMIN}`,
          },
        )
      ).json()) as { id: string };
      const key = (await (
        await s.server.request(
          "POST",
          `/admin/v1/accounts/${acct.id}/keys`,
          {},
          {
            authorization: `Bearer ${ADMIN}`,
          },
        )
      ).json()) as { key: string };
      keys[t] = key.key;
    }
  });
  afterAll(() => s.stop());

  it("keeps two accounts using the same workspace, peer and session names apart", async () => {
    const a = await connect(s.url, headers("A"));
    const b = await connect(s.url, headers("B"));
    try {
      const seed = async (c: Client, tea: string) => {
        await callTool(c, "create_workspace", { workspace_id: "shared", metadata: { tea } });
        await callTool(c, "create_peer", { peer_id: "alice", configuration: {} });
        await callTool(c, "add_messages_to_session", {
          session_id: "s1",
          messages: [{ peer_id: "alice", content: `I drink ${tea}` }],
        });
        const made = await callTool(c, "create_conclusions", {
          peer_id: "alice",
          target_peer_id: "alice",
          conclusions: [`Alice drinks ${tea}`],
        });
        return made.json.conclusions[0].id as string;
      };
      const aId = await seed(a, "oolong");
      const bId = await seed(b, "matcha");

      for (const [c, mine, theirs] of [
        [a, "oolong", "matcha"],
        [b, "matcha", "oolong"],
      ] as [Client, string, string][]) {
        const seen = JSON.stringify([
          await callTool(c, "list_workspaces", {}),
          await callTool(c, "inspect_workspace", {}),
          await callTool(c, "get_metadata", {}),
          await callTool(c, "list_peers", {}),
          await callTool(c, "get_session_messages", { session_id: "s1" }),
          await callTool(c, "list_conclusions", { peer_id: "alice" }),
          await callTool(c, "query_conclusions", { peer_id: "alice", query: "tea" }),
          await callTool(c, "search", { query: "drink", peer_id: "alice" }),
          await callTool(c, "get_session_context", { session_id: "s1", peer_target: "alice" }),
          await callTool(c, "chat", { peer_id: "alice", query: "what does alice drink?" }),
        ]);
        expect(seen).toContain(mine);
        expect(seen).not.toContain(theirs);
      }

      // Ids from the other account are simply not there.
      const peek = await callTool(a, "get_conclusions", { conclusion_ids: [aId, bId] });
      expect(peek.json.conclusions.map((c: { id: string }) => c.id)).toEqual([aId]);
      expect(peek.json.not_found).toEqual([bId]);
      expect((await callTool(a, "get_derived_conclusions", { conclusion_id: bId })).isError).toBe(
        true,
      );
      const hostile = await callTool(a, "delete_conclusion", {
        peer_id: "alice",
        target_peer_id: "alice",
        conclusion_id: bId,
      });
      expect(hostile.isError).toBe(true);
      expect(
        (await callTool(b, "get_conclusions", { conclusion_ids: [bId] })).json.conclusions,
      ).toHaveLength(1);
      // A write by A never lands in B's workspace.
      await callTool(a, "set_metadata", { metadata: { tea: "changed-by-a" } });
      expect((await callTool(b, "get_metadata", {})).json).toEqual({ tea: "matcha" });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("pins a workspace-scoped token to its workspace", async () => {
    const token = signToken({ w: "pinned" }, SECRET);
    const client = await connect(s.url, {
      Authorization: `Bearer ${token}`,
      "X-Recall-MCP-Profile": "full",
    });
    try {
      expect(
        (await callTool(client, "create_workspace", { workspace_id: "pinned" })).isError,
      ).toBeFalsy();
      const other = await callTool(client, "create_workspace", { workspace_id: "rival" });
      expect(other.isError).toBe(true);
      expect(other.text).toContain("cannot access workspace 'rival'");
      const elsewhere = await callTool(client, "list_peers", { workspace_id: "rival" });
      expect(elsewhere.isError).toBe(true);
      const listed = await callTool(client, "list_workspaces", {});
      expect(listed.json.items.map((w: { id: string }) => w.id)).toEqual(["pinned"]);
    } finally {
      await client.close();
    }
  });

  it("keeps the profile choice behind authentication", async () => {
    const res = await fetch(`${s.url}?profile=full`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
