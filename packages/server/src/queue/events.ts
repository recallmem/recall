import { EventEmitter } from "node:events";

/**
 * In-process queue signals. `enqueued` wakes the worker immediately instead of
 * waiting for the next poll; `finished` wakes long-polling status requests.
 * Polling remains the source of truth (other processes enqueue too).
 */
export const queueSignals = new EventEmitter();
queueSignals.setMaxListeners(0);

export function signalEnqueued(): void {
  queueSignals.emit("enqueued");
}

export function signalFinished(job: {
  id: number;
  kind: string;
  workspaceId: string | null;
}): void {
  queueSignals.emit("finished", job);
}
