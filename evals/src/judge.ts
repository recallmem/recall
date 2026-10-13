import { type Config, LlmClient, loadConfig } from "@recall-memory/server";
import {
  ALIGN_SYSTEM,
  alignmentPrompt,
  NUGGET_SYSTEM,
  nuggetPrompt,
  parseAlignment,
  parseNuggetScores,
} from "./beam/prompts.js";
import {
  BEAM_NUGGETS_V1,
  BEAM_REF,
  type BeamMethod,
  type BeamProtocol,
  DEFAULT_BEAM_PROTOCOL,
} from "./beam/protocol.js";
import {
  BEAM_REF_EQUIVALENCE_SYSTEM,
  type Equivalence,
  parseRefJudgeReply,
  type RefItemVerdict,
  type RefQuestionResult,
  refEquivalenceUser,
  refJudgePrompt,
  refSaysSame,
  refScoreQuestion,
} from "./beam/reference.js";
import {
  nuggetQuestionScore,
  type OrderingResult,
  orderingScore,
  orderingTauB,
} from "./beam/scoring.js";
import type { RefOrderingDetail } from "./results.js";
import {
  JUDGE_SYSTEM,
  judgePrompt,
  parseVerdict,
  RUBRIC_VERSION,
  type RubricName,
  rubricVersion,
} from "./rubric.js";
import type { BeamSpec, JudgeKind } from "./types.js";

export interface JudgeInput {
  kind: JudgeKind;
  question: string;
  gold: string;
  response: string;
}

export interface JudgeVerdict {
  correct: boolean | null; // null = the judge failed to produce a verdict
  reason: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

export interface BeamJudgeInput {
  question: string;
  response: string;
  spec: BeamSpec;
}

/** BEAM's own verdict on one answer (see beam/protocol.ts for the protocols). */
export interface BeamVerdict {
  protocol: BeamProtocol;
  /** In [0, 1] (beam-ref keeps any score the judge gives); null = no usable verdict. */
  score: number | null;
  method: BeamMethod;
  nuggetScores: number[] | null;
  /** beam-ref: the judge's reason per rubric item. */
  itemReasons?: string[] | null;
  tauB: number | null;
  ordering: Pick<OrderingResult, "matched" | "absent" | "extra"> | null;
  /** beam-ref event ordering: BEAM's other numbers. */
  refOrdering?: RefOrderingDetail | null;
  reason: string;
  /** Judge calls made (retries included). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

export interface JudgeSettings {
  kind: "llm" | "lexical-offline";
  /** "provider/model" for an LLM judge. */
  model: string;
  rubric: string;
  /** How `beam()` scores (beam/protocol.ts). */
  beamProtocol: BeamProtocol;
}

export interface JudgeOptions {
  /** BEAM scoring protocol; default beam-ref-b2da22e (BEAM's own code). */
  beamProtocol?: BeamProtocol;
}

export interface Judge {
  readonly settings: JudgeSettings;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
  /** BEAM's nugget / tau-b scoring. */
  beam(input: BeamJudgeInput): Promise<BeamVerdict>;
}

/** Environment passed to the server's LlmClient: provider keys and endpoints only. */
const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "RECALL_COMPAT_BASE_URL",
  "RECALL_COMPAT_API_KEY",
  "RECALL_PRICING_JSON",
];

export function judgeConfig(env: Record<string, string | undefined> = process.env): Config {
  const source: Record<string, string | undefined> = {};
  for (const k of PROVIDER_ENV) source[k] = env[k];
  return loadConfig(source);
}

/** Provider-neutral LLM judge built on the server's own `LlmClient`. */
export class LlmJudge implements Judge {
  readonly settings: JudgeSettings;
  private readonly client: LlmClient;

  constructor(
    model: string,
    config: Config = judgeConfig(),
    private readonly rubric: RubricName = "strict",
    opts: JudgeOptions = {},
  ) {
    this.settings = {
      kind: "llm",
      model,
      rubric: rubricVersion(rubric),
      beamProtocol: opts.beamProtocol ?? DEFAULT_BEAM_PROTOCOL,
    };
    this.client = new LlmClient(config);
    // Fail fast on a bad model reference or a missing API key.
    this.client.resolve({ task: "judge", model });
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | null = 0;
    let reason = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.complete({
        task: "judge",
        model: this.settings.model,
        system: JUDGE_SYSTEM,
        messages: [
          {
            role: "user",
            content: judgePrompt(
              input.kind,
              input.question,
              input.gold,
              input.response,
              this.rubric,
            ),
          },
        ],
        maxTokens: 1024,
        effort: "low",
      });
      inputTokens += res.usage.inputTokens;
      outputTokens += res.usage.outputTokens;
      const callCost = this.client.prices.cost(this.settings.model, res.usage);
      costUsd = costUsd === null || callCost === null ? null : costUsd + callCost;
      const verdict = parseVerdict(res.text);
      if (verdict) {
        return {
          correct: verdict.correct,
          reason: verdict.reason,
          inputTokens,
          outputTokens,
          costUsd,
          latencyMs: Date.now() - started,
        };
      }
      reason = `unparseable judge output: ${res.text.slice(0, 120)}`;
    }
    return {
      correct: null,
      reason,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: Date.now() - started,
    };
  }

  /** One JSON-answering call, retried once when the reply cannot be parsed. */
  private async askJson<T>(
    system: string,
    prompt: string,
    parse: (text: string) => T | null,
  ): Promise<{
    value: T | null;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    lastText: string;
  }> {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | null = 0;
    let lastText = "";
    let calls = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++;
      const res = await this.client.complete({
        task: "judge",
        model: this.settings.model,
        system,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 2048,
        effort: "low",
      });
      inputTokens += res.usage.inputTokens;
      outputTokens += res.usage.outputTokens;
      const callCost = this.client.prices.cost(this.settings.model, res.usage);
      costUsd = costUsd === null || callCost === null ? null : costUsd + callCost;
      lastText = res.text;
      const value = parse(res.text);
      if (value !== null) return { value, calls, inputTokens, outputTokens, costUsd, lastText };
    }
    return { value: null, calls, inputTokens, outputTokens, costUsd, lastText };
  }

  async beam(input: BeamJudgeInput): Promise<BeamVerdict> {
    return this.settings.beamProtocol === BEAM_REF ? this.refBeam(input) : this.nuggetsBeam(input);
  }

  /**
   * beam-ref-b2da22e: BEAM's own evaluation (beam/reference.ts), every call as BEAM's code makes it:
   * the verbatim prompts, temperature 0, no system message for the per-item judge. Calls are made
   * one at a time (event ordering needs the order; it also keeps a question to one call in flight).
   */
  private async refBeam(input: BeamJudgeInput): Promise<BeamVerdict> {
    const started = Date.now();
    const spend = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 as number | null };
    const call = async (prompt: string, system?: string): Promise<string> => {
      const res = await this.client.complete({
        task: "judge",
        model: this.settings.model,
        ...(system !== undefined ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        // BEAM's code sends no cap; its replies are a short JSON object or a YES/NO. A cap is
        // still needed: the client's default (8192) is above what some OpenAI-compatible routes take.
        maxTokens: 1024,
      });
      spend.calls++;
      spend.inputTokens += res.usage.inputTokens;
      spend.outputTokens += res.usage.outputTokens;
      const cost = this.client.prices.cost(this.settings.model, res.usage);
      spend.costUsd = spend.costUsd === null || cost === null ? null : spend.costUsd + cost;
      return res.text;
    };
    const item = async (rubricItem: string): Promise<RefItemVerdict> => {
      let text = "";
      // BEAM's code has no retry (an unreadable reply stops its run); like our other judge calls,
      // ask once more and otherwise leave the question unscored.
      for (let attempt = 0; attempt < 2; attempt++) {
        text = await call(refJudgePrompt(rubricItem, input.response));
        const parsed = parseRefJudgeReply(text);
        if (parsed) return parsed;
      }
      return { score: null, reason: `unparseable judge output: ${text.slice(0, 120)}` };
    };
    const same: Equivalence = async (reference, line) =>
      refSaysSame(await call(refEquivalenceUser(reference, line), BEAM_REF_EQUIVALENCE_SYSTEM));
    const r = await refScoreQuestion(input.spec.ability, refRubric(input.spec), input.response, {
      item,
      same,
    });
    return refVerdict(r, { ...spend, latencyMs: Date.now() - started });
  }

  /** beam-nuggets-v1: our own prompts, one call per question (prompts.ts, scoring.ts). */
  private async nuggetsBeam(input: BeamJudgeInput): Promise<BeamVerdict> {
    const started = Date.now();
    const { spec } = input;
    const events = spec.events ?? [];
    if (events.length >= 2) {
      const r = await this.askJson(
        ALIGN_SYSTEM,
        alignmentPrompt(input.question, events, input.response),
        (t) => parseAlignment(t, events.length),
      );
      const aligned = r.value;
      const ordering = aligned
        ? orderingTauB({
            events: events.length,
            items: aligned.items.length,
            matches: aligned.matches,
          })
        : null;
      return {
        protocol: BEAM_NUGGETS_V1,
        score: ordering ? orderingScore(ordering) : null,
        method: "tau-b",
        nuggetScores: null,
        tauB: ordering?.tauB ?? null,
        ordering: ordering
          ? { matched: ordering.matched, absent: ordering.absent, extra: ordering.extra }
          : null,
        reason: aligned
          ? `${ordering?.matched}/${events.length} events found, ${ordering?.extra} extra`
          : `unparseable aligner output: ${r.lastText.slice(0, 120)}`,
        calls: r.calls,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        latencyMs: Date.now() - started,
      };
    }
    const r = await this.askJson(
      NUGGET_SYSTEM,
      nuggetPrompt(input.question, spec.reference, spec.nuggets, input.response),
      (t) => parseNuggetScores(t, spec.nuggets.length),
    );
    return {
      protocol: BEAM_NUGGETS_V1,
      score: r.value ? nuggetQuestionScore(r.value.scores) : null,
      method: "nuggets",
      nuggetScores: r.value?.scores ?? null,
      tauB: null,
      ordering: null,
      reason: r.value ? r.value.reason : `unparseable judge output: ${r.lastText.slice(0, 120)}`,
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      latencyMs: Date.now() - started,
    };
  }
}

/** What BEAM's code judges for a question: the dataset's rubric verbatim (the trimmed nuggets for older records). */
export const refRubric = (spec: BeamSpec): string[] => spec.rubric ?? spec.nuggets;

/** A beam-ref result as a verdict. */
function refVerdict(
  r: RefQuestionResult,
  spend: Pick<BeamVerdict, "calls" | "inputTokens" | "outputTokens" | "costUsd" | "latencyMs">,
): BeamVerdict {
  const o = r.ordering;
  return {
    protocol: BEAM_REF,
    score: r.score,
    method: r.method,
    nuggetScores: r.itemScores,
    itemReasons: r.itemReasons,
    tauB: o ? o.tauB : null,
    ordering: o ? { matched: o.matched, absent: o.fn, extra: o.fp } : null,
    refOrdering: o
      ? {
          lines: o.lines,
          blankLines: o.blankLines,
          equivalenceCalls: o.calls,
          tauNorm: o.tauNorm,
          precision: o.precision,
          recall: o.recall,
          f1: o.f1,
          finalScore: o.finalScore,
        }
      : null,
    reason: r.reason,
    ...spend,
  };
}

const STOPWORDS = new Set(
  "a an the and or of to in on at for with is are was were be been it its this that as by from his her their my your i you he she they we do did does".split(
    " ",
  ),
);
const ABSTAIN =
  /\b(do(?:es)?n['’]?t (?:know|have|see|recall)|(?:did not|never) (?:mention|say|said|told|share)\w*|not (?:mentioned|available|specified|stated|clear)|no (?:information|record|mention|data)|cannot|can['’]?t (?:find|say|tell)|unknown|unable to)\b/i;

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));

/**
 * Deterministic, offline stand-in used only when no judge model is configured
 * (the smoke test against the mock provider). It checks that most of the reference's
 * content words appear in the response. It is crude on purpose and clearly labelled
 * in every report: scores from it are not accuracy.
 */
export class LexicalJudge implements Judge {
  readonly settings: JudgeSettings;

  constructor(opts: JudgeOptions = {}) {
    this.settings = {
      kind: "lexical-offline",
      model: "none",
      rubric: RUBRIC_VERSION,
      beamProtocol: opts.beamProtocol ?? DEFAULT_BEAM_PROTOCOL,
    };
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    let correct: boolean;
    if (input.kind === "abstention") correct = ABSTAIN.test(input.response);
    else {
      const gold = new Set(words(input.gold));
      const got = new Set(words(input.response));
      let hit = 0;
      for (const w of gold) if (got.has(w)) hit++;
      correct = gold.size > 0 && hit / gold.size >= 0.6;
    }
    return {
      correct,
      reason: "lexical overlap (offline judge)",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    };
  }

  async beam(input: BeamJudgeInput): Promise<BeamVerdict> {
    if (this.settings.beamProtocol !== BEAM_REF) return lexicalBeam(input);
    // BEAM's algorithm with word overlap standing in for the judge's two decisions.
    const r = await refScoreQuestion(input.spec.ability, refRubric(input.spec), input.response, {
      item: async (rubricItem) => ({
        score: lexicalNugget(rubricItem, input.response),
        reason: "lexical overlap (offline judge)",
      }),
      same: async (reference, line) => overlap(stripRubricPrefix(reference), line) >= 0.5,
    });
    return refVerdict(r, { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });
  }
}

const stripRubricPrefix = (item: string) => item.replace(/^LLM response should \w+:\s*/i, "");

/** Offline nugget score: 1 / 0.5 / 0 for most / some / few of its content words in the response. */
function lexicalNugget(nugget: string, response: string): 0 | 0.5 | 1 {
  const o = overlap(stripRubricPrefix(nugget), response);
  return o >= 0.6 ? 1 : o >= 0.3 ? 0.5 : 0;
}

/** Fraction of `a`'s content words that also occur in `b`. */
function overlap(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / wa.size;
}

/** Lexical stand-in for BEAM scoring, used by the offline smoke test and unit tests only. */
function lexicalBeam(input: BeamJudgeInput): BeamVerdict {
  const base: Pick<
    BeamVerdict,
    "protocol" | "reason" | "calls" | "inputTokens" | "outputTokens" | "costUsd" | "latencyMs"
  > = {
    protocol: BEAM_NUGGETS_V1,
    reason: "lexical overlap (offline judge)",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
  };
  const events = input.spec.events ?? [];
  if (events.length >= 2) {
    // Items of the answer: its lines, split further at numbered markers like "1)" or "2.".
    const items = input.response
      .split(/\n|(?<=[.;])\s+(?=\d+[).]\s)|\s(?=\d+\)\s)/)
      .map((l) => l.replace(/^\s*(?:[-*]|\d+[).])\s*/, "").trim())
      .filter(Boolean);
    const matches = events.map((e) => {
      let best = -1;
      let bestScore = 0.4;
      items.forEach((it, i) => {
        const s = overlap(e, it);
        if (s >= bestScore) {
          bestScore = s;
          best = i;
        }
      });
      return best >= 0 ? best + 1 : null;
    });
    const ordering = orderingTauB({ events: events.length, items: items.length, matches });
    return {
      ...base,
      score: orderingScore(ordering),
      method: "tau-b",
      nuggetScores: null,
      tauB: ordering.tauB,
      ordering: { matched: ordering.matched, absent: ordering.absent, extra: ordering.extra },
    };
  }
  const nuggetScores = input.spec.nuggets.map((n) => lexicalNugget(n, input.response));
  return {
    ...base,
    score: nuggetQuestionScore(nuggetScores),
    method: "nuggets",
    nuggetScores,
    tauB: null,
    ordering: null,
  };
}

/** True when a model reference points at the offline mock provider. */
export const isMockModel = (model: string | undefined) =>
  !model || model === "mock" || model.startsWith("mock/");

export function createJudge(
  model: string | undefined,
  env: Record<string, string | undefined> = process.env,
  opts: JudgeOptions = {},
): Judge {
  if (isMockModel(model)) return new LexicalJudge(opts);
  return new LlmJudge(model as string, judgeConfig(env), "strict", opts);
}
