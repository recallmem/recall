import { type Peer, Recall } from "@recall-memory/sdk";

/** Who the memory is about. */
export interface RecallUserOptions {
  /**
   * The Recall client. Default: one `new Recall()` per process, configured from `RECALL_API_KEY`,
   * `RECALL_URL` and `RECALL_WORKSPACE_ID`.
   */
  recall?: Recall;
  /** The person the agent talks to, as a Recall peer id: your own stable user id. */
  userId: string;
}

let defaultClient: Recall | undefined;
/** Assistant handles per client, so the `observeMe: false` setting is sent once per process. */
const assistants = new WeakMap<Recall, Map<string, Peer>>();

export function client(options: { recall?: Recall | undefined }): Recall {
  if (options.recall) return options.recall;
  defaultClient ??= new Recall();
  return defaultClient;
}

export function requireId(name: string, value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`);
  return value;
}

/** The assistant's peer: Recall reads its replies as context but learns nothing about it. */
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
export function pieces(text: string, size = 24_000): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
