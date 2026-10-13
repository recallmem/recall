import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { resolveConfig } from "../src/config.js";
import { messageToWire } from "../src/core.js";
import { errorFromResponse, messageFromBody, parseRetryAfter } from "../src/errors.js";
import { backoffDelay, buildQuery, HttpClient } from "../src/http.js";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ConnectionError,
  constructWebhookEvent,
  DialecticStream,
  NotFoundError,
  Page,
  PermissionDeniedError,
  RateLimitError,
  Recall,
  type RecallConfig,
  RecallError,
  ServerError,
  SessionContext,
  TimeoutError,
  UnprocessableEntityError,
  VERSION,
  verifyWebhookSignature,
} from "../src/index.js";
import { conclusionFromWire, configFromWire, configToWire, usageFromWire } from "../src/wire.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function clientWith(
  fetchImpl: typeof fetch,
  opts: Partial<ConstructorParameters<typeof Recall>[0]> = {},
) {
  return new HttpClient(
    resolveConfig(
      { baseURL: "http://x.test", fetch: fetchImpl, retryBaseDelay: 1, retryMaxDelay: 5, ...opts },
      {},
    ),
  );
}

describe("package", () => {
  it("reports the version in package.json and has no runtime dependencies", () => {
    expect(VERSION).toBe(pkg.version);
    const config: RecallConfig = { baseURL: "http://localhost:8000" };
    expect(new Recall(config).baseURL).toBe("http://localhost:8000");
    expect(Object.keys((pkg as { dependencies?: object }).dependencies ?? {})).toEqual([]);
  });
});

describe("config", () => {
  const env = (e: Record<string, string>) => e;
  it("prefers options, then RECALL_*, then defaults", () => {
    const defaults = resolveConfig({}, env({}));
    expect(defaults).toMatchObject({
      baseURL: "https://api.recallmem.dev",
      workspaceId: "default",
      apiKey: undefined,
      timeout: 60_000,
      maxRetries: 2,
    });
    const fromEnv = resolveConfig(
      {},
      env({ RECALL_URL: "http://p.test/", RECALL_API_KEY: "pk", RECALL_WORKSPACE_ID: "pw" }),
    );
    expect(fromEnv).toMatchObject({ baseURL: "http://p.test", apiKey: "pk", workspaceId: "pw" });
    const explicit = resolveConfig(
      { baseURL: "http://o.test/api", apiKey: "ok", workspaceId: "ow" },
      env({ RECALL_URL: "http://p.test", RECALL_API_KEY: "pk", RECALL_WORKSPACE_ID: "pw" }),
    );
    expect(explicit).toMatchObject({
      baseURL: "http://o.test/api",
      apiKey: "ok",
      workspaceId: "ow",
    });
  });

  it("defaults to the hosted API and keeps every explicit override", () => {
    expect(resolveConfig({}, env({})).baseURL).toBe("https://api.recallmem.dev");
    // Self-hosters: the argument, then RECALL_URL / RECALL_BASE_URL.
    expect(resolveConfig({ baseURL: "http://localhost:8000" }, env({})).baseURL).toBe(
      "http://localhost:8000",
    );
    expect(resolveConfig({}, env({ RECALL_URL: "http://localhost:8000/" })).baseURL).toBe(
      "http://localhost:8000",
    );
    expect(resolveConfig({}, env({ RECALL_BASE_URL: "http://rb.test" })).baseURL).toBe(
      "http://rb.test",
    );
    expect(resolveConfig({}, env({ RECALL_URL: "" })).baseURL).toBe("https://api.recallmem.dev");
  });

  it("ignores the variables of other products: HONCHO_* never reaches settings or requests", async () => {
    const foreign = env({
      HONCHO_URL: "http://other.test",
      HONCHO_BASE_URL: "http://other-base.test",
      HONCHO_API_KEY: "other-key",
      HONCHO_WORKSPACE_ID: "other-workspace",
    });
    // Only the foreign variables are set: no key, the default URL and the default workspace.
    expect(resolveConfig({}, foreign)).toMatchObject({
      baseURL: "https://api.recallmem.dev",
      workspaceId: "default",
      apiKey: undefined,
    });
    // With RECALL_* set as well, RECALL_* wins outright (nothing is merged in from HONCHO_*).
    expect(
      resolveConfig(
        {},
        {
          ...foreign,
          RECALL_URL: "http://p.test",
          RECALL_API_KEY: "pk",
          RECALL_WORKSPACE_ID: "pw",
        },
      ),
    ).toMatchObject({ baseURL: "http://p.test", apiKey: "pk", workspaceId: "pw" });
    // End to end: a client built from the real process environment sends no Authorization header.
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("RECALL_") || k.startsWith("HONCHO_")) delete process.env[k];
    }
    Object.assign(process.env, {
      HONCHO_URL: "http://other.test",
      HONCHO_API_KEY: "other-key",
      HONCHO_WORKSPACE_ID: "other-workspace",
    });
    try {
      const seen: { url: string; authorization: string | null }[] = [];
      const recall = new Recall({
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return json({ id: "default" });
        }) as typeof fetch,
      });
      expect(recall.baseURL).toBe("https://api.recallmem.dev");
      expect(recall.workspaceId).toBe("default");
      await recall.getMetadata();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url.startsWith("https://api.recallmem.dev/")).toBe(true);
      expect(seen[0]!.authorization).toBeNull();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("rejects values the API would reject, before any request", () => {
    expect(() => resolveConfig({ baseURL: "not a url" }, {})).toThrow(/valid URL/);
    expect(() => resolveConfig({ baseURL: "ftp://x.test" }, {})).toThrow(/http or https/);
    expect(() => resolveConfig({ workspaceId: "has space" }, {})).toThrow(/workspaceId/);
    expect(() => resolveConfig({ timeout: 0 }, {})).toThrow(/timeout/);
    expect(() => resolveConfig({ maxRetries: -1 }, {})).toThrow(/maxRetries/);
    expect(() => new Recall({ workspaceId: "ok" }).peer("bad id")).toThrow(/peer id/);
    expect(() => new Recall().session("a/b")).toThrow(/session id/);
    expect(() => new Recall().scope("scope.x")).toThrow(/scope/);
  });
});

describe("errors", () => {
  it("maps statuses to error classes and keeps the details", () => {
    const h = new Headers({ "x-request-id": "req-1" });
    const cases: [number, unknown, typeof RecallError][] = [
      [400, { detail: "bad" }, BadRequestError],
      [401, { detail: "no" }, AuthenticationError],
      [403, { detail: "no" }, PermissionDeniedError],
      [404, { detail: "gone" }, NotFoundError],
      [409, { detail: "clash" }, ConflictError],
      [422, { detail: [] }, UnprocessableEntityError],
      [429, { detail: "slow" }, RateLimitError],
      [503, { detail: "down" }, ServerError],
      [418, { detail: "tea" }, APIError],
    ];
    for (const [status, body, cls] of cases) {
      const err = errorFromResponse(status, body, h);
      expect(err, String(status)).toBeInstanceOf(cls);
      expect(err).toBeInstanceOf(APIError);
      expect(err).toBeInstanceOf(RecallError);
      expect(err.status).toBe(status);
      expect(err.requestId).toBe("req-1");
      expect(err.body).toEqual(body);
    }
    expect(errorFromResponse(500, { code: "boom", detail: "x" }, h).code).toBe("boom");
  });

  it("derives the message from detail (string or FastAPI list), message, error, or the status", () => {
    expect(messageFromBody({ detail: "plain" }, 400)).toBe("plain");
    expect(
      messageFromBody(
        { detail: [{ loc: ["body", "messages", 0, "peer_id"], msg: "Field required" }] },
        422,
      ),
    ).toBe("messages.0.peer_id: Field required");
    expect(messageFromBody({ message: "m" }, 500)).toBe("m");
    expect(messageFromBody({ error: "e" }, 500)).toBe("e");
    expect(messageFromBody({ error: { message: "nested" } }, 500)).toBe("nested");
    expect(messageFromBody("<html>oops</html>", 502)).toBe("<html>oops</html>");
    expect(messageFromBody(undefined, 504)).toBe("HTTP 504");
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter("0.5")).toBe(0.5);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    const rate = errorFromResponse(429, {}, new Headers({ "retry-after": "2" })) as RateLimitError;
    expect(rate.retryAfter).toBe(2);
  });
});

describe("http: retries", () => {
  it("backs off with full jitter, bounded by the cap", () => {
    expect(backoffDelay(0, 500, 8000, () => 0)).toBe(0);
    expect(backoffDelay(0, 500, 8000, () => 0.999)).toBe(499);
    expect(backoffDelay(3, 500, 8000, () => 0.999)).toBe(3996);
    expect(backoffDelay(10, 500, 8000, () => 0.999)).toBe(7992);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(2, 500, 8000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(2000);
    }
  });

  it("retries reads on 5xx and network errors, then succeeds", async () => {
    let n = 0;
    const http = clientWith(async () => {
      n++;
      if (n === 1) return json({ detail: "down" }, 503);
      if (n === 2) throw new TypeError("fetch failed");
      return json({ ok: true });
    });
    expect(await http.request({ method: "GET", path: "/x" })).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("gives up after maxRetries and raises the last error", async () => {
    let n = 0;
    const http = clientWith(async () => {
      n++;
      return json({ detail: "still down" }, 502);
    });
    const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as RecallError;
    expect(err).toBeInstanceOf(ServerError);
    expect(err.message).toBe("still down");
    expect(n).toBe(3);
    n = 0;
    const none = clientWith(
      async () => {
        n++;
        return json({}, 500);
      },
      { maxRetries: 0 },
    );
    await none.request({ method: "GET", path: "/x" }).catch(() => undefined);
    expect(n).toBe(1);
  });

  it("does not retry client errors", async () => {
    let n = 0;
    const http = clientWith(async () => {
      n++;
      return json({ detail: "nope" }, 404);
    });
    await expect(http.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(n).toBe(1);
  });

  it("retries a non-idempotent request only after a 429", async () => {
    let n = 0;
    const flaky = clientWith(async () => {
      n++;
      return json({ detail: "boom" }, 500);
    });
    await expect(
      flaky.request({ method: "POST", path: "/conclusions", body: {} }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(n).toBe(1);

    n = 0;
    const limited = clientWith(async () =>
      ++n === 1 ? json({ detail: "slow down" }, 429) : json({ created: true }, 201),
    );
    expect(await limited.request({ method: "POST", path: "/conclusions", body: {} })).toEqual({
      created: true,
    });
    expect(n).toBe(2);
  });

  it("retries an idempotent POST after a dropped connection, but not a bare one", async () => {
    let n = 0;
    const http = clientWith(async () => {
      if (++n === 1) throw new TypeError("fetch failed");
      return json([]);
    });
    await http.request({ method: "POST", path: "/m", body: {}, idempotent: true });
    expect(n).toBe(2);

    n = 0;
    const bare = clientWith(async () => {
      n++;
      throw new TypeError("fetch failed");
    });
    await expect(bare.request({ method: "POST", path: "/m", body: {} })).rejects.toBeInstanceOf(
      ConnectionError,
    );
    expect(n).toBe(1);
  });

  it("waits at least as long as Retry-After says", async () => {
    let n = 0;
    const http = clientWith(async () =>
      ++n === 1 ? json({ detail: "slow" }, 429, { "retry-after": "0.15" }) : json({ ok: 1 }),
    );
    const started = Date.now();
    await http.request({ method: "GET", path: "/x" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(n).toBe(2);
  });

  it("does not wait out an unreasonable Retry-After", async () => {
    let n = 0;
    const http = clientWith(async () => {
      n++;
      return json({ detail: "later" }, 429, { "retry-after": "3600" });
    });
    const err = (await http
      .request({ method: "GET", path: "/x" })
      .catch((e) => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(3600);
    expect(n).toBe(1);
  });

  it("retries extra statuses only when asked to (409 on message writes)", async () => {
    let n = 0;
    const http = clientWith(async () =>
      ++n === 1 ? json({ detail: "busy" }, 409) : json({ ok: 1 }),
    );
    await expect(
      http.request({ method: "POST", path: "/m", body: {}, idempotent: true }),
    ).rejects.toBeInstanceOf(ConflictError);
    n = 0;
    await expect(
      http.request({
        method: "POST",
        path: "/m",
        body: {},
        idempotent: true,
        retryStatuses: [409],
      }),
    ).resolves.toEqual({ ok: 1 });
  });

  it("times out a hung request and reports it as a TimeoutError", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const http = clientWith(hang, { timeout: 30, maxRetries: 1 });
    const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as RecallError;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("30 ms");
    const quick = clientWith(hang, { timeout: 1000 });
    expect(
      await quick
        .request({ method: "GET", path: "/x", timeout: 20, idempotent: false })
        .catch((e) => e),
    ).toBeInstanceOf(TimeoutError);
  });

  it("stops at once when the caller aborts", async () => {
    let n = 0;
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        n++;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const http = clientWith(hang);
    const controller = new AbortController();
    const pending = http.request({ method: "GET", path: "/x", signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 10);
    await expect(pending).rejects.toThrow("stop");
    expect(n).toBe(1);
  });

  it("sends auth, client and default headers, and builds queries", async () => {
    let seen: Request | undefined;
    const http = clientWith(
      async (input, init) => {
        seen = new Request(input as RequestInfo, init);
        return json({});
      },
      { apiKey: "secret", defaultHeaders: { "x-extra": "1" }, defaultQuery: { dq: "v" } },
    );
    await http.request({
      method: "POST",
      path: "/a b",
      query: { a: 1, b: undefined, c: null, d: ["x", "y"], e: false },
      body: { k: 1 },
    });
    expect(seen!.url).toBe("http://x.test/v3/a b?dq=v&a=1&d=x&d=y&e=false".replace(" ", "%20"));
    expect(seen!.headers.get("authorization")).toBe("Bearer secret");
    expect(seen!.headers.get("content-type")).toBe("application/json");
    expect(seen!.headers.get("x-extra")).toBe("1");
    expect(seen!.headers.get("x-recall-client")).toBe(`recall-typescript/${VERSION}`);
    expect(buildQuery({ q: "a&b=c" })).toBe("?q=a%26b%3Dc");
    expect(buildQuery(undefined)).toBe("");
  });
});

describe("wire conversion", () => {
  it("renames configuration keys but never touches user data", () => {
    const wire = configToWire({
      customInstructions: "be brief",
      peerCard: { use: true, customInstructions: "x" },
      summary: { messagesPerShortSummary: 10 },
      observeMe: false,
      somethingElse: { keepMe_as_is: 1 },
    });
    expect(wire).toEqual({
      custom_instructions: "be brief",
      peer_card: { use: true, custom_instructions: "x" },
      summary: { messages_per_short_summary: 10 },
      observe_me: false,
      somethingElse: { keepMe_as_is: 1 },
    });
    expect(configFromWire(wire)).toEqual({
      customInstructions: "be brief",
      peerCard: { use: true, customInstructions: "x" },
      summary: { messagesPerShortSummary: 10 },
      observeMe: false,
      somethingElse: { keepMe_as_is: 1 },
    });
    expect(configFromWire(null)).toEqual({});
    const m = messageToWire({
      peerId: "a",
      content: "hi",
      metadata: { camelCaseKey: { snake_key: 1 } },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(m).toEqual({
      peer_id: "a",
      content: "hi",
      metadata: { camelCaseKey: { snake_key: 1 } },
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("reads a conclusion's validity and source messages, and does without them", () => {
    const base = {
      id: "c1",
      content: "alice lives in Rotterdam",
      observer_id: "alice",
      observed_id: "alice",
      session_id: "s1",
      level: "explicit",
      source_ids: [],
      times_derived: 1,
      created_at: "2026-09-01T09:00:05.000Z",
    };
    const c = conclusionFromWire({
      ...base,
      valid_from: "2026-09-01T09:00:00.000Z",
      valid_to: "2026-09-20T09:00:00.000Z",
      superseded_by: "c2",
      message_ids: ["m1", "m2"],
    });
    expect(c).toMatchObject({
      sourceIds: [],
      validFrom: "2026-09-01T09:00:00.000Z",
      validTo: "2026-09-20T09:00:00.000Z",
      supersededBy: "c2",
      messageIds: ["m1", "m2"],
    });
    expect(conclusionFromWire({ ...base, valid_to: null, superseded_by: null })).toMatchObject({
      validTo: null,
      supersededBy: null,
    });
    // a server that does not send them (a Honcho server)
    const plain = conclusionFromWire(base);
    for (const key of ["validFrom", "validTo", "supersededBy", "messageIds"])
      expect(plain).not.toHaveProperty(key);
  });

  it("reads usage from the hosted service without inventing a provider cost", () => {
    const usage = usageFromWire({
      workspace_id: "w",
      since: null,
      until: null,
      total: { calls: 2, input_tokens: 480, output_tokens: 24 },
      by_task: { chat_low: { calls: 1, input_tokens: 240 } },
      items: [{ task: "chat_low", model: "recall-lumen", calls: 1, input_tokens: 240 }],
      billed: {
        billed_usd: 0.205,
        learning: { message_tokens: 200_000, billed_usd: 0.2 },
        chat: {
          questions: 1,
          billed_usd: 0.005,
          by_level: { low: { questions: 1, billed_usd: 0.005 } },
        },
      },
    });
    expect(usage.total.costUsd).toBeNull();
    expect(usage.total.unpricedCalls).toBeNull();
    expect(usage.items[0]).toMatchObject({ provider: null, model: "recall-lumen", costUsd: null });
    expect(usage.billed).toEqual({
      billedUsd: 0.205,
      learning: { messageTokens: 200_000, billedUsd: 0.2 },
      chat: {
        questions: 1,
        billedUsd: 0.005,
        byLevel: {
          minimal: { questions: 0, billedUsd: 0 },
          low: { questions: 1, billedUsd: 0.005 },
          medium: { questions: 0, billedUsd: 0 },
          high: { questions: 0, billedUsd: 0 },
          max: { questions: 0, billedUsd: 0 },
        },
      },
    });
    // A server of your own: the provider cost, and nothing billed.
    const own = usageFromWire({
      workspace_id: "w",
      total: { calls: 1, cost_usd: 0, unpriced_calls: 0 },
      items: [{ task: "reasoner", provider: "mock", model: "default", cost_usd: 0 }],
    });
    expect(own.total.costUsd).toBe(0);
    expect(own.total.unpricedCalls).toBe(0);
    expect(own.items[0]!.provider).toBe("mock");
    expect(own.billed).toBeNull();
  });
});

describe("streaming", () => {
  const sse = (events: unknown[], split = 7) => {
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
        controller.close();
      },
    });
  };

  it("reassembles events split across chunks and exposes the final fields", async () => {
    const stream = new DialecticStream(
      new Response(
        sse([
          { delta: { content: "Hel" }, done: false },
          { delta: { content: "lo \u00e9" }, done: false },
          {
            done: true,
            evidence: { conclusions: [], messages: [], tool_calls: [], reasoning_trace_id: null },
            citations: ["c1"],
            confidence: 0.9,
            abstained: false,
          },
        ]),
      ),
    );
    const seen: string[] = [];
    for await (const d of stream) seen.push(d);
    expect(seen).toEqual(["Hel", "lo \u00e9"]);
    expect(await stream.getFinalResponse()).toBe("Hello \u00e9");
    expect(stream.isComplete).toBe(true);
    expect(stream.citations).toEqual(["c1"]);
    expect(stream.confidence).toBe(0.9);
    expect(stream.evidence).toMatchObject({ toolCalls: [], reasoningTraceId: null });
  });

  it("ignores comments, blank and malformed events, and reports an incomplete stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(": keep-alive\n\n"));
        c.enqueue(enc.encode("data: not json\n\n"));
        c.enqueue(enc.encode('data:{"delta":{"content":"ok"},"done":false}\r\n\r\n'));
        c.close();
      },
    });
    const stream = new DialecticStream(new Response(body));
    expect(await stream.toArray()).toEqual(["ok"]);
    expect(stream.isComplete).toBe(false);
  });

  it("stops with the caller's abort reason when they cancel mid-stream", async () => {
    let pipe!: ReadableStreamDefaultController<Uint8Array>;
    const hang = new ReadableStream<Uint8Array>({
      start(c) {
        pipe = c;
        c.enqueue(new TextEncoder().encode('data: {"delta":{"content":"a"},"done":false}\n\n'));
      },
    });
    const controller = new AbortController();
    const http = clientWith(async (_url, init) => {
      // like a real fetch, aborting the request errors its body
      init?.signal?.addEventListener("abort", () => pipe.error(init.signal?.reason));
      return new Response(hang);
    });
    const response = await http.stream({
      method: "POST",
      path: "/chat",
      body: {},
      signal: controller.signal,
    });
    const stream = new DialecticStream(response, controller.signal);
    const seen: string[] = [];
    const reading = (async () => {
      for await (const d of stream) {
        seen.push(d);
        controller.abort(new Error("user cancelled"));
      }
    })();
    await expect(reading).rejects.toThrow("user cancelled");
    expect(seen).toEqual(["a"]);
  });
});

describe("pagination", () => {
  const envelope = (page: number) => ({
    items: [page * 10, page * 10 + 1],
    total: 6,
    page,
    size: 2,
    pages: 3,
  });
  const fetchPage = async (page: number): Promise<Page<string, number>> =>
    new Page(envelope(page), (n) => `n${n}`, fetchPage);

  it("walks every page when iterated, and only this page through items", async () => {
    const first = await fetchPage(1);
    expect(first.items).toEqual(["n10", "n11"]);
    expect(first.length).toBe(2);
    expect(first.get(1)).toBe("n11");
    expect(first.hasNextPage).toBe(true);
    const seen: string[] = [];
    for await (const item of first) seen.push(item);
    expect(seen).toEqual(["n10", "n11", "n20", "n21", "n30", "n31"]);
    expect(await first.toArray()).toEqual(seen);
    const last = await fetchPage(3);
    expect(last.hasNextPage).toBe(false);
    expect(await last.getNextPage()).toBeNull();
    expect((await first.getNextPage())!.items).toEqual(["n20", "n21"]);
  });
});

describe("session context", () => {
  const message = (peerId: string, content: string, id = content) => ({
    id,
    content,
    peerId,
    sessionId: "s",
    workspaceId: "w",
    metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
    tokenCount: 1,
  });
  const summary = {
    content: "They talked about pets.",
    messageId: "m0",
    summaryType: "short",
    createdAt: "2026-01-01T00:00:00Z",
    tokenCount: 5,
  };
  const ctx = new SessionContext(
    "s",
    [message("alice", "hi"), message("bot", "hello!"), message("alice", "one more")],
    summary,
    "Alice lives in Utrecht.",
    ["Has a dog", "Likes tea"],
  );

  it("builds OpenAI messages: memory blocks first as system, then named history", () => {
    expect(ctx.length).toBe(4);
    expect(ctx.toOpenAI("bot")).toEqual([
      {
        role: "system",
        content: "<peer_representation>Alice lives in Utrecht.</peer_representation>",
      },
      { role: "system", content: "<peer_card>- Has a dog\n- Likes tea</peer_card>" },
      { role: "system", content: "<summary>They talked about pets.</summary>" },
      { role: "user", name: "alice", content: "hi" },
      { role: "assistant", name: "bot", content: "hello!" },
      { role: "user", name: "alice", content: "one more" },
    ]);
    expect(ctx.toOpenAI({ id: "bot" })).toEqual(ctx.toOpenAI("bot"));
  });

  it("builds Anthropic messages, and ready-to-send params", () => {
    expect(ctx.toAnthropic("bot")).toEqual([
      {
        role: "user",
        content: "<peer_representation>Alice lives in Utrecht.</peer_representation>",
      },
      { role: "user", content: "<peer_card>- Has a dog\n- Likes tea</peer_card>" },
      { role: "user", content: "<summary>They talked about pets.</summary>" },
      { role: "user", content: "alice: hi" },
      { role: "assistant", content: "hello!" },
      { role: "user", content: "alice: one more" },
    ]);
    const params = new SessionContext(
      "s",
      [message("alice", "a"), message("carol", "b"), message("bot", "c")],
      null,
      "rep",
      null,
    ).toAnthropicParams("bot");
    expect(params).toEqual({
      system: "<peer_representation>rep</peer_representation>",
      messages: [
        { role: "user", content: "alice: a\ncarol: b" },
        { role: "assistant", content: "c" },
      ],
    });
  });

  it("leaves out blocks that are empty", () => {
    const bare = new SessionContext("s", [message("alice", "hi")], null, null, null);
    expect(bare.length).toBe(1);
    expect(bare.toOpenAI("bot")).toEqual([{ role: "user", name: "alice", content: "hi" }]);
    expect(bare.toAnthropicParams("bot")).toEqual({
      messages: [{ role: "user", content: "alice: hi" }],
    });
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ data: {}, timestamp: "2026-01-01T00:00:00Z", type: "test.event" });
  const sign = (b: string) => createHmac("sha256", secret).update(b).digest("hex");

  it("accepts the server's signature and rejects anything else", async () => {
    expect(await verifyWebhookSignature(body, sign(body), secret)).toBe(true);
    expect(await verifyWebhookSignature(new TextEncoder().encode(body), sign(body), secret)).toBe(
      true,
    );
    expect(await verifyWebhookSignature(body, `sha256=${sign(body).toUpperCase()}`, secret)).toBe(
      true,
    );
    expect(await verifyWebhookSignature(`${body} `, sign(body), secret)).toBe(false);
    expect(await verifyWebhookSignature(body, sign(body), "other")).toBe(false);
    expect(await verifyWebhookSignature(body, "deadbeef", secret)).toBe(false);
    expect(await verifyWebhookSignature(body, null, secret)).toBe(false);
  });

  it("constructs the event, and can enforce a replay window", async () => {
    const event = await constructWebhookEvent(body, sign(body), secret);
    expect(event).toEqual({ data: {}, timestamp: "2026-01-01T00:00:00Z", type: "test.event" });
    await expect(constructWebhookEvent(body, "bad", secret)).rejects.toMatchObject({
      code: "invalid_signature",
    });
    const now = Date.parse("2026-01-01T00:04:00Z");
    await expect(
      constructWebhookEvent(body, sign(body), secret, { toleranceSeconds: 300, now }),
    ).resolves.toMatchObject({ type: "test.event" });
    await expect(
      constructWebhookEvent(body, sign(body), secret, { toleranceSeconds: 60, now }),
    ).rejects.toMatchObject({ code: "stale_event" });
    const junk = "not json";
    await expect(constructWebhookEvent(junk, sign(junk), secret)).rejects.toMatchObject({
      code: "invalid_body",
    });
  });
});
