import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { signalEnqueued } from "./events.js";

export type JobKind =
  | "reason"
  | "summarize"
  | "dream"
  | "webhook"
  | "delete_session"
  | "delete_workspace"
  | "scope_backfill"
  | "scope_removal"
  | "embed";

export interface NewJob {
  kind: JobKind;
  /** Jobs with the same key never run concurrently; reason/summarize/dream coalesce while pending. */
  workKey: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
  runAfter?: Date;
}

/**
 * Enqueues background work. Call it with the same transaction that wrote the
 * data the job depends on, so a crash can never commit data without its job
 * (the transactional-outbox property Honcho lacks).
 * Returns false when a pending job with the same key already covers it; that job
 * then runs no later than this one would have, and takes this one's payload keys.
 */
export async function enqueue(tx: Pick<Db, "execute">, job: NewJob): Promise<boolean> {
  const runAfter = job.runAfter ?? new Date();
  const res = (await tx.execute(sql`
    INSERT INTO jobs (kind, work_key, workspace_id, session_id, payload, run_after)
    VALUES (${job.kind}, ${job.workKey}, ${job.workspaceId ?? null}, ${job.sessionId ?? null},
            ${JSON.stringify(job.payload ?? {})}::jsonb, ${runAfter})
    ON CONFLICT (work_key) WHERE status = 'pending' AND kind IN ('reason', 'summarize', 'dream')
    DO UPDATE SET run_after = LEAST(jobs.run_after, EXCLUDED.run_after),
                  payload = jobs.payload || EXCLUDED.payload
    RETURNING (xmax = 0) AS inserted`)) as unknown as { rows: { inserted: boolean }[] };
  // Usually still inside the caller's transaction; the worker re-polls briefly after a signal.
  signalEnqueued();
  return res.rows[0]?.inserted ?? false;
}
