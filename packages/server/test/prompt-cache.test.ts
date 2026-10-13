import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduleManualDream } from "../src/consolidate/index.js";
import { countTokens } from "../src/lib/tokens.js";
import { anthropicParams } from "../src/llm/providers/anthropic.js";
import { chatParams, wireCache } from "../src/llm/providers/openai.js";
import type { LlmRequest } from "../src/llm/types.js";
import { drainQueue } from "../src/queue/worker.js";
import { createTestServer } from "./helpers.js";
import { addMessages, seed } from "./reasoner-fixtures.js";
import { seedWorld } from "./recall-helpers.js";

/**
 * Every task's requests share a byte-identical prefix (tools, output schema,
 * fixed instructions) that ends at a cache breakpoint, whatever the workspace,
 * session or peer; everything that varies comes after it. Requests are built by
 * the real code paths (reasoner, summaries, dreams, cards, chat) against the
 * mock provider, then rendered by the real provider code for the two wire
 * formats Recall caches on: OpenAI GPT-5.6+ (`openai/gpt-6-luna`, the default
 * model) and Anthropic (`claude-haiku-5-5`).
 */

interface Piece {
  text: string;
  breakpoint: boolean;
}

type Body = Record<string, unknown>;
type Part = { text?: string; prompt_cache_breakpoint?: unknown; cache_control?: unknown };

/** An OpenAI chat body in the order the model reads it: tools, output schema, then messages. */
function openAiPieces(body: Body): Piece[] {
  const out: Piece[] = [];
  if (body.tools) out.push({ text: JSON.stringify(body.tools), breakpoint: false });
  if (body.response_format)
    out.push({ text: JSON.stringify(body.response_format), breakpoint: false });
  for (const m of body.messages as { role: string; content: unknown; tool_calls?: unknown }[]) {
    const parts: Part[] =
      typeof m.content === "string" ? [{ text: m.content }] : ((m.content as Part[]) ?? []);
    for (const p of parts)
      out.push({ text: `${m.role}: ${p.text ?? ""}`, breakpoint: !!p.prompt_cache_breakpoint });
    if (m.tool_calls) out.push({ text: JSON.stringify(m.tool_calls), breakpoint: false });
  }
  return out;
}

/** An Anthropic Messages body in cache-prefix order: tools, output format, system, messages. */
function anthropicPieces(body: Body): Piece[] {
  const out: Piece[] = [];
  if (body.tools) out.push({ text: JSON.stringify(body.tools), breakpoint: false });
  if (body.output_config) out.push({ text: JSON.stringify(body.output_config), breakpoint: false });
  for (const b of (body.system as Part[] | undefined) ?? [])
    out.push({ text: `system: ${b.text}`, breakpoint: !!b.cache_control });
  for (const m of body.messages as { role: string; content: unknown }[]) {
    const parts: Part[] =
      typeof m.content === "string" ? [{ text: m.content }] : (m.content as Part[]);
    for (const p of parts)
      out.push({
        text: `${m.role}: ${p.text ?? JSON.stringify(p)}`,
        breakpoint: !!p.cache_control,
      });
  }
  return out;
}

/** The text through the first breakpoint (the cached static prefix), or null without one. */
function cachedPrefix(pieces: Piece[]): { text: string; next: string } | null {
  const i = pieces.findIndex((p) => p.breakpoint);
  if (i < 0) return null;
  return {
    text: pieces
      .slice(0, i + 1)
      .map((p) => p.text)
      .join("\n"),
    next: pieces[i + 1]?.text ?? "",
  };
}

/** Static pieces before the first one that differs between two requests. */
function sharedPieces(a: Piece[], b: Piece[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i]!.text === b[i]!.text) i++;
  return i;
}

const openAiBody = (req: LlmRequest) =>
  chatParams(
    "openai",
    "gpt-6-luna",
    req,
    wireCache("openai", "gpt-6-luna", req),
  ) as unknown as Body;
const anthropicBody = (req: LlmRequest) =>
  anthropicParams("claude-haiku-5-5", req) as unknown as Body;

/** Prefix measurements printed by the test (o200k tokens). */
const report: string[] = [];

/**
 * Checks two requests of one task from different workspaces/sessions/peers. Returns the
 * cached prefix size on OpenAI, or 0 when the task's prefix is too short to carry one.
 */
function checkPair(task: string, a: LlmRequest, b: LlmRequest): number {
  expect(a.workspaceId).not.toBe(b.workspaceId);
  expect(a.system).toBe(b.system);
  let openAiTokens = 0;
  for (const [wire, body] of [
    ["openai", openAiBody],
    ["anthropic", anthropicBody],
  ] as const) {
    const pa = wire === "openai" ? openAiPieces(body(a)) : anthropicPieces(body(a));
    const pb = wire === "openai" ? openAiPieces(body(b)) : anthropicPieces(body(b));
    const shared = sharedPieces(pa, pb);
    const ca = cachedPrefix(pa);
    const cb = cachedPrefix(pb);
    if (!ca) {
      // Too short to cache: no breakpoint, so nothing is written (OpenAI: explicit mode, no writes).
      expect(cb).toBeNull();
      if (wire === "openai") expect(body(a).prompt_cache_options).toEqual({ mode: "explicit" });
      report.push(
        `${task.padEnd(12)} ${wire.padEnd(9)} static ${countTokens(
          pa
            .slice(0, shared)
            .map((p) => p.text)
            .join("\n"),
        )
          .toString()
          .padStart(5)} tokens, below the minimum: no breakpoint`,
      );
      continue;
    }
    // The cached prefix is byte-identical across workspaces, sessions and peers...
    expect(cb!.text).toBe(ca.text);
    // ...and it is the whole shared prefix: what follows the breakpoint is per-call content.
    const at = pa.findIndex((p) => p.breakpoint);
    expect(shared).toBe(at + 1);
    expect(ca.next).not.toBe(cb!.next);
    const tokens = countTokens(ca.text);
    if (wire === "openai") openAiTokens = tokens;
    report.push(
      `${task.padEnd(12)} ${wire.padEnd(9)} static ${String(tokens).padStart(5)} tokens, then ${String(
        countTokens(
          pa
            .slice(at + 1)
            .map((p) => p.text)
            .join("\n"),
        ),
      ).padStart(5)} per-call tokens (request a)`,
    );
  }
  return openAiTokens;
}

describe("prompt caching: one static prefix per task", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  const calls = () => server.ctx.llm.mock.calls.map((c) => c.req);
  const byTask = (task: string) => calls().filter((r) => r.task === task);
  /** One request per workspace for a task (the first each made). */
  const pair = (task: string): [LlmRequest, LlmRequest] => {
    const seen = new Map<string, LlmRequest>();
    for (const r of byTask(task)) if (!seen.has(r.workspaceId!)) seen.set(r.workspaceId!, r);
    const [a, b] = [...seen.values()];
    expect(a, `${task}: a request from a first workspace`).toBeDefined();
    expect(b, `${task}: a request from a second workspace`).toBeDefined();
    return [a!, b!];
  };

  beforeAll(async () => {
    server = await createTestServer({ RECALL_CHAT_CACHE_TTL_S: "0" });
    const { ctx } = server;
    // Background tasks: two workspaces, different peers and sessions; summaries come from
    // the fallback job in sessions that do not reason.
    const sessions = [
      {
        ws: "north",
        session: "trip-planning",
        peers: ["maya", "coach"],
        lines: [
          "I live in Leeds and work as a nurse.",
          "I love hiking in the Dales with my dog Rover.",
          "I prefer short answers.",
          "My sister Ana is visiting next week.",
        ],
      },
      {
        ws: "south",
        session: "onboarding",
        peers: ["olu", "helper"],
        lines: [
          "I moved to Lagos last year for a job at a bank.",
          "I like jazz and I play the saxophone.",
          "I am learning French on weekday evenings.",
          "My brother Femi studies medicine.",
        ],
      },
    ];
    for (const s of sessions) {
      const [speaker, agent] = s.peers as [string, string];
      const reasoned = await seed(ctx, {
        workspace: s.ws,
        session: s.session,
        peers: s.peers,
        sessionConfig: { summary: { messages_per_short_summary: 4 } },
      });
      await addMessages(
        ctx,
        reasoned,
        s.lines.flatMap((content, i) => [
          {
            peer: speaker,
            content,
            createdAt: new Date(Date.UTC(2026, 2, 1 + i, 9)),
          },
          {
            peer: agent,
            content: "Thanks for telling me, noted.",
            createdAt: new Date(Date.UTC(2026, 2, 1 + i, 9, 1)),
          },
        ]),
      );
      const quiet = await seed(ctx, {
        workspace: s.ws,
        session: `${s.session}-log`,
        peers: s.peers,
        sessionConfig: {
          reasoning: { enabled: false },
          summary: { messages_per_short_summary: 4 },
        },
      });
      await addMessages(
        ctx,
        quiet,
        s.lines.map((content, i) => ({
          peer: i % 2 ? agent : speaker,
          content,
          createdAt: new Date(Date.UTC(2026, 3, 1 + i, 9)),
        })),
      );
      await ctx.db.execute(
        sql`UPDATE jobs SET run_after = now(), payload = payload || '{"flush": true}'::jsonb WHERE status = 'pending'`,
      );
      await drainQueue(ctx);
      for (const type of ["omni", "card_refresh"] as const) {
        await scheduleManualDream(ctx, {
          workspaceId: reasoned.workspaceId,
          observer: speaker,
          observed: speaker,
          type,
          sessionName: null,
          rebuild: false,
        });
        await drainQueue(ctx);
      }
    }

    // Chat: two seeded worlds; the first is renamed so the second can reuse the fixture.
    const first = await seedWorld(ctx);
    await ctx.db.execute(sql`UPDATE workspaces SET name = 'beta' WHERE id = ${first.ws}`);
    await ctx.db.execute(sql`UPDATE peers SET name = 'carla' WHERE id = ${first.alice}`);
    await seedWorld(ctx);
    for (const level of ["minimal", "low", "medium", "high", "max"]) {
      for (const [ws, peer, extra] of [
        ["beta", "carla", { session_id: "s1" }],
        ["acme", "alice", {}],
      ] as const) {
        const res = await server.request("POST", `/v3/workspaces/${ws}/peers/${peer}/chat`, {
          query: "Where does she live now, and what does she do for fun?",
          reasoning_level: level,
          ...extra,
        });
        expect(res.status).toBe(200);
      }
    }
  });
  afterAll(async () => {
    console.log(`\nCACHED PREFIX PER TASK (o200k)\n${report.join("\n")}`);
    await server.close();
  });

  it("gives the reasoner a shared prefix of at least 1,024 tokens", () => {
    const [a, b] = pair("reasoner");
    expect(checkPair("reasoner", a, b)).toBeGreaterThanOrEqual(1024);
  });

  it("gives every chat level a shared prefix of at least 1,024 tokens", () => {
    for (const level of ["minimal", "low", "medium", "high", "max"]) {
      const [a, b] = pair(`chat_${level}`);
      if (level === "high" || level === "max") expect(a.tools?.length).toBeGreaterThan(0);
      expect(checkPair(`chat_${level}`, a, b)).toBeGreaterThanOrEqual(1024);
    }
  });

  it("keeps summaries, dreams and cards static-first (too short to cache on OpenAI)", () => {
    for (const task of ["summary", "dream", "card"]) {
      const [a, b] = pair(task);
      expect(checkPair(task, a, b)).toBe(0);
    }
  });

  it("marks every finished tool round on OpenAI so the next round reads it", () => {
    const loop = byTask("chat_max").find((r) => r.messages.some((m) => m.role === "tool"));
    expect(loop).toBeDefined();
    expect(loop!.cacheContext).toBe(true);
    const body = openAiBody(loop!);
    const marked = openAiPieces(body).filter((p) => p.breakpoint);
    // system, context, the question, and each group of tool results.
    const toolGroups = loop!.messages.filter(
      (m, i) => m.role === "tool" && loop!.messages[i + 1]?.role !== "tool",
    ).length;
    expect(marked).toHaveLength(3 + toolGroups);
    // Tool loops cache the memory pack, so they get a key per workspace.
    expect(body.prompt_cache_key).toBe(`recall:chat_max:${loop!.workspaceId}`);
    // Anthropic: system, context and the end of the conversation (it looks back on its own).
    const anthropic = anthropicPieces(anthropicBody(loop!)).filter((p) => p.breakpoint);
    expect(anthropic).toHaveLength(3);
  });

  it("uses one prompt_cache_key per task for everything else", () => {
    const [a, b] = pair("reasoner");
    expect(openAiBody(a).prompt_cache_key).toBe("recall:reasoner");
    expect(openAiBody(b).prompt_cache_key).toBe("recall:reasoner");
    const [c] = pair("chat_low");
    expect(openAiBody(c).prompt_cache_key).toBe("recall:chat_low");
  });
});
