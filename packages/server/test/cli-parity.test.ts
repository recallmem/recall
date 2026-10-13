import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliIo, run } from "../src/cli.js";
import { drainQueue } from "../src/queue/worker.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * The commands of Honcho's CLI that Recall's lacked before the parity audit (docs/PARITY.md),
 * plus `session upload` and `peer dream`, run against an in-process server.
 */

interface Captured {
  code: number | null;
  out: string;
  err: string;
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON output
  json: any;
}

let home: string;
let server: ApiServer;

async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env: { HOME: home, RECALL_URL: "http://recall.test", ...env },
    fetch: async (input, init) => server.app.fetch(new Request(input, init)),
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
const W = "/v3/workspaces/acme";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "recall-cli-parity-"));
  server = await createTestServer();
  const res = await server.request("POST", `${W}/sessions/chat-1/messages`, {
    messages: [
      { peer_id: "alice", content: "I just moved to Utrecht and I love cycling." },
      { peer_id: "bot", content: "Welcome to Utrecht!" },
    ],
  });
  expect(res.status).toBe(201);
});

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

describe("cli parity: workspace", () => {
  it("creates a workspace with metadata", async () => {
    const res = await cli(["workspace", "create", "lab", "--metadata", '{"team":"r&d"}', "--json"]);
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ id: "lab", metadata: { team: "r&d" } });
    const bad = await cli(["workspace", "create", "lab", "--metadata", "[1]"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--metadata must be a JSON object");
  });

  it("previews, refuses, then cascades a workspace delete", async () => {
    await server.request("POST", "/v3/workspaces/doomed/sessions", { id: "x1" });
    await server.request("POST", "/v3/workspaces/doomed/sessions", { id: "x2" });

    const dry = await cli(["workspace", "delete", "doomed", "--dry-run", "--json"]);
    expect(dry.json).toEqual({ workspace: "doomed", sessions: ["x1", "x2"], deleted: false });

    const unconfirmed = await cli(["workspace", "delete", "doomed"]);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("--yes");

    const blocked = await cli(["workspace", "delete", "doomed", "--yes", "--json"]);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.err).error.code).toBe("HAS_ACTIVE_SESSIONS");

    const done = await cli(["workspace", "delete", "doomed", "--yes", "--cascade", "--json"]);
    expect(done.json).toEqual({ workspace: "doomed", sessions_deleted: 2, deleted: true });
    const left = await server.request("POST", "/v3/workspaces/doomed/sessions/list", {});
    expect((await left.json()).items).toEqual([]);
  });

  it("searches the workspace and asks the workspace chat", async () => {
    const hits = await cli(["workspace", "search", "Utrecht", "--json"], ME);
    expect(hits.json.map((m: { content: string }) => m.content)).toContain(
      "I just moved to Utrecht and I love cycling.",
    );
    const human = await cli(["workspace", "search", "Utrecht"], ME);
    expect(human.out).toMatch(/^SESSION\s+PEER\s+WHEN\s+CONTENT/);

    const chat = await cli(["workspace", "chat", "Who", "moved?", "--json"], ME);
    expect(chat.code).toBe(0);
    expect(chat.json).toHaveProperty("content");

    const twoScopes = await cli(["workspace", "search", "x", "--scope", "a,b"], ME);
    expect(twoScopes.code).toBe(2);
  });
});

describe("cli parity: peer", () => {
  it("creates a peer with observation off and reads and replaces its metadata", async () => {
    const created = await cli(
      ["peer", "create", "carol", "--no-observe-me", "--metadata", '{"plan":"pro"}', "--json"],
      ME,
    );
    expect(created.json).toMatchObject({
      id: "carol",
      metadata: { plan: "pro" },
      configuration: { observe_me: false },
    });
    expect((await cli(["peer", "get-metadata", "carol", "--json"], ME)).json).toEqual({
      plan: "pro",
    });

    // Honcho's form: the JSON positional and -p for the peer.
    await cli(["peer", "set-metadata", '{"plan":"team"}', "-p", "carol"], ME);
    expect((await cli(["peer", "get-metadata", "-p", "carol", "--json"], ME)).json).toEqual({
      plan: "team",
    });
    // Also: <peer_id> <json>, and -d.
    await cli(["peer", "set-metadata", "carol", '{"plan":"x"}'], ME);
    await cli(["peer", "set-metadata", "carol", "-d", '{"plan":"y"}'], ME);
    expect((await cli(["peer", "get-metadata", "carol", "--json"], ME)).json).toEqual({
      plan: "y",
    });

    const missing = await cli(["peer", "get-metadata", "nobody", "--json"], ME);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err).error.code).toBe("PEER_NOT_FOUND");
  });

  it("prints a representation and queues a dream", async () => {
    await drainQueue(server.ctx);
    await server.request("POST", `${W}/conclusions`, {
      conclusions: [
        { content: "alice lives in Utrecht", observer_id: "alice", observed_id: "alice" },
      ],
    });
    const rep = await cli(["peer", "representation", "--json"], ME);
    expect(rep.json.representation).toContain("Utrecht");
    expect(rep.json).toMatchObject({ peer_id: "alice", target_id: "alice" });
    const text = await cli(
      ["peer", "representation", "--search-query", "home", "--max-conclusions", "5"],
      ME,
    );
    expect(text.out).toContain("Utrecht");

    const dream = await cli(["peer", "dream", "--json"], ME);
    expect(dream.json).toEqual({
      observer: "alice",
      observed: "alice",
      dream_type: "omni",
      scheduled: true,
    });
    const bad = await cli(["peer", "dream", "--type", "nap"], ME);
    expect(bad.code).toBe(2);
  });

  it("passes --scope and --sessions to peer chat, and refuses to combine them", async () => {
    const both = await cli(["peer", "chat", "hi", "--scope", "a", "--sessions", "chat-1"], ME);
    expect(both.code).toBe(2);
    const sessions = await cli(
      ["peer", "chat", "Where", "do", "I", "live?", "--sessions", "chat-1", "--json"],
      ME,
    );
    expect(sessions.code).toBe(0);
    const unknownScope = await cli(["peer", "chat", "hi", "--scope", "nope", "--json"], ME);
    expect(unknownScope.code).toBe(1);
    expect(JSON.parse(unknownScope.err).error.code).toBe("NOT_FOUND");
  });
});

describe("cli parity: session", () => {
  it("creates a session with peers and manages its members", async () => {
    const created = await cli(
      [
        "session",
        "create",
        "chat-9",
        "--peers",
        "alice,bot",
        "--metadata",
        '{"topic":"bikes"}',
        "--json",
      ],
      ME,
    );
    expect(created.json).toMatchObject({ id: "chat-9", metadata: { topic: "bikes" } });
    const peers = await cli(["session", "peers", "chat-9", "--json"], ME);
    expect(peers.json.map((p: { id: string }) => p.id).sort()).toEqual(["alice", "bot"]);

    await cli(["session", "add-peers", "chat-9", "carol", "dave"], ME);
    await cli(["session", "remove-peers", "chat-9", "bot"], ME);
    const after = await cli(["session", "peers", "-s", "chat-9", "--json"], ME);
    expect(after.json.map((p: { id: string }) => p.id).sort()).toEqual(["alice", "carol", "dave"]);
    expect((await cli(["session", "add-peers", "chat-9"], ME)).code).toBe(2);
  });

  it("reads and replaces session metadata", async () => {
    await cli(["session", "set-metadata", "chat-9", "-d", '{"topic":"trains"}'], ME);
    expect((await cli(["session", "get-metadata", "chat-9", "--json"], ME)).json).toEqual({
      topic: "trains",
    });
    await cli(["session", "set-metadata", '{"topic":"cars"}', "-s", "chat-9"], ME);
    expect((await cli(["session", "get-metadata", "-s", "chat-9", "--json"], ME)).json).toEqual({
      topic: "cars",
    });
  });

  it("searches a session, shows its summaries and a per-session representation", async () => {
    await server.request("POST", "/v3/workspaces/acme/sessions/other/messages", {
      messages: [{ peer_id: "bot", content: "cycling is also popular elsewhere" }],
    });
    const hits = await cli(["session", "search", "cycling", "chat-1", "--json"], ME);
    expect(hits.json.length).toBeGreaterThan(0);
    expect(new Set(hits.json.map((m: { session_id: string }) => m.session_id))).toEqual(
      new Set(["chat-1"]),
    );
    expect(hits.json.map((m: { content: string }) => m.content)).toContain(
      "I just moved to Utrecht and I love cycling.",
    );
    const summaries = await cli(["session", "summaries", "chat-1", "--json"], ME);
    expect(summaries.json).toEqual({ id: "chat-1", short_summary: null, long_summary: null });
    expect((await cli(["session", "summaries", "chat-1"], ME)).out).toContain(
      "Short summary: none yet",
    );

    const rep = await cli(["session", "representation", "alice", "chat-1", "--json"], ME);
    expect(rep.json).toMatchObject({ peer_id: "alice", session_id: "chat-1" });
    expect(typeof rep.json.representation).toBe("string");
  });

  it("shows the transcript under `view` as well as `messages`", async () => {
    const view = await cli(["session", "view", "chat-1", "--json"], ME);
    const messages = await cli(["session", "messages", "chat-1", "--json"], ME);
    expect(view.json).toEqual(messages.json);
  });

  it("uploads a file as messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-upload-"));
    try {
      const file = join(dir, "notes.md");
      writeFileSync(file, "# Notes\n\nalice prefers trains over planes.");
      const res = await cli(["session", "upload", file, "chat-9", "-p", "alice", "--json"], ME);
      expect(res.code).toBe(0);
      expect(res.json).toHaveLength(1);
      expect(res.json[0]).toMatchObject({ peer_id: "alice", session_id: "chat-9" });
      expect(res.json[0].content).toContain("trains over planes");
      const missing = await cli(["session", "upload", join(dir, "nope.txt"), "chat-9"], ME);
      expect(missing.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a session only with --yes", async () => {
    expect((await cli(["session", "delete", "chat-9"], ME)).code).toBe(2);
    const res = await cli(["session", "delete", "chat-9", "--yes", "--json"], ME);
    expect(res.json).toEqual({ session: "chat-9", deleted: true });
    const gone = await server.request("GET", `${W}/sessions/chat-9`);
    expect(gone.status).toBe(404);
  });
});

describe("cli parity: scope", () => {
  it("creates a scope with sessions, inspects it, and removes a session", async () => {
    await server.request("POST", `${W}/sessions`, { id: "chat-2" });
    const created = await cli(
      ["scope", "create", "team", "--sessions", "chat-1", "--sessions", "chat-2", "--json"],
      ME,
    );
    expect(created.json).toMatchObject({ id: "team", sessions: ["chat-1", "chat-2"] });

    const list = await cli(["scope", "list", "--json"], ME);
    expect(list.json.map((s: { id: string }) => s.id)).toEqual(["team"]);

    const sessions = await cli(["scope", "sessions", "team", "--json"], ME);
    expect(sessions.json.map((s: { id: string }) => s.id).sort()).toEqual(["chat-1", "chat-2"]);

    const status = await cli(["scope", "status", "team", "--json"], ME);
    expect(Object.keys(status.json.backfill_status)).toContain("chat-1");

    await cli(["scope", "remove-session", "team", "chat-2"], ME);
    await cli(["scope", "add-sessions", "team", "chat-2"], ME);
    await cli(["scope", "remove-session", "team", "chat-1"], ME);
    const inspect = await cli(["scope", "inspect", "team", "--json"], ME);
    expect(inspect.json).toMatchObject({ id: "team", session_count: 1, sessions: ["chat-2"] });
    expect((await cli(["scope", "inspect", "team"], ME)).out).toContain("sessions:");

    const missing = await cli(["scope", "status", "nope", "--json"], ME);
    expect(missing.code).toBe(1);
    expect((await cli(["scope", "add-sessions", "team"], ME)).code).toBe(2);
  });
});

describe("cli parity: message", () => {
  it("creates, lists and gets messages", async () => {
    const created = await cli(
      ["message", "create", "I", "bought", "a", "cargo", "bike", "-s", "chat-1", "--json"],
      ME,
    );
    expect(created.json).toMatchObject({ peer_id: "alice", content: "I bought a cargo bike" });

    const list = await cli(["message", "list", "chat-1", "--json"], ME);
    expect(list.json.at(-1).content).toBe("I bought a cargo bike");
    expect(list.json[0].content).toBe("I just moved to Utrecht and I love cycling.");
    const last = await cli(["message", "list", "-s", "chat-1", "--last", "1", "--json"], ME);
    expect(last.json.map((m: { content: string }) => m.content)).toEqual(["I bought a cargo bike"]);
    const brief = await cli(["message", "list", "chat-1", "--brief"], ME);
    expect(brief.out.split("\n")[0]).toBe("alice: I just moved to Utrecht and I love cycling.");
    const newestFirst = await cli(["message", "list", "chat-1", "--reverse", "--json"], ME);
    expect(newestFirst.json[0].content).toBe("I bought a cargo bike");

    const got = await cli(["message", "get", created.json.id, "-s", "chat-1", "--json"], ME);
    expect(got.json).toEqual(created.json);
    expect((await cli(["message", "get", created.json.id, "-s", "chat-1"], ME)).out).toContain(
      "I bought a cargo bike",
    );
  });
});

describe("cli parity: conclusion get and derived", () => {
  it("fetches conclusions by id and lists what was derived from one", async () => {
    const res = await server.request("POST", `${W}/conclusions`, {
      conclusions: [
        { content: "alice owns a cargo bike", observer_id: "alice", observed_id: "alice" },
      ],
    });
    const [premise] = await res.json();
    const one = await cli(["conclusion", "get", premise.id, "--json"], ME);
    expect(one.json).toMatchObject({ id: premise.id, content: "alice owns a cargo bike" });
    const two = await cli(["conclusion", "get", premise.id, premise.id, "--json"], ME);
    expect(two.json).toHaveLength(2);

    // Nothing derives from it yet; a derived conclusion citing it shows up in both views.
    expect((await cli(["conclusion", "derived", premise.id, "--json"], ME)).json).toEqual([]);
    const { sql } = await import("drizzle-orm");
    await server.ctx.db.execute(
      sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, content, level, source_ids)
          SELECT 'derived-0000000000001', workspace_id, collection_id, observer_id, observed_id,
                 'alice cycles to work', 'deductive', ARRAY[${premise.id}]::text[]
          FROM conclusions WHERE id = ${premise.id}`,
    );
    const derived = await cli(["conclusion", "derived", premise.id, "--json"], ME);
    expect(derived.json.map((c: { id: string }) => c.id)).toEqual(["derived-0000000000001"]);
    const listed = await cli(["conclusion", "list", "--derived-from", premise.id, "--json"], ME);
    expect(listed.json.map((c: { id: string }) => c.id)).toEqual(["derived-0000000000001"]);
  });
});

describe("cli parity: help", () => {
  it("lists every command group and command", async () => {
    const top = await cli(["--help"]);
    for (const word of ["scope", "message", "upload", "dream", "derived", "add-peers"])
      expect(top.out).toContain(word);
    expect((await cli(["scope", "--help"])).code).toBe(0);
    expect((await cli(["message", "--help"])).code).toBe(0);
    const unknown = await cli(["scope", "frobnicate"], ME);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("remove-session");
  });
});

describe("cli parity: peer delete (Recall extension)", () => {
  it("erases a peer only with --yes", async () => {
    await server.request("POST", `${W}/sessions/chat-1/messages`, {
      messages: [{ peer_id: "zed", content: "zed was here" }],
    });
    const unconfirmed = await cli(["peer", "delete", "zed"], ME);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("--yes");
    const res = await cli(["peer", "delete", "zed", "--yes", "--json"], ME);
    expect(res.json).toMatchObject({ peer_id: "zed", deleted: true, messages_deleted: 1 });
    const again = await cli(["peer", "delete", "zed", "--yes", "--json"], ME);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.err).error.code).toBe("NOT_FOUND");
  });
});

describe("cli parity: doctor checks the server as a client", () => {
  const checksOf = (res: Captured) =>
    Object.fromEntries(
      (res.json.checks as { name: string; status: string }[]).map((c) => [c.name, c.status]),
    );

  it("checks credentials, API access, the workspace, its queue and the peer", async () => {
    const res = await cli(["doctor", "--url", "http://recall.test", "--json"], ME);
    expect(res.code).toBe(0);
    expect(checksOf(res)).toMatchObject({
      "server /health": "ok",
      credentials: "ok",
      "API access": "ok",
      workspace: "ok",
      queue: "ok",
      peer: "ok",
    });
    const human = await cli(["doctor", "--url", "http://recall.test"], ME);
    expect(human.out).toMatch(
      /\[ok {2}\] workspace: 'acme' is reachable \(env RECALL_WORKSPACE_ID\)/,
    );
    expect(human.out).toMatch(/\[ok {2}\] queue: \d+\/\d+ work units done/);
  });

  it("fails for a named workspace or peer that does not exist, and only warns for the default", async () => {
    const ws = await cli(["doctor", "--url", "http://recall.test", "-w", "nowhere", "--json"]);
    expect(ws.code).toBe(1);
    expect(checksOf(ws).workspace).toBe("fail");

    const peer = await cli(["doctor", "--url", "http://recall.test", "-p", "ghost", "--json"], {
      RECALL_WORKSPACE_ID: "acme",
    });
    expect(peer.code).toBe(1);
    expect(checksOf(peer).peer).toBe("fail");

    const unnamed = await cli(["doctor", "--url", "http://recall.test", "--json"]);
    expect(unnamed.code).toBe(0);
    expect(checksOf(unnamed).workspace).toBe("warn");
    // Nothing was created by checking.
    const list = await server.request("POST", "/v3/workspaces/list", {});
    expect((await list.json()).items.map((w: { id: string }) => w.id)).not.toContain("nowhere");
  });

  it("reports credentials the server rejects", async () => {
    const secured = await createTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: "doctor-secret",
    });
    try {
      const io: CliIo = {
        out: () => {},
        err: () => {},
        env: { HOME: home },
        fetch: async (input, init) => secured.app.fetch(new Request(input, init)),
      };
      const lines: string[] = [];
      io.out = (t) => lines.push(t);
      const code = await run(
        ["doctor", "--url", "http://secured.test", "--api-key", "not-a-token", "--json"],
        io,
      );
      expect(code).toBe(1);
      const report = JSON.parse(lines.join("\n"));
      const access = report.checks.find((c: { name: string }) => c.name === "API access");
      expect(access).toMatchObject({ status: "fail" });
      expect(access.detail).toContain("rejected the credentials");
    } finally {
      await secured.close();
    }
  });
});
