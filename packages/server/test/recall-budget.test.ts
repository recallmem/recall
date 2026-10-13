import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { countTokens } from "../src/lib/tokens.js";
import {
  isAggregate,
  LEVELS,
  planFor,
  RULES_TOKENS,
  SYSTEM_PROMPT,
} from "../src/recall/prompts.js";
import { vecLiteral } from "../src/recall/util.js";
import { createTestServer } from "./api-helpers.js";
import { chatUsage, parseSse, seedWorld, type World } from "./recall-helpers.js";

/**
 * The bar from docs/ARCHITECTURE.md: minimal/low/medium answer with exactly one
 * LLM call and at most 5k input tokens, even when memory is large and every
 * candidate matches the question. The world below is deliberately dense: 400
 * conclusions and 200 long messages that all share words with the questions.
 */
describe("recall: cost per level on a dense memory", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let w: World;
  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    w = await seedWorld(server.ctx);
    const db = server.ctx.db;
    const topics = [
      "city",
      "apartment",
      "commute",
      "neighbourhood",
      "landlord",
      "garden",
      "train",
      "bakery",
    ];
    const facts = Array.from({ length: 400 }, (_, i) => {
      const t = topics[i % topics.length]!;
      return `Alice talked about where she lives, the ${t} near her home, and how living there compares to place number ${i}`;
    });
    const msgs = Array.from({ length: 200 }, (_, i) => {
      const t = topics[i % topics.length]!;
      return `Honestly where I live matters less than the ${t}: when I moved I looked at place ${i}, compared the ${t}, the rent, the light, the noise, the neighbours and what living there would do to my daily routine and my savings over the next few years.`;
    });
    const fv = (await server.ctx.embeddings.embed(facts, w.ws)).map(vecLiteral);
    for (const [i, text] of facts.entries()) {
      await db.execute(
        sql`INSERT INTO conclusions (id, workspace_id, collection_id, observer_id, observed_id, session_id, content, importance, embedding, valid_from)
            VALUES (${newId()}, ${w.ws}, ${w.collection}, ${w.alice}, ${w.alice}, ${w.s1}, ${text}, 0.5, ${fv[i]!}::vector, now() - ${i} * interval '1 day')`,
      );
    }
    const mv = (await server.ctx.embeddings.embed(msgs, w.ws)).map(vecLiteral);
    for (const [i, text] of msgs.entries()) {
      await db.execute(
        sql`INSERT INTO messages (id, workspace_id, session_id, peer_id, seq_in_session, content, token_count, embedding, created_at)
            VALUES (${newId()}, ${w.ws}, ${w.s1}, ${w.alice}, ${100 + i}, ${text}, ${countTokens(text)}, ${mv[i]!}::vector, now() - ${i} * interval '1 hour')`,
      );
    }
  });
  afterAll(() => server.close());

  it("keeps minimal, low and medium at one call within each level's input budget, with and without a session", async () => {
    // Level budgets leave out the worked example at the end of the instructions (it is static and
    // read from the prompt cache; docs/ARCHITECTURE.md), so it is allowed on top, measured the way
    // the mock provider counts (about 4 characters per token).
    const example = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Example (illustration only"));
    const exampleTokens = Math.ceil(example.length / 4);
    // The budget counts the rules in real tokens (RULES_TOKENS); the mock counts characters / 4.
    const rules = SYSTEM_PROMPT.slice(0, SYSTEM_PROMPT.indexOf("Example (illustration only"));
    const rulesSlack = Math.max(0, Math.ceil(rules.length / 4) - RULES_TOKENS);
    const rows: string[] = [];
    for (const session of [null, "s1"]) {
      for (const level of ["minimal", "low", "medium"] as const) {
        const since = (await chatUsage(server.ctx)).at(-1)?.id ?? 0;
        const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
          query:
            "Where does Alice live and what does she think about the neighbourhood and commute?",
          reasoning_level: level,
          ...(session ? { session_id: session } : {}),
        });
        expect(res.status).toBe(200);
        const usage = await chatUsage(server.ctx, since);
        expect(usage).toHaveLength(1);
        expect(usage[0]!.inputTokens).toBeLessThanOrEqual(
          LEVELS[level].budget + exampleTokens + rulesSlack,
        );
        rows.push(
          `${level.padEnd(8)} ${session ? "with session" : "no session  "}  calls=1  input=${usage[0]!.inputTokens}  output=${usage[0]!.outputTokens}`,
        );
      }
    }
    console.log(
      `\nDENSE MEMORY (400 conclusions, 213 messages; mock provider counts ~4 chars/token)\n${rows.join("\n")}`,
    );
  });

  it("looks wider for counting questions, still in one call within the wider budget", async () => {
    const query = "How many places has Alice lived in, and how much rent has she paid in total?";
    expect(isAggregate(query)).toBe(true);
    const plan = planFor("low", query);
    expect(plan.facts).toBeGreaterThan(LEVELS.low.facts);
    expect(plan.snippets).toBeGreaterThan(LEVELS.low.snippets);
    const example = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Example (illustration only"));
    const since = (await chatUsage(server.ctx)).at(-1)?.id ?? 0;
    const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
      query,
      reasoning_level: "low",
    });
    expect(res.status).toBe(200);
    const usage = await chatUsage(server.ctx, since);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.inputTokens).toBeLessThanOrEqual(plan.budget + Math.ceil(example.length / 4));
  });

  it("keeps high and max inside their round and token caps", async () => {
    for (const [level, rounds, cap] of [
      ["high", 3, 24_000],
      ["max", 6, 60_000],
    ] as const) {
      // A model that never stops searching: the loop must stop on its own and still answer.
      server.ctx.llm.mock.respondWith((req) =>
        req.tools?.length
          ? {
              toolCalls: [
                {
                  id: "c",
                  name: "search_memory",
                  input: { query: "where does alice live", top_k: 20 },
                },
              ],
            }
          : { text: "Alice lives in Utrecht [F1]." },
      );
      try {
        const since = (await chatUsage(server.ctx)).at(-1)?.id ?? 0;
        const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
          query: "Where does Alice live?",
          reasoning_level: level,
        });
        expect(res.status).toBe(200);
        const usage = await chatUsage(server.ctx, since);
        expect(usage.length).toBe(rounds + 1);
        expect(usage.reduce((n, u) => n + u.inputTokens, 0)).toBeLessThanOrEqual(cap);
        console.log(
          `${level}: ${usage.length} calls, ${usage.reduce((n, u) => n + u.inputTokens, 0)} input tokens in total`,
        );
      } finally {
        server.ctx.llm.mock.respondWith(null);
      }
    }
  });

  it("runs the search tools, continues the numbering and reports them as evidence", async () => {
    let toolOutputs: string[] = [];
    server.ctx.llm.mock.respondWith((req) => {
      if (!req.tools?.length) return { text: "done" };
      const tools = req.messages.filter((m) => m.role === "tool");
      toolOutputs = tools.map((m) => ("content" in m ? m.content : ""));
      if (tools.length) return { text: "Found it [F1]." };
      return {
        toolCalls: [
          { id: "a", name: "search_messages", input: { query: "Globex", limit: 3 } },
          {
            id: "b",
            name: "get_messages_by_date_range",
            input: { after_date: "2026-03-01", before_date: "2026-03-10", limit: 5, order: "asc" },
          },
          { id: "c", name: "get_messages_by_date_range", input: { after_date: "not a date" } },
          { id: "d", name: "nope", input: {} },
        ],
      };
    });
    try {
      const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
        query: "When did Alice change jobs?",
        reasoning_level: "high",
        include_evidence: true,
      });
      const json = (await res.json()) as {
        content: string;
        evidence: { tool_calls: { tool_name: string }[] };
      };
      expect(json.content).toBe("Found it.");
      expect(json.evidence.tool_calls.map((t) => t.tool_name)).toEqual(
        expect.arrayContaining(["search_messages", "get_messages_by_date_range"]),
      );
      expect(toolOutputs[0]).toMatch(/\[M\d+\]/);
      expect(toolOutputs[1]).toContain("2026-03-05 alice: I switched jobs");
      expect(toolOutputs[2]).toContain("ISO 8601");
      expect(toolOutputs[3]).toContain("unknown tool");
    } finally {
      server.ctx.llm.mock.respondWith(null);
    }
  });

  it("streams a tool-loop answer from the single call that produced it", async () => {
    const since = (await chatUsage(server.ctx)).at(-1)?.id ?? 0;
    const res = await server.request("POST", "/v3/workspaces/acme/peers/alice/chat", {
      query: "Where does Alice live now?",
      reasoning_level: "high",
      stream: true,
    });
    const events = parseSse(await res.text());
    expect(events.at(-1)!.done).toBe(true);
    expect(events.map((e) => e.delta?.content ?? "").join("").length).toBeGreaterThan(0);
    expect((await chatUsage(server.ctx, since)).length).toBe(2); // one tool round + the answer, never a second answer
  });
});
