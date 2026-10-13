/**
 * BEAM's scoring arithmetic (Tavakoli et al. 2025, section 2.4), kept free of any LLM call so it
 * can be tested exactly:
 *
 *  - nugget abilities: every rubric nugget scores 0, 0.5 or 1; a question scores the mean of its
 *    nuggets; an ability scores the mean of its questions;
 *  - event ordering: Kendall tau-b between the reference order of the events and the order in
 *    which the answer mentions them (see `orderingTauB` for how absent and extra events are treated);
 *  - the overall score is the unweighted mean of the ability scores (the paper's "Average" row
 *    is exactly that: e.g. Qwen2.5 vanilla at 100K, ten abilities summing to 2.801, average 0.280).
 *
 * The question-level arithmetic here (orderingTauB, orderingScore) is protocol beam-nuggets-v1's;
 * BEAM's own code (protocol beam-ref-b2da22e) is ported in reference.ts. Both share kendallTauB and
 * the aggregation below.
 */

export const BEAM_ABILITIES = [
  "abstention",
  "contradiction-resolution",
  "event-ordering",
  "information-extraction",
  "instruction-following",
  "knowledge-update",
  "multi-hop-reasoning",
  "preference-following",
  "summarization",
  "temporal-reasoning",
] as const;
export type BeamAbility = (typeof BEAM_ABILITIES)[number];

/** Dataset keys (the `probing_questions` object) -> canonical ability names. */
export const BEAM_ABILITY_KEYS: Record<string, BeamAbility> = {
  abstention: "abstention",
  contradiction_resolution: "contradiction-resolution",
  event_ordering: "event-ordering",
  information_extraction: "information-extraction",
  instruction_following: "instruction-following",
  knowledge_update: "knowledge-update",
  information_update: "knowledge-update",
  // The paper calls it multi-hop reasoning, the dataset key says multi-session.
  multi_session_reasoning: "multi-hop-reasoning",
  multi_hop_reasoning: "multi-hop-reasoning",
  preference_following: "preference-following",
  summarization: "summarization",
  temporal_reasoning: "temporal-reasoning",
};

export const isBeamAbility = (v: string): v is BeamAbility =>
  (BEAM_ABILITIES as readonly string[]).includes(v);

/** A judge's nugget score: exactly one of the paper's three levels (a number or numeric text), else null. */
export function snapNugget(v: unknown): 0 | 0.5 | 1 | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return n === 0 || n === 0.5 || n === 1 ? n : null;
}

export const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** A question's score from its nugget scores: their mean. */
export function nuggetQuestionScore(nuggets: readonly number[]): number | null {
  return mean(nuggets);
}

/**
 * Kendall's tau-b between two equally long rankings (ties allowed):
 * (C - D) / sqrt((n0 - n1)(n0 - n2)), with n0 = n(n-1)/2 and n1, n2 the numbers of tied pairs in
 * x and in y. Computed in SciPy's order of operations (`scipy.stats.kendalltau(variant="b")`:
 * (C - D) / sqrt(n0 - n1) / sqrt(n0 - n2), clipped to [-1, 1]) so the floating-point result is the
 * same. Returns null where SciPy returns NaN: fewer than two items, or a constant ranking.
 */
export function kendallTauB(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length) throw new Error("kendallTauB: rankings differ in length");
  const n = x.length;
  let concordant = 0;
  let discordant = 0;
  let tiedX = 0;
  let tiedY = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign((x[i] as number) - (x[j] as number));
      const dy = Math.sign((y[i] as number) - (y[j] as number));
      if (dx === 0) tiedX++;
      if (dy === 0) tiedY++;
      if (dx !== 0 && dy !== 0) {
        if (dx === dy) concordant++;
        else discordant++;
      }
    }
  }
  const n0 = (n * (n - 1)) / 2;
  if (tiedX === n0 || tiedY === n0) return null;
  const tau = (concordant - discordant) / Math.sqrt(n0 - tiedX) / Math.sqrt(n0 - tiedY);
  return Math.min(1, Math.max(-1, tau));
}

export interface OrderingAlignment {
  /** Number of reference events (their true order is 1..events). */
  events: number;
  /** Number of event items found in the answer, in the order they appear. */
  items: number;
  /** For each reference event: the 1-based position of the answer item that denotes it, or null. */
  matches: readonly (number | null)[];
}

export interface OrderingResult {
  /** Kendall tau-b in [-1, 1]; null when undefined (nothing matched, or fewer than two events). */
  tauB: number | null;
  matched: number;
  absent: number;
  extra: number;
}

/**
 * Event-ordering score. The paper aligns the events of the answer with the reference events using an
 * LLM equivalence check and computes Kendall tau-b "over the aligned sequences", capturing recall and
 * order. It does not spell out how events that are missing or invented are ranked, so this is our
 * explicit choice (documented in the README and the report):
 *
 *  - the universe is the reference events plus the answer's extra items (items that match no event);
 *  - reference ranks: events 1..n in true order, all extras tied after them;
 *  - answer ranks: each item by its position in the answer, all absent events tied after the last item.
 *
 * Ties are exactly what tau-b is built to handle, so an event that is left out stops contributing
 * ordered pairs (recall), and an invented item that precedes a real event counts as a disorder
 * (presence). A perfect answer gives 1, the exact reverse gives -1.
 */
export function orderingTauB(a: OrderingAlignment): OrderingResult {
  const taken = new Set<number>();
  const position: (number | null)[] = a.matches.slice(0, a.events).map((m) => {
    if (m === null || m === undefined || !Number.isInteger(m) || m < 1 || m > a.items) return null;
    if (taken.has(m)) return null; // one answer item denotes at most one event
    taken.add(m);
    return m;
  });
  while (position.length < a.events) position.push(null);

  const refRank: number[] = [];
  const ansRank: number[] = [];
  let absent = 0;
  for (let e = 0; e < a.events; e++) {
    refRank.push(e + 1);
    const p = position[e];
    if (p === null || p === undefined) {
      ansRank.push(a.items + 1);
      absent++;
    } else ansRank.push(p);
  }
  let extra = 0;
  for (let p = 1; p <= a.items; p++) {
    if (taken.has(p)) continue;
    refRank.push(a.events + 1);
    ansRank.push(p);
    extra++;
  }
  return {
    tauB: kendallTauB(refRank, ansRank),
    matched: taken.size,
    absent,
    extra,
  };
}

/** Event-ordering question score: tau-b clipped to [0, 1] (undefined counts as 0). */
export const orderingScore = (r: OrderingResult): number => Math.max(0, r.tauB ?? 0);

// ------------------------------------------------------------ aggregation ----

/** Small, seedable PRNG (mulberry32) so confidence intervals are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] as number;

/** Percentile bootstrap of the mean of `groups` (each group's mean, then the mean of those means). */
function bootstrap(
  groups: readonly (readonly number[])[],
  seed: number,
  iterations: number,
): [number, number] | null {
  const live = groups.filter((g) => g.length > 0);
  // With a single observation per group there is nothing to resample.
  if (!live.some((g) => g.length >= 2)) return null;
  const rand = prng(seed);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let acc = 0;
    for (const g of live) {
      let s = 0;
      for (let k = 0; k < g.length; k++) s += g[Math.floor(rand() * g.length)] as number;
      acc += s / g.length;
    }
    stats.push(acc / live.length);
  }
  stats.sort((x, y) => x - y);
  return [quantile(stats, 0.025), quantile(stats, 0.975)];
}

export interface ScoredQuestion {
  ability: string;
  /** null = no verdict from the judge (excluded and reported separately). */
  score: number | null;
}

export interface AbilityRow {
  ability: string;
  n: number;
  unscored: number;
  mean: number | null;
  ci95: [number, number] | null;
  /** Share of questions with every nugget fully satisfied (score 1). */
  fullCredit: number | null;
}

export interface BeamSummary {
  abilities: AbilityRow[];
  overall: {
    /** Unweighted mean of the ability scores (the paper's "Average"). */
    mean: number | null;
    ci95: [number, number] | null;
    abilitiesCovered: number;
    abilitiesTotal: number;
    questions: number;
    /** Mean over all scored questions, for samples whose abilities are unevenly represented. */
    questionMean: number | null;
  };
}

export function summarizeBeam(
  items: readonly ScoredQuestion[],
  opts: { iterations?: number; seed?: number } = {},
): BeamSummary {
  const iterations = opts.iterations ?? 2000;
  const seed = opts.seed ?? 20251031;
  const known: string[] = [...BEAM_ABILITIES];
  const extra = [...new Set(items.map((i) => i.ability))].filter((a) => !known.includes(a)).sort();
  const rows: AbilityRow[] = [];
  const groups: number[][] = [];
  for (const ability of [...known, ...extra]) {
    const mine = items.filter((i) => i.ability === ability);
    if (mine.length === 0) continue;
    const scores = mine.flatMap((i) => (i.score === null ? [] : [i.score]));
    groups.push(scores);
    rows.push({
      ability,
      n: scores.length,
      unscored: mine.length - scores.length,
      mean: mean(scores),
      ci95: bootstrap([scores], seed ^ hash(ability), iterations),
      fullCredit: scores.length ? scores.filter((s) => s >= 0.999).length / scores.length : null,
    });
  }
  const abilityMeans = rows.flatMap((r) => (r.mean === null ? [] : [r.mean]));
  const all = groups.flat();
  return {
    abilities: rows,
    overall: {
      mean: mean(abilityMeans),
      ci95: bootstrap(groups, seed ^ hash("overall"), iterations),
      abilitiesCovered: abilityMeans.length,
      abilitiesTotal: BEAM_ABILITIES.length,
      questions: all.length,
      questionMean: mean(all),
    },
  };
}
