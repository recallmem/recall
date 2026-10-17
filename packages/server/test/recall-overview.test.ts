import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { countTokens } from "../src/lib/tokens.js";
import { stripMarkers } from "../src/recall/markers.js";
import { type Pack, renderPack, type View } from "../src/recall/pack.js";
import type { MessageRow } from "../src/recall/search.js";
import { isOrdering, isOverview } from "../src/recall/shape.js";
import { createTestServer } from "./api-helpers.js";
import { seedWorld, type World } from "./recall-helpers.js";

const PEER = "/v3/workspaces/acme/peers/alice/chat";

describe("recall: overview and ordering questions", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let w: World;
  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    w = await seedWorld(server.ctx);
    const db = server.ctx.db;
    const lastOf = async (session: string, seq: number) =>
      (
        (await db.execute(
          sql`SELECT id FROM messages WHERE session_id = ${session} AND seq_in_session = ${seq}`,
        )) as unknown as { rows: { id: string }[] }
      ).rows[0]!.id;
    // A session Alice never joined: its log must not reach her chat.
    const s3 = newId();
    await db.execute(
      sql`INSERT INTO sessions (id, workspace_id, name, next_seq) VALUES (${s3}, ${w.ws}, 's3', 2)`,
    );
    await db.execute(
      sql`INSERT INTO session_peers (workspace_id, session_id, peer_id) VALUES (${w.ws}, ${s3}, ${w.bob})`,
    );
    const bobMsg = newId();
    await db.execute(
      sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, token_count, created_at)
          VALUES (${bobMsg}, ${w.ws}, ${s3}, ${w.bob}, 1, 'Bob keeps a secret diary.', 6, '2026-01-20T09:00:00Z')`,
    );
    const blocks: [string, number, number, string][] = [
      // Inserted out of order on purpose: the log is sorted by the time of the messages it covers.
      [w.s1, 6, 12, "2026-03-02: alice moved to Utrecht and switched to Globex."],
      [w.s1, 1, 5, "2026-01-10: alice introduced herself, her job at Acme and her dog Rover."],
      [w.s2, 1, 1, "2026-02-01: alice planned a trip to Japan with her sister Mila."],
      [s3, 1, 1, "2026-01-20: bob talked about his secret diary."],
    ];
    for (const [session, start, end, content] of blocks) {
      const last = session === s3 ? bobMsg : await lastOf(session, end);
      await db.execute(
        sql`INSERT INTO summary_blocks (id, workspace_id, session_id, kind, start_seq, end_seq, last_message_id, content, token_count)
            VALUES (${newId()}, ${w.ws}, ${session}, 'block', ${start}, ${end}, ${last}, ${content}, ${countTokens(content)})`,
      );
    }
  });
  afterAll(() => server.close());

  const lastContext = () => server.ctx.llm.mock.calls.at(-1)!.req.context ?? "";
  const section = (ctx: string, title: string) =>
    ctx.split("\n## ").find((s) => s.startsWith(title)) ?? "";

  it("recognises overview and ordering questions", () => {
    expect(isOrdering("In what order did I bring up the trip and the move?")).toBe(true);
    expect(isOrdering("Walk me through how my job search went")).toBe(true);
    expect(isOrdering("What did I do in order to get the job?")).toBe(false);
    expect(isOverview("Can you summarize my project so far?")).toBe(true);
    expect(isOverview("Geef een samenvatting van mijn reis")).toBe(true);
    expect(isOverview("Where does Alice live now?")).toBe(false);
  });

  it("adds the conversation log, oldest first and only from visible sessions, and lists facts in time order", async () => {
    const res = await server.request("POST", PEER, {
      query: "Summarize what Alice has been up to so far",
    });
    expect(res.status).toBe(200);
    const ctx = lastContext();
    const log = section(ctx, "Conversation log");
    expect(log.split("\n").slice(1)).toEqual([
      "[S1] 2026-01-10: alice introduced herself, her job at Acme and her dog Rover.",
      "[S2] 2026-02-01: alice planned a trip to Japan with her sister Mila.",
      "[S3] 2026-03-02: alice moved to Utrecht and switched to Globex.",
    ]);
    expect(ctx).not.toContain("secret diary");
    const facts = section(ctx, "Facts")
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.match(/^\[F\d+\] (\d{4}-\d{2}-\d{2})/)?.[1] ?? "");
    expect(facts.length).toBeGreaterThan(3);
    expect(facts).toEqual([...facts].sort());
  });

  it("leaves other questions as they were: best facts first, no log", async () => {
    await server.request("POST", PEER, { query: "Where does Alice live now?" });
    expect(lastContext()).not.toContain("## Conversation log");
  });

  it("treats log markers as citations of the answer", async () => {
    server.ctx.llm.mock.respondWith(() => ({
      text: "Alice first talked about Rover [S1], then the Japan trip [S2].",
    }));
    try {
      const res = await server.request("POST", PEER, {
        query: "In what order did Alice bring things up?",
      });
      const json = (await res.json()) as { content: string; abstained: boolean };
      expect(json.content).toBe("Alice first talked about Rover, then the Japan trip.");
      expect(json.abstained).toBe(false);
    } finally {
      server.ctx.llm.mock.respondWith(null);
    }
    expect(stripMarkers("Moved [S3]; trip [M1, S2].")).toEqual({
      text: "Moved; trip.",
      cited: ["S3", "M1", "S2"],
    });
  });
});

describe("pack rendering", () => {
  const msg = (id: string, peer: string, content: string, seq: number): MessageRow => ({
    seq,
    id,
    content,
    metadata: {},
    tokenCount: countTokens(content),
    createdAt: new Date(`2026-01-0${seq}T09:00:00Z`),
    seqInSession: seq,
    sessionInternal: "s",
    peerInternal: peer,
    sessionName: "s",
    peerName: peer,
    workspaceName: "w",
  });
  const view = {
    ws: { id: "w", name: "w" },
    observer: { id: "alice", name: "alice", isScope: false, configuration: {} },
    observed: { id: "alice", name: "alice", isScope: false, configuration: {} },
    noMemory: false,
    allowlist: null,
    session: null,
    messageObserver: null,
    cardsEnabled: false,
    instructions: null,
    scopeName: null,
  } as unknown as View;
  const empty = (over: Partial<Pack>): Pack => ({
    profile: [],
    selfProfile: [],
    peerProfiles: [],
    facts: [],
    history: [],
    snippets: [],
    log: [],
    brief: null,
    chronological: false,
    focus: [],
    replies: false,
    summary: null,
    recent: [],
    relevant: true,
    nextF: 1,
    nextM: 1,
    text: "",
    tokens: 0,
    steps: [],
    ...over,
  });

  it("clips other speakers' context around a hit, but never the hit itself", () => {
    const long = (who: string) => `${who} says ${"word ".repeat(150)}`.trim();
    const pack = empty({
      snippets: [
        {
          label: "M1",
          messages: [
            msg("a", "alice", long("alice"), 1),
            msg("b", "assistant", long("context"), 2),
            msg("c", "assistant", long("matched"), 3),
          ],
          score: 1,
          relevant: true,
          hits: new Set(["a", "c"]),
        },
      ],
    });
    renderPack(view, pack, 6000);
    const lines = pack.text.split("\n").filter((l) => l.includes(" says "));
    expect(lines).toHaveLength(3);
    const [alice, context, matched] = lines.map((l) => l.slice(l.indexOf(": ") + 2));
    expect(alice!.length).toBe(600);
    expect(context!.length).toBe(240);
    expect(matched!.length).toBe(600);
  });

  it("shows replies whole when the question asks what was said back, and clips them if they do not fit", () => {
    const long = (who: string) => `${who} says ${"word ".repeat(500)}`.trim();
    const pack = () =>
      empty({
        replies: true,
        snippets: [
          {
            label: "M1",
            messages: [
              msg("a", "alice", long("alice"), 1),
              msg("b", "assistant", long("context"), 2),
              msg("c", "assistant", long("matched"), 3),
            ],
            score: 1,
            relevant: true,
            hits: new Set(["a", "c"]),
          },
        ],
      });
    const shown = (p: Pack) =>
      p.text
        .split("\n")
        .filter((l) => l.includes(" says "))
        .map((l) => l.slice(l.indexOf(": ") + 2).length);
    const roomy = pack();
    renderPack(view, roomy, 6000);
    // The person's own message keeps the usual excerpt; both replies are whole.
    expect(shown(roomy)).toEqual([600, long("context").length, long("matched").length]);
    const tight = pack();
    renderPack(view, tight, 600);
    expect(shown(tight)).toEqual([600, 240, 600]);
  });

  it("drops the least relevant log notes first when the pack is over budget", () => {
    const note = (label: string, rank: number, text: string) => ({
      label,
      content: `2026-01-0${label.slice(1)}: ${text} ${"detail ".repeat(40)}`,
      at: new Date(`2026-01-0${label.slice(1)}T09:00:00Z`),
      tokens: 50,
      rank,
    });
    const pack = empty({
      log: [note("S1", 2, "least"), note("S2", 0, "best"), note("S3", 1, "middle")],
    });
    renderPack(view, pack, 200);
    expect(pack.log.map((l) => l.label)).toEqual(["S2", "S3"]);
    expect(pack.text.indexOf("[S2]")).toBeLessThan(pack.text.indexOf("[S3]"));
    expect(pack.text).not.toContain("[S1]");
  });
});
