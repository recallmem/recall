import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import { type Config, dashboardBase, joinBase } from "../../config.js";

export { dashboardBase, dashboardLink, joinBase } from "../../config.js";

/**
 * Where the dashboard lives. With one host for everything it is under `/app`
 * (https://example.com/app/keys); when it has a host of its own
 * (RECALL_DASHBOARD_URL differs from RECALL_PUBLIC_URL) it is at that host's
 * root (https://app.example.com/keys), and /app/* there redirects to the
 * prefix-less path.
 *
 * Every dashboard path that is generated (links, form actions, redirects, the
 * stylesheet and script, sign-in links, the OAuth flow's way through sign-in)
 * goes through `dashPath`, which reads the base of the request being served.
 * Cookies are unaffected: `__Host-` cookies must have `Path=/`.
 */

const current = new AsyncLocalStorage<string>();

/** Serves the rest of the request with this deployment's dashboard base. */
export function withDashboardBase(config: Config): MiddlewareHandler {
  const base = dashboardBase(config);
  return (_c, next) => current.run(base, next);
}

/** A dashboard path for the request being served (outside one: the single-host "/app"). */
export function dashPath(path: string): string {
  return joinBase(current.getStore() ?? "/app", path);
}
