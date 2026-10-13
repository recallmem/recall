import type { MastraDBMessage } from "@mastra/core/memory";
import type { ProcessInputArgs, ProcessOutputResultArgs, Processor } from "@mastra/core/processors";
import {
  assistantPeer,
  client,
  memoryText,
  pieces,
  type RecallMastraOptions,
  sessionIdOf,
  userIdOf,
} from "./core.js";

export interface RecallMemoryOptions extends RecallMastraOptions {
  /** Add what Recall knows about the user to each run, as a system message (default true). */
  context?: boolean;
  /** Store each run's user message and the agent's reply in the session (default true). */
  store?: boolean;
  /** Most facts to include (Recall's default when absent). */
  maxConclusions?: number;
  /**
   * Called when Recall cannot be read or written. The run always goes on, without memory if need
   * be. Default: a `console.warn`.
   */
  onError?: (error: unknown) => void;
}

const TAG = "recall-memory";

/** The text of a stored Mastra message: its text parts, else the legacy flattened string. */
function textOf(message: MastraDBMessage): string {
  const parts = message.content.parts ?? [];
  const fromParts = parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
  const legacy = (message.content as { content?: unknown }).content;
  return (fromParts || (typeof legacy === "string" ? legacy : "")).trim();
}

/** The text of the messages with this role. */
function textBy(role: "user" | "assistant", messages: MastraDBMessage[]): string {
  return messages
    .filter((m) => m.role === role)
    .map(textOf)
    .filter(Boolean)
    .join("\n");
}

/**
 * A Mastra processor that gives an agent Recall memory. As an input processor it adds what Recall
 * knows about the user (biased towards their message) to the run as a system message; as an output
 * processor it stores the user's message and the agent's reply in the session. Put the same
 * instance in both lists:
 *
 * ```ts
 * const memory = new RecallMemory();
 * new Agent({ ..., inputProcessors: [memory], outputProcessors: [memory] });
 * ```
 */
export class RecallMemory implements Processor<typeof TAG> {
  readonly id = TAG;
  readonly name = "Recall memory";
  readonly description = "Adds what Recall remembers about the user and stores each turn.";
  readonly #options: RecallMemoryOptions;

  constructor(options: RecallMemoryOptions = {}) {
    this.#options = options;
  }

  #report(error: unknown): void {
    if (this.#options.onError) this.#options.onError(error);
    else
      console.warn("[recall] memory unavailable:", error instanceof Error ? error.message : error);
  }

  async processInput({ messageList, requestContext }: ProcessInputArgs) {
    if (this.#options.context === false) return messageList;
    const userId = userIdOf(this.#options, requestContext);
    if (!userId) return messageList;
    const user = client(this.#options).peer(userId);
    let memory = "";
    try {
      const query = textBy("user", messageList.get.input.db());
      memory = await memoryText(user, query, this.#options.maxConclusions);
    } catch (error) {
      this.#report(error);
    }
    // A system message tagged as this processor's own, next to the agent's instructions.
    if (memory) messageList.addSystem(memory, TAG);
    return messageList;
  }

  async processOutputResult(args: ProcessOutputResultArgs) {
    const { messageList, requestContext } = args;
    if (this.#options.store === false) return messageList;
    const userId = userIdOf(this.#options, requestContext);
    const sessionId = sessionIdOf(this.#options, requestContext);
    if (!userId || !sessionId) return messageList;
    const recall = client(this.#options);
    const user = recall.peer(userId);
    const assistant = assistantPeer(recall, this.#options.assistantId ?? "assistant");
    // Recent @mastra/core releases pass `result` (the run's text); with older 1.x releases the reply
    // is the text of the run's response messages.
    const result = (args as { result?: { text?: unknown } }).result;
    const reply =
      typeof result?.text === "string"
        ? result.text.trim()
        : textBy("assistant", messageList.get.response.db());
    const messages = [
      ...pieces(textBy("user", messageList.get.input.db())).map((t) => user.message(t)),
      ...pieces(reply).map((t) => assistant.message(t)),
    ];
    if (!messages.length) return messageList;
    try {
      await recall.session(sessionId).addMessages(messages);
    } catch (error) {
      this.#report(error);
    }
    return messageList;
  }
}
