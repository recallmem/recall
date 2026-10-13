import type { ReasoningLevel } from "@recall-memory/sdk";
import { type Tool, tool } from "ai";
import { z } from "zod/v4";
import { handles, isNotFound, type RecallMemoryOptions } from "./core.js";

export interface RecallToolsOptions extends RecallMemoryOptions {
  /** Reasoning level for `askMemory` (Recall's default, `low`, when absent). */
  reasoningLevel?: ReasoningLevel;
}

export interface SearchMemoryResult {
  /** Facts Recall holds about the user that match the query, most relevant first. */
  facts: { content: string; createdAt: string }[];
  /** Messages the user wrote that match the query. */
  messages: { content: string; sessionId: string; createdAt: string }[];
}

export interface AskMemoryResult {
  /** Recall's answer, or null when nothing is remembered about the user yet. */
  answer: string | null;
}

export interface RememberFactResult {
  saved: true;
  /** The id of the stored fact (a Recall conclusion). */
  id: string | null;
}

/** The tools `recallTools` returns, keyed by the names the model sees. */
export type RecallTools = {
  searchMemory: Tool<{ query: string; limit?: number | undefined }, SearchMemoryResult>;
  askMemory: Tool<{ question: string }, AskMemoryResult>;
  rememberFact: Tool<{ fact: string }, RememberFactResult>;
};

const orNothing =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if (isNotFound(error)) return fallback;
    throw error;
  };

/**
 * Tools that let the model use Recall itself: search what is remembered about the user, ask a
 * question about them, and save a fact they shared. Spread them into `tools`.
 */
export function recallTools(options: RecallToolsOptions): RecallTools {
  const h = handles(options);
  const searchMemory = tool({
    description:
      "Search long-term memory about the user: facts learned from earlier conversations and messages they wrote. Returns the raw matches. Use it to look up a detail (a name, a date, a preference) before answering.",
    inputSchema: z.object({
      query: z.string().min(1).max(2_000).describe("What to look for, in a few words."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Most results of each kind (default 8)."),
    }),
    execute: async ({ query, limit }, { abortSignal }): Promise<SearchMemoryResult> => {
      const signal = abortSignal ? { signal: abortSignal } : {};
      const [facts, messages] = await Promise.all([
        h.user.conclusions.query(query, { topK: limit ?? 8, ...signal }).catch(orNothing([])),
        h.user.search(query, { limit: limit ?? 8, ...signal }).catch(orNothing([])),
      ]);
      return {
        facts: facts
          .filter((f) => !f.validTo)
          .map((f) => ({ content: f.content, createdAt: f.createdAt })),
        messages: messages.map((m) => ({
          content: m.content,
          sessionId: m.sessionId,
          createdAt: m.createdAt,
        })),
      };
    },
  });
  const askMemory = tool({
    description:
      "Ask long-term memory a question about the user in plain language, for example 'What diet does the user follow?' or 'What did we decide about the trip?'. Recall answers from everything it remembers. Slower than searchMemory; use it when the answer needs several facts combined.",
    inputSchema: z.object({
      question: z.string().min(1).max(2_000).describe("The question, about the user."),
    }),
    execute: async ({ question }, { abortSignal }): Promise<AskMemoryResult> => {
      const answer = await h.user
        .chat(question, {
          ...(options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        })
        .catch(orNothing(null));
      return { answer };
    },
  });
  const rememberFact = tool({
    description:
      "Save one lasting fact about the user to long-term memory, as one short sentence, for example 'Is allergic to peanuts.' or 'Moved to Utrecht in May 2026.'. Use it when the user shares a preference, plan, decision or correction worth keeping. Never save passwords, payment details or other secrets.",
    inputSchema: z.object({
      fact: z
        .string()
        .min(1)
        .max(2_000)
        .describe("The fact, as one short sentence about the user."),
    }),
    execute: async ({ fact }): Promise<RememberFactResult> => {
      const [created] = await h.user.conclusions.create(fact.trim());
      return { saved: true, id: created?.id ?? null };
    },
  });
  return { searchMemory, askMemory, rememberFact };
}
