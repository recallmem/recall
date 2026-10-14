import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { requestKey } from "../billing/index.js";
import type { AppContext } from "../context.js";
import type { WsKey } from "../core/tenancy.js";
import { rows } from "../db/client.js";
import type { AuthState } from "../http/auth.js";
import {
  conflict,
  notFound,
  outOfCreditMessage,
  paymentRequired,
  unauthorized,
  unprocessable,
} from "../lib/errors.js";
import { countTokens, truncateTokens } from "../lib/tokens.js";
import type { LlmMessage, LlmRequest, LlmResult, ToolCall, Usage } from "../llm/types.js";
import { answerCache, type ChatResult } from "./cache.js";
import { EvidenceLog } from "./format.js";
import { Corpus, JargonFilter, rewriteJargon } from "./jargon.js";
import { Instructions, LeakGuard, WITHHELD_ANSWER } from "./leak-guard.js";
import {
  type Allowlist,
  asScopeList,
  assertPeerMemberOf,
  dialecticInstructions,
  getPeer,
  getSession,
  getWorkspace,
  isPeerToken,
  type PeerRef,
  parseSessionAllowlist,
  peerCardEnabled,
  rejectScopePeer,
  requireWorkspaceLevelForScope,
  resolveAllowlist,
  resolveScopePeers,
  SCOPE_PREFIX,
  type SessionRef,
  scopeSessions,
} from "./lookup.js";
import { MarkerFilter, type MarkerOptions, stripJsonMarkers, stripMarkers } from "./markers.js";
import {
  buildPack,
  clip,
  conclusionCond,
  expandSnippets,
  type FactItem,
  messageCond,
  msgLine,
  type Pack,
  packIsEmpty,
  queryVectors,
  RELEVANT_DIST,
  REPLY_BUDGET,
  recordEvidence,
  renderPack,
  type View,
  workspaceWide,
} from "./pack.js";
import {
  type ChatLevel,
  EXAMPLE_TOKENS,
  FINAL_NUDGE,
  type LevelPlan,
  type PlanOverride,
  PRIVATE_TEXTS,
  planFor,
  RULES_TOKENS,
  SYSTEM_PROMPT,
  TOOLS,
  userMessage,
} from "./prompts.js";
import { projectToSchema, toProviderSchema, validateResponseFormat } from "./response-format.js";
import {
  type ConclusionRow,
  type MessageRow,
  MSG_COLS,
  MSG_FROM,
  mapMessage,
  rankScore,
  searchConclusions,
  searchMessages,
} from "./search.js";
import { and, day, normalizeQuery, num, sha, stableStringify } from "./util.js";

type Obj = Record<string, unknown>;

export interface ChatInput {
  workspace: WsKey;
  /** Null for workspace chat. */
  peer: string | null;
  query: string;
  target: string | null;
  sessionId: string | null;
  filters: unknown;
  scope: string | string[] | null;
  level: ChatLevel;
  responseFormat: Obj | null;
  includeEvidence: boolean;
  auth: AuthState;
  /** Identifies the request for billing (e.g. its Idempotency-Key): a retry is charged once. */
  billingKey?: string | null;
  /**
   * "provider/model" that writes the answer instead of the configured chat model, for accounts
   * the operator enabled (benchmarks comparing answer models on the same memory).
   */
  answerModel?: string | null;
  /**
   * Retrieval settings that replace the level's for this question, for the same accounts
   * (experiments with how much memory an answer gets). Part of the cache key.
   */
  planOverride?: PlanOverride | null;
  /**
   * Two models that answer together, for the same accounts (experiments): the analyst works the
   * question out from memory in notes, the writer checks the notes against the same memory and
   * writes the answer. Plain-text answers on the one-call levels only. Part of the cache key.
   */
  team?: { analyst: string; writer: string } | null;
}

export interface Prepared {
  input: ChatInput;
  view: View;
  plan: LevelPlan;
  providerSchema: Obj | null;
}

export type ChatEvent = { type: "delta"; text: string } | { type: "done"; result: ChatResult };

const MISSING_SESSION = "__missing_session__";

/**
 * Validation and resolution, in the order the reference reports errors:
 * scope peers, `scope` rules, peer-token membership, `filters`, `response_format`,
 * then the workspace and path peer. Unlike the reference, chat is a read and never
 * creates anything: an unknown workspace or path peer is a 404. An unknown target is
 * simply someone the observer knows nothing about. Nothing here calls an LLM.
 */
export async function prepareChat(ctx: AppContext, input: ChatInput): Promise<Prepared> {
  const { auth } = input;
  const wide = input.peer == null;

  if (!wide) {
    for (const name of [input.peer, input.target]) {
      if (name?.startsWith(SCOPE_PREFIX)) rejectScopePeer({ name, isScope: true });
    }
  }

  let scopes: string[] | null = null;
  if (input.scope != null) {
    scopes = asScopeList(input.scope);
    if (input.sessionId) throw unprocessable("`scope` and `session_id` are mutually exclusive");
    if (!wide && input.filters != null)
      throw unprocessable("`scope` and `filters` are mutually exclusive");
    requireWorkspaceLevelForScope(auth);
  }

  const ws = await getWorkspace(ctx, input.workspace);
  const filterNames = wide ? null : parseSessionAllowlist(input.filters, input.sessionId);
  if (isPeerToken(auth) && (input.sessionId || filterNames?.length)) {
    if (!ws) throw unauthorized();
    await assertPeerMemberOf(ctx, auth, ws, [
      ...(input.sessionId ? [input.sessionId] : []),
      ...(filterNames ?? []),
    ]);
  }

  if (input.responseFormat) validateResponseFormat(input.responseFormat);
  const providerSchema = input.responseFormat ? toProviderSchema(input.responseFormat) : null;

  if (!ws) throw notFound("Workspace");
  const workspace = ws;

  const session: SessionRef | null = input.sessionId
    ? ((await getSession(ctx, workspace.id, input.sessionId)) ?? {
        id: MISSING_SESSION,
        name: input.sessionId,
        configuration: {},
      })
    : null;

  let allowlist: Allowlist | null = null;
  let observer: PeerRef | null = null;
  let observed: PeerRef | null = null;
  let noMemory = false;
  let scopeName: string | null = null;

  if (scopes) {
    const scopePeers = await resolveScopePeers(ctx, workspace.id, scopes);
    if (wide || typeof input.scope !== "string")
      allowlist = await scopeSessions(ctx, workspace.id, scopePeers);
    else {
      observer = scopePeers[0]!;
      scopeName = scopes[0]!;
    }
  } else if (filterNames) {
    allowlist = await resolveAllowlist(ctx, workspace.id, filterNames);
  }

  let asker: PeerRef | null = null;
  if (!wide) {
    const pathPeer = await getPeer(ctx, workspace.id, input.peer!);
    if (!pathPeer) throw notFound("Peer");
    rejectScopePeer(pathPeer);
    asker = pathPeer;
    observer ??= pathPeer;
    const targetName = input.target ?? pathPeer.name;
    observed =
      targetName === pathPeer.name ? pathPeer : await getPeer(ctx, workspace.id, targetName);
    if (!observed) {
      noMemory = true;
      observed = { id: "", name: targetName, isScope: false, configuration: {} };
    }
    rejectScopePeer(observed);
  }

  const view: View = {
    ws: workspace,
    observer,
    observed,
    asker,
    noMemory,
    allowlist,
    session,
    messageObserver: observer,
    cardsEnabled: peerCardEnabled(session?.configuration, workspace.configuration),
    instructions: dialecticInstructions(session?.configuration, workspace.configuration),
    scopeName,
  };
  // Spend cap (hosted accounts): checked after validation, before any LLM call.
  const block = await ctx.tenancy.budget.blocked(input.workspace.account);
  if (block === "credit") throw paymentRequired(outOfCredit(ctx));
  if (block) throw paymentRequired();
  const plan = { ...planFor(input.level, input.query), ...(input.planOverride ?? {}) };
  return { input, view, plan, providerSchema };
}

// ---------------------------------------------------------------------------
// Cache key: the request plus everything that could change the answer.
// ---------------------------------------------------------------------------

async function memoryVersions(ctx: AppContext, v: View): Promise<string> {
  const ws = v.ws.id;
  const coll = workspaceWide(v)
    ? sql`workspace_id = ${ws} AND observer_id = observed_id`
    : sql`workspace_id = ${ws} AND observer_id = ${v.observer!.id}
          AND (observed_id = ${v.observed!.id} OR observed_id = ${v.observer!.id})`;
  const [[c], [m], [s], [b]] = await Promise.all([
    rows<{ v: string | number; n: string | number }>(
      ctx.db,
      sql`SELECT coalesce(sum(version), 0) AS v, count(*) AS n FROM collections WHERE ${coll}`,
    ),
    rows<{ w: string | number }>(
      ctx.db,
      sql`SELECT coalesce(max(m.seq), 0) AS w FROM messages m WHERE m.workspace_id = ${ws} AND ${and(messageCond(v))}`,
    ),
    v.session
      ? rows<{ e: string | number }>(
          ctx.db,
          sql`SELECT coalesce(max(end_seq), 0) AS e FROM summary_blocks WHERE session_id = ${v.session.id}`,
        )
      : Promise.resolve([{ e: 0 }]),
    // Conversation log notes (summary blocks) are written after the messages they cover.
    rows<{ n: string | number }>(
      ctx.db,
      sql`SELECT count(*) AS n FROM summary_blocks WHERE workspace_id = ${ws} AND kind = 'block'`,
    ),
  ]);
  return `${num(c!.v)}.${num(c!.n)}.${num(m!.w)}.${num((s as { e: number | string }).e)}.${num(b!.n)}`;
}

async function cacheKey(ctx: AppContext, p: Prepared): Promise<string> {
  const { input, view } = p;
  return sha(
    stableStringify({
      ws: view.ws.id,
      observer: view.observer?.id ?? null,
      observed: view.observed?.id ?? view.observed?.name ?? null,
      level: input.level,
      model: input.answerModel ?? ctx.config.models[`chat_${input.level}`],
      plan: input.planOverride ?? null,
      team: input.team ?? null,
      q: normalizeQuery(input.query),
      session: view.session?.id ?? null,
      allow: view.allowlist ? [...view.allowlist.ids].sort() : null,
      format: input.responseFormat,
      evidence: input.includeEvidence,
      instructions: view.instructions,
      cards: view.cardsEnabled,
      today: new Date().toISOString().slice(0, 10),
      versions: await memoryVersions(ctx, view),
    }),
  );
}

// ---------------------------------------------------------------------------
// Running a chat
// ---------------------------------------------------------------------------

const ZERO: ChatResult["usage"] = { calls: 0, inputTokens: 0, outputTokens: 0 };

function chunks(text: string, size = 48): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > i) end = space + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const outOfCredit = (ctx: AppContext) => outOfCreditMessage(ctx.config.server.publicUrl);

/**
 * Ledger key of a chat that carries a billing key (Idempotency-Key, playground nonce): bound to
 * what was asked, so a retry of the same request is charged once, but reusing the key for another
 * question, target or level is a new, charged request.
 */
export function chatBillingKey(workspaceId: string, input: ChatInput): string {
  const asked = JSON.stringify([
    input.peer,
    input.target,
    input.query,
    input.level,
    input.sessionId,
    input.filters ?? null,
    input.scope,
    input.responseFormat,
    input.includeEvidence,
  ]);
  const fingerprint = createHash("sha256").update(asked).digest("base64url").slice(0, 22);
  return `idem:${workspaceId}:${input.billingKey}:${fingerprint}`;
}

/** How many times one billing key may be retried after its earlier attempts produced no answer. */
const BILLING_KEY_ATTEMPTS = 3;

/**
 * Hosted billing: takes the request's price before any model call, so a balance can never be
 * spent twice by concurrent requests, and a request carrying a billing key (a claimed
 * Idempotency-Key, playground nonce) runs at most once per key. Reusing a key that already
 * produced an answer is refused with 409; a key whose earlier attempt failed may be retried.
 * For the API this is the second line of defence: `http/idempotency.ts` replays a retry before
 * it gets here.
 */
async function reserveChat(ctx: AppContext, p: Prepared): Promise<string | null> {
  if (!ctx.billing.enabled) return null;
  const base = p.input.billingKey ? chatBillingKey(p.view.ws.id, p.input) : requestKey();
  const accountId = p.input.workspace.account;
  for (let attempt = 1; attempt <= BILLING_KEY_ATTEMPTS; attempt++) {
    const key = attempt === 1 ? base : `${base}:${attempt}`;
    const r = await ctx.billing.reserveChat({
      accountId,
      workspaceId: p.view.ws.id,
      level: p.input.level,
      key,
    });
    if (r === "free") return null;
    if (r === "applied") return key;
    if (r === "insufficient") {
      ctx.tenancy.budget.invalidate(accountId);
      throw paymentRequired(outOfCredit(ctx));
    }
    if (!(await ctx.billing.chatReleased(accountId, key))) break;
  }
  throw conflict(
    "This Idempotency-Key was already used for an answer. Send a new key to ask again.",
  );
}

/**
 * True when a chat produced no answer worth paying for: nothing came from the model or the
 * cache (empty memory, answered without a model call). Its price is given back, and so is its
 * Idempotency-Key.
 */
export const noAnswer = (r: ChatResult): boolean => r.cache !== "hit" && r.usage.calls === 0;

/**
 * Runs a prepared chat. With hosted billing the price is reserved first; it is given back when
 * no answer comes (a model error, or empty memory answered without a model call). A client that
 * disconnects after the answer started still pays for it (with an Idempotency-Key the route
 * finishes the answer, so a retry gets it).
 */
export async function* runChat(
  ctx: AppContext,
  p: Prepared,
  stream: boolean,
): AsyncGenerator<ChatEvent> {
  const key = await reserveChat(ctx, p);
  const release = (reason: "failed" | "no model call") =>
    key
      ? ctx.billing
          .releaseChat({
            accountId: p.input.workspace.account,
            workspaceId: p.view.ws.id,
            level: p.input.level,
            key,
            reason,
          })
          .catch((err) => ctx.log.error({ err }, "could not return a chat reservation"))
      : Promise.resolve();
  let answered = false;
  try {
    for await (const ev of answer(ctx, p, stream)) {
      if (ev.type === "done") {
        answered = true;
        if (noAnswer(ev.result)) await release("no model call");
      }
      yield ev;
    }
  } catch (err) {
    if (!answered) await release("failed");
    throw err;
  }
}

/**
 * Answers a prepared chat; streams text deltas first when `stream` is set. Answers are cached
 * against memory versions. An answer that took no model call (empty memory) is not: it is free,
 * and a cached copy would be billed as a hit.
 */
async function* answer(ctx: AppContext, p: Prepared, stream: boolean): AsyncGenerator<ChatEvent> {
  const cache = answerCache(ctx);
  const keep = (r: ChatResult) => !!r.content && !noAnswer(r);
  const key = cache.enabled ? await cacheKey(ctx, p) : null;
  const replay = function* (r: ChatResult): Generator<ChatEvent> {
    if (stream && r.content) for (const text of chunks(r.content)) yield { type: "delta", text };
    // A shared answer that took no model call stays free, like the one it shares.
    yield { type: "done", result: { ...r, usage: ZERO, cache: noAnswer(r) ? "miss" : "hit" } };
  };

  if (key) {
    const hit = cache.get(key);
    if (hit) return yield* replay(hit);
    if (!stream) {
      const pending = cache.inflight.get(key);
      if (pending) return yield* replay(await pending);
      const run = (async () => {
        for await (const ev of generate(ctx, p, false)) if (ev.type === "done") return ev.result;
        throw new Error("chat produced no result");
      })();
      cache.inflight.set(key, run);
      try {
        const result = await run;
        if (keep(result)) cache.set(key, result);
        return yield { type: "done", result };
      } finally {
        cache.inflight.delete(key);
      }
    }
  }
  for await (const ev of generate(ctx, p, stream)) {
    if (ev.type === "done" && key && keep(ev.result)) cache.set(key, ev.result);
    yield ev;
  }
}

const clamp01 = (n: number) => Math.min(0.99, Math.max(0.05, Math.round(n * 100) / 100));

/** Support strength in [0, 1]: noisy-or over the facts the answer cites, discounted for inferred or rarely seen facts. */
function confidenceOf(cited: ConclusionRow[], excerpts: number): number {
  if (!cited.length) return excerpts ? 0.55 : 0.3;
  let miss = 1;
  for (const r of cited) {
    const weight =
      (r.level === "explicit" ? 1 : 0.85) * Math.min(1, 0.6 + 0.2 * Math.log2(1 + r.timesDerived));
    miss *= 1 - Math.min(0.97, r.confidence * weight);
  }
  return clamp01(1 - miss);
}

function parseJson(text: string): unknown {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  try {
    return JSON.parse(body.trim());
  } catch {
    const a = body.indexOf("{");
    const b = body.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(body.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Prompt tokens of one call (cached or not). */
const promptTokens = (u: Usage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** What a call counts against the level's caps: the worked example in the instructions is left out. */
const budgeted = (u: Usage) => Math.max(0, promptTokens(u) - EXAMPLE_TOKENS);

class Meter {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** Input counted against `inputCap`. */
  budgetedInput = 0;
  add(r: LlmResult): void {
    const u: Usage = r.usage;
    this.calls++;
    this.inputTokens += promptTokens(u);
    this.budgetedInput += budgeted(u);
    this.outputTokens += u.outputTokens;
  }
}

/** The fixed instructions, as written and with their example markers stripped, for the leak guard. */
const INSTRUCTIONS = new Instructions(PRIVATE_TEXTS.flatMap((t) => [t, stripMarkers(t).text]));

/** How an answer is cleaned for the reader: prose or structured, and what memory the model saw. */
interface Reading {
  prose: boolean;
  corpus: Corpus;
}

/** "(F3)" counts as a marker unless the question or the memory uses that very token ("M1" chip). */
const markerOptions = (corpus: Corpus): MarkerOptions => ({
  parens: (labels) => labels.every((l) => !corpus.has(l)),
});

/**
 * What a streamed answer shows: markers stripped (structured answers too, from their string
 * values), internal jargon rewritten (prose answers), then the leak guard.
 */
class VisibleAnswer {
  private readonly markers: MarkerFilter;
  private readonly jargon: JargonFilter | null;
  private readonly guard = new LeakGuard(INSTRUCTIONS);
  private readonly prose: boolean;
  text = "";

  constructor(reading: Reading) {
    this.prose = reading.prose;
    this.markers = new MarkerFilter(markerOptions(reading.corpus));
    this.jargon = reading.prose ? new JargonFilter(reading.corpus) : null;
  }

  push(chunk: string): string {
    let out = this.markers.push(chunk);
    if (this.jargon && out) out = this.jargon.push(out);
    return this.take(out ? this.guard.push(out) : "");
  }

  /** The held-back rest, or (prose answers) the refusal once the guard tripped. */
  flush(): string {
    let rest = this.markers.flush();
    if (this.jargon) rest = this.jargon.push(rest) + this.jargon.flush();
    const out = this.take(this.guard.push(rest) + this.guard.flush());
    if (!this.withheld || !this.prose) return out;
    return `${out}${this.text ? "\n\n" : ""}${WITHHELD_ANSWER}`;
  }

  get cited(): string[] {
    return this.markers.cited;
  }

  get withheld(): boolean {
    return this.guard.tripped;
  }

  private take(out: string): string {
    this.text += out;
    return out;
  }
}

/** The whole-text form of {@link VisibleAnswer} for a prose answer that is not streamed. */
function cleanProse(raw: string, corpus: Corpus): { text: string; cited: string[] } {
  const { text, cited } = stripMarkers(raw, markerOptions(corpus));
  return { text: rewriteJargon(text, corpus), cited };
}

/**
 * An answer that opens by saying memory does not hold what was asked ("I have no record of Dana
 * having a dog", "I don't know"). That is an abstention even when it goes on to cite what memory
 * does hold about the topic, which models do more often with more to read (the tool levels), so
 * the flag no longer depends on the level.
 */
const NO_RECORD = new RegExp(
  String.raw`^(?:(?:no|sorry|unfortunately)\b[,.!:;]?\s*)?(?:` +
    [
      String.raw`i(?:\s+(?:have|had)|['’]ve(?:\s+got)?)\s+no\s+(?:\w+\s+){0,2}?(?:record|information|info|memory|mention|details?|data|knowledge)`,
      String.raw`i\s+(?:don['’]t|do\s+not|didn['’]t)\s+(?:have|see|find)\s+(?:any\s+|a\s+|the\s+)?(?:\w+\s+)?(?:record|information|info|memory|mention|details?|data)`,
      String.raw`i\s+(?:don['’]t|do\s+not)\s+(?:know|recall|remember)\b`,
      String.raw`i\s+(?:can['’]t|cannot|couldn['’]t)\s+find\s+(?:any\s+|a\s+)?(?:record|information|mention)`,
      String.raw`there(?:\s+(?:is|are|was)|['’]s)\s+no\s+(?:\w+\s+){0,2}?(?:record|mention|information|details?)`,
      String.raw`nothing\s+in\s+(?:my\s+)?memory`,
      String.raw`no\s+(?:record|information|mention)\s+of`,
      String.raw`ik\s+heb\s+geen\s+(?:\w+\s+){0,2}?(?:gegevens|informatie|herinnering)`,
      String.raw`ik\s+weet\s+(?:het\s+)?niet\b`,
    ].join("|") +
    ")",
  "i",
);

/** Does a prose answer abstain? Nothing cited, or it opens by saying memory does not hold it. */
export const abstains = (content: string, cited: string[]): boolean =>
  cited.length === 0 || NO_RECORD.test(content.trim());

/** Fact labels shown to the model, so markers in the answer map back to conclusion ids. */
type Labels = Map<string, ConclusionRow>;

async function* generate(ctx: AppContext, p: Prepared, stream: boolean): AsyncGenerator<ChatEvent> {
  const { input, view, plan } = p;
  const evidence = new EvidenceLog();
  const meter = new Meter();
  const today = new Date().toISOString().slice(0, 10);
  const user = userMessage(input.query, today, input.responseFormat);

  const pack = await buildPack(ctx, view, input.query, plan);
  // Whole replies (questions about what was said back) get room of their own instead of pushing
  // out facts.
  const budget = plan.budget + (pack.replies ? Math.min(REPLY_BUDGET, plan.budget) : 0);
  renderPack(view, pack, Math.max(400, budget - RULES_TOKENS - countTokens(user) - 20), plan);
  recordEvidence(pack, evidence);
  const labels: Labels = new Map([...pack.facts, ...pack.history].map((f) => [f.label, f.hit.row]));
  // What the question and the memory say themselves, so cleaning the answer leaves their words
  // alone (tool results are added as they come in).
  const corpus = new Corpus(input.query, pack.text);
  const reading: Reading = { prose: !input.responseFormat, corpus };

  const settle = (visible: string, cited: string[]): ChatResult => {
    const rowsCited = [...new Set(cited.filter((l) => l.startsWith("F")))]
      .map((l) => labels.get(l))
      .filter((r): r is ConclusionRow => !!r);
    const citations = [...new Set(rowsCited.map((r) => r.id))];
    const content = visible.trim() ? visible.trim() : null;
    const abstained = input.responseFormat ? !pack.relevant : abstains(content ?? "", cited);
    return {
      content,
      evidence: input.includeEvidence ? evidence.build() : null,
      citations: abstained ? [] : citations,
      confidence:
        abstained || !content
          ? 0
          : confidenceOf(rowsCited, cited.some((l) => /^[MS]/.test(l)) ? 1 : 0),
      abstained: abstained || !content,
      usage: {
        calls: meter.calls,
        inputTokens: meter.inputTokens,
        outputTokens: meter.outputTokens,
      },
      cache: "miss",
    };
  };

  /** An answer that reproduced the instructions: the refusal (no JSON body for structured output). */
  const withhold = (): ChatResult => ({
    ...settle(input.responseFormat ? "" : WITHHELD_ANSWER, []),
    abstained: true,
    confidence: 0,
    citations: [],
  });

  /**
   * Turns raw model text into the final result: markers stripped (from every string value of a
   * structured answer too) and reported as citations, jargon rewritten, JSON projected.
   */
  const conclude = (
    raw: string,
    visible?: string,
    cited?: string[],
    withheld = false,
  ): ChatResult => {
    if (withheld || INSTRUCTIONS.reproducedIn(raw)) return withhold();
    if (input.responseFormat) {
      const parsed = parseJson(raw);
      const clean = stripJsonMarkers(
        parsed === undefined ? raw : projectToSchema(parsed, input.responseFormat),
        markerOptions(corpus),
      );
      const body = parsed === undefined ? String(clean.value) : JSON.stringify(clean.value);
      // The facts the values cite; without markers, the best relevant facts the answer drew on.
      const top = pack.facts
        .filter((f) => f.hit.lexical || (f.hit.dist ?? 1) <= RELEVANT_DIST)
        .slice(0, 5)
        .map((f) => f.label);
      const known = clean.cited.some((l) => labels.has(l));
      return settle(body, known ? clean.cited : [...top, ...clean.cited]);
    }
    if (visible !== undefined) return settle(visible, cited ?? []);
    const c = cleanProse(raw, corpus);
    return settle(c.text, c.cited);
  };

  if (packIsEmpty(pack) && !input.responseFormat) {
    const text = "I don't have any information about that in memory yet.";
    if (stream) yield { type: "delta", text };
    return yield { type: "done", result: { ...settle(text, []), abstained: true, confidence: 0 } };
  }

  const req: LlmRequest = {
    task: `chat_${input.level}`,
    ...(input.answerModel ? { model: input.answerModel } : {}),
    system: SYSTEM_PROMPT,
    context: pack.text,
    // The pack is query-specific; caching it only pays off when tool rounds re-send it.
    cacheContext: plan.rounds > 0,
    messages: [{ role: "user", content: user }],
    maxTokens: plan.maxOut,
    effort: plan.effort,
    workspaceId: view.ws.id,
    ...(p.providerSchema ? { jsonSchema: { name: "answer", schema: p.providerSchema } } : {}),
  };

  if (plan.rounds === 0 && input.team && !input.responseFormat) {
    // The analyst thinks on the page, so it gets twice the room; its notes are never shown.
    const notes = await draft(
      ctx,
      {
        ...req,
        model: input.team.analyst,
        maxTokens: plan.maxOut * 2,
        messages: [{ role: "user", content: analystMessage(user) }],
      },
      meter,
    );
    const out = yield* callFinal(
      ctx,
      {
        ...req,
        model: input.team.writer,
        messages: [{ role: "user", content: writerMessage(user, notes) }],
      },
      stream,
      reading,
      meter,
    );
    return yield { type: "done", result: conclude(out.raw, out.visible, out.cited, out.withheld) };
  }

  if (plan.rounds === 0) {
    const out = yield* callFinal(ctx, req, stream, reading, meter);
    return yield { type: "done", result: conclude(out.raw, out.visible, out.cited, out.withheld) };
  }

  // ---- high / max: bounded tool loop -------------------------------------
  const messages: LlmMessage[] = [{ role: "user", content: user }];
  const gathered: string[] = [];
  const shown = {
    facts: new Set([...labels.values()].map((r) => r.id)),
    messages: new Set<string>(),
  };
  let roundsLeft = plan.rounds;
  let lastInput = 0;
  for (;;) {
    const exhausted = roundsLeft <= 0 || meter.budgetedInput + lastInput * 1.4 > plan.inputCap;
    if (exhausted) break;
    const r = await ctx.llm.complete({
      ...req,
      messages,
      tools: TOOLS,
      effort: plan.effort,
    });
    meter.add(r);
    lastInput = budgeted(r.usage);
    // Cut off while thinking, with nothing to show: answer in the final call below instead.
    if (!r.toolCalls.length && cutOffEmpty(r)) break;
    if (!r.toolCalls.length) {
      // The round's text is already the answer: replay it instead of generating it again.
      if (!stream) return yield { type: "done", result: conclude(r.text) };
      const shown = new VisibleAnswer(reading);
      for (const piece of [...chunks(r.text), null]) {
        const out = piece === null ? shown.flush() : shown.push(piece);
        if (out) yield { type: "delta", text: out };
      }
      return yield {
        type: "done",
        result: input.responseFormat
          ? conclude(r.text, undefined, undefined, shown.withheld)
          : conclude(r.text, shown.text, shown.cited, shown.withheld),
      };
    }
    messages.push(r.assistantMessage);
    for (const call of r.toolCalls) {
      const output = await runTool(ctx, p, pack, labels, shown, evidence, call);
      gathered.push(output);
      corpus.add(output);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: output });
    }
    roundsLeft--;
  }

  // Out of rounds or budget: one last call over everything gathered, tools off. What was gathered is
  // trimmed so the whole request still fits under the level's input ceiling.
  const room = Math.max(1000, plan.inputCap - meter.budgetedInput - pack.tokens - 800);
  const research = truncateTokens(gathered.join("\n\n"), room);
  const finalReq: LlmRequest = {
    ...req,
    // Without the tools this call's prefix differs from the rounds' (tools come first), so it
    // cannot read their cached pack, and nothing reads it after this call: cache no more than
    // the instructions.
    cacheContext: false,
    messages: [
      {
        role: "user",
        content: `${user}\n\nAdditional material retrieved while researching (continues the same [F#]/[M#] numbering):\n${research}\n\n${FINAL_NUDGE}`,
      },
    ],
  };
  const out = yield* callFinal(ctx, finalReq, stream, reading, meter);
  return yield { type: "done", result: conclude(out.raw, out.visible, out.cited, out.withheld) };
}

/**
 * A reasoning model can spend its whole output allowance thinking and return no text. Then the
 * answer is asked again once with twice the allowance, rather than returning an empty answer.
 */
const cutOffEmpty = (r: LlmResult) => r.stopReason === "max_tokens" && !r.text.trim();
const retryAllowance = (req: LlmRequest): LlmRequest => ({
  ...req,
  maxTokens: (req.maxTokens ?? 1000) * 2,
});

/** One completed call, asked again once if a reasoning model ran out of room. */
async function draft(ctx: AppContext, req: LlmRequest, meter: Meter): Promise<string> {
  let r = await ctx.llm.complete(req);
  meter.add(r);
  if (cutOffEmpty(r)) {
    r = await ctx.llm.complete(retryAllowance(req));
    meter.add(r);
  }
  return r.text;
}

/** The analyst's task: work the question out from the memory, for the writer, not for the user. */
function analystMessage(user: string): string {
  return `${user}

Do not write the answer for the user yet. Work it out for a colleague who will write it:
1. List every fact and excerpt above that bears on the question, each with its date and marker.
2. Where facts conflict or changed over time, say which one holds for the time the question is about, where that changes the answer.
3. Do any counting, totals, date arithmetic or ordering step by step, and check each item against the exact wording of the question.
4. End with one line that starts "Conclusion:" and gives the answer, or "Conclusion: not in memory" when the memory does not hold it.
Be brief.`;
}

/**
 * The writer's task: answer from the memory with the analyst's work as a second opinion. It works
 * the answer out first and re-checks only where the two differ, so the notes catch its slips
 * without turning a clear answer into a hedged one.
 */
function writerMessage(user: string, notes: string): string {
  return `${user}

A colleague also worked this question out from the memory above:

${notes.trim() || "(no notes)"}

Work out the answer yourself from the memory, then compare it with the colleague's conclusion. Where you agree, that is the answer. Where you differ, look at that point in the memory again (a missed item in a count, a date, which fact is the latest) and go with what the memory supports. Then write the answer, following all the rules for answers and citing with the same markers: lead with the answer itself, and raise a doubt or a conflict only when it changes the answer. Do not mention the colleague or this comparison.`;
}

/** One final answer call: streamed straight through (cleaned on the fly) or completed. */
async function* callFinal(
  ctx: AppContext,
  req: LlmRequest,
  stream: boolean,
  reading: Reading,
  meter: Meter,
): AsyncGenerator<
  ChatEvent,
  { raw: string; visible?: string; cited?: string[]; withheld?: boolean }
> {
  if (!stream) {
    let r = await ctx.llm.complete(req);
    meter.add(r);
    if (cutOffEmpty(r)) {
      r = await ctx.llm.complete(retryAllowance(req));
      meter.add(r);
    }
    return { raw: r.text };
  }
  const shown = new VisibleAnswer(reading);
  let text = "";
  let cutOff = false;
  for await (const ev of ctx.llm.stream(req)) {
    if (ev.type === "text") {
      text += ev.delta;
      const out = shown.push(ev.delta);
      if (out) yield { type: "delta", text: out };
    } else {
      meter.add(ev.result);
      cutOff = !text.trim() && cutOffEmpty(ev.result);
    }
  }
  if (cutOff) {
    // Nothing was streamed, so the retry's answer can still be sent as the whole stream.
    const r = await ctx.llm.complete(retryAllowance(req));
    meter.add(r);
    text = r.text;
    const out = shown.push(r.text);
    if (out) yield { type: "delta", text: out };
  }
  const tail = shown.flush();
  if (tail) yield { type: "delta", text: tail };
  return !reading.prose
    ? { raw: text, withheld: shown.withheld }
    : { raw: text, visible: shown.text, cited: shown.cited, withheld: shown.withheld };
}

// ---------------------------------------------------------------------------
// Tools for high / max
// ---------------------------------------------------------------------------

const TOOL_OUTPUT_TOKENS = 1500;
const clampInt = (v: unknown, def: number, lo: number, hi: number) => {
  const n = typeof v === "number" ? Math.floor(v) : def;
  return Math.min(hi, Math.max(lo, n));
};

function parseDate(v: unknown): Date | null | "invalid" {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

async function runTool(
  ctx: AppContext,
  p: Prepared,
  pack: Pack,
  labels: Labels,
  shown: { facts: Set<string>; messages: Set<string> },
  evidence: EvidenceLog,
  call: ToolCall,
): Promise<string> {
  const { view, plan } = p;
  const args = call.input;
  const wsId = view.ws.id;
  const finish = (text: string) => truncateTokens(text, TOOL_OUTPUT_TOKENS);
  try {
    if (call.name === "search_memory") {
      const query = String(args.query ?? "").trim();
      if (!query) return "Error: query is required.";
      const topK = clampInt(args.top_k, 8, 1, 20);
      const vectors = await queryVectors(ctx, wsId, query, false);
      const peer = workspaceWide(view) && typeof args.peer === "string" ? args.peer : null;
      const hits = await searchConclusions(ctx, {
        workspaceId: wsId,
        query,
        vectors,
        pool: topK * 2,
        cond: and(conclusionCond(view), peer ? sql`obd.name = ${peer}` : undefined),
        state: args.include_superseded === true ? "all" : "current",
      });
      const now = new Date();
      const fresh = hits
        .sort((a, b) => rankScore(b, now) - rankScore(a, now))
        .filter((h) => !shown.facts.has(h.row.id));
      const picked = fresh.slice(0, topK);
      evidence.toolCall("search_memory", args);
      const already = Math.min(hits.length, topK) - Math.min(picked.length, topK);
      const lines = picked.map((hit) => {
        const label = `F${pack.nextF++}`;
        shown.facts.add(hit.row.id);
        labels.set(label, hit.row);
        evidence.conclusion(hit.row);
        const item: FactItem = { label, hit, previous: null };
        return describeFact(item, workspaceWide(view), hit.row.validTo != null);
      });
      if (!lines.length)
        return `No new facts found for "${query}"${already > 0 ? ` (${already} already shown)` : ""}.`;
      return finish(
        `${lines.join("\n")}${already > 0 ? `\n(${already} more already shown above)` : ""}`,
      );
    }

    if (call.name === "search_messages" || call.name === "get_messages_by_date_range") {
      const after = parseDate(args.after_date);
      const before = parseDate(args.before_date);
      if (after === "invalid" || before === "invalid")
        return "Error: after_date/before_date must be ISO 8601 dates.";
      const dateCond = and(
        after && sql`m.created_at >= ${after.toISOString()}::timestamptz`,
        before && sql`m.created_at <= ${before.toISOString()}::timestamptz`,
      );
      evidence.toolCall(call.name, args);
      if (call.name === "search_messages") {
        const query = String(args.query ?? "").trim();
        if (!query) return "Error: query is required.";
        const limit = clampInt(args.limit, 5, 1, 10);
        const vectors = await queryVectors(ctx, wsId, query, false);
        const hits = (
          await searchMessages(ctx, {
            workspaceId: wsId,
            query,
            vectors,
            limit,
            cond: and(messageCond(view), dateCond),
          })
        ).filter((h) => !shown.messages.has(h.row.id));
        const snippets = await expandSnippets(ctx, view, hits, pack.nextM, 1);
        pack.nextM += snippets.length;
        if (!snippets.length) return `No new messages found for "${query}".`;
        return finish(
          snippets
            .map((s) => {
              for (const m of s.messages) {
                shown.messages.add(m.id);
                evidence.message(m);
              }
              return s.messages
                .map((m, i) => `${i === 0 ? `[${s.label}] ` : ""}${msgLine(m, 500)}`)
                .join("\n");
            })
            .join("\n"),
        );
      }
      const limit = clampInt(args.limit, 12, 1, 20);
      const order = args.order === "asc" ? sql`ASC` : sql`DESC`;
      const found = (
        await rows<Obj>(
          ctx.db,
          sql`SELECT ${MSG_COLS} FROM ${MSG_FROM}
              WHERE m.workspace_id = ${wsId} AND ${and(messageCond(view), dateCond)}
              ORDER BY m.created_at ${order}, m.seq ${order} LIMIT ${limit}`,
        )
      ).map(mapMessage);
      if (!found.length) return "No messages in that window.";
      const label = `M${pack.nextM++}`;
      for (const m of found) {
        shown.messages.add(m.id);
        evidence.message(m);
      }
      return finish(
        found
          .map((m: MessageRow, i) => `${i === 0 ? `[${label}] ` : ""}${msgLine(m, 400)}`)
          .join("\n"),
      );
    }
    return `Error: unknown tool "${call.name}".`;
  } catch (err) {
    ctx.log.warn({ err, tool: call.name, plan: plan.rounds }, "chat tool failed");
    return `Error: ${call.name} failed.`;
  }
}

function describeFact(f: FactItem, wide: boolean, past: boolean): string {
  const r = f.hit.row;
  const subject = wide ? `(${r.observedName}) ` : "";
  if (past) return `[${f.label}] ${subject}${r.content} (true until ${day(r.validTo)})`;
  return `[${f.label}] ${day(r.validFrom ?? r.createdAt)} ${subject}${clip(r.content, 400)}${r.level !== "explicit" ? " (inferred)" : ""}`;
}
