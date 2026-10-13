import { pino } from "pino";
import { loadConfig } from "../src/config.js";
import { type AppContext, createContext } from "../src/context.js";
import { type App, createApp } from "../src/http/app.js";

/**
 * Fresh in-memory server for a test: embedded Postgres, mock LLM, hash
 * embeddings. Pass env overrides (e.g. auth) as needed.
 */
export async function createTestServer(env: Record<string, string> = {}): Promise<{
  ctx: AppContext;
  app: App;
  request: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  close: () => Promise<void>;
}> {
  const config = loadConfig({ RECALL_DATA_DIR: "memory", ...env });
  const ctx = await createContext(config, { log: pino({ level: "silent" }) });
  const app = createApp(ctx);
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ctx, app, request, close: () => ctx.close() };
}
