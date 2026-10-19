import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IExecuteFunctions, ISupplyDataFunctions } from "n8n-workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Recall as RecallClient } from "../../sdk/src/index.js";
import { startTestServer, type TestServer } from "../../sdk/test/harness.js";
import { RecallApi } from "../src/credentials/RecallApi.credentials.js";
import { Recall } from "../src/nodes/Recall/Recall.node.js";
import { RecallMemory } from "../src/nodes/RecallMemory/RecallMemory.node.js";
import { recallClient, safeId, split } from "../src/shared/api.js";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const ROOT = join(__dirname, "..");

interface Http {
  method: string;
  url: string;
  qs?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** n8n's request helper over fetch: throws on an error status the way n8n's does (httpCode). */
async function fetchJson(opts: Http) {
  const url = new URL(opts.url);
  for (const [k, v] of Object.entries(opts.qs ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: opts.method,
    headers: { ...opts.headers, ...(opts.body ? { "content-type": "application/json" } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw Object.assign(new Error(`Request failed with status code ${res.status}`), {
      httpCode: String(res.status),
      response: { status: res.status, data },
    });
  }
  return data;
}

/** The part of n8n's node context these nodes use. */
function context(
  workspace: string,
  params: Record<string, unknown>,
  opts: { items?: number; request?: (o: Http) => Promise<unknown>; continueOnFail?: boolean } = {},
) {
  const requests: Http[] = [];
  const logged: string[] = [];
  return {
    requests,
    logged,
    ctx: {
      getNode: () => ({
        id: "node-1",
        name: "Recall",
        type: "recall",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      }),
      getCredentials: async () => ({ apiKey: "", baseUrl: `${server.url}/`, workspace }),
      getNodeParameter: (name: string, _item: number, fallback?: unknown) =>
        name in params ? params[name] : fallback,
      getInputData: () => Array.from({ length: opts.items ?? 1 }, () => ({ json: {} })),
      continueOnFail: () => opts.continueOnFail ?? false,
      addInputData: (_type: string, data: { json: { action: string } }[][]) => {
        logged.push(`in:${data[0]?.[0]?.json.action}`);
        return { index: 0 };
      },
      addOutputData: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      helpers: {
        httpRequestWithAuthentication: async (_credential: string, o: Http) => {
          requests.push(o);
          return (opts.request ?? fetchJson)(o);
        },
      },
    },
  };
}

const fresh = () => `n8n-${Math.random().toString(36).slice(2, 9)}`;
const sdk = (workspace: string) =>
  new RecallClient({ baseURL: server.url, workspaceId: workspace, retryBaseDelay: 5 });

/** The memory n8n's AI Agent gets from the Recall Memory node. */
async function memoryFor(workspace: string, params: Record<string, unknown>) {
  const { ctx, logged } = context(workspace, params);
  const supplied = await new RecallMemory().supplyData.call(
    ctx as unknown as ISupplyDataFunctions,
    0,
  );
  return {
    logged,
    memory: supplied.response as {
      loadMemoryVariables(
        values: object,
      ): Promise<{ chat_history: { _getType(): string; content: unknown }[] }>;
      saveContext(input: object, output: object): Promise<void>;
      clear(): Promise<void>;
    },
  };
}

/** LangChain content is a string or a list of blocks; the text either way. */
const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as { type: string; text?: string }[])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");

const history = async (memory: Awaited<ReturnType<typeof memoryFor>>["memory"]) =>
  (await memory.loadMemoryVariables({})).chat_history.map((m) => [m._getType(), textOf(m.content)]);

describe("Recall Memory (AI Agent memory)", () => {
  it("brings what Recall knows about the user, stores each turn, and keeps the agent out of the facts", async () => {
    const workspace = fresh();
    await sdk(workspace).peer("alice").conclusions.create("Is vegetarian.");
    const { memory, logged } = await memoryFor(workspace, {
      sessionId: "chat-1",
      userId: "alice",
      options: { query: "Plan a dinner for four" },
    });

    // A new conversation: only what Recall knows from before, as one system message.
    const first = await history(memory);
    expect(first).toHaveLength(1);
    expect(first[0]![0]).toBe("system");
    expect(first[0]![1]).toContain("Is vegetarian.");
    expect(first[0]![1]).toContain("(alice)");

    await memory.saveContext(
      { input: "Plan a dinner for four." },
      { output: "A mushroom risotto." },
    );
    const recall = sdk(workspace);
    expect(
      (await (await recall.session("chat-1").messages()).toArray()).map((m) => [
        m.peerId,
        m.content,
      ]),
    ).toEqual([
      ["alice", "Plan a dinner for four."],
      ["assistant", "A mushroom risotto."],
    ]);
    expect((await recall.peer("assistant").getConfiguration()).observeMe).toBe(false);

    // The next turn has the conversation after the memory.
    expect((await history(memory)).slice(1)).toEqual([
      ["human", "Plan a dinner for four."],
      ["ai", "A mushroom risotto."],
    ]);
    // n8n's log wrapper saw both calls (it shows them in the execution view).
    expect(logged).toContain("in:loadMemoryVariables");
    expect(logged).toContain("in:saveContext");
  });

  it("remembers the user in a new conversation, and can carry memory as a user message", async () => {
    const workspace = fresh();
    const one = await memoryFor(workspace, { sessionId: "monday", userId: "jane@example.com" });
    await one.memory.saveContext({ input: "Hi" }, { output: "Hello!" });
    await sdk(workspace).peer("jane_example_com").conclusions.create("Works night shifts.");

    const two = await memoryFor(workspace, {
      sessionId: "tuesday",
      userId: "jane@example.com",
      options: { placement: "user" },
    });
    const loaded = await history(two.memory);
    expect(loaded).toHaveLength(1); // the new conversation is empty
    expect(loaded[0]![0]).toBe("human");
    expect(loaded[0]![1]).toContain("Works night shifts.");
  });

  it("starts empty for someone Recall has never seen, and leaves memory out when asked", async () => {
    const workspace = fresh();
    const { memory } = await memoryFor(workspace, { sessionId: "s", userId: "nobody" });
    expect(await history(memory)).toEqual([]);

    await sdk(workspace).peer("known").conclusions.create("Likes tea.");
    const off = await memoryFor(workspace, {
      sessionId: "s2",
      userId: "known",
      options: { knowledge: false },
    });
    expect(await history(off.memory)).toEqual([]);
  });

  it("clears a conversation by deleting its session", async () => {
    const workspace = fresh();
    const { memory } = await memoryFor(workspace, { sessionId: "gone", userId: "u1" });
    await memory.saveContext({ input: "Remember this" }, { output: "Okay" });
    await memory.clear();
    expect(await history(memory)).toEqual([]);
  });

  it("refuses an empty session or user", async () => {
    const workspace = fresh();
    await expect(memoryFor(workspace, { sessionId: "", userId: "a" })).rejects.toThrow(
      /Session ID is empty/,
    );
    await expect(memoryFor(workspace, { sessionId: "s", userId: " " })).rejects.toThrow(
      /User ID is empty/,
    );
  });
});

describe("Recall (node and agent tool)", () => {
  const execute = async (
    workspace: string,
    params: Record<string, unknown>,
    opts: { continueOnFail?: boolean } = {},
  ) => {
    const { ctx } = context(workspace, params, opts);
    const [out] = await new Recall().execute.call(ctx as unknown as IExecuteFunctions);
    return out!.map((item) => item.json as Record<string, unknown>);
  };

  it("remembers, searches, answers and stores messages", async () => {
    const workspace = fresh();
    const [saved] = await execute(workspace, {
      operation: "remember",
      userId: "bob",
      fact: "Is allergic to peanuts.",
    });
    expect(saved).toMatchObject({ userId: "bob", saved: true, id: expect.any(String) });

    const [found] = await execute(workspace, {
      operation: "search",
      userId: "bob",
      query: "peanuts",
      limit: 5,
    });
    expect((found!.facts as { content: string }[]).map((f) => f.content)).toContain(
      "Is allergic to peanuts.",
    );

    const [asked] = await execute(workspace, {
      operation: "ask",
      userId: "bob",
      question: "What is Bob allergic to?",
      reasoningLevel: "minimal",
    });
    expect(String(asked!.answer)).toContain("peanuts");

    const [added] = await execute(workspace, {
      operation: "addMessage",
      userId: "bob",
      sessionId: "ticket 4821",
      role: "user",
      message: `My order is late. ${"x".repeat(30_000)}`,
    });
    expect(added).toMatchObject({ sessionId: "ticket_4821", stored: 2 });

    const [profile] = await execute(workspace, { operation: "profile", userId: "bob" });
    expect(Array.isArray(profile!.profile)).toBe(true);
  });

  it("answers nothing, rather than failing, about someone Recall has never seen", async () => {
    const workspace = fresh();
    expect(
      await execute(workspace, { operation: "ask", userId: "stranger", question: "Who is this?" }),
    ).toEqual([{ userId: "stranger", question: "Who is this?", answer: null }]);
    const [found] = await execute(workspace, {
      operation: "search",
      userId: "stranger",
      query: "x",
    });
    expect(found).toMatchObject({ facts: [], messages: [] });
    const [profile] = await execute(workspace, { operation: "profile", userId: "stranger" });
    expect(profile).toMatchObject({ profile: [] });
  });

  it("reports a missing field per item when Continue On Fail is on", async () => {
    const workspace = fresh();
    await expect(
      execute(workspace, { operation: "ask", userId: "a", question: " " }),
    ).rejects.toThrow(/Question is empty/);
    expect(
      await execute(
        workspace,
        { operation: "ask", userId: "", question: "q" },
        { continueOnFail: true },
      ),
    ).toEqual([{ error: "User ID is empty" }]);
  });
});

describe("requests", () => {
  it("retry a busy session and rate limits, then give up with n8n's API error", async () => {
    let calls = 0;
    const busy = context(
      "w",
      {},
      {
        request: async () => {
          calls++;
          if (calls < 3) throw Object.assign(new Error("busy"), { httpCode: "409" });
          return { ok: true };
        },
      },
    );
    const recall = await recallClient(busy.ctx as unknown as IExecuteFunctions);
    expect(await recall("POST", "/x", { idempotencyKey: "k" })).toEqual({ ok: true });
    expect(calls).toBe(3);
    // Every attempt carried the same idempotency key, so a retry is never stored twice.
    expect(new Set(busy.requests.map((r) => r.headers?.["idempotency-key"]))).toEqual(
      new Set(["k"]),
    );

    const refused = context(
      "w",
      {},
      {
        request: async () => {
          throw Object.assign(new Error("Unauthorized"), { httpCode: "401" });
        },
      },
    );
    const denied = await recallClient(refused.ctx as unknown as IExecuteFunctions);
    await expect(denied("GET", "/x")).rejects.toThrow();
    expect(refused.requests).toHaveLength(1); // a refused key is not retried
  });

  it("use the credential's server and workspace, and its test request works", async () => {
    const workspace = fresh();
    const { ctx, requests } = context(workspace, {});
    const recall = await recallClient(ctx as unknown as IExecuteFunctions);
    await recall("GET", "/peers/x/card", { allowNotFound: true });
    expect(requests[0]!.url).toBe(`${server.url}/v3/workspaces/${workspace}/peers/x/card`);

    const test = new RecallApi().test.request;
    expect(test).toMatchObject({ url: "/v3/workspaces", method: "POST" });
    const res = await fetch(`${server.url}${test.url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workspace }),
    });
    expect(res.ok).toBe(true);
  });

  it("turn any name into an id Recall accepts, and split long text", () => {
    expect(safeId("jane@example.com")).toBe("jane_example_com");
    expect(safeId("  ")).toBe("");
    expect(safeId("@@", "fallback")).toBe("fallback");
    expect(safeId("user-42_ok")).toBe("user-42_ok");
    const parts = split(`${"a ".repeat(20_000)}`, 24_000);
    expect(parts.length).toBe(2);
    expect(parts.join("")).toBe("a ".repeat(20_000));
    expect(parts.every((p) => p.length <= 24_000)).toBe(true);
  });
});

describe("package", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  it("is an n8n community package that n8n can verify: listed nodes, no runtime dependencies", () => {
    expect(pkg.name).toMatch(/^@recall-memory\/n8n-nodes-/);
    expect(pkg.keywords).toContain("n8n-community-node-package");
    expect(pkg.license).toBe("MIT");
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const file of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
      const source = join(ROOT, file.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
      expect(readFileSync(source, "utf8").length, file).toBeGreaterThan(0);
    }
    expect(readFileSync(join(ROOT, "src/nodes/Recall/recall.svg"), "utf8")).toContain("<svg");
  });

  it("documents the nodes in its README", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const term of ["Recall Memory", "User ID", "Memory Placement", pkg.name])
      expect(readme).toContain(term);
  });
});
