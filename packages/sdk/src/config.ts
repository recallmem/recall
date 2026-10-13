import { NAME_PATTERN, readEnv } from "./util.js";

/** Recall's hosted API. Self-hosters point `baseURL` or `RECALL_URL` at their own server instead. */
export const DEFAULT_BASE_URL = "https://api.recallmem.dev";
export const DEFAULT_WORKSPACE_ID = "default";

/** Options for `new Recall(...)`. Every field is optional; the environment fills the gaps. */
export interface RecallConfig {
  /** Bearer token. Falls back to `RECALL_API_KEY`. */
  apiKey?: string;
  /**
   * Server URL. Falls back to `RECALL_URL` (or `RECALL_BASE_URL`), then Recall's hosted API,
   * `https://api.recallmem.dev`. An explicit value always wins. For a server you run yourself, pass
   * `baseURL: "http://localhost:8000"` or set `RECALL_URL`.
   */
  baseURL?: string;
  /** Workspace every call acts in. Falls back to `RECALL_WORKSPACE_ID`, then `"default"`. */
  workspaceId?: string;
  /** Per-attempt timeout in milliseconds (default 60000). */
  timeout?: number;
  /** Extra attempts after a retryable failure (default 2). 0 disables retries. */
  maxRetries?: number;
  /** First retry delay ceiling in ms; doubles each attempt, with full jitter (default 500). */
  retryBaseDelay?: number;
  /** Longest single retry delay in ms (default 8000). A longer `Retry-After` is still honoured up to 60 s. */
  retryMaxDelay?: number;
  /** Headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** Query parameters sent with every request. */
  defaultQuery?: Record<string, string>;
  /** A `fetch` implementation (default: the global one). */
  fetch?: typeof fetch;
  /**
   * Get-or-create on first use: the workspace is created on the first call that needs it, and each
   * `peer()`, `session()` and `scope()` handle gets-or-creates its resource before its first
   * request. Off by default, so a typo in an id is a 404, not a new peer.
   */
  autoCreate?: boolean;
}

export interface ResolvedConfig {
  apiKey: string | undefined;
  baseURL: string;
  workspaceId: string;
  timeout: number;
  maxRetries: number;
  retryBaseDelay: number;
  retryMaxDelay: number;
  defaultHeaders: Record<string, string>;
  defaultQuery: Record<string, string>;
  fetch: typeof fetch;
  autoCreate: boolean;
}

const first = (...values: (string | undefined)[]): string | undefined =>
  values.find((v) => v !== undefined && v !== "");

export function resolveConfig(
  opts: RecallConfig = {},
  env: Record<string, string | undefined> = readEnv(),
): ResolvedConfig {
  const baseURLRaw = first(opts.baseURL, env.RECALL_URL, env.RECALL_BASE_URL) ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseURLRaw);
  } catch {
    throw new TypeError(`baseURL is not a valid URL: ${JSON.stringify(baseURLRaw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`baseURL must be http or https (got ${url.protocol})`);
  }
  const workspaceId = first(opts.workspaceId, env.RECALL_WORKSPACE_ID) ?? DEFAULT_WORKSPACE_ID;
  if (workspaceId.length > 512 || !NAME_PATTERN.test(workspaceId)) {
    throw new TypeError(
      `workspaceId must be 1-512 characters of a-z, A-Z, 0-9, "_" and "-" (got ${JSON.stringify(workspaceId)})`,
    );
  }
  const positive = (name: string, value: number | undefined, fallback: number, min = 1) => {
    const v = value ?? fallback;
    if (!Number.isFinite(v) || v < min) throw new TypeError(`${name} must be a number >= ${min}`);
    return v;
  };
  const impl = opts.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  if (!impl) throw new Error("No global fetch available: pass the `fetch` option");

  return {
    apiKey: first(opts.apiKey, env.RECALL_API_KEY),
    baseURL: url.toString().replace(/\/+$/, ""),
    workspaceId,
    timeout: positive("timeout", opts.timeout, 60_000),
    maxRetries: Math.floor(positive("maxRetries", opts.maxRetries, 2, 0)),
    retryBaseDelay: positive("retryBaseDelay", opts.retryBaseDelay, 500, 0),
    retryMaxDelay: positive("retryMaxDelay", opts.retryMaxDelay, 8000, 0),
    defaultHeaders: opts.defaultHeaders ?? {},
    defaultQuery: opts.defaultQuery ?? {},
    fetch: impl.bind(globalThis),
    autoCreate: opts.autoCreate === true,
  };
}
