import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliIo, run } from "../src/cli.js";
import { signToken } from "../src/http/auth.js";
import { drainQueue } from "../src/queue/worker.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/** The resource commands (`recall peer card`, `recall session messages`, ...) against an in-process server. */

interface Captured {
  code: number | null;
  out: string;
  err: string;
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON output
  json: any;
}

let home: string;
let server: ApiServer;

/** Runs the CLI with its `fetch` wired straight to the server's app: no sockets. */
async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  s: ApiServer = server,
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env: { HOME: home, RECALL_URL: "http://recall.test", ...env },
    fetch: async (input, init) => s.app.fetch(new Request(input, init)),
  };
  const code = await run(args, io);
  const text = out.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  return { code, out: text, err: err.join("\n"), json };
}

const ME = { RECALL_WORKSPACE_ID: "acme", RECALL_PEER_ID: "alice" };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "recall-cli-"));
  server = await createTestServer();
  const post = async (path: string, body: unknown) => {
    const res = await server.request("POST", path, body);
    expect(res.status, path).toBeLessThan(300);
  };
  await post("/v3/workspaces/acme/sessions/chat-1/messages", {
    messages: [
      { peer_id: "alice", content: "I just moved to Utrecht and I love cycling." },
      { peer_id: "bot", content: "Welcome to Utrecht!" },
    ],
  });
  await post("/v3/workspaces/acme/sessions/chat-2/messages", {
    messages: [{ peer_id: "bob", content: "I am a baker in Delft." }],
  });
  await post("/v3/workspaces/acme/conclusions", {
    conclusions: [
      { content: "Alice lives in Utrecht", observer_id: "alice", observed_id: "alice" },
      { content: "Alice loves cycling", observer_id: "alice", observed_id: "alice" },
      { content: "Bob bakes bread", observer_id: "bob", observed_id: "bob" },
    ],
  });
  await server.request("PUT", "/v3/workspaces/acme/peers/alice/card", {
    peer_card: ["Lives in Utrecht", "Cycles everywhere"],
  });
});

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

describe("cli: workspace", () => {
  it("lists workspaces as a table and as JSON", async () => {
    const table = await cli(["workspace", "list"]);
    expect(table.code).toBe(0);
    expect(table.out).toMatch(/^ID\s+CREATED\s+METADATA/);
    expect(table.out).toContain("acme");

    const json = await cli(["workspace", "list", "--json"]);
    expect(Array.isArray(json.json)).toBe(true);
    expect(json.json.map((w: { id: string }) => w.id)).toEqual(["acme"]);
  });

  it("inspects a workspace", async () => {
    const res = await cli(["workspace", "inspect", "--json"], ME);
    expect(res.json).toMatchObject({ id: "acme", peer_count: 3, session_count: 2 });
    expect(res.json.peers.sort()).toEqual(["alice", "bob", "bot"]);
    expect(res.json.queue).toHaveProperty("pending");

    const human = await cli(["workspace", "inspect", "acme"]);
    expect(human.out).toContain("peers:");
    expect(human.out).toContain("3");
    // The workspace can be a positional, a flag or the default.
    expect((await cli(["workspace", "inspect", "-w", "acme", "--json"])).json.id).toBe("acme");

    const missing = await cli(["workspace", "inspect", "nowhere", "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err).error).toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  it("answers `workspace queue-status` like `queue status`", async () => {
    const a = await cli(["workspace", "queue-status", "--json"], ME);
    const b = await cli(["queue", "status", "--json"], ME);
    expect(Object.keys(a.json).sort()).toEqual(Object.keys(b.json).sort());
  });
});

describe("cli: peer", () => {
  it("lists and inspects peers", async () => {
    const list = await cli(["peer", "list"], ME);
    expect(list.out).toMatch(/^ID\s+CREATED/);
    for (const id of ["alice", "bob", "bot"]) expect(list.out).toContain(id);
    expect((await cli(["peer", "list", "--json"], ME)).json).toHaveLength(3);
    expect((await cli(["peer", "list", "--limit", "1", "--json"], ME)).json).toHaveLength(1);
    expect((await cli(["peer", "list", "--limit", "1"], ME)).out).toContain("Showing 1 of 3");

    const inspect = await cli(["peer", "inspect", "--json"], ME);
    expect(inspect.err).toBe("");
    expect(inspect.json).toMatchObject({
      id: "alice",
      workspace_id: "acme",
      peer_card: ["Lives in Utrecht", "Cycles everywhere"],
      session_count: 1,
      conclusion_count: 2,
    });
    const human = await cli(["peer", "inspect", "bob"], ME);
    expect(human.out).toContain("peer:");
    expect(human.out).toContain("Card: (none yet)");

    const missing = await cli(["peer", "inspect", "ghost", "--json"], ME);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err).error.code).toBe("PEER_NOT_FOUND");
  });

  it("shows the peer card", async () => {
    const card = await cli(["peer", "card"], ME);
    expect(card.out).toBe("- Lives in Utrecht\n- Cycles everywhere");
    expect((await cli(["peer", "card", "--json"], ME)).json).toEqual({
      peer_id: "alice",
      target_id: "alice",
      peer_card: ["Lives in Utrecht", "Cycles everywhere"],
    });
    expect((await cli(["peer", "card", "bob"], ME)).out).toBe("No card for 'bob' yet.");
    // `-p` and `--workspace` work as flags, wherever they sit.
    expect((await cli(["peer", "-w", "acme", "card", "-p", "alice"])).out).toContain("Utrecht");
  });

  it("chats and searches", async () => {
    const chat = await cli(["peer", "chat", "Where", "does", "Alice", "live?"], ME);
    expect(chat.code).toBe(0);
    expect(chat.out).toContain("Utrecht");
    const evidence = await cli(
      ["peer", "chat", "Where does Alice live?", "--evidence", "-r", "minimal", "--json"],
      ME,
    );
    expect(evidence.json.content).toContain("Utrecht");
    expect(evidence.json.evidence).toBeTruthy();

    const search = await cli(["peer", "search", "Utrecht"], ME);
    expect(search.out).toMatch(/^SESSION\s+WHEN\s+CONTENT/);
    expect(search.out).toContain("chat-1");
    const json = await cli(["peer", "search", "Utrecht", "--limit", "1", "--json"], ME);
    expect(json.json).toHaveLength(1);
    expect(json.json[0]).toMatchObject({ peer_id: "alice" });
    expect((await cli(["peer", "search", "zzzzqqq"], ME)).out).toContain("Nothing found");
  });

  it("needs a peer and a question, and says so", async () => {
    const noPeer = await cli(["peer", "chat", "hello?"], { RECALL_WORKSPACE_ID: "acme" });
    expect(noPeer.code).toBe(2);
    expect(noPeer.err).toContain("no peer");
    const noQuery = await cli(["peer", "chat"], ME);
    expect(noQuery.code).toBe(2);
    expect(noQuery.err).toContain("needs a question");
    expect((await cli(["peer", "card", "bad id!"], ME)).code).toBe(2);
  });
});

describe("cli: session", () => {
  it("lists sessions, optionally for one peer", async () => {
    const all = await cli(["session", "list", "--json"], ME);
    expect(all.json.map((s: { id: string }) => s.id).sort()).toEqual(["chat-1", "chat-2"]);
    // Only an explicit -p narrows the list, not the configured default peer.
    const bob = await cli(["session", "list", "-p", "bob", "--json"], ME);
    expect(bob.err).toBe("");
    expect(bob.json.map((s: { id: string }) => s.id)).toEqual(["chat-2"]);
    expect((await cli(["session", "list"], ME)).out).toMatch(/^ID\s+ACTIVE\s+CREATED/);
  });

  it("inspects a session", async () => {
    const res = await cli(["session", "inspect", "chat-1", "--json"], ME);
    expect(res.json).toMatchObject({ id: "chat-1", is_active: true, message_count: 2 });
    expect(res.json.peers.sort()).toEqual(["alice", "bot"]);
    expect((await cli(["session", "inspect", "-s", "chat-2"], ME)).out).toContain("messages:");
    const missing = await cli(["session", "inspect", "nope", "--json"], ME);
    expect(JSON.parse(missing.err).error.code).toBe("SESSION_NOT_FOUND");
    const none = await cli(["session", "inspect"], ME);
    expect(none.code).toBe(2);
    expect(none.err).toContain("no session");
  });

  it("prints the transcript", async () => {
    const table = await cli(["session", "messages", "chat-1"], ME);
    expect(table.out).toMatch(/^WHEN\s+PEER\s+CONTENT/);
    expect(table.out.indexOf("moved to Utrecht")).toBeLessThan(table.out.indexOf("Welcome"));
    const json = await cli(["session", "messages", "chat-1", "--json", "--reverse"], ME);
    expect(json.json.map((m: { peer_id: string }) => m.peer_id)).toEqual(["bot", "alice"]);
    const last = await cli(["session", "messages", "chat-1", "--last", "1", "--json"], ME);
    expect(last.json).toHaveLength(1);
    expect(last.json[0].content).toBe("Welcome to Utrecht!");
    const authored = await cli(["session", "messages", "chat-1", "-p", "alice", "--json"], ME);
    expect(authored.json).toHaveLength(1);
    expect((await cli(["session", "messages", "chat-1", "--ids"], ME)).out).toMatch(/^ID\s+WHEN/);
  });

  it("shows the context an agent would receive", async () => {
    const res = await cli(["session", "context", "chat-1", "--no-summary", "--json"], ME);
    expect(res.json.messages).toHaveLength(2);
    expect(res.json.peer_card).toEqual(["Lives in Utrecht", "Cycles everywhere"]);
    expect(res.json.peer_representation).toContain("Utrecht");
    const human = await cli(["session", "context", "chat-1", "--tokens", "2000"], ME);
    expect(human.out).toContain("Card (alice):");
    expect(human.out).toContain("Messages (2):");
    expect(human.out).toContain("alice: I just moved to Utrecht");
    expect((await cli(["session", "context", "chat-1", "--tokens", "lots"], ME)).code).toBe(2);
  });
});

describe("cli: conclusion", () => {
  it("lists, searches, creates and deletes", async () => {
    const list = await cli(["conclusion", "list", "--json"], ME);
    expect(list.json.map((c: { content: string }) => c.content).sort()).toEqual([
      "Alice lives in Utrecht",
      "Alice loves cycling",
    ]);
    expect(
      (await cli(["conclusion", "list", "--observer", "bob", "--json"], ME)).json,
    ).toHaveLength(1);
    expect((await cli(["conclusion", "list"], ME)).out).toMatch(
      /^ID\s+WHO\s+LEVEL\s+SEEN\s+CONTENT/,
    );
    expect((await cli(["conclusion", "list", "--limit", "1"], ME)).out).toContain("Showing 1 of 2");

    const found = await cli(["conclusion", "search", "cycling", "--top-k", "1", "--json"], ME);
    expect(found.json).toHaveLength(1);
    expect(found.json[0].content).toBe("Alice loves cycling");
    expect((await cli(["conclusion", "search", "cycling"], ME)).out).toContain(
      "Alice loves cycling",
    );

    const made = await cli(
      ["conclusion", "create", "Alice owns a dog named Rover", "Alice prefers tea", "--json"],
      ME,
    );
    expect(made.code).toBe(0);
    expect(made.json).toHaveLength(2);
    expect(made.json[0]).toMatchObject({
      observer_id: "alice",
      observed_id: "alice",
      level: "explicit",
    });
    const dog = made.json[0].id as string;
    const about = await cli(
      [
        "conclusion",
        "create",
        "Bob is a friend",
        "--observer",
        "alice",
        "--observed",
        "bob",
        "-s",
        "chat-2",
      ],
      ME,
    );
    expect(about.out).toContain("alice>bob");

    // Deleting needs confirmation.
    const unconfirmed = await cli(["conclusion", "delete", dog], ME);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("--yes");
    expect((await cli(["conclusion", "list", "--limit", "50", "--json"], ME)).json).toHaveLength(4);

    const deleted = await cli(["conclusion", "delete", dog, "--yes", "--json"], ME);
    expect(deleted.json).toEqual({ deleted: [dog] });
    expect((await cli(["conclusion", "list", "--limit", "50", "--json"], ME)).json).toHaveLength(3);
    const again = await cli(["conclusion", "delete", dog, "-y", "--json"], ME);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.err).error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("needs an observer for search and create", async () => {
    const res = await cli(["conclusion", "search", "x"], { RECALL_WORKSPACE_ID: "acme" });
    expect(res.code).toBe(2);
    expect(res.err).toContain("needs an observer");
    expect((await cli(["conclusion", "create"], ME)).code).toBe(2);
  });
});

describe("cli: queue", () => {
  it("reports background work, and can wait for it", async () => {
    // Nothing runs the worker in this harness: the seeded messages are still waiting.
    const waiting = await cli(["queue", "status", "--wait", "50", "--json"], ME);
    expect(waiting.json.idle).toBe(false);
    expect((await cli(["queue", "status", "--wait", "50"], ME)).out).toContain(
      "no (gave up waiting)",
    );
    await drainQueue(server.ctx);
    const res = await cli(["queue", "status", "--json"], ME);
    expect(res.json).toMatchObject({
      total_work_units: expect.any(Number),
      pending_work_units: expect.any(Number),
    });
    const waited = await cli(["queue", "status", "--wait", "5000", "--json"], ME);
    expect(waited.json.idle).toBe(true);
    const human = await cli(["queue", "status", "--wait", "5000"], ME);
    expect(human.out).toContain("work units:");
    expect(human.out).toContain("idle:");
    expect((await cli(["queue", "status", "-s", "chat-1", "--json"], ME)).json.sessions).toBeNull();
  });
});

describe("cli: output, errors and usage", () => {
  it("prints JSON whenever RECALL_JSON is set", async () => {
    const res = await cli(["peer", "list"], { ...ME, RECALL_JSON: "1" });
    expect(Array.isArray(res.json)).toBe(true);
  });

  it("reports an unreachable server in one line, or as a JSON error", async () => {
    const refuse: typeof fetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      env: { HOME: home, RECALL_URL: "http://127.0.0.1:1" },
      fetch: refuse,
    };
    expect(await run(["peer", "list"], io)).toBe(1);
    expect(err[0]).toMatch(
      /^recall peer: Could not reach http:\/\/127\.0\.0\.1:1 \(ECONNREFUSED\)/,
    );
    err.length = 0;
    expect(await run(["peer", "list", "--json"], io)).toBe(1);
    expect(JSON.parse(err[0]!).error).toMatchObject({ code: "CONNECTION_FAILED" });
    expect(out).toEqual([]);
  });

  it("explains usage mistakes with exit code 2", async () => {
    for (const args of [
      ["peer", "frobnicate"],
      ["conclusion", "list", "--limit", "0"],
      ["peer", "list", "--nonsense"],
      ["session", "list", "-w", "bad id"],
    ]) {
      const res = await cli(args, ME);
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.err, args.join(" ")).toContain("recall");
    }
    for (const group of ["workspace", "peer", "session", "conclusion", "queue"]) {
      const help = await cli([group, "--help"]);
      expect(help.code, group).toBe(0);
      expect(help.out, group).toContain(`recall ${group}`);
      expect(help.out, group).toContain("--json");
    }
    expect((await cli(["--help"])).out).toContain("recall init");
    // A bare group prints its usage and exits 2.
    const bare = await cli(["peer"]);
    expect(bare.code).toBe(2);
    expect(bare.out).toContain("Usage: recall peer");
  });
});

describe("cli: authentication", () => {
  const SECRET = "cli-resources-secret";
  let authed: ApiServer;
  beforeAll(async () => {
    authed = await createTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: SECRET,
    });
    const admin = signToken({ ad: true }, SECRET);
    await authed.request(
      "POST",
      "/v3/workspaces/acme/sessions/s1/messages",
      { messages: [{ peer_id: "alice", content: "hello from alice" }] },
      { authorization: `Bearer ${admin}` },
    );
  });
  afterAll(() => authed.close());

  it("sends the API key from the environment, a flag or the config file", async () => {
    const admin = signToken({ ad: true }, SECRET);
    const viaEnv = await cli(["peer", "list", "--json"], { ...ME, RECALL_API_KEY: admin }, authed);
    expect(viaEnv.json.map((p: { id: string }) => p.id)).toEqual(["alice"]);
    const viaFlag = await cli(["peer", "list", "--api-key", admin, "--json"], ME, authed);
    expect(viaFlag.code).toBe(0);

    const none = await cli(["peer", "list", "--json"], ME, authed);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.err).error).toMatchObject({ code: "UNAUTHORIZED" });
    expect(JSON.parse(none.err).error.message).toContain("recall init");
  });

  it("works with a workspace-scoped key, degrading where the key cannot reach", async () => {
    const scoped = signToken({ w: "acme" }, SECRET);
    const env = { ...ME, RECALL_API_KEY: scoped };
    expect((await cli(["peer", "list", "--json"], env, authed)).code).toBe(0);
    const inspect = await cli(["workspace", "inspect", "--json"], env, authed);
    expect(inspect.code).toBe(0);
    expect(inspect.json).toMatchObject({ id: "acme", peer_count: 1, metadata: null });
    const list = await cli(["workspace", "list", "--json"], env, authed);
    expect(list.code).toBe(1);
    expect(JSON.parse(list.err).error.code).toBe("UNAUTHORIZED");
  });
});
