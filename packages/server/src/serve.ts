import { serve } from "@hono/node-server";
import type { Config } from "./config.js";
import { type AppContext, createContext } from "./context.js";
import { createApp } from "./http/app.js";

export interface RunningRecall {
  ctx: AppContext;
  /** The port the API is listening on (resolved when the configured port is 0); null for a worker-only role. */
  port: number | null;
  stop(): Promise<void>;
}

/**
 * Opens the database and runs the API server and/or the background worker, as
 * the configured role says. Shared by `recall-server` and `recall start`.
 */
export async function startRecall(config: Config): Promise<RunningRecall> {
  const ctx = await createContext(config);
  const stops: (() => Promise<void>)[] = [];
  try {
    return await launch(config, ctx, stops);
  } catch (err) {
    // e.g. the port is taken: release the database so the process can exit with the error.
    for (const stop of stops.reverse()) await stop().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    throw err;
  }
}

async function launch(
  config: Config,
  ctx: AppContext,
  stops: (() => Promise<void>)[],
): Promise<RunningRecall> {
  let port: number | null = null;

  if (config.role !== "worker") {
    const app = createApp(ctx);
    const server = serve({
      fetch: app.fetch,
      hostname: config.server.host,
      port: config.server.port,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : config.server.port;
    ctx.log.info(
      { port, database: ctx.dbKind, models: config.models, embedding: config.embedding.model },
      "recall api listening",
    );
    stops.push(() => new Promise((resolve) => server.close(() => resolve())));
  }

  if (config.role !== "api") {
    const { startWorker } = await import("./queue/worker.js");
    const { startFunnelReports } = await import("./core/funnel-report.js");
    const { startOnboardingEmails } = await import("./core/onboarding.js");
    stops.push(await startWorker(ctx));
    stops.push(ctx.billing.startSweeper());
    stops.push(startFunnelReports(ctx));
    stops.push(startOnboardingEmails(ctx));
  }

  return {
    ctx,
    port,
    async stop() {
      for (const stop of stops) await stop();
      await ctx.close();
    },
  };
}

/** Stops `running` on SIGINT/SIGTERM, then exits. */
export function stopOnSignals(running: RunningRecall): void {
  const shutdown = async () => {
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
