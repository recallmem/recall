import type { AppContext } from "../context.js";
import type { JobRow } from "../core/jobs.js";

/** A claimed job as the worker hands it to a handler. */
export interface ClaimedJob extends JobRow {
  createdAt: Date;
  runAfter: Date;
}

/**
 * What a handler may return. `rescheduleAt` puts the job back to pending
 * without counting an attempt (e.g. a batch that is not ready yet); `payload`
 * is merged into the stored payload either way.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: handlers that have nothing to report just return
export type JobOutcome = void | { rescheduleAt?: Date; payload?: Record<string, unknown> };

export type JobHandler = (ctx: AppContext, job: ClaimedJob) => Promise<JobOutcome>;

/** An error that retrying cannot fix: the job goes straight to `failed`. */
export class TerminalJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalJobError";
  }
}

/** Puts a job back until the account can spend again (a top-up or the next month resumes it). */
export const budgetPause = (ctx: Pick<AppContext, "config">): JobOutcome => ({
  rescheduleAt: new Date(Date.now() + ctx.config.tenancy.budgetRetryMs),
  payload: { budget_paused_at: new Date().toISOString() },
});
