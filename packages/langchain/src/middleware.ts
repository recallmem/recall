import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { RecallError } from "@recall-memory/sdk";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";
import { assistantPeer, client, isNotFound, pieces, type RecallUserOptions } from "./core.js";

export interface RecallMiddlewareOptions extends Partial<RecallUserOptions> {
  /**
   * The person the agent talks to, as a Recall peer id. When absent it is read from the run's
   * context: `agent.invoke(input, { context: { userId: "user-42" } })` (key set by `userIdKey`).
   */
  userId?: string;
  /** The context key that holds the user id when `userId` is absent (default `"userId"`). */
  userIdKey?: string;
  /**
   * The Recall session each exchange is recorded in. When absent, the run's thread id
   * (`{ configurable: { thread_id } }`) is used.
   */
  sessionId?: string;
  /** The assistant's peer id (default `"assistant"`): Recall reads its replies but learns nothing about it. */
  assistantId?: string;
  /** Add what Recall knows about the user to the system prompt (default true). */
  read?: boolean;
  /** Store each exchange, the user's message and the final answer, in Recall (default true). */
  record?: boolean;
  /** Most facts added to the prompt (default 20). */
  maxConclusions?: number;
  /**
   * Called when Recall cannot be read or written. The run always goes on, without memory if need
   * be. Default: a `console.warn`.
   */
  onError?: (error: unknown) => void;
}

const MAX_QUERY = 500;
/** Memory fetched at the start of a run, kept until its end (bounded for runs that never end). */
const MAX_PENDING = 1_000;
const RECALL_ID = /^[A-Za-z0-9_-]{1,512}$/;

type Exchange = { human: HumanMessage | null; answer: AIMessage | null };

/** The run's question (the last human message) and its final answer (the last AI text after it). */
function lastExchange(messages: readonly BaseMessage[]): Exchange {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (HumanMessage.isInstance(messages[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return { human: null, answer: null };
  let answer: AIMessage | null = null;
  for (let i = messages.length - 1; i > at; i--) {
    const m = messages[i];
    if (AIMessage.isInstance(m) && !m.tool_calls?.length && m.text.trim()) {
      answer = m;
      break;
    }
  }
  return { human: messages[at] as HumanMessage, answer };
}

/** What Recall knows about a person, as text for a prompt ("" when it knows nothing). */
function memoryText(representation: string | null, card: string[] | null): string {
  const parts: string[] = [];
  if (card?.length) parts.push(`Key facts:\n${card.map((line) => `- ${line}`).join("\n")}`);
  if (representation?.trim()) parts.push(representation.trim());
  return parts.join("\n\n");
}

function withMemory(system: SystemMessage, memory: string): SystemMessage {
  const block =
    "<memory>\nWhat you remember about the user from earlier conversations " +
    `(it may be incomplete or out of date):\n${memory}\n</memory>`;
  const text = system.text ? `\n\n${block}` : block;
  if (typeof system.content === "string") return system.concat(text);
  return system.concat(new SystemMessage({ content: [{ type: "text", text }] }));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `value` as a Recall id (letters, digits, `_` and `-`). Valid ids are returned unchanged; anything
 * else is cleaned up and given a short hash of the original, so two values never share an id.
 */
export async function safeId(value: string): Promise<string> {
  if (RECALL_ID.test(value)) return value;
  const cleaned =
    value
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 400) || "id";
  return `${cleaned}-${(await sha256Hex(value)).slice(0, 10)}`;
}

/**
 * Agent middleware for LangChain.js `createAgent` that gives the agent long-term memory of each
 * user. Before the agent runs it reads the user's peer card and the facts Recall learned that
 * relate to the new message (no model call) and adds them to the system prompt. After the run it
 * stores the user's message and the agent's final answer in a Recall session, so Recall keeps
 * learning. Tool calls and their results are not recorded.
 *
 * ```ts
 * import { createAgent } from "langchain";
 * import { recallMiddleware } from "@recall-memory/langchain/middleware";
 *
 * const agent = createAgent({ model, tools: [], middleware: [recallMiddleware()] });
 * await agent.invoke(
 *   { messages: [{ role: "user", content: "Plan my weekend" }] },
 *   { context: { userId: "user-42" }, configurable: { thread_id: "chat-1" } },
 * );
 * ```
 *
 * If Recall cannot be reached the run goes on without memory, and `onError` is called.
 */
export function recallMiddleware(options: RecallMiddlewareOptions = {}) {
  const recall = client(options);
  const userIdKey = options.userIdKey ?? "userId";
  const assistantId = options.assistantId ?? "assistant";
  const read = options.read ?? true;
  const record = options.record ?? true;
  const maxConclusions = options.maxConclusions ?? 20;
  const warn = (what: string, error: unknown) => {
    if (options.onError) options.onError(error);
    else console.warn(`Recall: ${what}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const pending = new Map<string, string>();

  const userOf = (runtime: { context?: unknown }): string => {
    if (options.userId) return options.userId;
    const context = runtime.context as Record<string, unknown> | undefined;
    const value = context?.[userIdKey];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
    throw new Error(
      `recallMiddleware does not know the user: pass userId, or invoke the agent with { context: { ${userIdKey}: ... } }`,
    );
  };

  const sessionOf = async (runtime: { configurable?: { thread_id?: unknown } }) => {
    if (options.sessionId) return options.sessionId;
    const thread = runtime.configurable?.thread_id;
    if (thread === undefined || thread === null || thread === "")
      throw new Error(
        "recallMiddleware needs a session to record into: pass sessionId, invoke the agent with { configurable: { thread_id: ... } }, or set record: false",
      );
    return safeId(String(thread));
  };

  const keyOf = (user: string, human: HumanMessage) => `${user}\u0000${human.id ?? human.text}`;

  return createMiddleware({
    name: "RecallMiddleware",
    // A middleware is only given the context fields it declares.
    contextSchema: z.object({ [userIdKey]: z.union([z.string(), z.number()]).optional() }),

    beforeAgent: async (state, runtime) => {
      if (!(read || record)) return;
      const user = userOf(runtime);
      if (record) await sessionOf(runtime); // fail before the run, not after it
      if (!read) return;
      const { human } = lastExchange(state.messages);
      if (!human) return;
      const query = human.text.trim().slice(0, MAX_QUERY);
      let memory = "";
      try {
        const context = await recall.peer(user).context({
          ...(query ? { searchQuery: query } : {}),
          maxConclusions,
          includeMostFrequent: true,
        });
        memory = memoryText(context.representation, context.peerCard);
      } catch (error) {
        if (!(error instanceof RecallError)) throw error;
        // A 404: nobody by that id yet, so nothing is known.
        if (!isNotFound(error)) warn("could not read memory, going on without it", error);
      }
      if (!memory) return;
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      pending.set(keyOf(user, human), memory);
    },

    wrapModelCall: (request, handler) => {
      if (!read) return handler(request);
      const { human } = lastExchange(request.state.messages);
      const memory = human ? pending.get(keyOf(userOf(request.runtime), human)) : undefined;
      if (!memory) return handler(request);
      return handler({ ...request, systemMessage: withMemory(request.systemMessage, memory) });
    },

    afterAgent: async (state, runtime) => {
      const { human, answer } = lastExchange(state.messages);
      if (human && read) pending.delete(keyOf(userOf(runtime), human));
      if (!record || !human || !answer) return;
      const question = human.text.trim();
      const reply = answer.text.trim();
      if (!question) return;
      const user = userOf(runtime);
      const sessionId = await sessionOf(runtime);
      const userPeer = recall.peer(user);
      const assistant = assistantPeer(recall, assistantId);
      const messages = [
        ...pieces(question).map((p) => userPeer.message(p)),
        ...pieces(reply).map((p) => assistant.message(p)),
      ];
      const basis = [sessionId, human.id ?? question, answer.id ?? reply].join("\u0000");
      try {
        await recall.session(sessionId).addMessages(messages, {
          idempotencyKey: `lc-${(await sha256Hex(basis)).slice(0, 40)}`,
        });
      } catch (error) {
        if (!(error instanceof RecallError)) throw error;
        warn("could not record the exchange", error);
      }
    },
  });
}
