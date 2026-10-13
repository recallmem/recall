import { type Peer, Recall, type Session } from "@recall-memory/sdk";

/** Who the memory is about, and where the conversation is stored. */
export interface RecallMemoryOptions {
  /**
   * The Recall client. Default: one `new Recall()` per process, configured from `RECALL_API_KEY`,
   * `RECALL_URL` and `RECALL_WORKSPACE_ID`.
   */
  recall?: Recall;
  /** The person the agent talks to, as a Recall peer id: your own stable user id. */
  userId: string;
  /**
   * The assistant's peer id (default `"assistant"`). Recall reads its replies as context for the
   * user's messages but learns nothing about the assistant itself (`observeMe: false`).
   */
  assistantId?: string;
  /** The conversation, as a Recall session id. Needed to store turns. */
  sessionId?: string;
}

export interface Handles {
  recall: Recall;
  user: Peer;
  assistant: Peer;
  session: Session | null;
}

let defaultClient: Recall | undefined;
/** Assistant handles per client, so the `observeMe: false` setting is sent once per process. */
const assistants = new WeakMap<Recall, Map<string, Peer>>();

export function handles(options: RecallMemoryOptions): Handles {
  if (typeof options.userId !== "string" || !options.userId) {
    throw new TypeError("userId is required: the Recall peer id of the person the agent talks to");
  }
  if (!options.recall) defaultClient ??= new Recall();
  const recall = options.recall ?? (defaultClient as Recall);
  const assistantId = options.assistantId ?? "assistant";
  let byId = assistants.get(recall);
  if (!byId) {
    byId = new Map();
    assistants.set(recall, byId);
  }
  let assistant = byId.get(assistantId);
  if (!assistant) {
    assistant = recall.peer(assistantId, { configuration: { observeMe: false } });
    byId.set(assistantId, assistant);
  }
  return {
    recall,
    user: recall.peer(options.userId),
    assistant,
    session: options.sessionId ? recall.session(options.sessionId) : null,
  };
}

/** A 404 from Recall: the workspace, peer or session does not exist yet, so nothing is known. */
export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404
  );
}

/** Recall stores at most 25,000 characters per message; longer text is stored as several. */
export function pieces(text: string, size = 24_000): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export interface MemoryOptions {
  /** Most facts to include (Recall's default when absent). */
  maxConclusions?: number;
}

/**
 * What Recall knows about the user, as a block for the system prompt, biased towards `query`
 * (usually the user's latest message). Empty when nothing is known yet.
 */
export async function memoryText(
  h: Handles,
  query: string | undefined,
  options: MemoryOptions = {},
): Promise<string> {
  let representation: string | null = null;
  let card: string[] | null = null;
  try {
    const context = await h.user.context({
      ...(query?.trim() ? { searchQuery: query.trim().slice(0, 2_000) } : {}),
      ...(options.maxConclusions === undefined ? {} : { maxConclusions: options.maxConclusions }),
    });
    representation = context.representation;
    card = context.peerCard;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const blocks: string[] = [];
  if (card?.length)
    blocks.push(`<peer_card>\n${card.map((l) => `- ${l}`).join("\n")}\n</peer_card>`);
  if (representation?.trim()) {
    blocks.push(`<peer_representation>\n${representation.trim()}\n</peer_representation>`);
  }
  if (!blocks.length) return "";
  return [
    `Memory: what you know about the user (${h.user.id}) from earlier conversations, kept by Recall. Use it when it helps. It can be incomplete or out of date; what the user says now takes precedence.`,
    ...blocks,
  ].join("\n");
}

/** One exchange to store: the user's message and the assistant's reply (either may be absent). */
export interface Turn {
  user?: string;
  assistant?: string;
}

/** Stores a turn in the session: the user's message, then the reply. Empty parts are skipped. */
export async function storeTurn(h: Handles, turn: Turn): Promise<void> {
  if (!h.session) throw new TypeError("sessionId is required to store turns");
  const messages = [
    ...pieces(turn.user?.trim() ?? "").map((text) => h.user.message(text)),
    ...pieces(turn.assistant?.trim() ?? "").map((text) => h.assistant.message(text)),
  ];
  if (messages.length) await h.session.addMessages(messages);
}
