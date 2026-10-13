import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmRequest } from "../src/llm/types.js";
import { abstains } from "../src/recall/chat.js";
import { Corpus, JargonFilter, rewriteJargon } from "../src/recall/jargon.js";
import { MarkerFilter, stripJsonMarkers, stripMarkers } from "../src/recall/markers.js";
import { cardLineFor, describeView, type View } from "../src/recall/pack.js";
import { SYSTEM_PROMPT } from "../src/recall/prompts.js";
import { createTestServer } from "./api-helpers.js";
import { parseSse, seedWorld, type World } from "./recall-helpers.js";

/**
 * What an answer shows the reader, found wrong in an end-to-end run: internal citation markers in
 * structured output, internal jargon in prose, a person refused her own secret, `abstained` that
 * depended on the level, a chat that created the peer it read, and another peer addressed as the
 * person asked about.
 */

const peerRef = (id: string) => ({ id, name: id, isScope: false, configuration: {} });

/** Feeds `text` in chunks of `size` through a filter with push/flush. */
function streamed(f: { push(s: string): string; flush(): string }, text: string, size: number) {
  let out = "";
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  return out + f.flush();
}

describe("structured answers: citation markers", () => {
  it("strips every marker form from all string values, at any depth, and reports the labels", () => {
    const { value, cited } = stripJsonMarkers({
      allergies: ["peanuts [F1]", "shellfish [F1, M1]"],
      languages: ["Dutch (learning, started) [F2]"],
      home: { city: "Utrecht [S3; F4]", since: 2026, verified: true, note: null },
      plain: "no markers here",
    });
    expect(value).toEqual({
      allergies: ["peanuts", "shellfish"],
      languages: ["Dutch (learning, started)"],
      home: { city: "Utrecht", since: 2026, verified: true, note: null },
      plain: "no markers here",
    });
    expect(cited).toEqual(["F1", "M1", "F2", "S3", "F4"]);
  });

  it("treats parenthesised ids as markers only when the caller accepts them", () => {
    const text = "You live in Utrecht (F2). You own a MacBook (M1) [F3].";
    expect(stripMarkers(text).text).toBe("You live in Utrecht (F2). You own a MacBook (M1).");
    const notChips = { parens: (labels: string[]) => !labels.includes("M1") };
    expect(stripMarkers(text, notChips)).toEqual({
      text: "You live in Utrecht. You own a MacBook (M1).",
      cited: ["F3", "F2"],
    });
    for (const size of [1, 2, 5]) {
      const f = new MarkerFilter(notChips);
      expect(streamed(f, text, size)).toBe("You live in Utrecht. You own a MacBook (M1).");
      expect([...f.cited].sort()).toEqual(["F2", "F3"]);
    }
  });
});

describe("internal jargon", () => {
  const none = new Corpus("Where does Alice live now?");
  const rewrites: [string, string][] = [
    [
      "The pack has no later change, so you still use Jest [F2].",
      "My memory has no later change, so you still use Jest [F2].",
    ],
    ["There is nothing in the pack about a dog.", "There is nothing in my memory about a dog."],
    [
      "The Profile still lists Jest, but you switched to Vitest.",
      "My memory still lists Jest, but you switched to Vitest.",
    ],
    ["Your Profile line says nurse.", "My memory says nurse."],
    [
      "I can't say more: the excerpt cuts off before the name.",
      "I can't say more: the message cuts off before the name.",
    ],
    ["An excerpt from May mentions it.", "A message from May mentions it."],
    ["Two excerpts mention Porto.", "Two messages mention Porto."],
    ["My notes say you moved in March.", "I remember you moved in March."],
    ["The Facts section lists two cats.", "My memory lists two cats."],
    ["According to the memory pack, yes.", "According to my memory, yes."],
  ];
  const untouched = [
    "You bought a six-pack of beer for the party.",
    "You opened the pack of cards before the game.",
    "You updated your profile picture in May.",
    "Her LinkedIn profile lists Python.",
    "You took notes in every lecture.",
    "The facts list is long.",
    "A backpack and a pack-mule.",
  ];

  it("rewrites clearly internal phrases into plain words", () => {
    for (const [from, to] of rewrites) expect(rewriteJargon(from, none), from).toBe(to);
  });

  it("leaves everyday words alone", () => {
    for (const text of untouched) expect(rewriteJargon(text, none), text).toBe(text);
  });

  it("leaves a word alone when the question or the memory uses it", () => {
    const hiking = new Corpus(
      "What did I forget on the hike?",
      "## Facts\n[F1] 2026-05-01 alice left her pack at the hut\n[F2] alice read an excerpt from Dune\n## Profile\n- alice has a dating profile",
    );
    for (const text of [
      "You left the pack at the hut [F1].",
      "The excerpt you read was from Dune.",
      "Your Profile line says nothing.",
    ])
      expect(rewriteJargon(text, hiking), text).toBe(text);
    // Headings and markers are not the memory's words: "Profile" and "F1" still count as internal.
    const headings = new Corpus("", "## Profile\n- ATTRIBUTE: Job: nurse\n## Facts\n[F1] x");
    expect(rewriteJargon("The Profile says nurse.", headings)).toBe("My memory says nurse.");
    expect(headings.has("F1")).toBe(false);
  });

  it("gives the same text however the answer is chunked", () => {
    const text = `${rewrites.map(([from]) => from).join(" ")}\n${untouched.join(" ")}`;
    const whole = rewriteJargon(text, none);
    for (const size of [1, 2, 3, 7, 50])
      expect(streamed(new JargonFilter(none), text, size)).toBe(whole);
  });
});

describe("abstention", () => {
  it("is an answer that cites nothing, or opens by saying memory does not hold it", () => {
    expect(abstains("I have no record of Dana having a dog. She has a cat [F1].", ["F1"])).toBe(
      true,
    );
    expect(abstains("No, I have no record of that.", ["F2"])).toBe(true);
    expect(abstains("I've no record of a dog.", ["F2"])).toBe(true);
    expect(abstains("I don't know.", ["F2"])).toBe(true);
    expect(abstains("I don't have any information about Dana's pets.", ["F1"])).toBe(true);
    expect(abstains("There's no mention of a dog; Dana has a cat.", ["F1"])).toBe(true);
    expect(abstains("Ik heb geen informatie over een hond.", ["F1"])).toBe(true);
    expect(abstains("Dana has a cat named Miso.", [])).toBe(true);
    expect(abstains("Dana has a cat named Miso.", ["F1"])).toBe(false);
    // A partial answer is not an abstention.
    expect(abstains("I don't have the exact date, but you moved in March.", ["F1"])).toBe(false);
    expect(abstains("Not any more: you were vegetarian until May.", ["F6"])).toBe(false);
  });
});

describe("perspective and privacy in the context header", () => {
  const view = (observer: string, observed: string, asker: string | null): View =>
    ({
      ws: { id: "w", name: "w", configuration: {} },
      observer: peerRef(observer),
      observed: peerRef(observed),
      asker: asker ? peerRef(asker) : null,
      noMemory: false,
      allowlist: null,
      session: null,
      messageObserver: null,
      cardsEnabled: true,
      instructions: null,
      scopeName: null,
    }) as View;

  it("speaks to the person about themself, and of them in the third person to anyone else", () => {
    expect(describeView(view("carla", "carla", "carla"))).toBe("About: carla.");
    expect(describeView(view("ben", "carla", "ben"))).toBe(
      'About: carla, as known by ben.\nben is asking, not carla: speak of carla in the third person ("carla said"), and "you" means ben.',
    );
    expect(describeView(view("carla", "carla", "carla"), true)).toBe(
      "About: carla.\ncarla is the one asking: what carla wants kept private or secret is kept from other people, never from carla.",
    );
    // Someone else asking keeps the owner's privacy wishes as they are.
    expect(describeView(view("ben", "carla", "ben"), true)).not.toContain("never from");
  });

  it("puts a privacy instruction to its owner as information, and to anyone else as written", () => {
    const line = "INSTRUCTION: Confidentiality: Keep carla's planned move to Vancouver private";
    expect(cardLineFor(line, "carla")).toBe(
      "Privacy wish (kept from others; carla may always be told): Confidentiality: Keep carla's planned move to Vancouver private",
    );
    expect(cardLineFor(line, null)).toBe(line);
    for (const other of [
      "INSTRUCTION: Style: Answer briefly",
      "INSTRUCTION: Contact: Prefers private messages over email",
      "ATTRIBUTE: Secret hobby: knitting",
    ])
      expect(cardLineFor(other, "carla")).toBe(other);
    expect(cardLineFor("INSTRUCTION: Don't tell her brother about the move", "carla")).toMatch(
      /^Privacy wish/,
    );
  });
});

describe("recall: answers through the chat path", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let w: World;
  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    w = await seedWorld(server.ctx);
  });
  afterAll(() => server.close());

  const PEER = "/v3/workspaces/acme/peers/alice/chat";
  type Chat = {
    content: string | null;
    citations: string[];
    confidence: number;
    abstained: boolean;
  };
  const ask = async (body: Record<string, unknown>, path = PEER) => {
    const res = await server.request("POST", path, body);
    expect(res.status).toBe(200);
    return (await res.json()) as Chat;
  };
  const askStream = async (body: Record<string, unknown>, path = PEER) => {
    const res = await server.request("POST", path, { ...body, stream: true });
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    return { text: frames.map((f) => f.delta?.content ?? "").join(""), last: frames.at(-1)! };
  };
  const contexts = () => server.ctx.llm.mock.calls.map((c) => c.req.context ?? "");
  const lastContext = () => contexts().at(-1)!;
  /** Replies with `answer`, after one search round on the tool levels. */
  const reply = (answer: (req: LlmRequest) => { text?: string; json?: unknown }) =>
    server.ctx.llm.mock.respondWith((req) =>
      req.tools?.length && !req.messages.some((m) => m.role === "tool")
        ? { toolCalls: [{ id: "t1", name: "search_memory", input: { query: "alice" } }] }
        : answer(req),
    );
  /** The conclusion the pack labelled `label` in the last call's context. */
  const idOf = async (label: string) => {
    const line = lastContext()
      .split("\n")
      .find((l) => l.startsWith(`[${label}] `))!;
    const found = (await server.ctx.db.execute(
      sql`SELECT id, content FROM conclusions WHERE workspace_id = ${w.ws}`,
    )) as unknown as { rows: { id: string; content: string }[] };
    // The fact itself comes first on its line; a replaced one may follow as "(was: ...)".
    const at = (r: { content: string }) => line.indexOf(r.content);
    return found.rows.filter((r) => at(r) >= 0).sort((a, b) => at(a) - at(b))[0]!.id;
  };

  it("returns structured values without markers, streamed or not, and still cites", async () => {
    reply((req) =>
      req.jsonSchema
        ? { json: { city: "Utrecht [F1]", pets: ["Rover (dog) [F1, M1]"], years: 1 } }
        : { text: "?" },
    );
    try {
      const response_format = {
        type: "object",
        properties: {
          city: { type: "string" },
          pets: { type: "array", items: { type: "string" } },
          years: { type: "integer" },
        },
        required: ["city"],
      };
      for (const level of ["low", "high"]) {
        const body = {
          query: "Where does Alice live now?",
          reasoning_level: level,
          response_format,
        };
        const json = await ask(body);
        expect(JSON.parse(json.content!)).toEqual({
          city: "Utrecht",
          pets: ["Rover (dog)"],
          years: 1,
        });
        const f1 = await idOf("F1");
        expect(json.citations).toEqual([f1]);
        const s = await askStream(body);
        expect(s.text).not.toMatch(/\[[FMS]\d/);
        expect(JSON.parse(s.text)).toEqual({ city: "Utrecht", pets: ["Rover (dog)"], years: 1 });
        expect(s.last.citations).toEqual([f1]);
      }
    } finally {
      server.ctx.llm.mock.respondWith(null);
    }
  });

  it("rewrites internal jargon in prose, the same streamed or not, with byte-stable instructions", async () => {
    reply(() => ({
      text: "The pack has no later change: you live in Utrecht [F1]. The excerpt cuts off before the street.",
    }));
    try {
      const want =
        "My memory has no later change: you live in Utrecht. The message cuts off before the street.";
      for (const level of ["low", "high"]) {
        const body = { query: "Where does Alice live now?", reasoning_level: level };
        expect((await ask(body)).content).toBe(want);
        expect((await askStream(body)).text).toBe(want);
      }
      const systems = new Set(server.ctx.llm.mock.calls.slice(-4).map((c) => c.req.system));
      expect([...systems]).toEqual([SYSTEM_PROMPT]);
    } finally {
      server.ctx.llm.mock.respondWith(null);
    }
  });

  it("flags an answer that has no record as abstained at every level, streamed or not", async () => {
    for (const [text, abstained] of [
      [
        "I have no record of Alice having a cat. She has a golden retriever named Rover [F1].",
        true,
      ],
      ["Alice has a golden retriever named Rover [F1].", false],
    ] as const) {
      reply(() => ({ text }));
      try {
        for (const level of ["minimal", "low", "medium", "high", "max"]) {
          const body = { query: "Does Alice have a cat?", reasoning_level: level };
          const json = await ask(body);
          const { last } = await askStream(body);
          for (const r of [json, last]) {
            expect(r.abstained, `${level}: ${text}`).toBe(abstained);
            if (abstained) {
              expect(r.confidence).toBe(0);
              expect(r.citations).toEqual([]);
            } else {
              expect(r.confidence).toBeGreaterThan(0.5);
              expect(r.citations).toHaveLength(1);
            }
          }
        }
      } finally {
        server.ctx.llm.mock.respondWith(null);
      }
    }
  });

  it("never refuses a person their own secret, and keeps it from anyone else", async () => {
    const secret = "INSTRUCTION: Confidentiality: Keep alice's planned move to Vancouver private";
    await server.ctx.db.execute(
      sql`UPDATE collections SET peer_card = ${JSON.stringify(["Lives in Utrecht", secret])}::jsonb
          WHERE workspace_id = ${w.ws} AND observed_id = ${w.alice}`,
    );
    try {
      for (const session of [null, "s1"]) {
        await ask({
          query: "Where am I planning to move?",
          ...(session ? { session_id: session } : {}),
        });
        const own = lastContext();
        expect(own).toContain(
          "- Privacy wish (kept from others; alice may always be told): Confidentiality: Keep alice's planned move to Vancouver private",
        );
        expect(own).toContain(
          "alice is the one asking: what alice wants kept private or secret is kept from other people, never from alice.",
        );
        expect(own).not.toContain("INSTRUCTION: Confidentiality");
      }
      // Bob asking about Alice: her wish stands as written.
      await ask(
        { query: "Where is Alice planning to move?", target: "alice" },
        "/v3/workspaces/acme/peers/bob/chat",
      );
      const theirs = lastContext();
      expect(theirs).toContain(`- ${secret}`);
      expect(theirs).not.toContain("Privacy wish");
      expect(theirs).not.toContain("never from");
    } finally {
      await server.ctx.db.execute(
        sql`UPDATE collections SET peer_card = ${JSON.stringify(["Alice is a machine learning engineer", "Lives in Utrecht", "Has a dog named Rover"])}::jsonb
            WHERE id = ${w.collection}`,
      );
      await server.ctx.db.execute(
        sql`UPDATE collections SET peer_card = '[]'::jsonb WHERE workspace_id = ${w.ws} AND observer_id = ${w.bob}`,
      );
    }
  });

  it("tells the model who asks: another peer hears about the person in the third person", async () => {
    await ask(
      { query: "What does Alice do?", target: "alice" },
      "/v3/workspaces/acme/peers/bob/chat",
    );
    expect(lastContext().split("\n").slice(0, 2)).toEqual([
      "About: alice, as known by bob.",
      'bob is asking, not alice: speak of alice in the third person ("alice said"), and "you" means bob.',
    ]);
    await ask({ query: "What do I do?" });
    expect(lastContext().split("\n")[0]).toBe("About: alice.");
    expect(lastContext()).not.toContain("is asking");
  });
});

describe("recall: reads never create", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    await seedWorld(server.ctx);
  });
  afterAll(() => server.close());

  const census = async () =>
    (
      (await server.ctx.db.execute(
        sql`SELECT (SELECT count(*) FROM workspaces) + (SELECT count(*) FROM peers)
                 + (SELECT count(*) FROM collections) + (SELECT count(*) FROM sessions) AS n`,
      )) as unknown as { rows: { n: number | string }[] }
    ).rows[0]!.n;

  it("answers 404 or empty for unknown workspaces and peers, and creates nothing", async () => {
    const before = await census();
    for (const ws of ["nowhere", "acme"]) {
      const base = `/v3/workspaces/${ws}`;
      const notFound = [
        ["POST", `${base}/peers/zed/chat`, { query: "Where does zed live?" }],
        [
          "POST",
          `${base}/peers/zed/chat`,
          { query: "Where?", stream: true, reasoning_level: "high" },
        ],
        ["GET", `${base}/peers/zed/context`, undefined],
        ["GET", `${base}/peers/zed/card`, undefined],
      ] as const;
      for (const [method, path, body] of notFound) {
        const res = await server.request(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(typeof (await res.json()).detail).toBe("string");
      }
      // Search and representation of an unknown peer are empty, as in the reference.
      expect(
        await (await server.request("POST", `${base}/peers/zed/search`, { query: "x" })).json(),
      ).toEqual([]);
      expect(
        (await (await server.request("POST", `${base}/peers/zed/representation`, {})).json())
          .representation,
      ).toBe("");
      expect((await server.request("GET", `${base}/sessions/ghost/context`)).status).toBeLessThan(
        500,
      );
    }
    expect(
      (await server.request("POST", "/v3/workspaces/nowhere/chat", { query: "hi" })).status,
    ).toBe(404);
    expect(await census()).toBe(before);
  });

  it("chats with a peer created by the documented calls (messages, peer create)", async () => {
    const res = await server.request("POST", "/v3/workspaces/fresh/sessions/s/messages", {
      messages: [{ peer_id: "newbie", content: "I just moved to Lisbon." }],
    });
    expect(res.status).toBeLessThan(300);
    expect(
      (await server.request("POST", "/v3/workspaces/fresh/peers/newbie/chat", { query: "Where?" }))
        .status,
    ).toBe(200);
    expect(
      (await server.request("POST", "/v3/workspaces/fresh/peers", { id: "other" })).status,
    ).toBe(201);
    expect(
      (await server.request("POST", "/v3/workspaces/fresh/peers/other/chat", { query: "Where?" }))
        .status,
    ).toBe(200);
  });
});
