import type { BeamMethod } from "./beam/protocol.js";
import type { BeamSummary } from "./beam/scoring.js";
import type { UsageReport } from "./client.js";
import type { BeamSplit, DatasetName } from "./sources.js";
import type { JudgeKind } from "./types.js";

/** Which judgement(s) a run records: our pass/fail rubric, BEAM's own scoring, or both. */
export type ScoringMode = "rubric" | "beam" | "both";

/**
 * BEAM's own event-ordering numbers for one answer under beam-ref-b2da22e (`event_ordering_score`).
 * Only `tauNorm` is the score; the rest is kept for transparency.
 */
export interface RefOrderingDetail {
  /** Lines of the answer, blank ones included, and how many of them were blank (not sent to the judge). */
  lines: number;
  blankLines: number;
  equivalenceCalls: number;
  /** (tau-b + 1) / 2; null when tau-b is undefined (NaN in BEAM's code; the question then scores 0). */
  tauNorm: number | null;
  precision: number;
  recall: number;
  f1: number;
  /** tau_norm x F1; null when tau-b is undefined. */
  finalScore: number | null;
}

/** Judge calls, tokens and cost spent on a record's BEAM score (its latest scoring). */
export interface JudgeSpend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** BEAM's own score for one question (see beam/scoring.ts), with enough of the rubric to re-score it. */
export interface BeamRecord {
  ability: string;
  /** Scoring protocol (beam/protocol.ts). Absent in records written before it was stored: beam-nuggets-v1. */
  protocol?: string;
  /**
   * beam-nuggets-v1: nuggets (mean of 0 / 0.5 / 1 per nugget) or tau-b (event ordering).
   * beam-ref-b2da22e: llm-judge (BEAM's llm_judge_score) or tau-norm (event ordering).
   */
  method: BeamMethod;
  /** In [0, 1]. null = the judge gave no usable verdict (excluded from the tables). */
  score: number | null;
  /** Score per nugget (beam-ref: per rubric item, as the judge gave it). */
  nuggetScores: number[] | null;
  /** Event ordering: raw Kendall tau-b in [-1, 1] (null when undefined). */
  tauB: number | null;
  /**
   * Event ordering. beam-nuggets-v1: reference events found in the answer, left out of it, and extra
   * items it listed. beam-ref: answer lines matched to an event, events not matched (BEAM's fn), and
   * lines that matched none (BEAM's fp, blank lines included).
   */
  matched: number | null;
  absent: number | null;
  extra: number | null;
  reason: string;
  nuggets: string[];
  events: string[] | null;
  reference: string;
  /** The dataset's rubric verbatim, stored only where it differs from `nuggets` (which are trimmed). */
  rubric?: string[];
  /** beam-ref: the judge's reason for each rubric item. */
  itemReasons?: string[] | null;
  /** beam-ref event ordering: BEAM's other numbers. */
  refOrdering?: RefOrderingDetail | null;
  /** Judge spend on this BEAM score (also included in the record's judge totals). */
  judge?: JudgeSpend | null;
}

/** One asked question, as written to records.jsonl. */
export interface QuestionRecord {
  unit: string;
  id: string;
  category: string;
  kind: JudgeKind;
  question: string;
  gold: string;
  peer: string;
  answer: string | null;
  /** Recall extensions to the chat response; null on servers that do not send them. */
  abstained: boolean | null;
  confidence: number | null;
  latencyMs: number | null;
  /** Input and output tokens of the answer's model calls, as Recall reports them; null elsewhere. */
  answerTokensIn?: number | null;
  answerTokensOut?: number | null;
  /** Set when the question could not be answered (HTTP error, timeout, failed ingest). Counts as wrong. */
  error: string | null;
  /** null = the judge produced no verdict (excluded from accuracy, reported separately). */
  correct: boolean | null;
  judgeReason: string;
  judgeInputTokens: number;
  judgeOutputTokens: number;
  judgeCostUsd: number | null;
  /** BEAM scoring (runs with --scoring beam|both on the beam dataset). */
  beam?: BeamRecord | null;
}

/** One isolated workspace, as written to units.jsonl. */
export interface UnitRecord {
  unit: string;
  workspace: string;
  dataset: DatasetName;
  sessions: number;
  messages: number;
  /** Server-reported token counts of the ingested messages (estimated when absent). */
  tokens: number;
  tokensEstimated: boolean;
  ingestMs: number;
  drainMs: number;
  drainTimedOut: boolean;
  /** `--reuse`: the workspace already held the messages, so nothing was ingested (tokens are estimated). */
  reused?: boolean;
  /** Metered usage once background processing was idle, and after all questions (Recall only). */
  usageAfterIngest: UsageReport | null;
  usageFinal: UsageReport | null;
  error: string | null;
  cleanedUp: boolean | null;
}

export interface Bucket {
  n: number;
  correct: number;
  accuracy: number | null;
  ci95: [number, number] | null;
  errors: number;
  unjudged: number;
}

export interface HonchoListPriceSummary {
  ingestUsd: number;
  queryUsd: number;
  totalUsd: number;
  per100MessagesUsd: number | null;
  perQueryUsd: number | null;
}

export interface RunSettings {
  harnessVersion: string;
  rubric: string;
  label: string;
  note: string | null;
  startedAt: string;
  finishedAt: string;
  target: { url: string; authenticated: boolean };
  dataset: DatasetName;
  /** BEAM only: the conversation length. */
  beamSplit?: BeamSplit | null;
  /** Default "rubric" (results written before BEAM support have no value). */
  scoring?: ScoringMode;
  /** BEAM scoring protocol (beam/protocol.ts) when BEAM scoring was used: beam-ref-b2da22e or beam-nuggets-v1. */
  beamScoring?: string | null;
  selection: {
    limit: number | null;
    offset: number;
    perUnit?: number | null;
    types: string[] | null;
    order: "stratified" | "file";
    questions: number;
    units: number;
  };
  level: string;
  concurrency: number;
  questionConcurrency: number;
  observeOthers: boolean;
  dream: boolean;
  judge: { kind: "llm" | "lexical-offline"; model: string };
  /** The model asked to write the answers (--answer-model); null: the server's own. */
  answerModel?: string | null;
  /** X-Recall-Plan sent with every question (retrieval experiments), if any. */
  plan?: string | null;
  /** X-Recall-Team: "analyst,writer" models that answered together, if any. */
  team?: string | null;
  costModel: "recall-metered" | "honcho-list-estimate";
  /** provider/model per task, as reported by the server's usage endpoint (Recall only). */
  serverModels: Record<string, string[]> | null;
}

/** What the BEAM section reports next to the scores. */
export interface BeamDetail {
  /** Protocols of the BEAM records; more than one means a mixed run, which the report flags. */
  protocols?: string[];
  /** beam-ref event ordering: BEAM's other numbers, averaged over questions (not part of the score). */
  eventOrdering?: {
    n: number;
    precision: number;
    recall: number;
    f1: number;
    /** tau_norm x F1, with an undefined tau-b counted as 0 (as in the score). */
    finalScore: number;
    undefinedTau: number;
  } | null;
  /** Judge spend on BEAM scoring, over the records that carry it. */
  judge?: JudgeSpend | null;
}

export interface Summary {
  /** BEAM's own scores per ability and overall; present when any record has one. */
  beam?: (BeamSummary & BeamDetail) | null;
  accuracy: {
    overall: Bucket;
    answerable: Bucket;
    abstention: Bucket;
    byCategory: Record<string, Bucket>;
  };
  latencyMs: {
    n: number;
    p50: number | null;
    p95: number | null;
    mean: number | null;
    max: number | null;
  };
  ingest: {
    workspaces: number;
    failedWorkspaces: number;
    sessions: number;
    messages: number;
    tokens: number;
    tokensEstimated: boolean;
    /** Median wall-clock seconds from first message to idle, per 100 messages, over workspaces. */
    secondsPer100MessagesMedian: number | null;
    drainTimeouts: number;
  };
  cost: {
    model: RunSettings["costModel"];
    queries: number;
    ingestUsd: number;
    queryUsd: number;
    totalUsd: number;
    per100MessagesUsd: number | null;
    perQueryUsd: number | null;
    /** Recall only (needs the usage endpoint): background LLM work per 100 ingested messages. */
    llmCallsPer100Messages: number | null;
    inputTokensPer100Messages: number | null;
    chatCallsPerQuery: number | null;
    chatInputTokensPerQuery: number | null;
    unpricedCalls: number;
    /** Workspaces whose usage could not be read; metered cost is then a lower bound. */
    workspacesWithoutUsage: number;
    honchoListPrice: HonchoListPriceSummary;
    judge: { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null };
  };
}

export interface Results {
  schema: 1;
  settings: RunSettings;
  summary: Summary;
  units: UnitRecord[];
  records: QuestionRecord[];
}
