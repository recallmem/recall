import { sleep } from "./util.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} -> HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export interface QueueStatus {
  total_work_units?: number;
  completed_work_units?: number;
  in_progress_work_units?: number;
  pending_work_units?: number;
  /**
   * Recall extension, present when `wait_ms` was sent: whether the server's own definition
   * of idle holds. Authoritative where it exists, because the counts alone cannot say (a dream
   * scheduled for later is "pending" but nothing is happening).
   */
  idle?: boolean;
  /**
   * Recall extension: background units that failed for good (counted among the completed ones),
   * so the memory they would have built is missing. Other servers leave it out.
   */
  failed_work_units?: number;
}

export interface ChatResponse {
  content: string | null;
  /** Recall extensions; absent on other servers. */
  citations?: unknown;
  confidence?: number | null;
  abstained?: boolean | null;
  /** From Recall's X-Recall-Tokens-In/-Out and X-Recall-LLM-Calls headers; absent elsewhere. */
  usage?: { tokensIn: number; tokensOut: number; calls: number };
}

export interface MessageOut {
  id: string;
  token_count?: number;
}

/** Shape of Recall's `GET /v3/workspaces/{id}/usage` (an extension; Honcho has no such route). */
export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  unpriced_calls: number;
}
export interface UsageReport {
  total: UsageTotals;
  by_task: Record<string, UsageTotals>;
  items: { task: string; provider: string; model: string; calls: number }[];
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Attempts for transient failures (network errors, 429, 502-504). */
  attempts?: number;
  /** Sees the headers of the successful response. */
  onHeaders?: (headers: Headers) => void;
}

const TRANSIENT = new Set([429, 502, 503, 504]);

/**
 * Minimal REST client for Honcho's v3 API using plain fetch. Works against any
 * compatible server, which is the point: the same code measures every target.
 */
export class MemoryApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey?: string,
    private readonly defaults: { timeoutMs: number; attempts: number } = {
      timeoutMs: 60_000,
      attempts: 4,
    },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const attempts = opts.attempts ?? this.defaults.attempts;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaults.timeoutMs),
        });
        const text = await res.text();
        if (res.ok) {
          opts.onHeaders?.(res.headers);
          try {
            return (text ? JSON.parse(text) : undefined) as T;
          } catch {
            throw new HttpError(res.status, method, path, `non-JSON response: ${text}`);
          }
        }
        const err = new HttpError(res.status, method, path, text);
        if (!TRANSIENT.has(res.status) || attempt === attempts) throw err;
        lastError = err;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
      } catch (err) {
        if (err instanceof HttpError) throw err; // already classified above
        // Network error or timeout. Safe to retry: workspace/peer/session creation is
        // get-or-create and message batches carry an Idempotency-Key.
        lastError = describeNetworkError(method, path, err);
        if (attempt === attempts) break;
        await sleep(backoff(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  createWorkspace(id: string, metadata: Record<string, unknown>) {
    return this.request("POST", "/v3/workspaces", { body: { id, metadata } });
  }

  createPeer(ws: string, id: string, observeMe: boolean) {
    return this.request("POST", `/v3/workspaces/${ws}/peers`, {
      body: { id, configuration: { observe_me: observeMe } },
    });
  }

  createSession(
    ws: string,
    id: string,
    peers: Record<string, { observe_me: boolean; observe_others: boolean }>,
  ) {
    return this.request("POST", `/v3/workspaces/${ws}/sessions`, { body: { id, peers } });
  }

  addMessages(
    ws: string,
    session: string,
    messages: { peer_id: string; content: string; created_at: string }[],
    idempotencyKey: string,
  ) {
    return this.request<MessageOut[]>("POST", `/v3/workspaces/${ws}/sessions/${session}/messages`, {
      body: { messages },
      headers: { "idempotency-key": idempotencyKey },
      timeoutMs: 120_000,
    });
  }

  /**
   * Messages a session holds (the `total` of a one-item page of the message list). A workspace or
   * session that does not exist holds none: servers answer it with an empty page or a 404.
   */
  async countMessages(ws: string, session: string): Promise<number> {
    try {
      const page = await this.request<{ total?: number; items?: unknown[] }>(
        "POST",
        `/v3/workspaces/${ws}/sessions/${session}/messages/list`,
        { body: {}, query: { page: 1, size: 1 } },
      );
      if (typeof page?.total === "number") return page.total;
      if (page?.items?.length) throw new Error("the message list reports no total");
      return 0;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return 0;
      throw err;
    }
  }

  /** `wait_ms` makes servers that support it (Recall) hold the request until idle; others ignore it. */
  queueStatus(ws: string, waitMs?: number) {
    return this.request<QueueStatus>("GET", `/v3/workspaces/${ws}/queue/status`, {
      query: { wait_ms: waitMs },
      timeoutMs: (waitMs ?? 0) + 15_000,
    });
  }

  /**
   * Recall extension: puts the workspace's failed background units back in the queue. Null on
   * servers without it.
   */
  async retryFailed(ws: string): Promise<number | null> {
    try {
      const out = await this.request<{ retried?: number }>(
        "POST",
        `/v3/workspaces/${ws}/queue/retry`,
        { body: {} },
      );
      return typeof out?.retried === "number" ? out.retried : null;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  }

  /** Ids of the workspaces whose metadata holds `eval_run: runId` (every page). */
  async listRunWorkspaces(runId: string): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const out = await this.request<{ items?: { id: string }[]; pages?: number }>(
        "POST",
        "/v3/workspaces/list",
        { body: { filters: { metadata: { eval_run: runId } } }, query: { page, size: 100 } },
      );
      for (const w of out?.items ?? []) ids.push(w.id);
      if (!out?.pages || page >= out.pages) return ids;
    }
  }

  /** Ids of a workspace's sessions (every page). */
  async listSessions(ws: string): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const out = await this.request<{ items?: { id: string }[]; pages?: number }>(
        "POST",
        `/v3/workspaces/${ws}/sessions/list`,
        { body: {}, query: { page, size: 100 } },
      );
      for (const s of out?.items ?? []) ids.push(s.id);
      if (!out?.pages || page >= out.pages) return ids;
    }
  }

  scheduleDream(ws: string, observer: string, observed: string) {
    return this.request("POST", `/v3/workspaces/${ws}/schedule_dream`, {
      body: { observer, observed, dream_type: "omni" },
    });
  }

  /**
   * `answerModel` asks Recall to answer with that model and `plan` (JSON) to retrieve with other
   * settings: experiments for accounts the operator enabled.
   */
  async chat(
    ws: string,
    peer: string,
    query: string,
    level: string,
    timeoutMs: number,
    answerModel?: string,
    plan?: string,
    team?: string,
  ) {
    const headers: Record<string, string> = {
      ...(answerModel ? { "x-recall-answer-model": answerModel } : {}),
      ...(plan ? { "x-recall-plan": plan } : {}),
      ...(team ? { "x-recall-team": team } : {}),
    };
    let usage: ChatResponse["usage"];
    const res = await this.request<ChatResponse>(
      "POST",
      `/v3/workspaces/${ws}/peers/${peer}/chat`,
      {
        body: { query, reasoning_level: level, stream: false },
        timeoutMs,
        // A retried chat is billed again on managed services, so only retry clear transient errors.
        attempts: 2,
        ...(Object.keys(headers).length ? { headers } : {}),
        onHeaders: (h) => {
          const n = (name: string) => Number(h.get(name) ?? Number.NaN);
          const [tokensIn, tokensOut, calls] = [
            n("x-recall-tokens-in"),
            n("x-recall-tokens-out"),
            n("x-recall-llm-calls"),
          ];
          if ([tokensIn, tokensOut, calls].every(Number.isFinite))
            usage = { tokensIn, tokensOut, calls };
        },
      },
    );
    return res && usage ? { ...res, usage } : res;
  }

  /** Exact metered usage if the server has the Recall extension, else null. */
  async usage(ws: string): Promise<UsageReport | null> {
    try {
      const report = await this.request<UsageReport>("GET", `/v3/workspaces/${ws}/usage`, {
        attempts: 2,
      });
      return report?.total && typeof report.total.cost_usd === "number" ? report : null;
    } catch (err) {
      if (err instanceof HttpError && [404, 405, 501].includes(err.status)) return null;
      throw err;
    }
  }

  /**
   * The account's monthly budget (Recall's `GET /v3/usage`, account-admin keys), or null when the
   * server has no such route or the key may not read it.
   */
  async budget(): Promise<{ limitUsd: number | null; spentUsd: number; exceeded: boolean } | null> {
    try {
      const r = await this.request<{
        budget?: {
          monthly_budget_usd: number | null;
          month_to_date_usd: number;
          exceeded: boolean;
        };
      }>("GET", "/v3/usage", { attempts: 2 });
      if (!r?.budget) return null;
      return {
        limitUsd: r.budget.monthly_budget_usd,
        spentUsd: r.budget.month_to_date_usd,
        exceeded: r.budget.exceeded,
      };
    } catch (err) {
      if (err instanceof HttpError && [401, 403, 404, 405, 501].includes(err.status)) return null;
      throw err;
    }
  }

  deleteSession(ws: string, session: string) {
    return this.request("DELETE", `/v3/workspaces/${ws}/sessions/${session}`, { attempts: 1 });
  }

  deleteWorkspace(ws: string) {
    return this.request("DELETE", `/v3/workspaces/${ws}`, { attempts: 1 });
  }
}

/** fetch() reports every network failure as a bare "fetch failed"; the useful part is in `cause`. */
function describeNetworkError(method: string, path: string, err: unknown): Error {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message ?? (err as Error)?.message ?? String(err);
  return new Error(`${method} ${path} failed: ${detail}`, { cause: err });
}

const backoff = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 15_000);

export interface IdleResult {
  idle: boolean;
  waitedMs: number;
  /** Failed background units the server reported at the last reading (Recall only; else 0). */
  failed: number;
  /** True when idleness was inferred because the counts stopped changing (servers without `idle`). */
  stalled?: boolean;
}

const isIdle = (s: QueueStatus) =>
  (s.pending_work_units ?? 0) === 0 && (s.in_progress_work_units ?? 0) === 0;

/**
 * Waits until the workspace's background processing has drained. Uses `wait_ms`
 * long-polling where supported (trusting the server's `idle` flag) and plain polling
 * of the work-unit counts otherwise. Without the flag, two idle readings in a row are
 * required so work that is about to be enqueued is not missed, and counts that stay
 * frozen with nothing in progress (e.g. a dream scheduled for an hour from now) are
 * treated as idle after `stallMs`.
 */
export async function waitUntilIdle(
  api: MemoryApi,
  ws: string,
  opts: {
    timeoutMs: number;
    pollMs?: number;
    settleMs?: number;
    holdMs?: number;
    stallMs?: number;
  },
): Promise<IdleResult> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 1500;
  const settleMs = opts.settleMs ?? 400;
  const holdMs = opts.holdMs ?? 25_000;
  const stallMs = opts.stallMs ?? 120_000;
  let confirmed = false;
  let signature = "";
  let changedAt = started;
  while (Date.now() < deadline) {
    const t0 = Date.now();
    let status: QueueStatus;
    try {
      status = await api.queueStatus(ws, Math.min(holdMs, Math.max(0, deadline - t0)));
    } catch (err) {
      // A server too busy to answer in time (timeouts, 429/5xx after the client's own retries)
      // has not lost the workspace: keep waiting until the deadline. Anything else is real.
      if (err instanceof HttpError && !TRANSIENT.has(err.status)) throw err;
      confirmed = false;
      await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())));
      continue;
    }
    const failed = status.failed_work_units ?? 0;
    if (status.idle === true) return { idle: true, waitedMs: Date.now() - started, failed };
    if (status.idle === undefined) {
      if (isIdle(status)) {
        if (confirmed) return { idle: true, waitedMs: Date.now() - started, failed };
        confirmed = true;
        await sleep(settleMs);
        continue;
      }
      const sig = `${status.completed_work_units}/${status.pending_work_units}/${status.in_progress_work_units}`;
      if (sig !== signature) {
        signature = sig;
        changedAt = Date.now();
      } else if ((status.in_progress_work_units ?? 0) === 0 && Date.now() - changedAt >= stallMs) {
        return { idle: true, waitedMs: Date.now() - started, stalled: true, failed };
      }
    }
    confirmed = false;
    // A server without long-poll support answers immediately; pace the polling ourselves.
    const spent = Date.now() - t0;
    if (spent < pollMs) await sleep(pollMs - spent);
  }
  return { idle: false, waitedMs: Date.now() - started, failed: 0 };
}
