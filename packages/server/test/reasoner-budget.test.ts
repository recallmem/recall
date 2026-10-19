import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DreamOut, scheduleManualDream } from "../src/consolidate/index.js";
import { rows } from "../src/db/client.js";
import { countTokens } from "../src/lib/tokens.js";
import { strictJsonSchema } from "../src/llm/client.js";
import { drainQueue } from "../src/queue/worker.js";
import { ExtractionOut } from "../src/reasoner/prompt.js";
import { SummaryOut } from "../src/summaries/index.js";
import { createTestServer } from "./helpers.js";
import { addMessages, conclusions, seed } from "./reasoner-fixtures.js";

/**
 * Background cost per 100 messages, measured the way spec 02 §8 models
 * Honcho: one session, `user` and `assistant` alternating, ~60 tokens per
 * message, posted live one at a time, all defaults (batch 1,200 tokens,
 * summaries every 20/60, both peers observed), then the session goes idle
 * and each collection dreams once (Honcho's scenario has two dreams).
 *
 * Honcho at defaults: ~56 calls, ~190k input tokens. Budget: <= 8 calls, <= 26k (the cached
 * extraction prefix grew by its changes list and in-passing rule: 25k before).
 */

const USER = [
  "I live in Amsterdam with my partner Sam and our dog Rover.",
  "I work as a nurse at the OLVG hospital, mostly night shifts.",
  "My favorite food is Indonesian rijsttafel from the place around the corner.",
  "I love cycling along the Amstel river early in the morning.",
  "I have a younger brother called Tom who studies law in Leiden.",
  "I'm training for the Amsterdam half marathon in October.",
  "I'm allergic to peanuts, so I always check menus carefully.",
  "I play the cello in an amateur orchestra on Tuesday evenings.",
  "I prefer short, direct answers without long introductions.",
  "My mother lives in Utrecht and I visit her every other Sunday.",
  "I love sushi, especially salmon nigiri from the market stall.",
  "I'm learning Spanish because we plan a long trip to Andalusia.",
  "I have a vegetable garden on our balcony with tomatoes and basil.",
  "I enjoy reading crime novels by Scandinavian authors before bed.",
  "I drive an old blue Volvo that my father gave me.",
  "I'm saving money for a down payment on a bigger apartment.",
  "I hate crowded supermarkets, so I shop very early on Saturdays.",
  "I volunteer at a food bank on the first Saturday of every month.",
  "I love hiking in the Alps and go there every summer with Sam.",
  "I studied nursing at the Hogeschool van Amsterdam.",
  "My partner Sam works as a graphic designer at a small studio.",
  "I'm thinking about switching to day shifts next year for better sleep.",
  "I enjoy baking sourdough bread on my days off.",
  "I live in Amsterdam, close to the Oosterpark.",
  "I have a cat called Miso as well as the dog.",
  "I moved to Berlin last month for a new job at the Charité.",
  "I work as a midwife now, which I always wanted to do.",
  "I'm finding the German bureaucracy quite exhausting.",
  "I love the lakes around Berlin for swimming in summer.",
  "My brother Tom is visiting me in Berlin next weekend.",
  "I'm taking German lessons twice a week in the evening.",
  "I don't like sushi anymore after a bad experience last month.",
  "I prefer the U-Bahn over cycling here because of the traffic.",
  "I joined a running club in Tempelhof to keep up my marathon training.",
  "I'm planning to adopt a second dog once we settle in.",
  "My partner Sam found a remote job, so we both live in Berlin now.",
  "I love the flea market at Mauerpark on Sundays.",
  "I still play the cello and found a new orchestra in Kreuzberg.",
  "I'm worried about the long commute to the hospital.",
  "I enjoy cooking Indonesian food for new friends here.",
  "I have a night shift every Wednesday this month.",
  "I'm reading a new crime novel by a Norwegian author.",
  "I want to visit my mother in Utrecht at Christmas.",
  "I prefer short, direct answers, please keep it brief.",
  "I bought a cargo bike for weekend trips with Rover.",
  "I'm considering a master's degree in public health.",
  "I love hiking and plan a trip to the Harz mountains.",
  "My favorite food is still Indonesian rijsttafel.",
  "I'm saving for a house outside the city now.",
  "I finished the Berlin half marathon in under two hours!",
];

const FILLER = [
  "Could you help me think this through a bit?",
  "What would you suggest as a next step for me?",
  "Any practical advice is welcome, nothing too fancy.",
  "I would love a couple of concrete ideas for this week.",
  "Does that sound reasonable to you, or am I missing something?",
];

const CONTEXT = [
  "The last few weeks have been hectic, with lots of overtime and very little time to cook proper meals or see friends.",
  "Things are going reasonably well overall, but the weather has been grey and rainy, which does not help with motivation.",
  "Lately there has been a lot going on, between family visits, appointments and a pile of paperwork that keeps growing.",
  "It is a small thing, but it keeps coming up in conversations with friends and it would be nice to finally sort it out.",
  "Honestly it has been on the to-do list for months, and every weekend something else seems to get in the way of it.",
];

const ADVICE = [
  "That sounds like a lot to juggle. A good next step could be to write down the three things that matter most this week, then block time for each of them in your calendar. Keep the plan small enough that it survives a busy night shift.",
  "Great question. Start with one small habit you can repeat daily, track it for two weeks, and only then add the next one. Most people overestimate what they can change in a month and underestimate a year.",
  "Here is a simple approach: pick a fixed day, prepare everything the evening before, and keep a short checklist on your phone. That way the routine runs even when you are tired after work.",
  "It helps to compare the options side by side: cost, time per week, and how much energy each one takes. Write a quick score from one to five for each, and the best choice usually becomes obvious.",
  "A practical idea is to ask a friend or neighbour to join you, because shared plans are easier to keep. If that is not possible, a small reward after each step works surprisingly well too.",
];

function script(): { peer: string; content: string; createdAt: Date }[] {
  const t0 = Date.parse("2026-10-01T08:00:00Z");
  const out: { peer: string; content: string; createdAt: Date }[] = [];
  for (let i = 0; i < 50; i++) {
    const user = `${USER[i]} ${CONTEXT[(i * 3) % CONTEXT.length]} ${FILLER[i % FILLER.length]}`;
    const reply = `${ADVICE[i % ADVICE.length]} Let me know how it goes this week, and we can adjust the plan together next time if something does not work for you.`;
    out.push({ peer: "user", content: user, createdAt: new Date(t0 + i * 120_000) });
    out.push({ peer: "assistant", content: reply, createdAt: new Date(t0 + i * 120_000 + 60_000) });
  }
  return out;
}

const SCHEMA_TOKENS: Record<string, number> = {
  reasoner: countTokens(JSON.stringify(strictJsonSchema(ExtractionOut))),
  summary: countTokens(JSON.stringify(strictJsonSchema(SummaryOut))),
  dream: countTokens(JSON.stringify(strictJsonSchema(DreamOut))),
};

describe("cost per 100 messages", () => {
  it("stays within 8 LLM calls and 26k input tokens", async () => {
    const { ctx, close } = await createTestServer({ RECALL_REASONER_MAX_DELAY_MS: "600000" });
    try {
      const s = await seed(ctx, { peers: ["user", "assistant"] });
      const messages = script();
      const messageTokens = messages.map((m) => countTokens(m.content));
      // Live: each message is posted on its own and the worker runs in between.
      for (const m of messages) {
        await addMessages(ctx, s, [m]);
        await drainQueue(ctx);
      }
      // The session goes quiet: flush what is still waiting for a batch...
      await ctx.db.execute(
        sql`UPDATE jobs SET run_after = now(), payload = payload || '{"flush": true}'::jsonb WHERE status = 'pending' AND kind = 'reason'`,
      );
      await drainQueue(ctx);
      const autoDreamsDue = await rows<{ n: number }>(
        ctx.db,
        sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'dream'`,
      );
      // ...and, as in Honcho's scenario, each collection dreams once.
      for (const peer of ["user", "assistant"]) {
        await scheduleManualDream(ctx, {
          workspaceId: s.workspaceId,
          observer: peer,
          observed: peer,
          type: "omni",
          sessionName: null,
          rebuild: false,
        });
      }
      await drainQueue(ctx);

      await ctx.usage.flush();
      const usage = await rows<{
        task: string;
        calls: number;
        input: number | string;
        output: number | string;
      }>(
        ctx.db,
        sql`SELECT task, count(*)::int AS calls, sum(input_tokens) AS input, sum(output_tokens) AS output
            FROM llm_usage WHERE workspace_id = ${s.workspaceId} GROUP BY task ORDER BY task`,
      );
      // o200k count of everything sent, including the JSON schema that real providers bill as input.
      const exact: Record<string, { calls: number; input: number }> = {};
      for (const { req } of ctx.llm.mock.calls) {
        const text = [
          req.system ?? "",
          req.context ?? "",
          ...req.messages.map((m) => m.content),
        ].join("\n");
        exact[req.task] ??= { calls: 0, input: 0 };
        const e = exact[req.task]!;
        e.calls++;
        e.input += countTokens(text) + (req.jsonSchema ? (SCHEMA_TOKENS[req.task] ?? 0) : 0);
      }
      const llm = usage.filter((u) => u.task !== "embedding");
      const totalCalls = llm.reduce((n, u) => n + u.calls, 0);
      const totalInput = Object.values(exact).reduce((n, e) => n + e.input, 0);
      const cs = await conclusions(ctx, s.workspaceId);
      const summaries = await rows<{ kind: string; n: number }>(
        ctx.db,
        sql`SELECT kind, count(*)::int AS n FROM summary_blocks GROUP BY kind ORDER BY kind`,
      );
      const embeddingCalls = usage.find((u) => u.task === "embedding")?.calls ?? 0;

      console.log(
        [
          `messages: ${messages.length}, message tokens: ${messageTokens.reduce((a, b) => a + b, 0)} (avg ${Math.round(messageTokens.reduce((a, b) => a + b, 0) / messages.length)})`,
          "task       calls  input(o200k+schema)  input(llm_usage)  output(llm_usage)",
          ...llm.map(
            (u) =>
              `${u.task.padEnd(10)} ${String(u.calls).padStart(5)}  ${String(exact[u.task]?.input ?? 0).padStart(19)}  ${String(u.input).padStart(16)}  ${String(u.output).padStart(17)}`,
          ),
          `TOTAL      ${String(totalCalls).padStart(5)}  ${String(totalInput).padStart(19)}`,
          `embedding requests: ${embeddingCalls}`,
          `auto dreams queued by threshold: ${autoDreamsDue[0]!.n}`,
          `conclusions: ${cs.length} rows, current ${cs.filter((c) => !c.valid_to && !c.deleted_at).length}, superseded ${cs.filter((c) => c.valid_to).length}, merged ${cs.filter((c) => c.deleted_at).length}, reinforced ${cs.filter((c) => c.times_derived > 1).length}`,
          `levels: ${JSON.stringify(Object.fromEntries(["explicit", "deductive", "inductive", "contradiction"].map((l) => [l, cs.filter((c) => c.level === l).length])))}`,
          `summary rows: ${JSON.stringify(Object.fromEntries(summaries.map((x) => [x.kind, x.n])))}`,
        ].join("\n"),
      );

      expect(totalCalls).toBeLessThanOrEqual(8);
      expect(totalInput).toBeLessThanOrEqual(26_000);
      // Updates are applied at ingest: Amsterdam -> Berlin, nurse -> midwife.
      const current = cs
        .filter((c) => c.observed === "user" && !c.valid_to && !c.deleted_at)
        .map((c) => c.content);
      expect(current.some((c) => c.includes("lives in Berlin"))).toBe(true);
      expect(current.some((c) => c.includes("lives in Amsterdam"))).toBe(false);
      expect(current.some((c) => c.includes("works as a midwife"))).toBe(true);
      expect(current.some((c) => c.includes("works as a nurse"))).toBe(false);
      expect(summaries.find((x) => x.kind === "short")?.n).toBe(1);
      expect(summaries.find((x) => x.kind === "long")?.n).toBe(1);
    } finally {
      await close();
    }
  });
});
