import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import type { ReasoningLevel } from "@recall-memory/sdk";
import { z } from "zod/v4";
import { client, orNothing, type RecallUserOptions, requireId } from "./core.js";

export interface RecallToolsOptions extends RecallUserOptions {
  /** Reasoning level for `ask_memory` (Recall's default, `low`, when absent). */
  reasoningLevel?: ReasoningLevel;
}

/** The tools `recallTools` returns, in this order. */
export type RecallToolList = [
  searchMemory: StructuredToolInterface,
  askMemory: StructuredToolInterface,
  rememberFact: StructuredToolInterface,
];

/**
 * Tools that let a LangChain agent use Recall itself: `search_memory` (facts and messages that
 * match), `ask_memory` (a question about the user, answered from memory) and `remember_fact`
 * (save one fact). Pass them to `bindTools`, `createAgent` or a tool node.
 */
export function recallTools(options: RecallToolsOptions): RecallToolList {
  const user = client(options).peer(requireId("userId", options.userId));

  const searchMemory = tool(
    async ({ query, limit }) => {
      const [facts, messages] = await Promise.all([
        user.conclusions.query(query, { topK: limit ?? 8 }).catch(orNothing([])),
        user.search(query, { limit: limit ?? 8 }).catch(orNothing([])),
      ]);
      return JSON.stringify({
        facts: facts
          .filter((f) => !f.validTo)
          .map((f) => ({ content: f.content, createdAt: f.createdAt })),
        messages: messages.map((m) => ({
          content: m.content,
          sessionId: m.sessionId,
          createdAt: m.createdAt,
        })),
      });
    },
    {
      name: "search_memory",
      description:
        "Search long-term memory about the user: facts learned from earlier conversations and messages they wrote. Returns the raw matches as JSON. Use it to look up a detail (a name, a date, a preference) before answering.",
      schema: z.object({
        query: z.string().min(1).max(2_000).describe("What to look for, in a few words."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Most results of each kind (default 8)."),
      }),
    },
  );

  const askMemory = tool(
    async ({ question }) => {
      const answer = await user
        .chat(question, options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {})
        .catch(orNothing(null));
      return answer ?? "Nothing is remembered about this user yet.";
    },
    {
      name: "ask_memory",
      description:
        "Ask long-term memory a question about the user in plain language, for example 'What diet does the user follow?' or 'What did we decide about the trip?'. Recall answers from everything it remembers. Slower than search_memory; use it when the answer needs several facts combined.",
      schema: z.object({
        question: z.string().min(1).max(2_000).describe("The question, about the user."),
      }),
    },
  );

  const rememberFact = tool(
    async ({ fact }) => {
      await user.conclusions.create(fact.trim());
      return `Saved: ${fact.trim()}`;
    },
    {
      name: "remember_fact",
      description:
        "Save one lasting fact about the user to long-term memory, as one short sentence, for example 'Is allergic to peanuts.' or 'Moved to Utrecht in May 2026.'. Use it when the user shares a preference, plan, decision or correction worth keeping. Never save passwords, payment details or other secrets.",
      schema: z.object({
        fact: z
          .string()
          .min(1)
          .max(2_000)
          .describe("The fact, as one short sentence about the user."),
      }),
    },
  );

  return [searchMemory, askMemory, rememberFact];
}
