import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { rows } from "../../db/client.js";
import { ApiError, badRequest } from "../../lib/errors.js";
import { LlmError } from "../../llm/types.js";
import { peerContext, representation, searchMessagesApi } from "../../recall/api.js";
import type { ChatResult } from "../../recall/cache.js";
import {
  type ChatEvent,
  type ChatInput,
  noAnswer,
  prepareChat,
  runChat,
} from "../../recall/chat.js";
import { registerOfflineChat } from "../../recall/mock.js";
import type { PlanOverride } from "../../recall/prompts.js";
import { sessionContext, sessionSummaries } from "../../recall/session-context.js";
import type { App } from "../app.js";
import { type AppEnv, type AuthState, guard, limitChat, wsOf } from "../auth.js";
import { beginIdempotent, type IdempotencyClaim, keptHeaders } from "../idempotency.js";
import { parseBody, parseQuery } from "../validate.js";

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const Scope = z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(100)]);
const Level = z.enum(["minimal", "low", "medium", "high", "max"]);
const JsonObject = z.record(z.string(), z.unknown());

const WorkspaceChatBody = z.object({
  query: z.string().min(1).max(10_000),
  session_id: z.string().nullish(),
  stream: z.boolean().default(false),
  reasoning_level: Level.default("low"),
  response_format: JsonObject.nullish(),
  scope: Scope.nullish(),
  include_evidence: z.boolean().default(false),
});

const PeerChatBody = WorkspaceChatBody.extend({
  target: z.string().nullish(),
  filters: JsonObject.nullish(),
});

const SearchBody = z.object({
  query: z.string().min(1).max(10_000),
  filters: JsonObject.nullish(),
  limit: z.number().int().min(1).max(100).default(10),
});
const WorkspaceSearchBody = SearchBody.extend({ scope: z.string().min(1).nullish() });

const RepresentationBody = z.object({
  session_id: z.string().nullish(),
  filters: JsonObject.nullish(),
  scope: Scope.nullish(),
  target: z.string().nullish(),
  search_query: z.string().max(10_000).nullish(),
  search_top_k: z.number().int().min(1).max(100).nullish(),
  search_max_distance: z.number().min(0).max(1).nullish(),
  include_most_frequent: z.boolean().nullish(),
  max_conclusions: z.number().int().min(1).max(100).nullish(),
});

const bool = z.string().transform((v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const optInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max).optional();

const PeerContextQuery = z.object({
  target: z.string().optional(),
  search_query: z.string().max(10_000).optional(),
  search_top_k: optInt(1, 100),
  search_max_distance: z.coerce.number().min(0).max(1).optional(),
  include_most_frequent: bool.optional(),
  max_conclusions: optInt(1, 100),
});

const SessionContextQuery = z.object({
  tokens: z.coerce.number().int().max(100_000).optional(),
  summary: bool.optional(),
  /** Honcho's name for `summary`; `summary` wins when both are sent. */
  include_summary: bool.optional(),
  peer_target: z.string().optional(),
  peer_perspective: z.string().optional(),
  scope: z.string().optional(),
  limit_to_session: bool.optional(),
  search_query: z.string().max(10_000).optional(),
  search_top_k: optInt(1, 100),
  search_max_distance: z.coerce.number().min(0).max(1).optional(),
  include_most_frequent: bool.optional(),
  max_conclusions: optInt(1, 100),
});

// ---------------------------------------------------------------------------
// Chat transport
// ---------------------------------------------------------------------------

/**
 * Provider trouble is the caller's 503, not an internal error; the cause is logged.
 * Shared with the dashboard playground, which runs the same chat path.
 */
export function mapLlmError(err: unknown, ctx: AppContext): unknown {
  if (!(err instanceof LlmError)) return err;
  ctx.log.warn({ err }, "chat failed at the LLM provider");
  if (err.kind === "refusal") return new ApiError(422, "The model declined to answer this request");
  if (err.kind === "invalid_output")
    return new ApiError(502, "The model returned output that could not be used");
  return new ApiError(503, "Upstream language model provider is unavailable");
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** Terminal SSE payload: the spec's `done` (+ `evidence`), plus additive citations/confidence/abstained. */
function terminal(r: ChatResult, evidence: boolean) {
  return {
    done: true,
    ...(evidence ? { evidence: r.evidence } : {}),
    citations: r.citations,
    confidence: r.confidence,
    abstained: r.abstained,
  };
}

const MODEL_NAME = /^[a-z0-9_-]+(\/[A-Za-z0-9._:-]+)+$/;

/**
 * Experiment headers (`X-Recall-Answer-Model`, `X-Recall-Plan`) are for accounts the operator
 * marked (`metadata.answer_model_override`, settable through the admin API alone): they run on our
 * provider keys, so anyone else is refused.
 */
async function requireExperiments(ctx: AppContext, auth: AuthState, header: string) {
  const [row] = await rows<{ ok: boolean | null }>(
    ctx.db,
    sql`SELECT (metadata->>'answer_model_override') = 'true' AS ok FROM accounts WHERE id = ${auth.account}`,
  );
  if (!row?.ok) throw new ApiError(403, `${header} is not enabled for this account`);
}

/** The answer model an `X-Recall-Answer-Model` header asks for. */
async function answerModel(
  ctx: AppContext,
  auth: AuthState,
  header: string | undefined,
): Promise<string | null> {
  if (!header) return null;
  await requireExperiments(ctx, auth, "X-Recall-Answer-Model");
  if (header.length > 200 || !MODEL_NAME.test(header))
    throw badRequest(
      "X-Recall-Answer-Model must be a model name such as openrouter/<vendor>/<model>",
    );
  return header;
}

/** `X-Recall-Team`: "analyst,writer", two models that answer together. */
async function team(
  ctx: AppContext,
  auth: AuthState,
  header: string | undefined,
): Promise<{ analyst: string; writer: string } | null> {
  if (!header) return null;
  await requireExperiments(ctx, auth, "X-Recall-Team");
  const [analyst, writer, ...rest] = header.split(",").map((m) => m.trim());
  if (
    header.length > 400 ||
    !analyst ||
    !writer ||
    rest.length ||
    ![analyst, writer].every((m) => MODEL_NAME.test(m))
  )
    throw badRequest('X-Recall-Team must be "analyst-model,writer-model"');
  return { analyst, writer };
}

const PlanHeader = z
  .object({
    facts: z.number().int().min(1).max(200),
    snippets: z.number().int().min(0).max(100),
    sessionTokens: z.number().int().min(0).max(8000),
    budget: z.number().int().min(500).max(40_000),
    inputCap: z.number().int().min(500).max(80_000),
    maxOut: z.number().int().min(100).max(8000),
    multiQuery: z.boolean(),
    history: z.number().int().min(0).max(50),
    excerptChars: z.number().int().min(100).max(6000),
    contextChars: z.number().int().min(0).max(6000),
    focusContext: z.boolean(),
    sources: z.number().int().min(0).max(40),
    effort: z.enum(["low", "medium", "high"]),
  })
  .partial()
  .strict();

/** `X-Recall-Plan`: JSON retrieval settings that replace the level's for this question. */
async function planOverride(
  ctx: AppContext,
  auth: AuthState,
  header: string | undefined,
): Promise<PlanOverride | null> {
  if (!header) return null;
  await requireExperiments(ctx, auth, "X-Recall-Plan");
  let parsed: unknown;
  try {
    parsed = header.length <= 500 ? JSON.parse(header) : null;
  } catch {
    parsed = null;
  }
  const plan = PlanHeader.safeParse(parsed);
  if (!plan.success) throw badRequest("X-Recall-Plan must be a JSON object of retrieval settings");
  return plan.data;
}

const PEER_CHAT = "POST /v3/workspaces/:workspace_id/peers/:peer_id/chat";
const WORKSPACE_CHAT = "POST /v3/workspaces/:workspace_id/chat";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

/**
 * Answers a chat request. With an `Idempotency-Key` the first answer is kept for a day: a retry
 * of the same request gets it again (`Idempotent-Replayed: true`) without running or charging,
 * and the key with a different request is a 409 (`http/idempotency.ts`). `body` is the parsed
 * request body, part of what makes two requests the same.
 */
async function respond(
  c: Context<AppEnv>,
  ctx: AppContext,
  route: string,
  input: ChatInput,
  body: { stream: boolean } & Record<string, unknown>,
): Promise<Response> {
  const experiment = {
    answerModel: c.req.header("x-recall-answer-model"),
    plan: c.req.header("x-recall-plan"),
    team: c.req.header("x-recall-team"),
  };
  const idem = await beginIdempotent(ctx, {
    auth: input.auth,
    route,
    key: c.req.header("idempotency-key"),
    request: {
      workspace_id: input.workspace.name,
      peer_id: input.peer,
      ...body,
      "x-recall-answer-model": experiment.answerModel,
      "x-recall-plan": experiment.plan,
      "x-recall-team": experiment.team,
    },
  });
  if (idem && "replay" in idem) return idem.replay;
  const claim = idem?.claim ?? null;
  try {
    limitChat(ctx, input.auth);
    const prepared = await prepareChat(ctx, {
      ...input,
      billingKey: claim?.billingKey ?? null,
      answerModel: await answerModel(ctx, input.auth, experiment.answerModel),
      planOverride: await planOverride(ctx, input.auth, experiment.plan),
      team: await team(ctx, input.auth, experiment.team),
    });
    const gen = runChat(ctx, prepared, body.stream);
    if (body.stream) return await streamChat(ctx, gen, input.includeEvidence, claim);
    for await (const ev of gen) {
      if (ev.type !== "done") continue;
      const r = ev.result;
      const res = c.json(
        {
          content: r.content,
          evidence: r.evidence,
          citations: r.citations,
          confidence: r.confidence,
          abstained: r.abstained,
        },
        200,
        {
          "X-Recall-Cache": r.cache,
          "X-Recall-LLM-Calls": String(r.usage.calls),
          "X-Recall-Tokens-In": String(r.usage.inputTokens),
          "X-Recall-Tokens-Out": String(r.usage.outputTokens),
        },
      );
      if (claim && noAnswer(r)) await claim.release();
      else if (claim)
        await claim.complete({
          status: res.status,
          headers: keptHeaders(res.headers),
          body: await res.clone().text(),
        });
      return res;
    }
    throw new Error("chat produced no result");
  } catch (err) {
    await claim?.release();
    throw mapLlmError(err, ctx);
  }
}

/**
 * Sends a chat as server-sent events. The first event is pulled before the 200, so a provider
 * outage is still a clean 503. With an Idempotency-Key the stream is kept as sent and stored once
 * the answer is done. A client that hangs up mid-answer has already paid for it, so with a key
 * the answer is finished without the client and a retry with the same key gets all of it;
 * without a key the answer stops.
 */
async function streamChat(
  ctx: AppContext,
  gen: AsyncGenerator<ChatEvent>,
  evidence: boolean,
  claim: IdempotencyClaim | null,
): Promise<Response> {
  let pending: IteratorResult<ChatEvent> | null = await gen.next();
  const sent: string[] = [];
  let finished = false;
  /** The next frame, or null once the stream is over; settles the claim with the last one. */
  const next = async (): Promise<string | null> => {
    if (finished) return null;
    let step: IteratorResult<ChatEvent>;
    try {
      step = pending ?? (await gen.next());
      pending = null;
    } catch (err) {
      finished = true;
      await claim?.release();
      throw err;
    }
    if (finished) return null;
    if (step.done) {
      finished = true;
      await claim?.release();
      return null;
    }
    const ev = step.value;
    if (ev.type === "delta") {
      const text = frame({ delta: { content: ev.text }, done: false });
      sent.push(text);
      return text;
    }
    finished = true;
    const text = frame(terminal(ev.result, evidence));
    sent.push(text);
    if (claim && noAnswer(ev.result)) await claim.release();
    else if (claim)
      await claim.complete({ status: 200, headers: SSE_HEADERS, body: sent.join("") });
    return text;
  };
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const text = await next();
        if (text !== null) controller.enqueue(enc.encode(text));
        if (finished) controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      if (!claim) {
        void gen.return(undefined);
        return;
      }
      void (async () => {
        try {
          while (!finished) await next();
        } catch (err) {
          ctx.log.warn({ err }, "chat failed after the client disconnected");
        }
      })();
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

export function register(app: App, ctx: AppContext): void {
  registerOfflineChat();
  const base = "/v3/workspaces/:workspace_id";

  // ---- chat ---------------------------------------------------------------
  app.post(`${base}/peers/:peer_id/chat`, guard(ctx), async (c) => {
    const b = await parseBody(c, PeerChatBody);
    return respond(
      c,
      ctx,
      PEER_CHAT,
      {
        workspace: wsOf(c),
        peer: c.req.param("peer_id")!,
        query: b.query,
        target: b.target ?? null,
        sessionId: b.session_id ?? null,
        filters: b.filters ?? null,
        scope: b.scope ?? null,
        level: b.reasoning_level,
        responseFormat: b.response_format ?? null,
        includeEvidence: b.include_evidence,
        auth: c.get("auth"),
      },
      b,
    );
  });

  app.post(`${base}/chat`, guard(ctx), async (c) => {
    const b = await parseBody(c, WorkspaceChatBody);
    return respond(
      c,
      ctx,
      WORKSPACE_CHAT,
      {
        workspace: wsOf(c),
        peer: null,
        query: b.query,
        target: null,
        sessionId: b.session_id ?? null,
        filters: null,
        scope: b.scope ?? null,
        level: b.reasoning_level,
        responseFormat: b.response_format ?? null,
        includeEvidence: b.include_evidence,
        auth: c.get("auth"),
      },
      b,
    );
  });

  // ---- search -------------------------------------------------------------
  app.post(`${base}/search`, guard(ctx), async (c) => {
    const b = await parseBody(c, WorkspaceSearchBody);
    return c.json(
      await searchMessagesApi(ctx, {
        workspace: wsOf(c),
        query: b.query,
        filters: b.filters,
        limit: b.limit,
        scope: b.scope,
      }),
    );
  });

  app.post(`${base}/peers/:peer_id/search`, guard(ctx), async (c) => {
    const b = await parseBody(c, SearchBody);
    return c.json(
      await searchMessagesApi(ctx, {
        workspace: wsOf(c),
        query: b.query,
        filters: b.filters,
        limit: b.limit,
        peer: c.req.param("peer_id")!,
      }),
    );
  });

  app.post(`${base}/sessions/:session_id/search`, guard(ctx, { memberRead: true }), async (c) => {
    const b = await parseBody(c, SearchBody);
    return c.json(
      await searchMessagesApi(ctx, {
        workspace: wsOf(c),
        query: b.query,
        filters: b.filters,
        limit: b.limit,
        session: c.req.param("session_id")!,
      }),
    );
  });

  // ---- representation and peer context ------------------------------------
  app.post(`${base}/peers/:peer_id/representation`, guard(ctx), async (c) => {
    const b = await parseBody(c, RepresentationBody);
    const text = await representation(ctx, {
      workspace: wsOf(c),
      peer: c.req.param("peer_id")!,
      auth: c.get("auth"),
      sessionId: b.session_id,
      filters: b.filters,
      scope: b.scope,
      target: b.target,
      searchQuery: b.search_query,
      searchTopK: b.search_top_k,
      searchMaxDistance: b.search_max_distance,
      includeMostFrequent: b.include_most_frequent ?? false,
      // absent -> 25; an explicit null -> the server default of 100
      maxConclusions: b.max_conclusions === undefined ? 25 : (b.max_conclusions ?? 100),
    });
    return c.json({ representation: text });
  });

  app.get(`${base}/peers/:peer_id/context`, guard(ctx), async (c) => {
    const q = parseQuery(c, PeerContextQuery);
    return c.json(
      await peerContext(ctx, {
        workspace: wsOf(c),
        peer: c.req.param("peer_id")!,
        target: q.target ?? null,
        searchQuery: q.search_query ?? null,
        searchTopK: q.search_top_k ?? null,
        searchMaxDistance: q.search_max_distance ?? null,
        includeMostFrequent: q.include_most_frequent ?? true,
        maxConclusions: q.max_conclusions ?? 100,
      }),
    );
  });

  // ---- session context and summaries --------------------------------------
  app.get(`${base}/sessions/:session_id/context`, guard(ctx, { memberRead: true }), async (c) => {
    const q = parseQuery(c, SessionContextQuery);
    const sessions = c.req.queries("sessions");
    return c.json(
      await sessionContext(ctx, {
        workspace: wsOf(c),
        session: c.req.param("session_id")!,
        tokens: q.tokens ?? null,
        summary: q.summary ?? q.include_summary ?? true,
        peerTarget: q.peer_target ?? null,
        peerPerspective: q.peer_perspective ?? null,
        scope: q.scope ?? null,
        sessions: sessions?.length ? sessions : null,
        limitToSession: q.limit_to_session ?? false,
        searchQuery: q.search_query ?? null,
        searchTopK: q.search_top_k ?? null,
        searchMaxDistance: q.search_max_distance ?? null,
        includeMostFrequent: q.include_most_frequent ?? false,
        maxConclusions: q.max_conclusions ?? 100,
        auth: c.get("auth"),
      }),
    );
  });

  app.get(`${base}/sessions/:session_id/summaries`, guard(ctx, { memberRead: true }), async (c) =>
    c.json(await sessionSummaries(ctx, wsOf(c), c.req.param("session_id")!)),
  );
}
