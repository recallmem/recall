import type { BeamSplit, DatasetName } from "./sources.js";

/** Which judge instructions apply to a question (see rubric.ts). */
export type JudgeKind = "standard" | "temporal" | "update" | "preference" | "abstention";

export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";
export const LEVELS: readonly ReasoningLevel[] = ["minimal", "low", "medium", "high", "max"];

export interface EvalMessage {
  peer: string;
  content: string;
  /** ISO-8601, UTC. The original timestamp of the message, never "now". */
  createdAt: string;
}

export interface EvalSession {
  id: string;
  messages: EvalMessage[];
}

/** What BEAM's own scoring needs for a question (see beam/scoring.ts). */
export interface BeamSpec {
  /** Canonical ability name (same as the question's category). */
  ability: string;
  /** Rubric nuggets: atomic criteria a correct answer satisfies. */
  nuggets: string[];
  /**
   * The dataset's rubric verbatim (`nuggets` are trimmed). BEAM's own scoring (beam-ref) judges
   * these items, and for event ordering they are the reference events; `nuggets` when absent.
   */
  rubric?: string[];
  /** The dataset's ideal answer, shown to the judge for context. */
  reference: string;
  /** Event ordering only: the reference events in their true order. */
  events?: string[];
}

export interface EvalQuestion {
  id: string;
  /** Reporting bucket: the dataset's question type, or "abstention" for unanswerable questions. */
  category: string;
  kind: JudgeKind;
  /** Text sent to the chat endpoint. */
  query: string;
  /** The original question, shown to the judge. */
  question: string;
  /** Reference answer (or, for abstention questions, the reason it is unanswerable). */
  gold: string;
  /** Peer the question is asked through. */
  peer: string;
  /** BEAM only: the rubric for the dataset's own scoring. */
  beam?: BeamSpec;
}

/** Everything that lives in one isolated workspace: a conversation history and its questions. */
export interface EvalUnit {
  id: string;
  dataset: DatasetName;
  peers: { id: string; observeMe: boolean }[];
  sessions: EvalSession[];
  questions: EvalQuestion[];
}

/** A unit that has been selected but not yet read from disk. */
export interface UnitSource {
  id: string;
  questionCount: number;
  load(): Promise<EvalUnit>;
}

export interface SelectOptions {
  /** Maximum number of questions across all units. */
  limit?: number;
  /** Questions to skip after ordering. */
  offset?: number;
  /** Keep only these categories (e.g. "temporal-reasoning", "abstention"). */
  types?: string[];
  /** "stratified" (default): round-robin across categories so small samples cover every type. */
  order?: "stratified" | "file";
  /** Take at most this many (stratified) questions from every unit, so a sample spans all conversations. */
  perUnit?: number;
  /** BEAM only: which conversation length. */
  beamSplit?: BeamSplit;
}

/** Splits text into chunks of at most `max` characters, preferring paragraph breaks. */
export function splitContent(text: string, max = 20_000): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

/**
 * Orders items for `--limit`: filters by category, then (stratified) takes one per
 * category in turn so even a 5-question sample spans the question types. Deterministic,
 * so every target sees exactly the same questions.
 */
export function selectItems<T>(
  items: readonly T[],
  categoryOf: (item: T) => string,
  categoryOrder: readonly string[],
  opts: SelectOptions,
): T[] {
  let pool = opts.types?.length
    ? items.filter((i) => opts.types?.includes(categoryOf(i)))
    : [...items];
  if ((opts.order ?? "stratified") === "stratified") {
    const buckets = new Map<string, T[]>();
    for (const c of categoryOrder) buckets.set(c, []);
    for (const item of pool) {
      const c = categoryOf(item);
      if (!buckets.has(c)) buckets.set(c, []);
      buckets.get(c)?.push(item);
    }
    const lists = [...buckets.values()].filter((l) => l.length > 0);
    const interleaved: T[] = [];
    for (let round = 0; interleaved.length < pool.length; round++) {
      for (const list of lists) if (round < list.length) interleaved.push(list[round] as T);
    }
    pool = interleaved;
  }
  const start = opts.offset ?? 0;
  return pool.slice(start, opts.limit === undefined ? undefined : start + opts.limit);
}
