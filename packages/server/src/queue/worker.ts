import { hostname } from "node:os";
import { type SQL, sql } from "drizzle-orm";
import { handleConsolidate } from "../consolidate/index.js";
import type { AppContext } from "../context.js";
import {
  handleDeleteSession,
  handleDeleteWorkspace,
  handleScopeBackfill,
  handleScopeRemoval,
} from "../core/jobs.js";
import { rows } from "../db/client.js";
import { pruneIdempotencyRecords } from "../http/idempotency.js";
import { newId } from "../lib/ids.js";
import { metrics } from "../lib/metrics.js";
import { LlmError } from "../llm/types.js";
import { handleEmbed } from "../reasoner/embed.js";
import { handleReason } from "../reasoner/index.js";
import { handleSummarize } from "../summaries/index.js";
import { handleWebhook } from "../webhooks/index.js";
import { queueSignals, signalFinished } from "./events.js";
import {
  budgetPause,
  type ClaimedJob,
  type JobHandler,
  type JobOutcome,
  TerminalJobError,
} from "./types.js";

/**
 * Postgres job queue worker.
 *
 * - Claims with `FOR UPDATE SKIP LOCKED`, one job per statement, at most
 *   `concurrency` at a time. A partial unique index on `work_key WHERE
 *   status='running'` makes "one running job per key" a database invariant; a
 *   claim that loses that race gets a unique violation and simply moves on.
 * - Every claim carries a lease (`locked_until`) that is extended while the
 *   handler runs. Expired leases are reclaimed by any worker.
 * - Failures retry with exponential backoff up to `maxAttempts`, then the job
 *   is marked `failed` with its error kept. Nothing is dropped silently.
 * - Wakes on in-process enqueue signals as well as on a poll interval.
 */

const HANDLERS: Record<string, JobHandler> = {
  reason: handleReason,
  summarize: handleSummarize,
  dream: handleConsolidate,
  webhook: handleWebhook,
  embed: handleEmbed,
  delete_session: handleDeleteSession,
  delete_workspace: handleDeleteWorkspace,
  scope_backfill: handleScopeBackfill,
  scope_removal: handleScopeRemoval,
};

/**
 * Kinds that spend model tokens. While the owning account is over its monthly
 * budget they are put back with a later run_after (attempts unchanged), never
 * dropped; they resume once the budget is raised or the month rolls over.
 */
const BUDGETED = new Set(["reason", "summarize", "dream", "embed"]);

/** Kinds whose pending jobs coalesce per key (mirrors jobs_pending_coalesce_idx). */
const COALESCING = ["reason", "summarize", "dream"];

/** A reason job's session has unreasoned messages written by peer `peer` (an SQL expression). */
const hasUnreasonedBy = (job: string, peer: SQL) =>
  sql`EXISTS (SELECT 1 FROM messages um WHERE um.session_id = ${sql.raw(job)}.session_id
                AND um.reasoned_at IS NULL AND um.peer_id = ${peer})`;
/** Message time of a reason job's oldest unreasoned message. */
const oldestUnreasoned = (job: string) =>
  sql`(SELECT min(om.created_at) FROM messages om
       WHERE om.session_id = ${sql.raw(job)}.session_id AND om.reasoned_at IS NULL)`;

/**
 * Learning about one peer runs in message-time order and never twice at once, also when a
 * backfill posts many backdated sessions together. A reason job (one session's new messages)
 * waits while another session's reason job about a peer it shares is running, or is still to
 * run with older messages (oldest unreasoned message first, then queue order), and while a
 * dream about one of its peers runs. A dream waits while reasoning about its peer is running or
 * due. Peers are the authors of the unreasoned messages: the observed side of every collection
 * a reason job writes.
 */
const PEER_ORDER = sql`(
  j.kind NOT IN ('reason', 'dream')
  OR (j.kind = 'reason' AND NOT EXISTS (
    SELECT 1 FROM jobs k
    WHERE k.workspace_id = j.workspace_id AND k.id <> j.id AND k.status IN ('pending', 'running')
      AND (
        (k.kind = 'reason' AND k.session_id <> j.session_id
          AND (k.status = 'running'
               OR (${oldestUnreasoned("k")}, k.id) < (${oldestUnreasoned("j")}, j.id))
          AND EXISTS (SELECT 1 FROM messages km
                      WHERE km.session_id = k.session_id AND km.reasoned_at IS NULL
                        AND ${hasUnreasonedBy("j", sql`km.peer_id`)}))
        OR (k.kind = 'dream' AND k.status = 'running'
          AND ${hasUnreasonedBy("j", sql`k.payload->>'observed_id'`)}))))
  OR (j.kind = 'dream' AND NOT EXISTS (
    SELECT 1 FROM jobs k
    WHERE k.workspace_id = j.workspace_id AND k.kind = 'reason'
      AND (k.status = 'running' OR (k.status = 'pending' AND k.run_after <= now()))
      AND ${hasUnreasonedBy("k", sql`j.payload->>'observed_id'`)})))`;
const MAX_BACKOFF_MS = 10 * 60_000;
const RECOVERY_INTERVAL_MS = 15_000;
const CLEANUP_INTERVAL_MS = 10 * 60_000;
const ERROR_MAX_CHARS = 65_535;

interface JobDbRow {
  id: number | string;
  kind: string;
  work_key: string;
  workspace_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date | string;
  run_after: Date | string;
}

function toJob(r: JobDbRow): ClaimedJob {
  return {
    id: Number(r.id),
    kind: r.kind,
    workKey: r.work_key,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    payload: r.payload ?? {},
    attempts: r.attempts,
    createdAt: new Date(r.created_at),
    runAfter: new Date(r.run_after),
  };
}

export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function errorText(err: unknown): string {
  const e = err as Error;
  const text = e?.name && e?.message ? `${e.name}: ${e.message}` : String(err);
  return text.slice(0, ERROR_MAX_CHARS);
}

function isTerminal(err: unknown): boolean {
  if (err instanceof TerminalJobError) return true;
  if (err instanceof LlmError && err.kind === "config") return true;
  return false;
}

export interface WorkerOptions {
  concurrency: number;
  pollMs: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
}

export class Worker {
  readonly id = `${hostname()}:${process.pid}:${newId().slice(0, 8)}`;
  private readonly running = new Map<number, Promise<void>>();
  private readonly opts: WorkerOptions;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private polling = false;
  private pollAgain = false;
  private lastSignalAt = 0;
  private lastRecoveryAt = 0;
  private lastCleanupAt = 0;

  constructor(
    private readonly ctx: AppContext,
    opts: Partial<WorkerOptions> = {},
  ) {
    const w = ctx.config.worker;
    this.opts = {
      concurrency: Math.max(1, opts.concurrency ?? w.concurrency),
      pollMs: opts.pollMs ?? w.pollMs,
      leaseMs: opts.leaseMs ?? w.leaseMs,
      maxAttempts: Math.max(1, opts.maxAttempts ?? w.maxAttempts),
      retryBaseMs: opts.retryBaseMs ?? w.retryBaseMs,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    queueSignals.on("enqueued", this.onSignal);
    this.wake(0);
  }

  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    queueSignals.off("enqueued", this.onSignal);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const all = Promise.allSettled([...this.running.values()]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  private readonly onSignal = () => {
    this.lastSignalAt = Date.now();
    this.wake(2);
  };

  private wake(delayMs: number): void {
    if (this.stopped) return;
    const at = Date.now() + Math.max(0, delayMs);
    if (this.timer && at >= this.timerAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAt = Number.POSITIVE_INFINITY;
        void this.poll();
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    let next = this.opts.pollMs;
    try {
      await this.recoverIfDue();
      const claimed = await this.fill();
      if (!claimed && this.running.size < this.opts.concurrency) {
        // An enqueue signal can arrive before its transaction commits: look again shortly.
        // Due jobs that could not be claimed wait for a running job (theirs, or one about the
        // same peer): its completion wakes this worker, other processes' within a poll interval.
        if (Date.now() - this.lastSignalAt < 500) next = 25;
        else next = Math.min(next, await this.msUntilNextDue(false));
      }
    } catch (err) {
      this.ctx.log.error({ err }, "worker poll failed");
    } finally {
      this.polling = false;
    }
    if (this.pollAgain) {
      this.pollAgain = false;
      next = 0;
    }
    this.wake(next);
  }

  /** Claims jobs until the slots are full or nothing is ready; returns how many were claimed. */
  private async fill(): Promise<number> {
    let claimed = 0;
    while (this.running.size < this.opts.concurrency) {
      const job = await this.claim();
      if (!job) break;
      claimed++;
      this.launch(job);
    }
    return claimed;
  }

  private launch(job: ClaimedJob): void {
    const done = this.execute(job).finally(() => {
      this.running.delete(job.id);
      signalFinished(job);
      this.wake(0);
    });
    this.running.set(job.id, done);
  }

  /** Time until the next pending job falls due; with `includeDue` false, jobs already due are ignored. */
  private async msUntilNextDue(includeDue = true): Promise<number> {
    const [r] = await rows<{ ms: number | string | null }>(
      this.ctx.db,
      sql`SELECT EXTRACT(EPOCH FROM (min(run_after) - now())) * 1000 AS ms FROM jobs
          WHERE status = 'pending' ${includeDue ? sql`` : sql`AND run_after > now()`}`,
    );
    const ms = r?.ms == null ? Number.POSITIVE_INFINITY : Number(r.ms);
    return Math.max(5, Math.ceil(ms) + 5);
  }

  /**
   * Claims one ready job whose work key is not running anywhere and that no other unit about
   * the same peer has to precede (PEER_ORDER). Claims are serialised by a transaction-level
   * advisory lock, so two workers can never both pass the peer check for conflicting jobs; a
   * claim is one short statement, so this costs no throughput.
   */
  async claim(): Promise<ClaimedJob | null> {
    try {
      const [r] = await this.ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('recall:queue-claim'))`);
        return rows<JobDbRow>(
          tx,
          sql`UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ${this.id},
                locked_until = now() + make_interval(secs => ${this.opts.leaseMs / 1000})
              WHERE id = (
                SELECT j.id FROM jobs j
                WHERE j.status = 'pending' AND j.run_after <= now()
                  AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.work_key = j.work_key AND r.status = 'running')
                  AND ${PEER_ORDER}
                ORDER BY j.run_after, j.id
                LIMIT 1
                FOR UPDATE OF j SKIP LOCKED)
              RETURNING id, kind, work_key, workspace_id, session_id, payload, attempts, created_at, run_after`,
        );
      });
      return r ? toJob(r) : null;
    } catch (err) {
      // Another worker claimed a job with the same key between our check and our update.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const heartbeat = setInterval(
      () => void this.extendLease(job.id).catch(() => {}),
      Math.max(1000, this.opts.leaseMs / 3),
    );
    heartbeat.unref?.();
    let outcome: JobOutcome;
    try {
      const handler = HANDLERS[job.kind];
      if (!handler) throw new TerminalJobError(`unknown job kind "${job.kind}"`);
      const budget = this.ctx.tenancy.budget;
      if (
        BUDGETED.has(job.kind) &&
        (await budget.exceededForWorkspace(job.workspaceId)) &&
        // Confirmed before pausing: a top-up in another process may be newer than the cache.
        (await budget.exceededForWorkspace(job.workspaceId, true))
      ) {
        outcome = budgetPause(this.ctx);
      } else {
        outcome = await handler(this.ctx, job);
      }
    } catch (err) {
      clearInterval(heartbeat);
      await this.fail(job, err).catch((e) =>
        this.ctx.log.error({ err: e, job: job.id }, "could not record job failure"),
      );
      return;
    }
    clearInterval(heartbeat);
    try {
      if (outcome?.rescheduleAt) {
        await this.requeue(job, {
          runAfter: outcome.rescheduleAt,
          attemptsDelta: -1,
          payload: outcome.payload,
        });
      } else {
        await this.complete(job, outcome?.payload);
      }
    } catch (err) {
      this.ctx.log.error({ err, job: job.id }, "could not record job completion");
    }
  }

  private async extendLease(id: number): Promise<void> {
    await this.ctx.db.execute(
      sql`UPDATE jobs SET locked_until = now() + make_interval(secs => ${this.opts.leaseMs / 1000})
          WHERE id = ${id} AND status = 'running' AND locked_by = ${this.id}`,
    );
  }

  private async complete(job: ClaimedJob, payload?: Record<string, unknown>): Promise<void> {
    const done = await rows<{ id: number }>(
      this.ctx.db,
      sql`UPDATE jobs SET status = 'done', finished_at = now(), locked_by = NULL, locked_until = NULL,
            payload = payload || ${JSON.stringify(payload ?? {})}::jsonb
          WHERE id = ${job.id} AND status = 'running' AND locked_by = ${this.id} RETURNING id`,
    );
    if (!done.length)
      this.ctx.log.warn({ job: job.id, kind: job.kind }, "job lease was lost before completion");
  }

  private async fail(job: ClaimedJob, err: unknown): Promise<void> {
    const message = errorText(err);
    const final = isTerminal(err) || job.attempts >= this.opts.maxAttempts;
    metrics.jobFailures.inc({ kind: job.kind, final: String(final) });
    if (final) {
      this.ctx.log.error(
        { err, job: job.id, kind: job.kind, attempts: job.attempts },
        "job failed",
      );
      await this.ctx.db.execute(
        sql`UPDATE jobs SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
              last_error = ${message}
            WHERE id = ${job.id} AND status = 'running' AND locked_by = ${this.id}`,
      );
      return;
    }
    const base = this.opts.retryBaseMs * 2 ** Math.max(0, job.attempts - 1);
    const delay = Math.min(MAX_BACKOFF_MS, base) * (0.75 + Math.random() * 0.5);
    this.ctx.log.warn(
      { err, job: job.id, kind: job.kind, attempts: job.attempts, delay },
      "job failed; will retry",
    );
    await this.requeue(job, {
      runAfter: new Date(Date.now() + delay),
      attemptsDelta: 0,
      error: message,
    });
  }

  /**
   * Puts a running job back to pending. If a newer pending job with the same
   * key exists (it coalesces new work), this one is folded into it instead:
   * it keeps the earlier creation time, the attempt count and the error.
   */
  private async requeue(
    job: ClaimedJob,
    opts: {
      runAfter: Date;
      attemptsDelta: number;
      error?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    const patch = JSON.stringify(opts.payload ?? {});
    const isRetry = opts.error !== undefined;
    try {
      await this.ctx.db.execute(
        sql`UPDATE jobs SET status = 'pending', run_after = ${opts.runAfter}, locked_by = NULL, locked_until = NULL,
              attempts = GREATEST(0, attempts + ${opts.attemptsDelta}),
              last_error = COALESCE(${opts.error ?? null}, last_error),
              payload = payload || ${patch}::jsonb
            WHERE id = ${job.id} AND status = 'running' AND locked_by = ${this.id}`,
      );
    } catch (err) {
      if (!isUniqueViolation(err) || !COALESCING.includes(job.kind)) throw err;
      const attempts = Math.max(0, job.attempts + opts.attemptsDelta);
      await this.ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE jobs SET
                run_after = ${isRetry ? sql`GREATEST(run_after, ${opts.runAfter})` : sql`LEAST(run_after, ${opts.runAfter})`},
                created_at = LEAST(created_at, ${job.createdAt}),
                attempts = GREATEST(attempts, ${attempts}),
                last_error = COALESCE(${opts.error ?? null}, last_error),
                payload = ${JSON.stringify({ ...job.payload, ...(opts.payload ?? {}) })}::jsonb || payload
              WHERE work_key = ${job.workKey} AND status = 'pending'`,
        );
        await tx.execute(sql`DELETE FROM jobs WHERE id = ${job.id} AND locked_by = ${this.id}`);
      });
    }
  }

  private async recoverIfDue(): Promise<void> {
    if (Date.now() - this.lastRecoveryAt < RECOVERY_INTERVAL_MS) return;
    this.lastRecoveryAt = Date.now();
    await recoverStaleJobs(this.ctx, this.opts.maxAttempts);
    if (Date.now() - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      this.lastCleanupAt = Date.now();
      await cleanupJobs(this.ctx);
    }
  }

  /** Runs jobs until none is ready (tests, evals, CLI). Delayed jobs are left pending. */
  async runUntilIdle(opts: { timeoutMs?: number } = {}): Promise<number> {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    let processed = 0;
    await recoverStaleJobs(this.ctx, this.opts.maxAttempts);
    for (;;) {
      while (this.running.size < this.opts.concurrency) {
        const job = await this.claim();
        if (!job) break;
        processed++;
        const done = this.execute(job).finally(() => {
          this.running.delete(job.id);
          signalFinished(job);
        });
        this.running.set(job.id, done);
      }
      if (this.running.size === 0) return processed;
      if (Date.now() > deadline) throw new Error("runUntilIdle timed out");
      await Promise.race(this.running.values());
    }
  }

  /**
   * Serverless mode: runs ready jobs, and waits for delayed ones that fall due
   * within `maxWaitMs`, until the queue is idle or `budgetMs` is spent. At the
   * deadline it stops claiming and lets running jobs finish (their leases are
   * still extended), so nothing is left half-done.
   */
  async runFor(budgetMs: number, maxWaitMs: number): Promise<number> {
    const deadline = Date.now() + budgetMs;
    let processed = 0;
    await this.recoverIfDue();
    for (;;) {
      while (Date.now() < deadline && this.running.size < this.opts.concurrency) {
        const job = await this.claim();
        if (!job) break;
        processed++;
        const done = this.execute(job).finally(() => {
          this.running.delete(job.id);
          signalFinished(job);
        });
        this.running.set(job.id, done);
      }
      if (this.running.size > 0) {
        await Promise.race(this.running.values());
        continue;
      }
      // Ready jobs whose key runs elsewhere are skipped by claim(): poll them gently.
      const wait = Math.max(250, await this.msUntilNextDue());
      if (wait > maxWaitMs || Date.now() + wait >= deadline) return processed;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Returns jobs whose lease expired (crashed or stuck worker) to the queue.
 * Exhausted ones fail; ones that a newer pending job already covers fold into it.
 */
export async function recoverStaleJobs(ctx: AppContext, maxAttempts: number): Promise<number> {
  const failed = await rows<{ id: number }>(
    ctx.db,
    sql`UPDATE jobs SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
          last_error = COALESCE(last_error || E'\n', '') || 'lease expired on attempt ' || attempts
        WHERE status = 'running' AND locked_until < now() AND attempts >= ${maxAttempts}
        RETURNING id`,
  );
  const merged = await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE jobs p SET attempts = GREATEST(p.attempts, s.attempts), created_at = LEAST(p.created_at, s.created_at)
          FROM jobs s
          WHERE s.status = 'running' AND s.locked_until < now() AND p.status = 'pending' AND p.work_key = s.work_key
            AND s.kind IN ('reason', 'summarize', 'dream')`,
    );
    return rows<{ id: number }>(
      tx,
      sql`DELETE FROM jobs s USING jobs p
          WHERE s.status = 'running' AND s.locked_until < now() AND p.status = 'pending' AND p.work_key = s.work_key
            AND s.kind IN ('reason', 'summarize', 'dream')
          RETURNING s.id`,
    );
  });
  const requeued = await rows<{ id: number }>(
    ctx.db,
    sql`UPDATE jobs SET status = 'pending', locked_by = NULL, locked_until = NULL, run_after = now(),
          last_error = COALESCE(last_error || E'\n', '') || 'lease expired on attempt ' || attempts
        WHERE status = 'running' AND locked_until < now()
        RETURNING id`,
  );
  const n = failed.length + merged.length + requeued.length;
  if (n)
    ctx.log.warn(
      { failed: failed.length, merged: merged.length, requeued: requeued.length },
      "recovered stale jobs",
    );
  return n;
}

/**
 * Completed jobs stay visible to queue status for a day; failed ones are kept
 * for 30 days so errors can be inspected. Stored Idempotency-Key responses
 * expire after a day as well (deleted in bounded batches).
 */
export async function cleanupJobs(ctx: AppContext): Promise<void> {
  await ctx.db.execute(
    sql`DELETE FROM jobs WHERE (status = 'done' AND finished_at < now() - interval '1 day')
          OR (status = 'failed' AND finished_at < now() - interval '30 days')`,
  );
  await pruneIdempotencyRecords(ctx.db);
}

/** Starts the background worker loop; returns a function that stops it gracefully. */
export async function startWorker(ctx: AppContext): Promise<() => Promise<void>> {
  const worker = new Worker(ctx);
  worker.start();
  ctx.log.info({ worker: worker.id }, "worker started");
  return () => worker.stop();
}

/** Processes every ready job until the queue is idle (tests and evals). */
export async function drainQueue(
  ctx: AppContext,
  opts: Partial<WorkerOptions> & { timeoutMs?: number } = {},
) {
  const worker = new Worker(ctx, opts);
  const processed = await worker.runUntilIdle({ timeoutMs: opts.timeoutMs });
  await ctx.usage.flush();
  return processed;
}
