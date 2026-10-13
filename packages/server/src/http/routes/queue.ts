import { sql } from "drizzle-orm";
import { z } from "zod";
import { billedFrom, getBillingRow, usageCharges } from "../../billing/ledger.js";
import { scheduleManualDream } from "../../consolidate/index.js";
import type { AppContext } from "../../context.js";
import type { WsKey } from "../../core/tenancy.js";
import { findWorkspace } from "../../core/workspaces.js";
import { rows } from "../../db/client.js";
import { badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { iso } from "../../lib/time.js";
import { queueSignals, signalEnqueued } from "../../queue/events.js";
import type { App } from "../app.js";
import { guard, requireOperator, wsOf } from "../auth.js";
import { customerUsage, modelNamer } from "../redact.js";
import { parseBody, parseQuery } from "../validate.js";

/**
 * Background-work routes (component B):
 * - GET  /v3/workspaces/{id}/queue/status  (+ extension `wait_ms`: flush and long-poll until idle; adds `idle`)
 * - POST /v3/workspaces/{id}/schedule_dream
 * - GET  /deriver/metrics
 * - GET  /v3/workspaces/{id}/usage          (extension: model calls and tokens by task and model;
 *                                            provider cost on a self-hosted server, `billed` on a
 *                                            billed account of the hosted service)
 *
 * Queue status counts work units, not messages: a session's pending messages
 * are one `reason` unit, its summaries one `summarize` unit, and each
 * collection's dream one `dream` unit. Sessions are keyed by name.
 */

const MAX_WAIT_MS = 60_000;
const emptyToUndef = (v: unknown) => (v === "" ? undefined : v);

const StatusQuery = z.object({
  observer_id: z.preprocess(emptyToUndef, z.string().optional()),
  sender_id: z.preprocess(emptyToUndef, z.string().optional()),
  session_id: z.preprocess(emptyToUndef, z.string().optional()),
  wait_ms: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).optional()),
});

const ScheduleDreamBody = z.object({
  observer: z.string().min(1),
  observed: z.string().min(1).nullish(),
  dream_type: z.enum(["omni", "card_refresh"]),
  session_id: z.string().nullish(),
  rebuild: z.boolean().optional().default(false),
});

const UsageQuery = z.object({
  since: z.preprocess(emptyToUndef, z.coerce.date().optional()),
  until: z.preprocess(emptyToUndef, z.coerce.date().optional()),
});

interface Counts {
  total_work_units: number;
  completed_work_units: number;
  in_progress_work_units: number;
  pending_work_units: number;
}

const zero = (): Counts => ({
  total_work_units: 0,
  completed_work_units: 0,
  in_progress_work_units: 0,
  pending_work_units: 0,
});

function add(c: Counts, status: string, n: number) {
  c.total_work_units += n;
  if (status === "running") c.in_progress_work_units += n;
  else if (status === "pending") c.pending_work_units += n;
  else c.completed_work_units += n;
}

async function workspaceId(ctx: AppContext, key: WsKey): Promise<string> {
  const w = await findWorkspace(ctx.db, key);
  if (!w) throw notFound("Workspace");
  return w.internal_id;
}

async function peerId(
  ctx: AppContext,
  ws: string,
  name: string | undefined,
): Promise<string | null> {
  if (!name) return null;
  const [p] = await rows<{ id: string }>(
    ctx.db,
    sql`SELECT id FROM peers WHERE workspace_id = ${ws} AND name = ${name}`,
  );
  return p?.id ?? "~unknown~"; // matches nothing: unknown peers count zero
}

export async function queueStatus(
  ctx: AppContext,
  ws: string,
  f: { sessionId: string | null; observerId: string | null; senderId: string | null },
): Promise<Counts & { sessions: Record<string, Counts & { session_id: string | null }> | null }> {
  const peerFilter =
    f.observerId || f.senderId
      ? sql`AND (
          (j.kind = 'reason' AND j.status IN ('pending', 'running') AND EXISTS (
            SELECT 1 FROM messages m WHERE m.session_id = j.session_id AND m.reasoned_at IS NULL
              AND (m.peer_id = ${f.senderId} OR m.internal->'observers' @> jsonb_build_array(${f.observerId}::text))))
          OR (j.kind = 'reason' AND j.status IN ('done', 'failed')
              AND (j.payload->'observed' @> jsonb_build_array(${f.senderId}::text)
                   OR j.payload->'observers' @> jsonb_build_array(${f.observerId}::text)))
          OR (j.kind = 'dream' AND (j.payload->>'observed_id' = ${f.senderId} OR j.payload->>'observer_id' = ${f.observerId})))`
      : sql``;
  const found = await rows<{ status: string; session_name: string | null; n: number }>(
    ctx.db,
    sql`SELECT j.status, s.name AS session_name, count(*)::int AS n
        FROM jobs j LEFT JOIN sessions s ON s.id = j.session_id
        WHERE j.workspace_id = ${ws} AND j.kind IN ('reason', 'summarize', 'dream')
          ${f.sessionId ? sql`AND j.session_id = ${f.sessionId}` : sql``}
          ${peerFilter}
        GROUP BY j.status, s.name`,
  );
  const total = zero();
  const sessions: Record<string, Counts & { session_id: string | null }> = {};
  for (const r of found) {
    add(total, r.status, r.n);
    if (!f.sessionId && r.session_name) {
      sessions[r.session_name] ??= { session_id: r.session_name, ...zero() };
      add(sessions[r.session_name]!, r.status, r.n);
    }
  }
  return { ...total, sessions: f.sessionId || !Object.keys(sessions).length ? null : sessions };
}

/** A failed unit that no later attempt at the same work (done, queued or running) has covered. */
export const unresolvedFailure = sql`j.status = 'failed'
  AND NOT EXISTS (SELECT 1 FROM jobs k WHERE k.workspace_id = j.workspace_id AND k.work_key = j.work_key
                    AND k.id > j.id AND k.status IN ('done', 'pending', 'running'))`;

/** Manual retries one failed unit gets through POST /queue/retry, so a poisoned unit cannot loop forever. */
export const MAX_MANUAL_RETRIES = 3;

/** Background units that failed for good and still leave a hole in the memory. */
async function failedUnits(ctx: AppContext, ws: string, sessionId: string | null): Promise<number> {
  const [r] = await rows<{ n: number }>(
    ctx.db,
    sql`SELECT count(*)::int AS n FROM jobs j
        WHERE j.workspace_id = ${ws} AND j.kind IN ('reason', 'summarize', 'dream')
          ${sessionId ? sql`AND j.session_id = ${sessionId}` : sql``}
          AND ${unresolvedFailure}`,
  );
  return r?.n ?? 0;
}

/**
 * Puts the workspace's failed units back in the queue (the latest attempt per piece of work), e.g.
 * after a provider outage. Returns how many were queued again.
 */
export async function retryFailed(ctx: AppContext, ws: string): Promise<number> {
  const requeued = await rows<{ id: number }>(
    ctx.db,
    sql`UPDATE jobs SET status = 'pending', attempts = 0, run_after = now(), finished_at = NULL,
          locked_by = NULL, locked_until = NULL,
          payload = jsonb_set(payload, '{manual_retries}',
            to_jsonb(COALESCE((payload->>'manual_retries')::int, 0) + 1)),
          last_error = COALESCE(last_error || E'\n', '') || 'queued again on request'
        WHERE id IN (
          SELECT DISTINCT ON (j.work_key) j.id FROM jobs j
          WHERE j.workspace_id = ${ws} AND j.kind IN ('reason', 'summarize', 'dream')
            AND ${unresolvedFailure}
            AND COALESCE((j.payload->>'manual_retries')::int, 0) < ${MAX_MANUAL_RETRIES}
            AND NOT EXISTS (SELECT 1 FROM jobs p WHERE p.work_key = j.work_key AND p.status = 'pending')
          ORDER BY j.work_key, j.id DESC)
        RETURNING id`,
  );
  if (requeued.length) signalEnqueued();
  return requeued.length;
}

/** Pulls the scope's waiting reason/summary units forward and marks them to skip batching. */
async function flush(ctx: AppContext, ws: string, sessionId: string | null): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE jobs SET run_after = LEAST(run_after, now()), payload = payload || '{"flush": true}'::jsonb
        WHERE workspace_id = ${ws} AND status = 'pending' AND kind IN ('reason', 'summarize')
          ${sessionId ? sql`AND session_id = ${sessionId}` : sql``}`,
  );
  signalEnqueued();
}

/** Idle = no reason/summary unit pending or running, and no dream running or due. */
async function idle(ctx: AppContext, ws: string, sessionId: string | null): Promise<boolean> {
  const [r] = await rows<{ busy: boolean }>(
    ctx.db,
    sql`SELECT EXISTS (
          SELECT 1 FROM jobs WHERE workspace_id = ${ws} AND (
            (kind IN ('reason', 'summarize') AND status IN ('pending', 'running')
              ${sessionId ? sql`AND session_id = ${sessionId}` : sql``})
            OR (kind = 'dream' AND (status = 'running' OR (status = 'pending' AND run_after <= now()))))
        ) AS busy`,
  );
  return !r?.busy;
}

function nextSignal(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      queueSignals.off("finished", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    queueSignals.on("finished", done);
  });
}

export function register(app: App, ctx: AppContext): void {
  app.get("/v3/workspaces/:workspace_id/queue/status", guard(ctx), async (c) => {
    const q = parseQuery(c, StatusQuery);
    const ws = await workspaceId(ctx, wsOf(c));
    let sessionId: string | null = null;
    if (q.session_id) {
      const [s] = await rows<{ id: string }>(
        ctx.db,
        sql`SELECT id FROM sessions WHERE workspace_id = ${ws} AND name = ${q.session_id}`,
      );
      if (!s)
        return c.json({
          ...zero(),
          sessions: null,
          ...(q.wait_ms ? { idle: true, failed_work_units: 0 } : {}),
        });
      sessionId = s.id;
    }
    // Extension: with wait_ms the response also says whether the wait ended because the scope is
    // idle (true) or because the deadline passed (false). The counts alone cannot say: a dream
    // scheduled for later is pending but does not keep the workspace busy.
    let settled: boolean | undefined;
    if (q.wait_ms) {
      await flush(ctx, ws, sessionId);
      const deadline = Date.now() + Math.min(q.wait_ms, MAX_WAIT_MS);
      while (!(await idle(ctx, ws, sessionId)) && Date.now() < deadline) {
        await nextSignal(Math.min(250, Math.max(1, deadline - Date.now())));
      }
      settled = await idle(ctx, ws, sessionId);
    }
    const [observerId, senderId] = await Promise.all([
      peerId(ctx, ws, q.observer_id),
      peerId(ctx, ws, q.sender_id),
    ]);
    const status = await queueStatus(ctx, ws, { sessionId, observerId, senderId });
    if (settled === undefined) return c.json(status);
    // Extension, also with wait_ms only (plain requests keep Honcho's exact shape): units that
    // failed for good, so a client can tell "idle" from "idle with holes in the memory".
    return c.json({
      ...status,
      idle: settled,
      failed_work_units: await failedUnits(ctx, ws, sessionId),
    });
  });

  // Extension: queue the workspace's failed background work again (e.g. after a provider outage).
  app.post("/v3/workspaces/:workspace_id/queue/retry", guard(ctx), async (c) => {
    const ws = await workspaceId(ctx, wsOf(c));
    return c.json({ retried: await retryFailed(ctx, ws) });
  });

  app.post("/v3/workspaces/:workspace_id/schedule_dream", guard(ctx), async (c) => {
    const body = await parseBody(c, ScheduleDreamBody);
    if (!ctx.config.features.dreams)
      throw badRequest("Dreams are not enabled in the system configuration");
    const ws = await workspaceId(ctx, wsOf(c));
    const observed = body.observed ?? body.observer;
    const [scope] = await rows<{ is_scope: boolean }>(
      ctx.db,
      sql`SELECT is_scope FROM peers WHERE workspace_id = ${ws} AND name = ${observed}`,
    );
    if (scope?.is_scope) throw unprocessable("A scope cannot be the observed peer of a dream");
    await scheduleManualDream(ctx, {
      workspaceId: ws,
      observer: body.observer,
      observed,
      type: body.dream_type,
      sessionName: body.session_id ?? null,
      rebuild: body.dream_type === "card_refresh" && body.rebuild,
    });
    return c.body(null, 204);
  });

  app.get("/deriver/metrics", async (c) => {
    // Aggregate across every tenant: operator-only in hosted mode.
    if (ctx.config.tenancy.hosted) await requireOperator(ctx, c);
    const [j] = await rows<Record<string, number | string | null>>(
      ctx.db,
      sql`SELECT
            count(*) FILTER (WHERE status = 'pending')::int AS pending_items,
            count(*) FILTER (WHERE status = 'running')::int AS claimed_work_units,
            count(*) FILTER (WHERE status = 'pending' AND run_after <= now() AND NOT EXISTS (
              SELECT 1 FROM jobs r WHERE r.work_key = jobs.work_key AND r.status = 'running'))::int AS eligible_work_units,
            COALESCE(EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'pending')), 0) AS oldest_pending_age_seconds,
            COALESCE(sum(EXTRACT(EPOCH FROM now() - run_after)) FILTER (WHERE status = 'pending' AND run_after <= now()), 0)
              AS outstanding_work_seconds,
            count(*) FILTER (WHERE status = 'pending' AND kind = 'dream' AND run_after <= now())::int AS dreams_due,
            count(*) FILTER (WHERE status = 'failed')::int AS failed_jobs
          FROM jobs`,
    );
    const [e] = await rows<{ pending: number; due: number }>(
      ctx.db,
      sql`SELECT count(*)::int AS pending,
                 count(*) FILTER (WHERE created_at < now() - interval '30 seconds')::int AS due
          FROM messages WHERE embedding IS NULL AND content <> ''`,
    );
    const num = (v: unknown) => Number(v ?? 0);
    return c.json({
      outstanding_work_seconds: num(j?.outstanding_work_seconds),
      eligible_work_units: num(j?.eligible_work_units),
      claimed_work_units: num(j?.claimed_work_units),
      pending_items: num(j?.pending_items),
      oldest_pending_age_seconds: num(j?.oldest_pending_age_seconds),
      embeddings_pending: num(e?.pending),
      embeddings_pending_due: num(e?.due),
      dreams_due: num(j?.dreams_due),
      failed_jobs: num(j?.failed_jobs),
      measured_at: iso(new Date()),
      measurement_age_seconds: 0,
    });
  });

  app.get("/v3/workspaces/:workspace_id/usage", guard(ctx), async (c) => {
    const q = parseQuery(c, UsageQuery);
    const name = wsOf(c);
    const ws = await workspaceId(ctx, name);
    await ctx.usage.flush();
    const items = await rows<{
      task: string;
      provider: string;
      model: string;
      calls: number;
      input_tokens: number | string;
      output_tokens: number | string;
      cache_read_tokens: number | string;
      cache_write_tokens: number | string;
      cost_usd: number | null;
      unpriced: number;
    }>(
      ctx.db,
      sql`SELECT task, provider, model, count(*)::int AS calls,
                 sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                 sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
                 COALESCE(sum(cost_usd), 0)::float8 AS cost_usd,
                 count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced
          FROM llm_usage WHERE workspace_id = ${ws}
            ${q.since ? sql`AND created_at >= ${q.since}` : sql``}
            ${q.until ? sql`AND created_at < ${q.until}` : sql``}
          GROUP BY task, provider, model ORDER BY task, provider, model`,
    );
    type Totals = {
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
      unpriced_calls: number;
    };
    const empty = (): Totals => ({
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      unpriced_calls: 0,
    });
    const total = empty();
    const byTask: Record<string, Totals> = {};
    // Hosted: models by their public names (codenames for the hosted defaults), one item per
    // task and name, so a renamed model never shows as two rows of the same codename.
    const named = await modelNamer(ctx, c.get("auth").account);
    const merged = new Map<string, { task: string; provider: string; model: string } & Totals>();
    for (const r of items) {
      const t: Totals = {
        calls: r.calls,
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cache_read_tokens: Number(r.cache_read_tokens),
        cache_write_tokens: Number(r.cache_write_tokens),
        cost_usd: Number(r.cost_usd),
        unpriced_calls: r.unpriced,
      };
      byTask[r.task] ??= empty();
      for (const acc of [total, byTask[r.task]!]) {
        for (const k of Object.keys(t) as (keyof Totals)[]) acc[k] += t[k];
      }
      const model = named ? named(r.task, `${r.provider}/${r.model}`) : r.model;
      const key = named ? `${r.task}\n${model}` : `${r.task}\n${r.provider}\n${r.model}`;
      const item = merged.get(key);
      if (!item) merged.set(key, { task: r.task, provider: r.provider, model, ...t });
      else for (const k of Object.keys(t) as (keyof Totals)[]) item[k] += t[k];
    }
    // Billed accounts (the hosted service's prepaid credit): what this workspace was charged.
    const account = c.get("auth").account;
    const billed = (await getBillingRow(ctx.db, account))
      ? billedFrom(
          await usageCharges(ctx.db, account, {
            workspaceId: ws,
            ...(q.since ? { since: q.since } : {}),
            ...(q.until ? { until: q.until } : {}),
          }),
        )
      : null;
    return c.json(
      customerUsage(
        ctx,
        {
          workspace_id: name.name,
          since: q.since ? iso(q.since) : null,
          until: q.until ? iso(q.until) : null,
          total,
          by_task: byTask,
          items: [...merged.values()],
          ...(billed ? { billed } : {}),
        },
        { modelsNamed: true },
      ),
    );
  });
}
