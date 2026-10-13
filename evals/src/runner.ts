import { beamMethod, LEGACY_BEAM_PROTOCOL } from "./beam/protocol.js";
import { type MemoryApi, waitUntilIdle } from "./client.js";
import type { BeamVerdict, Judge } from "./judge.js";
import type { BeamRecord, QuestionRecord, ScoringMode, UnitRecord } from "./results.js";
import type { DatasetName } from "./sources.js";
import type { EvalQuestion, EvalUnit, ReasoningLevel, UnitSource } from "./types.js";
import { mapPool, sleep, slug } from "./util.js";

export interface RunOptions {
  runId: string;
  dataset: DatasetName;
  level: ReasoningLevel;
  /** Workspaces processed at once. */
  concurrency: number;
  /** Questions in flight at once inside one workspace. */
  questionConcurrency: number;
  drainTimeoutMs: number;
  /**
   * A workspace whose background processing has not finished within `drainTimeoutMs` fails
   * instead of being asked on half-built memory; it stays stored, so `--resume` asks it later.
   */
  strictDrain?: boolean;
  chatTimeoutMs: number;
  /** Peers also form views of each other (doubles extraction work on systems that do it per observer). */
  observeOthers: boolean;
  /** Ask the server to consolidate ("dream") before questions, then wait for idle again. */
  dream: boolean;
  /** Delete the workspace afterwards (best effort). Off by default: kept workspaces can be asked again (`reuse`). */
  cleanup: boolean;
  /**
   * Stop starting new workspaces after this many fail in a row (a provider outage or an empty
   * budget fails every one of them); the rest stay undone for `--resume`. Default 3; 0 = never.
   */
  maxConsecutiveFailures?: number;
  /**
   * Stop starting workspaces when the answers go bad mid-run (a provider serving the answer model
   * worse, say): over the last `window` answers, `maxEmptyShare` or more empty, or accuracy
   * `maxAccuracyDrop` or more below the run's first `window` answers. Default 40 / 0.1 / 0.3;
   * `window` 0 turns it off.
   */
  qualityGuard?: QualityGuard;
  /**
   * Reuse workspaces that already hold the unit's messages (from an earlier run with the same
   * `runId` and `--keep`): their ingestion is skipped and only the questions are asked. A workspace
   * that is missing or empty is ingested as usual; one holding only part of the messages fails.
   */
  reuse?: boolean;
  /** With `reuse`: take the workspaces as complete without counting their messages. */
  trustStored?: boolean;
  /** Whether to read per-workspace metered usage. */
  meterUsage: boolean;
  /** "provider/model" that writes the answers on Recall (X-Recall-Answer-Model); default: the server's. */
  answerModel?: string;
  /** JSON retrieval settings for Recall's chat (X-Recall-Plan); operator-enabled accounts only. */
  plan?: string;
  /** "analyst,writer": two models that answer together on Recall (X-Recall-Team); operator-enabled only. */
  team?: string;
  /** Which judgement(s) to record: our pass/fail rubric, BEAM's own scoring (beam dataset only), or both. Default "rubric". */
  scoring?: ScoringMode;
  /** Polling interval and stall window for servers without long-poll support (defaults suit real servers). */
  pollMs?: number;
  stallMs?: number;
  log: (line: string) => void;
}

export interface RunHooks {
  onQuestion?: (record: QuestionRecord) => void;
  onUnit?: (record: UnitRecord) => void;
}

const BATCH = 100;

const idleOpts = (opts: RunOptions) => ({
  timeoutMs: opts.drainTimeoutMs,
  pollMs: opts.pollMs,
  stallMs: opts.stallMs,
});

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Thrown when background work failed for good and a retry did not repair it. */
export class IncompleteMemoryError extends Error {
  constructor(readonly failed: number) {
    super(
      `${failed} background job(s) failed, so the memory is incomplete (provider outage or budget?); questions were not asked`,
    );
    this.name = "IncompleteMemoryError";
  }
}

export function workspaceName(runId: string, unitId: string): string {
  return slug(`ev-${runId}-${unitId}`, 100);
}

/** Ingests one unit's history. Returns message and token totals. */
async function ingest(api: MemoryApi, ws: string, unit: EvalUnit, opts: RunOptions) {
  await api.createWorkspace(ws, {
    eval_run: opts.runId,
    eval_unit: unit.id,
    dataset: unit.dataset,
  });
  for (const p of unit.peers) await api.createPeer(ws, p.id, p.observeMe);
  const members = Object.fromEntries(
    unit.peers.map((p) => [p.id, { observe_me: p.observeMe, observe_others: opts.observeOthers }]),
  );
  let messages = 0;
  let tokens = 0;
  let estimated = false;
  for (const session of unit.sessions) {
    await api.createSession(ws, session.id, members);
    for (let i = 0; i < session.messages.length; i += BATCH) {
      const batch = session.messages.slice(i, i + BATCH);
      const out = await api.addMessages(
        ws,
        session.id,
        batch.map((m) => ({ peer_id: m.peer, content: m.content, created_at: m.createdAt })),
        `${ws}:${session.id}:${i}`,
      );
      messages += batch.length;
      batch.forEach((m, j) => {
        const reported = out?.[j]?.token_count;
        if (typeof reported === "number") tokens += reported;
        else {
          tokens += Math.ceil(m.content.length / 4);
          estimated = true;
        }
      });
    }
  }
  return { messages, tokens, estimated };
}

/**
 * For `reuse`: true when the workspace already holds every message of the unit, false when it
 * holds none. Anything in between cannot be completed safely (a server that ignores
 * Idempotency-Key would store duplicates), so it is an error.
 */
async function alreadyIngested(api: MemoryApi, ws: string, unit: EvalUnit): Promise<boolean> {
  let held = 0;
  let expected = 0;
  for (const s of unit.sessions) {
    held += await api.countMessages(ws, s.id);
    expected += s.messages.length;
  }
  if (held === 0) return false;
  if (held === expected) return true;
  throw new Error(
    `workspace ${ws} holds ${held} of the unit's ${expected} messages; delete it or reuse another run`,
  );
}

/** For `--reuse`: the units whose workspaces (named after `runId`) already hold all their messages. */
export async function storedUnits(
  api: MemoryApi,
  runId: string,
  sources: readonly UnitSource[],
): Promise<Set<string>> {
  const out = new Set<string>();
  await mapPool(sources, 8, async (s) => {
    const unit = await s.load();
    const stored = await alreadyIngested(api, workspaceName(runId, s.id), unit).catch(() => false);
    if (stored) out.add(s.id);
  });
  return out;
}

/** The part of a BEAM record that comes from the question itself, before any judging. */
function beamBase(q: EvalQuestion, protocol: string): BeamRecord | null {
  if (!q.beam) return null;
  const { rubric, nuggets } = q.beam;
  const sameAsNuggets =
    !rubric || (rubric.length === nuggets.length && rubric.every((r, i) => r === nuggets[i]));
  return {
    ability: q.beam.ability,
    protocol,
    method: beamMethod(protocol, q.beam.ability, (q.beam.events?.length ?? 0) >= 2),
    score: null,
    nuggetScores: null,
    tauB: null,
    matched: null,
    absent: null,
    extra: null,
    reason: "",
    nuggets,
    events: q.beam.events ?? null,
    reference: q.beam.reference,
    ...(sameAsNuggets ? {} : { rubric }),
  };
}

/** A question that could not be answered scores 0 on BEAM's scale, like a wrong answer elsewhere. */
export function beamFailed(
  q: EvalQuestion,
  scoring: ScoringMode | undefined,
  protocol: string,
): BeamRecord | null {
  const base = beamBase(q, protocol);
  return base && scoring && scoring !== "rubric"
    ? { ...base, score: 0, reason: "no answer" }
    : null;
}

const sumCost = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

function beamRecord(q: EvalQuestion, v: BeamVerdict): BeamRecord {
  return {
    ...(beamBase(q, v.protocol) as BeamRecord),
    method: v.method,
    score: v.score,
    nuggetScores: v.nuggetScores,
    tauB: v.tauB,
    matched: v.ordering?.matched ?? null,
    absent: v.ordering?.absent ?? null,
    extra: v.ordering?.extra ?? null,
    reason: v.reason,
    ...(v.itemReasons ? { itemReasons: v.itemReasons } : {}),
    ...(v.refOrdering ? { refOrdering: v.refOrdering } : {}),
    judge: {
      calls: v.calls,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      costUsd: v.costUsd,
    },
  };
}

async function ask(
  api: MemoryApi,
  judge: Judge,
  ws: string,
  unit: EvalUnit,
  q: EvalQuestion,
  opts: RunOptions,
): Promise<QuestionRecord> {
  const rec: QuestionRecord = {
    unit: unit.id,
    id: q.id,
    category: q.category,
    kind: q.kind,
    question: q.question,
    gold: q.gold,
    peer: q.peer,
    answer: null,
    abstained: null,
    confidence: null,
    latencyMs: null,
    error: null,
    correct: null,
    judgeReason: "",
    judgeInputTokens: 0,
    judgeOutputTokens: 0,
    judgeCostUsd: 0,
    beam: null,
  };
  const t0 = performance.now();
  try {
    const res = await api.chat(
      ws,
      q.peer,
      q.query,
      opts.level,
      opts.chatTimeoutMs,
      opts.answerModel,
      opts.plan,
      opts.team,
    );
    rec.latencyMs = Math.round(performance.now() - t0);
    rec.answerTokensIn = res?.usage?.tokensIn ?? null;
    rec.answerTokensOut = res?.usage?.tokensOut ?? null;
    rec.answer = typeof res?.content === "string" ? res.content : "";
    rec.abstained = typeof res?.abstained === "boolean" ? res.abstained : null;
    rec.confidence = typeof res?.confidence === "number" ? res.confidence : null;
    if (!rec.answer.trim()) {
      // A failed request, not an answer (e.g. a reasoning model that spent its whole allowance
      // thinking): it counts as wrong, and --resume asks it again.
      rec.error = EMPTY_ANSWER;
      rec.correct = false;
      rec.beam = beamFailed(q, opts.scoring, judge.settings.beamProtocol);
      return rec;
    }
  } catch (e) {
    rec.error = `chat failed: ${errMsg(e)}`;
    rec.correct = false;
    rec.beam = beamFailed(q, opts.scoring, judge.settings.beamProtocol);
    return rec;
  }
  return judgeAnswer(judge, rec, q, opts.scoring);
}

/**
 * Which of a record's judgements are missing (its judge call failed), or, given `beamProtocol`,
 * whose BEAM score was not made with that protocol: what `rejudge` redoes.
 */
export function judgingNeeded(
  rec: QuestionRecord,
  scoring: ScoringMode | undefined,
  beamProtocol?: string,
): { rubric: boolean; beam: boolean } {
  if (rec.error !== null) return { rubric: false, beam: false };
  const beam = rec.beam;
  return {
    rubric: (scoring ?? "rubric") !== "beam" && rec.correct === null,
    beam:
      scoring !== undefined &&
      scoring !== "rubric" &&
      !!beam &&
      (beam.score === null ||
        (beamProtocol !== undefined && (beam.protocol ?? LEGACY_BEAM_PROTOCOL) !== beamProtocol)),
  };
}

/**
 * Judges an answered record in place: the rubric verdict, BEAM's score, or both (`redo` limits it
 * to the parts asked for, keeping the others and their reasons).
 */
export async function judgeAnswer(
  judge: Judge,
  rec: QuestionRecord,
  q: EvalQuestion,
  scoring: ScoringMode | undefined,
  redo: { rubric: boolean; beam: boolean } = { rubric: true, beam: true },
): Promise<QuestionRecord> {
  const wantRubric = redo.rubric && (scoring ?? "rubric") !== "beam";
  const wantBeam =
    redo.beam && scoring !== undefined && scoring !== "rubric" && q.beam !== undefined;
  const response = rec.answer ?? "";
  const [rubric, beam] = await Promise.allSettled([
    wantRubric
      ? judge.judge({ kind: q.kind, question: q.question, gold: q.gold, response })
      : Promise.resolve(null),
    wantBeam && q.beam
      ? judge.beam({ question: q.question, response, spec: q.beam })
      : Promise.resolve(null),
  ]);
  // Earlier reasons stay, except the failures being redone (and, when only BEAM's score is
  // recorded, the earlier BEAM reason that the new one replaces).
  const reasons = (rec.judgeReason ? rec.judgeReason.split(" | ") : []).filter(
    (r) =>
      !(wantRubric && r.startsWith("judge failed: ")) &&
      !(wantBeam && (r.startsWith("beam judge failed: ") || scoring === "beam")),
  );
  if (rubric.status === "fulfilled" && rubric.value) {
    const v = rubric.value;
    rec.correct = v.correct;
    reasons.push(v.reason);
    rec.judgeInputTokens += v.inputTokens;
    rec.judgeOutputTokens += v.outputTokens;
    rec.judgeCostUsd = sumCost(rec.judgeCostUsd, v.costUsd);
  } else if (rubric.status === "rejected") reasons.push(`judge failed: ${errMsg(rubric.reason)}`);
  if (beam.status === "fulfilled" && beam.value && q.beam) {
    rec.beam = beamRecord(q, beam.value);
    rec.judgeInputTokens += beam.value.inputTokens;
    rec.judgeOutputTokens += beam.value.outputTokens;
    rec.judgeCostUsd = sumCost(rec.judgeCostUsd, beam.value.costUsd);
    if (!wantRubric) reasons.push(beam.value.reason);
  } else if (beam.status === "rejected") {
    rec.beam = beamBase(q, judge.settings.beamProtocol);
    reasons.push(`beam judge failed: ${errMsg(beam.reason)}`);
  }
  rec.judgeReason = reasons.filter(Boolean).join(" | ");
  return rec;
}

/** Best-effort removal. Servers that delete asynchronously refuse the workspace until its sessions are gone, so retry briefly. */
async function cleanup(api: MemoryApi, ws: string, unit: EvalUnit): Promise<boolean> {
  for (const s of unit.sessions) await api.deleteSession(ws, s.id).catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api.deleteWorkspace(ws);
      return true;
    } catch {
      await sleep(2000);
    }
  }
  return false;
}

/** Runs one workspace end to end: ingest, drain, ask, judge. Never throws. */
export async function runUnit(
  api: MemoryApi,
  judge: Judge,
  source: UnitSource,
  opts: RunOptions,
  hooks: RunHooks = {},
): Promise<{ unit: UnitRecord; records: QuestionRecord[] }> {
  const ws = workspaceName(opts.runId, source.id);
  const unitRec: UnitRecord = {
    unit: source.id,
    workspace: ws,
    dataset: opts.dataset,
    sessions: 0,
    messages: 0,
    tokens: 0,
    tokensEstimated: false,
    ingestMs: 0,
    drainMs: 0,
    drainTimedOut: false,
    usageAfterIngest: null,
    usageFinal: null,
    error: null,
    cleanedUp: null,
  };
  const records: QuestionRecord[] = [];
  let unit: EvalUnit | null = null;
  /** Set while this attempt is storing messages: a failure then leaves a partial workspace behind. */
  let ingesting = false;
  try {
    unit = await source.load();
    unitRec.sessions = unit.sessions.length;

    if (opts.reuse && (opts.trustStored || (await alreadyIngested(api, ws, unit)))) {
      unitRec.reused = true;
      unitRec.messages = unit.sessions.reduce((n, s) => n + s.messages.length, 0);
      unitRec.tokens = unit.sessions.reduce(
        (n, s) => n + s.messages.reduce((t, m) => t + Math.ceil(m.content.length / 4), 0),
        0,
      );
      unitRec.tokensEstimated = true;
      opts.log(`  ${ws}: reusing the stored messages, ingestion skipped`);
    } else {
      const t0 = Date.now();
      ingesting = true;
      const totals = await ingest(api, ws, unit, opts);
      ingesting = false;
      unitRec.ingestMs = Date.now() - t0;
      unitRec.messages = totals.messages;
      unitRec.tokens = totals.tokens;
      unitRec.tokensEstimated = totals.estimated;
    }

    let idle = await waitUntilIdle(api, ws, idleOpts(opts));
    unitRec.drainMs = idle.waitedMs;
    if (opts.dream && idle.idle) {
      for (const p of unit.peers.filter((x) => x.observeMe)) {
        await api
          .scheduleDream(ws, p.id, p.id)
          .catch((e) => opts.log(`  ${ws}: dream not scheduled: ${errMsg(e)}`));
      }
      idle = await waitUntilIdle(api, ws, idleOpts(opts));
      unitRec.drainMs += idle.waitedMs;
    }
    if (idle.idle && idle.failed > 0) {
      // Work that failed for good leaves holes in the memory. Retry it once; if it fails again
      // (the provider is still down), asking now would only record wrong answers.
      const retried = await api.retryFailed(ws).catch(() => null);
      opts.log(`  ${ws}: ${idle.failed} background job(s) failed; retried ${retried ?? 0}`);
      if (retried) {
        const again = await waitUntilIdle(api, ws, idleOpts(opts));
        unitRec.drainMs += again.waitedMs;
        idle = again;
      }
      if (idle.idle && idle.failed > 0) throw new IncompleteMemoryError(idle.failed);
    }
    unitRec.drainTimedOut = !idle.idle;
    if (!idle.idle && opts.strictDrain)
      throw new Error(
        `background processing not idle after ${opts.drainTimeoutMs / 1000}s (stalled queue or spent budget?); questions were not asked`,
      );
    if (!idle.idle)
      opts.log(
        `  ${ws}: background processing not idle after ${opts.drainTimeoutMs / 1000}s, asking anyway`,
      );
    if (opts.meterUsage) unitRec.usageAfterIngest = await api.usage(ws).catch(() => null);

    const loaded = unit;
    const asked = await mapPool(loaded.questions, opts.questionConcurrency, async (q) => {
      const rec = await ask(api, judge, ws, loaded, q, opts);
      hooks.onQuestion?.(rec);
      return rec;
    });
    records.push(...asked);
    if (opts.meterUsage) unitRec.usageFinal = await api.usage(ws).catch(() => null);
  } catch (e) {
    unitRec.error = errMsg(e);
    opts.log(`  ${ws}: failed: ${unitRec.error}`);
    // Every selected question still counts, as an error, so accuracy denominators stay honest.
    const missing = unit ? unit.questions.filter((q) => !records.some((r) => r.id === q.id)) : [];
    for (const q of missing) {
      const rec: QuestionRecord = {
        unit: source.id,
        id: q.id,
        category: q.category,
        kind: q.kind,
        question: q.question,
        gold: q.gold,
        peer: q.peer,
        answer: null,
        abstained: null,
        confidence: null,
        latencyMs: null,
        error: `workspace failed: ${unitRec.error}`,
        correct: false,
        judgeReason: "",
        judgeInputTokens: 0,
        judgeOutputTokens: 0,
        judgeCostUsd: 0,
        beam: beamFailed(q, opts.scoring, judge.settings.beamProtocol),
      };
      records.push(rec);
      hooks.onQuestion?.(rec);
    }
  }
  // A partly stored workspace cannot be reused, so it goes even when workspaces are kept.
  if (unit && ((opts.cleanup && !opts.reuse) || ingesting))
    unitRec.cleanedUp = await cleanup(api, ws, unit);
  hooks.onUnit?.(unitRec);
  return { unit: unitRec, records };
}

export const EMPTY_ANSWER = "empty answer";

export interface QualityGuard {
  window: number;
  maxEmptyShare: number;
  maxAccuracyDrop: number;
}

const DEFAULT_GUARD: QualityGuard = { window: 40, maxEmptyShare: 0.1, maxAccuracyDrop: 0.3 };

/**
 * Why the answers of a run have gone bad, or null. `answered` holds the records in the order they
 * finished; failed requests other than empty answers are the failure breaker's business.
 */
export function qualityDrop(
  answered: readonly Pick<QuestionRecord, "error" | "correct">[],
  guard: QualityGuard = DEFAULT_GUARD,
): string | null {
  const w = guard.window;
  const seen = answered.filter((r) => r.error === null || r.error === EMPTY_ANSWER);
  if (w <= 0 || seen.length < w) return null;
  const recent = seen.slice(-w);
  const empty = recent.filter((r) => r.error === EMPTY_ANSWER).length;
  if (empty / w >= guard.maxEmptyShare) return `${empty} of the last ${w} answers were empty`;
  if (seen.length < 2 * w) return null;
  const accuracy = (rs: typeof seen) => {
    const judged = rs.filter((r) => r.correct !== null);
    return judged.length ? judged.filter((r) => r.correct).length / judged.length : null;
  };
  const first = accuracy(seen.slice(0, w));
  const last = accuracy(recent);
  if (first !== null && last !== null && first - last >= guard.maxAccuracyDrop)
    return `accuracy fell from ${Math.round(first * 100)}% (first ${w} answers) to ${Math.round(last * 100)}% (last ${w})`;
  return null;
}

/** A unit that produced no usable answer: it failed, or every one of its questions errored. */
export function unitFailed(unit: UnitRecord, records: readonly QuestionRecord[]): boolean {
  return unit.error !== null || (records.length > 0 && records.every((r) => r.error !== null));
}

/**
 * Runs every selected unit with bounded concurrency. After `maxConsecutiveFailures` failed units
 * in a row no new unit starts (`stopped`); the ones not started are simply absent from the result.
 */
export async function runAll(
  api: MemoryApi,
  judge: Judge,
  sources: readonly UnitSource[],
  opts: RunOptions,
  hooks: RunHooks = {},
): Promise<{ units: UnitRecord[]; records: QuestionRecord[]; stopped: boolean }> {
  const limit = opts.maxConsecutiveFailures ?? 3;
  let streak = 0;
  let stopped = false;
  const answered: QuestionRecord[] = [];
  const results = await mapPool(sources, opts.concurrency, async (s) => {
    if (stopped) return null;
    const r = await runUnit(api, judge, s, opts, hooks);
    streak = unitFailed(r.unit, r.records) ? streak + 1 : 0;
    if (limit > 0 && streak >= limit && !stopped) {
      stopped = true;
      opts.log(
        `stopping: ${streak} workspaces failed in a row (last: ${r.unit.error ?? r.records[0]?.error})`,
      );
    }
    answered.push(...r.records);
    const drop = stopped ? null : qualityDrop(answered, opts.qualityGuard);
    if (drop) {
      stopped = true;
      opts.log(
        `stopping: answer quality dropped (${drop}). Check the answer model's provider; --resume asks the failed questions again, a fresh --reuse run asks all of them`,
      );
    }
    return r;
  });
  const done = results.filter((r) => r !== null);
  return { units: done.map((r) => r.unit), records: done.flatMap((r) => r.records), stopped };
}
