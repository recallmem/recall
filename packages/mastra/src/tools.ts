import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import type { ReasoningLevel } from "@recall-memory/sdk";
import { z } from "zod/v4";
import { client, orNothing, type RecallMastraOptions, userIdOf } from "./core.js";

export interface RecallToolsOptions extends Omit<RecallMastraOptions, "sessionId" | "assistantId"> {
  /** Reasoning level for `askMemory` (Recall's default, `low`, when absent). */
  reasoningLevel?: ReasoningLevel;
}

export interface SearchMemoryResult {
  /** Facts Recall holds about the user that match the query, most relevant first. */
  facts: { content: string; createdAt: string }[];
  /** Messages the user wrote that match the query. */
  messages: { content: string; sessionId: string; createdAt: string }[];
}

/**
 * Tools that let a Mastra agent use Recall itself: `searchMemory` (facts and messages that match),
 * `askMemory` (a question about the user, answered from memory) and `rememberFact` (save one fact).
 * Spread them into the agent's `tools`. The user is `userId`, else the run's resource id.
 */
export function recallTools(options: RecallToolsOptions = {}) {
  const userFor = (context: { requestContext?: RequestContext } | undefined) => {
    const userId = userIdOf(options, context?.requestContext);
    if (!userId) {
      throw new Error(
        "Recall does not know who the user is: pass userId, or set MASTRA_RESOURCE_ID_KEY in the request context",
      );
    }
    return client(options).peer(userId);
  };

  const searchMemory = createTool({
    id: "search-memory",
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
    execute: async ({ query, limit }, context): Promise<SearchMemoryResult> => {
      const user = userFor(context);
      const [facts, messages] = await Promise.all([
        user.conclusions.query(query, { topK: limit ?? 8 }).catch(orNothing([])),
        user.search(query, { limit: limit ?? 8 }).catch(orNothing([])),
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

  const askMemory = createTool({
    id: "ask-memory",
    description:
      "Ask long-term memory a question about the user in plain language, for example 'What diet does the user follow?' or 'What did we decide about the trip?'. Recall answers from everything it remembers. Slower than searchMemory; use it when the answer needs several facts combined.",
    inputSchema: z.object({
      question: z.string().min(1).max(2_000).describe("The question, about the user."),
    }),
    execute: async ({ question }, context): Promise<{ answer: string | null }> => {
      const answer = await userFor(context)
        .chat(question, options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {})
        .catch(orNothing(null));
      return { answer };
    },
  });

  const rememberFact = createTool({
    id: "remember-fact",
    description:
      "Save one lasting fact about the user to long-term memory, as one short sentence, for example 'Is allergic to peanuts.' or 'Moved to Utrecht in May 2026.'. Use it when the user shares a preference, plan, decision or correction worth keeping. Never save passwords, payment details or other secrets.",
    inputSchema: z.object({
      fact: z
        .string()
        .min(1)
        .max(2_000)
        .describe("The fact, as one short sentence about the user."),
    }),
    execute: async ({ fact }, context): Promise<{ saved: true; id: string | null }> => {
      const [created] = await userFor(context).conclusions.create(fact.trim());
      return { saved: true, id: created?.id ?? null };
    },
  });

  return { searchMemory, askMemory, rememberFact };
}
