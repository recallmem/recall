import type { RequestContext } from "@mastra/core/request-context";
import { type Peer, Recall } from "@recall-memory/sdk";

/**
 * An id, or how to find it for a run. A function gets the run's request context; returning
 * `undefined` means "not known for this run" and memory is skipped.
 */
export type IdSource =
  | string
  | ((args: { requestContext: RequestContext | undefined }) => string | undefined);

/** Who the memory is about, and where the conversation is stored. */
export interface RecallMastraOptions {
  /**
   * The Recall client. Default: one `new Recall()` per process, configured from `RECALL_API_KEY`,
   * `RECALL_URL` and `RECALL_WORKSPACE_ID`.
   */
  recall?: Recall;
  /**
   * The person the agent talks to, as a Recall peer id. Default: the run's resource id, which is
   * `MASTRA_RESOURCE_ID_KEY` in the request context, or `memory.resource` when the agent has Mastra
   * memory.
   */
  userId?: IdSource;
  /**
   * The conversation, as a Recall session id. Default: the run's thread id, which is
   * `MASTRA_THREAD_ID_KEY` in the request context, or `memory.thread` when the agent has Mastra
   * memory.
   */
  sessionId?: IdSource;
  /**
   * The assistant's peer id (default `"assistant"`). Recall reads its replies as context for the
   * user's messages but learns nothing about the assistant itself (`observeMe: false`).
   */
  assistantId?: string;
}

// Mastra's reserved request-context keys (MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY), and the
// entry Mastra memory sets for a run.
const RESOURCE_KEY = "mastra__resourceId";
const THREAD_KEY = "mastra__threadId";
const MEMORY_KEY = "MastraMemory";

const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function contextValue(requestContext: RequestContext | undefined, key: string): unknown {
  return (requestContext as { get?: (key: string) => unknown } | undefined)?.get?.(key);
}

function resolve(
  source: IdSource | undefined,
  requestContext: RequestContext | undefined,
  key: string,
  fromMemory: (memory: { resourceId?: unknown; thread?: { id?: unknown } | null }) => unknown,
): string | undefined {
  if (typeof source === "string") return text(source);
  if (typeof source === "function") return text(source({ requestContext }));
  const memory = contextValue(requestContext, MEMORY_KEY) as Parameters<typeof fromMemory>[0];
  return text(contextValue(requestContext, key)) ?? (memory ? text(fromMemory(memory)) : undefined);
}

export function userIdOf(options: RecallMastraOptions, requestContext?: RequestContext) {
  return resolve(options.userId, requestContext, RESOURCE_KEY, (m) => m.resourceId);
}

export function sessionIdOf(options: RecallMastraOptions, requestContext?: RequestContext) {
  return resolve(options.sessionId, requestContext, THREAD_KEY, (m) => m.thread?.id);
}

let defaultClient: Recall | undefined;
/** Assistant handles per client, so the `observeMe: false` setting is sent once per process. */
const assistants = new WeakMap<Recall, Map<string, Peer>>();

export function client(options: RecallMastraOptions): Recall {
  if (options.recall) return options.recall;
  defaultClient ??= new Recall();
  return defaultClient;
}

export function assistantPeer(recall: Recall, id: string): Peer {
  let byId = assistants.get(recall);
  if (!byId) {
    byId = new Map();
    assistants.set(recall, byId);
  }
  let peer = byId.get(id);
  if (!peer) {
    peer = recall.peer(id, { configuration: { observeMe: false } });
    byId.set(id, peer);
  }
  return peer;
}

/** A 404 from Recall: the workspace, peer or session does not exist yet, so nothing is known. */
export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404
  );
}

/** For `.catch()`: a 404 becomes `fallback`, anything else is rethrown. */
export const orNothing =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if (isNotFound(error)) return fallback;
    throw error;
  };

/** Recall stores at most 25,000 characters per message; longer text is stored as several. */
export function pieces(value: string, size = 24_000): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

/**
 * What Recall knows about the user, as a block for the system prompt, biased towards `query`
 * (usually the user's latest message). Empty when nothing is known yet.
 */
export async function memoryText(
  user: Peer,
  query: string | undefined,
  maxConclusions?: number,
): Promise<string> {
  let representation: string | null = null;
  let card: string[] | null = null;
  try {
    const context = await user.context({
      ...(query?.trim() ? { searchQuery: query.trim().slice(0, 2_000) } : {}),
      ...(maxConclusions === undefined ? {} : { maxConclusions }),
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
    `Memory: what you know about the user (${user.id}) from earlier conversations, kept by Recall. Use it when it helps. It can be incomplete or out of date; what the user says now takes precedence.`,
    ...blocks,
  ].join("\n");
}
