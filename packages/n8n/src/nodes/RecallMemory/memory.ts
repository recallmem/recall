import { BaseChatHistory, BaseChatMemory, type Message } from "@n8n/ai-node-sdk";
import { newKey, type Recall, split } from "../../shared/api.js";

export interface RecallMemoryConfig {
  recall: Recall;
  /** The conversation (a Recall session). */
  sessionId: string;
  /** The person the agent talks to (a Recall peer): what Recall learns is about them. */
  userId: string;
  /** The agent's peer. Recall reads its replies as context but learns nothing about it. */
  assistantId: string;
  /** Token budget for the conversation: a summary of older turns plus the latest messages. */
  tokens: number;
  /** Add what Recall knows about the user from every earlier conversation. */
  knowledge: boolean;
  /** What to bias that knowledge towards, usually the incoming message. */
  query: string;
  /** Role of the message carrying memory: some chat models accept a system message only first. */
  placement: "system" | "user";
}

interface WireMessage {
  peer_id?: string;
  content?: string;
}

interface SessionContext {
  messages?: WireMessage[];
  summary?: { content?: string } | null;
}

interface PeerContext {
  representation?: string | null;
  peer_card?: string[] | null;
}

const text = (message: Message) =>
  message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

const asMessage = (role: Message["role"], body: string): Message => ({
  role,
  content: [{ type: "text", text: body }],
});

/** The conversation as Recall stores it: one session, the user's and the agent's messages. */
export class RecallChatHistory extends BaseChatHistory {
  #session: Promise<unknown> | null = null;

  constructor(private readonly config: RecallMemoryConfig) {
    super();
  }

  /** Gets or creates the session once, with the agent marked as not a source of facts. */
  #ensureSession() {
    const { recall, sessionId, userId, assistantId } = this.config;
    this.#session ??= recall("PUT", `/peers/${encodeURIComponent(assistantId)}`, {
      body: { configuration: { observe_me: false } },
    })
      .then(() =>
        recall("POST", "/sessions", {
          body: {
            id: sessionId,
            peers: { [userId]: { observe_me: true }, [assistantId]: { observe_me: false } },
          },
        }),
      )
      .catch((error: unknown) => {
        this.#session = null;
        throw error;
      });
    return this.#session;
  }

  /** The conversation within the token budget: a summary of the older turns, then the latest ones. */
  async getMessages(): Promise<Message[]> {
    const { recall, sessionId, assistantId, tokens } = this.config;
    const context = await recall<SessionContext>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/context`,
      { query: { tokens, summary: true }, allowNotFound: true },
    );
    const out: Message[] = [];
    const summary = context?.summary?.content?.trim();
    if (summary) out.push(asMessage("system", `Summary of the earlier conversation:\n${summary}`));
    for (const m of context?.messages ?? []) {
      if (!m.content) continue;
      out.push(asMessage(m.peer_id === assistantId ? "assistant" : "user", m.content));
    }
    return out;
  }

  async addMessage(message: Message): Promise<void> {
    await this.addMessages([message]);
  }

  /** Stores the user's and the agent's messages; anything else (system, tool) is not part of it. */
  override async addMessages(messages: Message[]): Promise<void> {
    const { recall, sessionId, userId, assistantId } = this.config;
    const wire = messages.flatMap((m) => {
      if (m.role !== "user" && m.role !== "assistant") return [];
      const peer = m.role === "user" ? userId : assistantId;
      return split(text(m)).map((content) => ({
        peer_id: peer,
        content,
        metadata: { source: "n8n" },
      }));
    });
    if (!wire.length) return;
    await this.#ensureSession();
    await recall("POST", `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      body: { messages: wire },
      idempotencyKey: newKey("messages"),
    });
  }

  /** Deletes the conversation from Recall; its messages and what was learned from them go too. */
  async clear(): Promise<void> {
    const { recall, sessionId } = this.config;
    await recall("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, { allowNotFound: true });
    this.#session = null;
  }
}

/**
 * Memory for n8n's AI Agent: what Recall knows about the user from every earlier conversation,
 * then this conversation within a token budget. Each turn is stored, so Recall keeps learning.
 */
export class RecallAgentMemory extends BaseChatMemory {
  readonly chatHistory: RecallChatHistory;

  constructor(private readonly config: RecallMemoryConfig) {
    super();
    this.chatHistory = new RecallChatHistory(config);
  }

  async loadMessages(): Promise<Message[]> {
    const [known, conversation] = await Promise.all([
      this.config.knowledge ? this.knowledge() : Promise.resolve(""),
      this.chatHistory.getMessages(),
    ]);
    return known ? [asMessage(this.config.placement, known), ...conversation] : conversation;
  }

  async saveTurn(input: string, output: string): Promise<void> {
    await this.chatHistory.addMessages([asMessage("user", input), asMessage("assistant", output)]);
  }

  async clear(): Promise<void> {
    await this.chatHistory.clear();
  }

  /** What Recall knows about the user, as one block of text; empty when it knows nothing yet. */
  async knowledge(): Promise<string> {
    const { recall, userId, query } = this.config;
    const q = query.trim().slice(0, 2_000);
    const context = await recall<PeerContext>(
      "GET",
      `/peers/${encodeURIComponent(userId)}/context`,
      { query: q ? { search_query: q } : {}, allowNotFound: true },
    );
    const blocks: string[] = [];
    const card = context?.peer_card?.filter((line) => line.trim()) ?? [];
    if (card.length) blocks.push(card.map((line) => `- ${line}`).join("\n"));
    const representation = context?.representation?.trim();
    if (representation) blocks.push(representation);
    if (!blocks.length) return "";
    return [
      `Memory: what you know about the user (${userId}) from earlier conversations, kept by Recall. Use it when it helps. It can be incomplete or out of date; what the user says now takes precedence.`,
      ...blocks,
    ].join("\n\n");
  }
}
