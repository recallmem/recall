import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { signToken } from "../src/http/auth.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

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
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
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

const TOOLS = [
  "add_messages_to_session",
  "chat",
  "create_conclusions",
  "delete_conclusion",
  "get_peer_card",
  "get_session_context",
  "list_conclusions",
  "search",
];

describe("mcp: tools over streamable HTTP", () => {
  let s: Served;
  let client: Client;
  beforeAll(async () => {
    s = await startServer();
    client = await connect(s.url, {
      "X-Recall-Workspace-ID": "acme",
      "X-Recall-User-Name": "alice",
    });
  });
  afterAll(async () => {
    await client.close();
    await s.stop();
  });

  it("advertises a small curated toolset with truthful annotations and instructions", async () => {
    expect(client.getServerVersion()?.name).toBe("Recall");
    expect(client.getInstructions()).toContain("add_messages_to_session");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);

    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of [
      "chat",
      "search",
      "get_session_context",
      "get_peer_card",
      "list_conclusions",
    ]) {
      expect(hints[name]?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["add_messages_to_session", "create_conclusions", "delete_conclusion"]) {
      expect(hints[name]?.readOnlyHint, name).toBe(false);
    }
    expect(hints.delete_conclusion?.destructiveHint).toBe(true);
    expect(hints.create_conclusions?.destructiveHint).toBe(false);
    // OpenAI's directory wants all three hints as explicit booleans on every tool.
    for (const t of tools) {
      for (const key of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[key], `${t.name} ${key}`).toBe("boolean");
      }
      if (t.annotations?.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
    }
    // No instruction to hand over the conversation (directory policy).
    expect(client.getInstructions()).toMatch(/never the whole conversation/);
    expect(client.getInstructions()?.slice(0, 512)).toContain(
      "save what the user asks you to remember",
    );
    // Argument docs reach the client.
    const record = tools.find((t) => t.name === "add_messages_to_session")!;
    expect(record.inputSchema.required).toEqual(["messages"]);
    expect(JSON.stringify(record.inputSchema)).toContain("Who said it");
  });

  it("records messages with connection defaults and replays an idempotent retry", async () => {
    const args = {
      session_id: "chat-1",
      messages: [
        { content: "I just moved to Utrecht." },
        { peer_id: "bot", content: "Welcome to Utrecht!", metadata: { turn: 1 } },
      ],
      idempotency_key: "rec-1",
    };
    const first = await call(client, "add_messages_to_session", args);
    expect(first.isError).toBeFalsy();
    expect(first.json).toMatchObject({ session_id: "chat-1", stored: 2, replayed: false });
    expect(first.json.messages.map((m: { peer_id: string }) => m.peer_id)).toEqual([
      "alice",
      "bot",
    ]);

    const retry = await call(client, "add_messages_to_session", args);
    expect(retry.json.replayed).toBe(true);
    expect(retry.json.messages.map((m: { id: string }) => m.id)).toEqual(
      first.json.messages.map((m: { id: string }) => m.id),
    );
    const [{ n }] = (await rows<{ n: number }>(
      s.server.ctx.db,
      sql`SELECT count(*)::int AS n FROM messages m JOIN sessions x ON x.id = m.session_id WHERE x.name = 'chat-1'`,
    )) as [{ n: number }];
    expect(n).toBe(2);
  });

  it("returns the session context, including the user's representation and card", async () => {
    await call(client, "create_conclusions", { conclusions: ["Alice lives in Utrecht"] });
    await s.server.request("PUT", "/v3/workspaces/acme/peers/alice/card", {
      peer_card: ["Lives in Utrecht"],
    });
    const ctxOut = await call(client, "get_session_context", {
      session_id: "chat-1",
      summary: false,
      tokens: 4000,
    });
    expect(ctxOut.isError).toBeFalsy();
    expect(ctxOut.json.messages.map((m: { content: string }) => m.content)).toEqual([
      "I just moved to Utrecht.",
      "Welcome to Utrecht!",
    ]);
    expect(ctxOut.json.peer_representation).toContain("Utrecht");
    expect(ctxOut.json.peer_card).toEqual(["Lives in Utrecht"]);

    const card = await call(client, "get_peer_card", {});
    expect(card.json).toEqual({
      peer_id: "alice",
      target_peer_id: "alice",
      peer_card: ["Lives in Utrecht"],
    });
    const none = await call(client, "get_peer_card", { peer_id: "bot" });
    expect(none.json.peer_card).toBeNull();
  });

  it("answers questions from memory and can return the evidence", async () => {
    const plain = await call(client, "chat", { query: "Where does Alice live?" });
    expect(plain.isError).toBeFalsy();
    expect(plain.text).toContain("Utrecht");

    const withEvidence = await call(client, "chat", {
      query: "Where does Alice live?",
      include_evidence: true,
      reasoning_level: "minimal",
    });
    expect(withEvidence.json.content).toContain("Utrecht");
    expect(withEvidence.json.abstained).toBe(false);
    expect(withEvidence.json.evidence.conclusions.length).toBeGreaterThan(0);
  });

  it("answers workspace-wide when no peer is given or defaulted", async () => {
    const bare = await connect(s.url, { "X-Recall-Workspace-ID": "acme" });
    try {
      const out = await call(bare, "chat", { query: "Where does Alice live?" });
      expect(out.isError).toBeFalsy();
      expect(out.text).toContain("Utrecht");
    } finally {
      await bare.close();
    }
  });

  it("searches messages and the user's facts together", async () => {
    const found = await call(client, "search", { query: "Utrecht" });
    expect(found.isError).toBeFalsy();
    expect(
      found.json.messages.some((m: { content: string }) => m.content.includes("Utrecht")),
    ).toBe(true);
    expect(found.json.conclusions.map((c: { content: string }) => c.content)).toContain(
      "Alice lives in Utrecht",
    );
    const scoped = await call(client, "search", {
      query: "Utrecht",
      session_id: "chat-1",
      conclusion_top_k: 0,
    });
    expect(scoped.json.conclusions).toEqual([]);
    expect(
      scoped.json.messages.every((m: { session_id: string }) => m.session_id === "chat-1"),
    ).toBe(true);
  });

  it("lists, queries, creates and deletes conclusions", async () => {
    const made = await call(client, "create_conclusions", {
      conclusions: ["Alice owns a dog named Rover", "Alice prefers tea over coffee"],
      session_id: "chat-1",
    });
    expect(made.json.created).toBe(2);
    const [dog] = made.json.conclusions as { id: string }[];

    const list = await call(client, "list_conclusions", { size: 50 });
    expect(list.json.total).toBe(3);
    expect(list.json.items.map((c: { content: string }) => c.content)).toEqual(
      expect.arrayContaining(["Alice owns a dog named Rover", "Alice lives in Utrecht"]),
    );
    const bySession = await call(client, "list_conclusions", { session_id: "chat-1" });
    expect(bySession.json.total).toBe(2);
    const explicit = await call(client, "list_conclusions", { filters: { level: "explicit" } });
    expect(explicit.json.total).toBe(3);
    const paged = await call(client, "list_conclusions", { size: 1, page: 2 });
    expect(paged.json).toMatchObject({ page: 2, size: 1, pages: 3 });

    const matches = await call(client, "list_conclusions", { query: "dog Rover", size: 1 });
    expect(matches.json.items).toHaveLength(1);
    expect(matches.json.items[0].content).toBe("Alice owns a dog named Rover");

    const removed = await call(client, "delete_conclusion", { conclusion_id: dog!.id });
    expect(removed.json).toEqual({ deleted: dog!.id });
    expect((await call(client, "list_conclusions", {})).json.total).toBe(2);
    const again = await call(client, "delete_conclusion", { conclusion_id: dog!.id });
    expect(again.isError).toBe(true);
    expect(again.text).toBe("Failed to delete the conclusion: Conclusion not found");
  });

  it("reports problems as tool errors the model can act on", async () => {
    const bare = await connect(s.url, { "X-Recall-Workspace-ID": "acme" });
    try {
      // No person named: the only person memory knows (alice, from the tests above), not an error.
      const noPeer = await call(bare, "get_peer_card", {});
      expect(noPeer.isError).toBeFalsy();
      expect(JSON.parse(noPeer.text).peer_id).toBe("alice");
      const noSession = await call(bare, "add_messages_to_session", {
        messages: [{ peer_id: "alice", content: "x" }],
      });
      expect(noSession.text).toContain("session_id is required");
      const bad = await call(bare, "create_conclusions", {
        conclusions: ["x"],
        peer_id: "scope.team",
      });
      expect(bad.isError).toBe(true);
    } finally {
      await bare.close();
    }
    // Schema violations are rejected by the protocol layer.
    const invalid = await client
      .callTool({ name: "search", arguments: { query: "" } })
      .catch((e) => e);
    expect(invalid.isError ?? invalid.message).toBeTruthy();
  });
});

describe("mcp: connections without a default person (chat apps cannot set headers)", () => {
  let s: Served;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  it("uses the only person memory knows, and names them all when there are several", async () => {
    const c = await connect(s.url, { "X-Recall-Workspace-ID": "people" });
    try {
      // Nobody remembered yet: "user", with an empty answer rather than an error.
      expect(JSON.parse((await call(c, "get_peer_card", {})).text)).toMatchObject({
        peer_id: "user",
        peer_card: null,
      });
      await call(c, "create_conclusions", { conclusions: ["Maya runs"], peer_id: "maya" });
      const one = JSON.parse((await call(c, "list_conclusions", {})).text);
      expect(one.items.map((i: { content: string }) => i.content)).toEqual(["Maya runs"]);
      // A first write without a person goes to the only person too.
      await call(c, "create_conclusions", { conclusions: ["Maya swims"] });
      expect(JSON.parse((await call(c, "list_conclusions", {})).text).items).toHaveLength(2);

      await call(c, "create_conclusions", { conclusions: ["Ravi cooks"], peer_id: "ravi" });
      const several = await call(c, "get_peer_card", {});
      expect(several.isError).toBe(true);
      expect(several.text).toContain("several people (maya, ravi)");
      expect(several.text).toContain("Pass peer_id");
    } finally {
      await c.close();
    }
  });
});

describe("mcp: read-only tools never create anything", () => {
  let s: Served;
  let client: Client;
  beforeAll(async () => {
    s = await startServer();
    client = await connect(s.url, {
      "X-Recall-Workspace-ID": "ghost",
      "X-Recall-User-Name": "nobody",
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
                  + (SELECT count(*) FROM conclusions) AS n`,
      )
    )[0]!.n;

  it("answers empty for unknown workspaces, peers and sessions instead of creating them", async () => {
    const { tools } = await client.listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly.sort()).toEqual(
      ["chat", "get_peer_card", "get_session_context", "list_conclusions", "search"].sort(),
    );
    const before = await census();
    const args: Record<string, Record<string, unknown>> = {
      chat: { query: "who is nobody?" },
      search: { query: "anything" },
      get_session_context: { session_id: "nope" },
      get_peer_card: {},
      list_conclusions: {},
    };
    // A fresh connector's first calls: nothing yet, said plainly, and no model call for chat.
    for (const name of readOnly) {
      const out = await call(client, name, args[name]);
      expect(out.isError, name).toBeFalsy();
      expect(out.text, name).toContain("Nothing is remembered here yet");
    }
    expect(await census()).toBe(before);
  });

  it("leaves an existing workspace untouched when a peer or session is unknown", async () => {
    await call(client, "add_messages_to_session", {
      session_id: "real",
      messages: [{ peer_id: "somebody", content: "hello there" }],
    });
    const before = await census();
    const calls: [string, Record<string, unknown>, RegExp][] = [
      ["chat", { query: "hi?" }, /Nothing is remembered here yet/],
      ["chat", { query: "hi?", peer_id: "somebody", session_id: "ghost-session" }, /(?:)/],
      ["get_peer_card", { peer_id: "stranger" }, /Nothing is remembered here yet/],
      ["get_session_context", { session_id: "nope" }, /Nothing is remembered here yet/],
      ["search", { query: "hello", session_id: "nope" }, /Nothing is remembered here yet/],
    ];
    for (const [name, args, expected] of calls) {
      const out = await call(client, name, args);
      expect(out.text, name).toMatch(expected);
    }
    // Searching and listing for peers that do not exist yet is just empty.
    expect((await call(client, "search", { query: "hello" })).json).toMatchObject({
      messages: [{ content: "hello there" }],
      conclusions: [],
    });
    expect((await call(client, "list_conclusions", { peer_id: "stranger" })).json.items).toEqual(
      [],
    );
    expect(await census()).toBe(before);
  });
});

describe("mcp: connection defaults", () => {
  let s: Served;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  const wsOf = async (session: string) =>
    (
      await rows<{ w: string }>(
        s.server.ctx.db,
        sql`SELECT w.name AS w FROM sessions x JOIN workspaces w ON w.id = x.workspace_id WHERE x.name = ${session}`,
      )
    )[0]?.w;

  it("uses X-Recall-*, falls back to X-Honcho-*, and defaults the workspace to 'default'", async () => {
    const record = (c: Client, session: string) =>
      call(c, "add_messages_to_session", { session_id: session, messages: [{ content: "hi" }] });

    const recall = await connect(s.url, {
      "X-Recall-Workspace-ID": "ws-recall",
      "X-Recall-User-Name": "pat",
      "X-Recall-Session-ID": "from-header",
    });
    const honcho = await connect(s.url, {
      "X-Honcho-Workspace-ID": "ws-honcho",
      "X-Honcho-User-Name": "hannah",
    });
    const plain = await connect(s.url);
    try {
      expect((await record(recall, "s-a")).json.messages[0].peer_id).toBe("pat");
      expect(await wsOf("s-a")).toBe("ws-recall");
      expect((await record(honcho, "s-b")).json.messages[0].peer_id).toBe("hannah");
      expect(await wsOf("s-b")).toBe("ws-honcho");
      expect(
        (
          await call(plain, "add_messages_to_session", {
            session_id: "s-c",
            messages: [{ peer_id: "x", content: "hi" }],
          })
        ).isError,
      ).toBeFalsy();
      expect(await wsOf("s-c")).toBe("default");

      // The session header supplies session_id.
      const viaHeader = await call(recall, "add_messages_to_session", {
        messages: [{ content: "yo" }],
      });
      expect(viaHeader.json.session_id).toBe("from-header");
      // An explicit workspace_id argument wins over the header.
      await call(recall, "add_messages_to_session", {
        workspace_id: "elsewhere",
        session_id: "s-d",
        messages: [{ content: "hi" }],
      });
      expect(await wsOf("s-d")).toBe("elsewhere");
    } finally {
      await Promise.all([recall.close(), honcho.close(), plain.close()]);
    }
  });

  it("rejects malformed ids in headers and unsupported verbs", async () => {
    const bad = await fetch(s.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-recall-workspace-id": "no spaces allowed",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(bad.status).toBe(400);
    const get = await fetch(s.url, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await fetch(s.url, { method: "DELETE" })).status).toBe(405);
  });

  it("tolerates a client that omits the event-stream media type from Accept", async () => {
    const res = await fetch(s.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(8);
  });
});

describe("mcp: auth", () => {
  const secret = "mcp-secret";
  let s: Served;
  const bearer = (claims: Parameters<typeof signToken>[0]) => ({
    Authorization: `Bearer ${signToken(claims, secret)}`,
  });
  const rpc = (headers: Record<string, string> = {}) =>
    fetch(s.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  beforeAll(async () => {
    s = await startServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: secret });
  });
  afterAll(() => s.stop());

  it("requires the same bearer token as the API, and challenges when it is missing", async () => {
    const none = await rpc();
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await rpc({ Authorization: "Bearer not-a-jwt" })).status).toBe(401);
    expect((await rpc(bearer({ w: "acme" }))).status).toBe(200);
    expect((await rpc(bearer({ ad: true }))).status).toBe(200);
  });

  it("refuses peer and session tokens", async () => {
    expect((await rpc(bearer({ w: "acme", p: "alice" }))).status).toBe(401);
    expect((await rpc(bearer({ w: "acme", s: "chat" }))).status).toBe(401);
  });

  it("pins a workspace token to its workspace", async () => {
    // The token's workspace is the default when no header is sent.
    const client = await connect(s.url, bearer({ w: "acme" }));
    try {
      const ok = await call(client, "add_messages_to_session", {
        session_id: "t1",
        messages: [{ peer_id: "alice", content: "hello" }],
      });
      expect(ok.isError).toBeFalsy();
      const row = await rows<{ w: string }>(
        s.server.ctx.db,
        sql`SELECT w.name AS w FROM sessions x JOIN workspaces w ON w.id = x.workspace_id WHERE x.name = 't1'`,
      );
      expect(row[0]!.w).toBe("acme");
      // A tool argument cannot reach past the claim.
      const other = await call(client, "add_messages_to_session", {
        workspace_id: "rival",
        session_id: "t2",
        messages: [{ peer_id: "alice", content: "hello" }],
      });
      expect(other.isError).toBe(true);
      expect(other.text).toContain("cannot access workspace 'rival'");
    } finally {
      await client.close();
    }
    // Neither can the header.
    expect((await rpc({ ...bearer({ w: "acme" }), "X-Recall-Workspace-ID": "rival" })).status).toBe(
      401,
    );
    // Admin tokens may use any workspace.
    expect((await rpc({ ...bearer({ ad: true }), "X-Recall-Workspace-ID": "rival" })).status).toBe(
      200,
    );
  });
});
