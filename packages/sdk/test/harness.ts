import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { loadConfig } from "../../server/src/config.js";
import { type AppContext, createContext } from "../../server/src/context.js";
import { createApp } from "../../server/src/http/app.js";
import { startWorker } from "../../server/src/queue/worker.js";

export interface TestServer {
  /** Base URL of the in-process server. */
  url: string;
  ctx: AppContext;
  close(): Promise<void>;
}

/**
 * The real Recall server, in this process: embedded Postgres (PGlite) in memory, the offline mock
 * model, the background worker, and reasoning that starts immediately (no batching delay).
 * Listens on an ephemeral port.
 */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const config = loadConfig({
    RECALL_DATA_DIR: "memory",
    RECALL_LOG_LEVEL: "silent",
    RECALL_REASONER_MAX_DELAY_MS: "0",
    RECALL_WORKER_POLL_MS: "50",
    ...env,
  });
  const ctx = await createContext(config);
  const stopWorker = await startWorker(ctx);
  const http = serve({ fetch: createApp(ctx).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    ctx,
    async close() {
      await stopWorker();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        (http as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await ctx.close();
    },
  };
}

export interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
}

/** A `fetch` that records every request and lets a test intercept some of them. */
export function recordingFetch(
  intercept?: (req: Recorded, next: () => Promise<Response>, count: number) => Promise<Response>,
) {
  const calls: Recorded[] = [];
  const impl: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const text = init?.body && typeof init.body === "string" ? init.body : null;
    const rec: Recorded = { method: req.method, url: req.url, headers: req.headers, body: text };
    calls.push(rec);
    const next = () => fetch(input as RequestInfo, init);
    return intercept ? intercept(rec, next, calls.length) : next();
  };
  return { fetch: impl, calls };
}
