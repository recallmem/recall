import {
  handles,
  type MemoryOptions,
  memoryText,
  type RecallMemoryOptions,
  storeTurn,
  type Turn,
} from "./core.js";

export interface RecallContextOptions extends RecallMemoryOptions, MemoryOptions {
  /** Bias the memory towards this text, usually the user's latest message. */
  query?: string;
}

/**
 * What Recall knows about the user, as text for `system` or `instructions` (for example in a
 * `ToolLoopAgent`'s `prepareCall`). Resolves to `""` when nothing is known yet. It is a context
 * read, not a question to Recall, so it is fast.
 */
export function recallContext(options: RecallContextOptions): Promise<string> {
  return memoryText(handles(options), options.query, options);
}

/**
 * Stores one exchange in the session: the user's message, then the reply. Use it from `onEnd`
 * when you do not store turns with `recallMiddleware`.
 */
export function saveTurn(
  options: RecallMemoryOptions & { sessionId: string },
  turn: Turn,
): Promise<void> {
  return storeTurn(handles(options), turn);
}
