import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { loadConfig } from "./config.js";
import { type AppContext, createContext } from "./context.js";
import { createApp } from "./http/app.js";
import { queueSignals } from "./queue/events.js";
import { Worker } from "./queue/worker.js";

/**
 * Vercel entry point (Node.js runtime, Web handlers). There is no long-running
 * worker: one context per function instance serves requests, and queued jobs
 * run after the response through `waitUntil`. `/internal/tick`, called every
 * minute by a scheduler (a Neon Function trigger), runs whatever fell due while
 * no request was around, recovers expired leases and runs the billing sweep.
 */

/** Below the function's maxDuration (300 s), so a drain finishes its running jobs. */
const DRAIN_BUDGET_MS = 240_000;
/** Delayed jobs due within this window are waited for (reasoning batches wait up to ~15 s). */
const DRAIN_MAX_WAIT_MS = 60_000;

interface Booted {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
}

let booted: Promise<Booted> | null = null;
let draining: Promise<void> | null = null;
let enqueues = 0;

function boot(): Promise<Booted> {
  booted ??= (async () => {
    const ctx = await createContext(loadConfig(process.env));
    queueSignals.on("enqueued", () => {
      enqueues++;
    });
    return { ctx, app: createApp(ctx) };
  })().catch((err) => {
    booted = null;
    throw err;
  });
  return booted;
}

/** Runs queued jobs in this instance; one drain at a time, repeated while new work arrives. */
function drain(ctx: AppContext): Promise<void> {
  draining ??= (async () => {
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    try {
      let seen: number;
      do {
        seen = enqueues;
        await new Worker(ctx).runFor(deadline - Date.now(), DRAIN_MAX_WAIT_MS);
      } while (enqueues !== seen && Date.now() < deadline - 5_000);
    } catch (err) {
      ctx.log.error({ err }, "queue drain failed");
    } finally {
      await ctx.usage.flush().catch((err) => ctx.log.error({ err }, "usage flush failed"));
    }
  })().finally(() => {
    draining = null;
  });
  return draining;
}

function authorized(secret: string | null | undefined, req: Request): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function handle(req: Request): Promise<Response> {
  let ctx: AppContext;
  let app: Booted["app"];
  try {
    ({ ctx, app } = await boot());
  } catch (err) {
    console.error("recall: startup failed", err);
    // The operator (cron secret) sees why, since function logs are not always at hand.
    const reason = authorized(process.env.RECALL_CRON_SECRET, req)
      ? { reason: String((err as Error)?.message ?? err).slice(0, 500) }
      : {};
    return json(503, { detail: "Service is starting or unavailable; retry shortly", ...reason });
  }

  if (new URL(req.url).pathname === "/internal/tick") {
    if (!authorized(ctx.config.worker.cronSecret, req))
      return json(401, { detail: "Unauthorized" });
    waitUntil(
      Promise.all([
        drain(ctx),
        ctx.billing.sweep().catch((err) => ctx.log.error({ err }, "billing sweep failed")),
      ]),
    );
    return json(202, { accepted: true });
  }

  const before = enqueues;
  const res = await app.fetch(req);
  if (enqueues !== before) waitUntil(drain(ctx));
  else waitUntil(ctx.usage.flush().catch((err) => ctx.log.error({ err }, "usage flush failed")));
  return res;
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
