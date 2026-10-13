import { honchoListPrice } from "./honcho-pricing.js";
import type { ScoringMode } from "./results.js";
import type { BeamSplit, DatasetName } from "./sources.js";
import type { ReasoningLevel, UnitSource } from "./types.js";

/**
 * Offline cost estimate for a run, printed before spending anything. The rates are what Recall
 * measured on the hosted service's models in the LoCoMo runs of 2026-10-09; they have NOT been
 * measured on BEAM or LongMemEval-S, whose messages are far longer, so treat the estimate as
 * +/-50% until a pilot of a few units confirms it. Re-measure after changing models.
 */
export const DEFAULT_RATES = {
  /** USD per 1M message tokens ingested (LoCoMo: $1.04 to $1.20; reasoning calls dominate). */
  ingestUsdPerMTok: 1.2,
  /** USD per chat query at `low` (LoCoMo: $0.0003 measured; padded for much larger memories). */
  queryUsd: 0.001,
  /** USD per judged answer on openai/gpt-4.1: rubric-v1 pass/fail, and BEAM nuggets / alignment. */
  judgeRubricUsd: 0.001,
  judgeBeamUsd: 0.003,
  /** The "high" scenario multiplies the system cost (not the judge) by this much. */
  highFactor: 1.5,
} as const;

export type Rates = { -readonly [K in keyof typeof DEFAULT_RATES]: number };

/** Characters per o200k_base token, measured on each dataset's text with the server's tokenizer (2026-10-09). */
export const CHARS_PER_TOKEN = {
  longmemeval: 4.817,
  locomo: 4.5,
  beam: { "100k": 4.73, "500k": 4.42, "1m": 4.44, "10m": 4.3 },
} as const;

export const charsPerToken = (dataset: DatasetName, split?: BeamSplit): number =>
  dataset === "beam" ? CHARS_PER_TOKEN.beam[split ?? "100k"] : CHARS_PER_TOKEN[dataset];

export interface Estimate {
  dataset: DatasetName;
  beamSplit?: BeamSplit;
  level: ReasoningLevel;
  scoring: ScoringMode;
  units: number;
  questions: number;
  sessions: number;
  messages: number;
  tokens: number;
  /** Units whose messages are already stored (`--reuse`): no ingest cost. */
  reused: number;
  usd: { ingest: number; query: number; judge: number; system: number; total: number };
  /** system cost x highFactor + judge. */
  highTotal: number;
  honchoListUsd: number;
}

export async function estimateRun(
  plan: readonly UnitSource[],
  ctx: {
    dataset: DatasetName;
    beamSplit?: BeamSplit;
    level: ReasoningLevel;
    scoring: ScoringMode;
    rates?: Partial<Rates>;
    /** Units already ingested (`--reuse`): their tokens are not ingested again. */
    reused?: ReadonlySet<string>;
  },
): Promise<Estimate> {
  const rates: Rates = { ...DEFAULT_RATES, ...ctx.rates };
  let sessions = 0;
  let messages = 0;
  let chars = 0;
  let newChars = 0;
  let questions = 0;
  let reused = 0;
  for (const source of plan) {
    const unit = await source.load();
    const stored = ctx.reused?.has(source.id) ?? false;
    if (stored) reused++;
    questions += unit.questions.length;
    sessions += unit.sessions.length;
    for (const s of unit.sessions) {
      messages += s.messages.length;
      for (const m of s.messages) {
        chars += m.content.length;
        if (!stored) newChars += m.content.length;
      }
    }
  }
  const perToken = charsPerToken(ctx.dataset, ctx.beamSplit);
  const tokens = Math.round(chars / perToken);
  const ingest = (Math.round(newChars / perToken) / 1e6) * rates.ingestUsdPerMTok;
  const query = questions * rates.queryUsd;
  const perAnswer =
    (ctx.scoring === "rubric" || ctx.scoring === "both" ? rates.judgeRubricUsd : 0) +
    (ctx.scoring === "beam" || ctx.scoring === "both" ? rates.judgeBeamUsd : 0);
  const judge = questions * perAnswer;
  const system = ingest + query;
  return {
    dataset: ctx.dataset,
    beamSplit: ctx.beamSplit,
    level: ctx.level,
    scoring: ctx.scoring,
    units: plan.length,
    questions,
    sessions,
    messages,
    tokens,
    reused,
    usd: { ingest, query, judge, system, total: system + judge },
    highTotal: system * rates.highFactor + judge,
    honchoListUsd: honchoListPrice(tokens, questions, ctx.level).totalUsd,
  };
}

const usd = (v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;

export function renderEstimate(e: Estimate): string {
  const name = `${e.dataset}${e.beamSplit ? ` ${e.beamSplit.toUpperCase()}` : ""}`;
  return [
    `Cost estimate (offline, nothing sent): ${name}, level ${e.level}, scoring ${e.scoring}`,
    `  workload   ${e.questions} questions in ${e.units} workspaces; ${e.sessions} sessions, ${e.messages.toLocaleString("en-US")} messages, ~${(e.tokens / 1e6).toFixed(2)}M tokens`,
    `  ingest     ${usd(e.usd.ingest)}${e.reused ? ` (${e.reused} workspace(s) reused, not ingested again)` : ""}   query ${usd(e.usd.query)}   judge ${usd(e.usd.judge)}`,
    `  total      ${usd(e.usd.total)} expected, ${usd(e.highTotal)} if Recall costs 50% more than measured on LoCoMo`,
    `  same workload at Honcho list price: ${usd(e.honchoListUsd)} (excluding judge)`,
    "  Rates come from Recall's LoCoMo runs; run a pilot of a few workspaces before committing to the full cost.",
  ].join("\n");
}
