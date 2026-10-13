import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Message, MessageInput, Peer, Session } from "@recall-memory/sdk";
import {
  assistantPeer,
  client,
  isNotFound,
  pieces,
  type RecallUserOptions,
  requireId,
} from "./core.js";

export interface RecallChatMessageHistoryInput extends RecallUserOptions {
  /** The conversation, as a Recall session id. */
  sessionId: string;
  /**
   * The assistant's peer id (default `"assistant"`). Recall reads its replies as context for the
   * user's messages but learns nothing about the assistant itself (`observeMe: false`).
   */
  assistantId?: string;
  /**
   * Return Recall's context for the session instead of every message: a summary of the older turns
   * (as a system message) and the most recent messages, within this many tokens.
   */
  tokens?: number;
}

/**
 * A LangChain chat message history stored in a Recall session. Human messages are stored as the
 * user's, AI messages as the assistant's; Recall learns about the user from them. System and tool
 * messages are not stored.
 */
export class RecallChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ["langchain", "stores", "message", "recall"];

  readonly sessionId: string;
  readonly userId: string;
  readonly assistantId: string;
  readonly tokens: number | undefined;
  readonly #session: Session;
  readonly #user: Peer;
  readonly #assistant: Peer;

  static override lc_name(): string {
    return "RecallChatMessageHistory";
  }

  constructor(fields: RecallChatMessageHistoryInput) {
    // Only the ids are kept as serializable fields: never the client, which holds the API key.
    super({ sessionId: fields.sessionId, userId: fields.userId, assistantId: fields.assistantId });
    const recall = client(fields);
    this.sessionId = requireId("sessionId", fields.sessionId);
    this.userId = requireId("userId", fields.userId);
    this.assistantId = fields.assistantId ?? "assistant";
    this.tokens = fields.tokens;
    this.#session = recall.session(this.sessionId);
    this.#user = recall.peer(this.userId);
    this.#assistant = assistantPeer(recall, this.assistantId);
  }

  async getMessages(): Promise<BaseMessage[]> {
    try {
      if (this.tokens) {
        const context = await this.#session.context({ tokens: this.tokens, summary: true });
        const summary = context.summary?.content
          ? [new SystemMessage(`Summary of the earlier conversation:\n${context.summary.content}`)]
          : [];
        return [...summary, ...context.messages.map((m) => this.#toLangChain(m))];
      }
      const out: BaseMessage[] = [];
      for await (const m of await this.#session.messages({ size: 100 })) {
        out.push(this.#toLangChain(m));
      }
      return out;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await this.addMessages([message]);
  }

  override async addMessages(messages: BaseMessage[]): Promise<void> {
    const out: MessageInput[] = [];
    for (const message of messages) {
      const text = message.text.trim();
      const type = message.getType();
      const author = type === "human" ? this.#user : type === "ai" ? this.#assistant : null;
      if (!author || !text) continue; // system and tool messages; AI messages that only call tools
      for (const piece of pieces(text)) out.push(author.message(piece));
    }
    if (out.length) await this.#session.addMessages(out);
  }

  /**
   * Deletes the Recall session: its messages, and the facts Recall learned from this conversation.
   * What was learned in other sessions stays.
   */
  override async clear(): Promise<void> {
    try {
      await this.#session.delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  #toLangChain(m: Message): BaseMessage {
    if (m.peerId === this.assistantId) return new AIMessage({ content: m.content, id: m.id });
    return new HumanMessage({
      content: m.content,
      id: m.id,
      ...(m.peerId === this.userId ? {} : { name: m.peerId }),
    });
  }
}
