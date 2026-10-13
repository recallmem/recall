import type { ResolvedConfig } from "./config.js";
import {
  errorFromResponse,
  RateLimitError,
  RecallConnectionError,
  RecallError,
  RecallTimeoutError,
} from "./errors.js";
import { sleep } from "./util.js";
import { API_VERSION, VERSION } from "./version.js";

export type QueryValue = string | number | boolean | null | undefined | readonly string[];

/** Per-call knobs accepted by the network-facing methods. */
export interface CallOptions {
  /** Timeout for this call in milliseconds, overriding the client's. */
  timeout?: number;
  /** Abort the call (and any retries). */
  signal?: AbortSignal;
}

export interface RequestInit2 extends CallOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Path below `/v3`, starting with `/`. */
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON body. */
  body?: unknown;
  /** Multipart body (set instead of `body`). */
  form?: FormData;
  headers?: Record<string, string>;
  /**
   * Safe to send twice (reads, upserts, deletes, and writes that carry an idempotency key).
   * Non-idempotent requests are retried only after a 429, which proves they were not processed.
   */
  idempotent?: boolean;
  /** Status codes (besides 429/500/502/503/504) that are worth retrying for this call. */
  retryStatuses?: readonly number[];
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** A `Retry-After` longer than this is not waited out; the error is raised instead. */
const MAX_RETRY_AFTER_MS = 60_000;

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Full-jitter exponential backoff: uniform in [0, min(max, base * 2^attempt)]. */
export function backoffDelay(
  attempt: number,
  base: number,
  max: number,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * Math.min(max, base * 2 ** attempt));
}

export class HttpClient {
  #workspaceEnsured: Promise<void> | null = null;

  constructor(readonly config: ResolvedConfig) {}

  /**
   * With `autoCreate`, the client's workspace is got-or-created once, before the first request
   * below it. A failure is not cached.
   */
  private async ensureWorkspace(init: RequestInit2): Promise<void> {
    if (!this.config.autoCreate) return;
    if (!init.path.startsWith(`/workspaces/${encodeURIComponent(this.config.workspaceId)}/`))
      return;
    this.#workspaceEnsured ??= this.send(
      {
        method: "POST",
        path: "/workspaces",
        body: { id: this.config.workspaceId },
        idempotent: true,
      },
      false,
      async (res) => {
        await parseBody(res);
      },
    ).catch((err) => {
      this.#workspaceEnsured = null;
      throw err;
    });
    await this.#workspaceEnsured;
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    const merged = { ...this.config.defaultQuery, ...query };
    return `${this.config.baseURL}/${API_VERSION}${path}${buildQuery(merged)}`;
  }

  private headers(init: RequestInit2): Headers {
    const h = new Headers({
      accept: "application/json",
      "x-recall-client": `recall-typescript/${VERSION}`,
      ...this.config.defaultHeaders,
    });
    if (this.config.apiKey) h.set("authorization", `Bearer ${this.config.apiKey}`);
    if (init.body !== undefined) h.set("content-type", "application/json");
    for (const [k, v] of Object.entries(init.headers ?? {})) h.set(k, v);
    return h;
  }

  /** One JSON round trip, with retries. Resolves to the parsed body (undefined for 204/empty). */
  async request<T = unknown>(init: RequestInit2): Promise<T> {
    await this.ensureWorkspace(init);
    return (await this.send(init, false, async (res) => parseBody(res))) as T;
  }

  /** Like `request`, but hands back the response once its headers arrive, for streaming. */
  async stream(init: RequestInit2): Promise<Response> {
    await this.ensureWorkspace(init);
    return this.send(init, true, async (res) => res);
  }

  private async send<R>(
    init: RequestInit2,
    keepOpen: boolean,
    read: (res: Response) => Promise<R>,
  ): Promise<R> {
    const { maxRetries, retryBaseDelay, retryMaxDelay } = this.config;
    const url = this.url(init.path, init.query);
    const body: BodyInit | undefined =
      init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    const idempotent = init.idempotent ?? init.method === "GET";
    const extra = new Set(init.retryStatuses ?? []);

    for (let attempt = 0; ; attempt++) {
      let failure: RecallError;
      let retryAfterMs: number | undefined;
      try {
        return await this.attempt(url, init, body, keepOpen, read);
      } catch (err) {
        if (init.signal?.aborted) throw init.signal.reason ?? err;
        if (!isRecallError(err)) throw err;
        failure = err;
        if (err instanceof RateLimitError && err.retryAfter !== undefined) {
          retryAfterMs = err.retryAfter * 1000;
        }
      }
      const status = failure.status;
      const transient = status === 0 || RETRY_STATUSES.has(status) || extra.has(status);
      // A 429 proves the request was not processed, so it is safe to resend whatever it was.
      const retryable = status === 429 || (transient && idempotent);
      if (!retryable || attempt >= maxRetries) throw failure;
      if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) throw failure;
      const jittered = backoffDelay(attempt, retryBaseDelay, retryMaxDelay);
      await sleep(Math.max(jittered, retryAfterMs ?? 0), init.signal);
    }
  }

  private async attempt<R>(
    url: string,
    init: RequestInit2,
    body: BodyInit | undefined,
    keepOpen: boolean,
    read: (res: Response) => Promise<R>,
  ): Promise<R> {
    const timeout = init.timeout ?? this.config.timeout;
    const controller = new AbortController();
    const onAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    // A streamed body outlives this call, so it stays tied to the caller's signal once it is handed over.
    let handedOver = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    try {
      let res: Response;
      try {
        res = await this.config.fetch(url, {
          method: init.method,
          headers: this.headers(init),
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) {
          throw new RecallTimeoutError(`Request timed out after ${timeout} ms`, { cause: err });
        }
        if (init.signal?.aborted) throw err;
        throw new RecallConnectionError(
          `Could not reach ${this.config.baseURL}: ${describeNetworkError(err)}`,
          { cause: err },
        );
      }
      if (!res.ok)
        throw errorFromResponse(
          res.status,
          await parseBody(res).catch(() => undefined),
          res.headers,
        );
      if (keepOpen) clearTimeout(timer);
      try {
        const out = await read(res);
        handedOver = keepOpen;
        return out;
      } catch (err) {
        if (timedOut) {
          throw new RecallTimeoutError(`Request timed out after ${timeout} ms`, { cause: err });
        }
        if (isRecallError(err) || init.signal?.aborted) throw err;
        throw new RecallConnectionError(`Connection lost: ${describeNetworkError(err)}`, {
          cause: err,
        });
      }
    } finally {
      clearTimeout(timer);
      if (!handedOver) init.signal?.removeEventListener("abort", onAbort);
    }
  }
}

const isRecallError = (err: unknown): err is RecallError => err instanceof RecallError;

function describeNetworkError(err: unknown): string {
  const e = err as { cause?: { code?: string; message?: string }; message?: string } | null;
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
