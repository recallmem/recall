import type { Db } from "../db/client.js";
import { enqueue } from "../queue/enqueue.js";

/**
 * Called by message creation, inside the same transaction that inserted the
 * messages. Schedules the session's "process new messages" job (embedding +
 * reasoning) to run now; the job embeds at once and then waits for its batch
 * (see handleReason). `last_message_at` records the arrival (server time, never
 * the message's own possibly backdated time), so the job can tell when the
 * session has gone quiet. Owned by the reasoner; the batching policy lives there.
 */
export async function scheduleMessageProcessing(
  tx: Pick<Db, "execute">,
  args: { workspaceId: string; sessionId: string; newTokens: number },
): Promise<void> {
  await enqueue(tx, {
    kind: "reason",
    workKey: `reason:${args.sessionId}`,
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    payload: { last_message_at: new Date().toISOString() },
  });
}

/**
 * Called by message creation for each new message whose per-session sequence
 * number may trigger a summary (see spec 01 §4.4). Owned by the summaries module.
 */
export async function scheduleSummaries(
  tx: Pick<Db, "execute">,
  args: {
    workspaceId: string;
    sessionId: string;
    seqInSession: number;
    shortEvery: number;
    longEvery: number;
  },
): Promise<void> {
  if (args.seqInSession % args.shortEvery === 0 || args.seqInSession % args.longEvery === 0) {
    await enqueue(tx, {
      kind: "summarize",
      workKey: `summarize:${args.sessionId}`,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
    });
  }
}
