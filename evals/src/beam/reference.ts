/*
 * BEAM's reference scoring, ported from the evaluation code of the BEAM repository
 * (https://github.com/mohammadtavakoli78/BEAM, commit b2da22e) so that this harness computes BEAM
 * scores the way BEAM's own code does:
 *
 *  - src/prompts.py: `unified_llm_judge_base_prompt` (BEAM_REF_JUDGE_PROMPT below);
 *  - src/evaluation/compute_metrics.py: `llm_equivalence` (BEAM_REF_EQUIVALENCE_SYSTEM and
 *    refEquivalenceUser below), `align_with_llm`, `event_ordering_score`, `parse_json_response` and
 *    the `evaluate_*` functions;
 *  - src/evaluation/report_results.py: an ability scores the mean of `llm_judge_score` over its
 *    questions, except event ordering, which uses `tau_norm`.
 *
 * The three prompt texts are copied verbatim (whitespace and spelling included); the rest is a
 * TypeScript port. That code carries this license:
 *
 * MIT License
 *
 * Copyright (c) 2025 Mohammad Tavakoli
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { extractJsonObject } from "./prompts.js";
import { kendallTauB } from "./scoring.js";

/**
 * BEAM's per-rubric-item judge prompt (`unified_llm_judge_base_prompt`, src/prompts.py), verbatim.
 * BEAM's code sends it as the only (user) message, at temperature 0 on gpt-4.1-mini.
 */
export const BEAM_REF_JUDGE_PROMPT = `
You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate. 

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT
A compliant response must be **on-topic** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., “$68,000”, “68k”, “68,000 USD”, or “sixty-eight thousand dollars”). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.

## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., “itemized list”, “no citations”, “one sentence”).
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.

## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.
  
- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.
  
- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.

## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).

2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)
   
3. **Check Compliance**: 
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element

4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that
`;

/** The judge prompt for one rubric item, filled in as BEAM's code does (`str.replace`, every occurrence, item first). */
export function refJudgePrompt(rubricItem: string, response: string): string {
  // split/join replaces every occurrence like Python's str.replace, without String.replace's `$` patterns.
  return BEAM_REF_JUDGE_PROMPT.split("<rubric_item>")
    .join(rubricItem)
    .split("<llm_response>")
    .join(response);
}

/** System message of BEAM's `llm_equivalence` (src/evaluation/compute_metrics.py), verbatim. */
export const BEAM_REF_EQUIVALENCE_SYSTEM = `
            You are a binary classifier.
            If the TWO snippets describe the SAME event/fact, reply **YES**
            Otherwise reply **NO**. No extra words.
            DO NOT provide any exaplanation.
        `;

/**
 * User message of BEAM's `llm_equivalence`, verbatim (its f-string): `first` is the reference event,
 * `second` the line of the answer.
 */
export const refEquivalenceUser = (first: string, second: string): string =>
  `First snippet: ${first} \n
                       Second snippet: ${second}
                    `;

/** `llm_equivalence`'s decision: "yes" anywhere in the lowercased reply. */
export const refSaysSame = (reply: string): boolean => reply.toLowerCase().includes("yes");

// ------------------------------------------------------------ judge replies ----

/**
 * `parse_json_response`: the reply's JSON from a ``` fence, the whole text, or else the first
 * `{...}` / `[...]` (non-greedy, as in BEAM's regex). Throws when there is none, like the original.
 */
export function parseJsonResponse(text: string): unknown {
  let response = text.trim();
  if (response.startsWith("```")) {
    const fenced = /```(?:json)?\s*(\[.*\]|\{.*\})\s*```/s.exec(response);
    if (fenced) response = (fenced[1] as string).trim();
  }
  try {
    return JSON.parse(response);
  } catch {
    // fall through to the first {...} or [...]
  }
  const part = /(\{.*?\}|\[.*?\])/s.exec(response);
  if (part) return JSON.parse(part[1] as string);
  throw new Error("No valid JSON found in response.");
}

/**
 * Python's `float()` on a judge's score: numbers, booleans and numeric strings. null where BEAM's code
 * would raise (or would get NaN / infinity, which this harness does not average).
 */
export function pyFloat(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(v))
    return Number(v);
  return null;
}

const scoreOf = (v: unknown): number | null =>
  v && typeof v === "object" && !Array.isArray(v) && "score" in v
    ? pyFloat((v as Record<string, unknown>).score)
    : null;

/** A `"score": <number>` key in object-like text, for replies that are not valid JSON. */
const SCORE_KEY = /\{[\s\S]*?["']score["']\s*:\s*["']?([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/**
 * One per-item judge reply, read as BEAM's `evaluate_*` functions read it: `parse_json_response`,
 * then `float(reply["score"])`. Where BEAM's code falls back to `json_repair` this takes the first
 * balanced JSON object, then a `"score": n` key in object-like text (a truncated or malformed
 * object, which json_repair recovers). null when nothing yields a score: the caller retries once.
 * Any number is kept as given (BEAM's code does not snap scores to 0 / 0.5 / 1).
 */
export function parseRefJudgeReply(text: string): { score: number; reason: string } | null {
  const reply = text.trim();
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(reply);
  } catch {
    parsed = undefined;
  }
  let score = scoreOf(parsed);
  if (score === null) {
    parsed = extractJsonObject(reply);
    score = scoreOf(parsed);
  }
  if (score === null) {
    const m = SCORE_KEY.exec(reply);
    if (m) score = pyFloat(m[1]);
  }
  if (score === null) return null;
  const reason = (parsed as { reason?: unknown } | null | undefined)?.reason;
  return { score, reason: typeof reason === "string" ? reason.slice(0, 500) : "" };
}

/** `llm_judge_score`: the sum of the item scores divided by the number of items (null for none). */
export function refItemsScore(scores: readonly number[]): number | null {
  if (scores.length === 0) return null;
  let sum = 0;
  for (const s of scores) sum += s;
  return sum / scores.length;
}

// ---------------------------------------------------------- event ordering ----

/** Decides whether a reference event and a line of the answer are the same (BEAM: one LLM call). */
export type Equivalence = (reference: string, line: string) => Promise<boolean>;

export interface RefAlignment {
  /** The answer's lines with every matched line replaced by its reference event (`system_out`). */
  systemCanon: string[];
  /** Lines matched to a reference event. */
  matched: number;
  /** Equivalence decisions asked for. */
  calls: number;
  /** Blank lines, which are not sent to the judge (see alignWithEquivalence). */
  blankLines: number;
}

/**
 * `align_with_llm`: each line in turn takes the first still-unused reference event (in reference
 * order) that the judge calls the same, and is replaced by it; a line that matches none stays as it
 * is. Sequential on purpose: which events are still free depends on the earlier answers.
 */
export async function alignWithEquivalence(
  reference: readonly string[],
  lines: readonly string[],
  same: Equivalence,
): Promise<RefAlignment> {
  const used = new Set<number>();
  const systemCanon: string[] = [];
  let calls = 0;
  let blankLines = 0;
  for (const line of lines) {
    let hit: number | null = null;
    // Cost-only shortcut, not in BEAM's code: a blank or whitespace-only line is not sent to the
    // judge and matches nothing (BEAM's code asks the judge about it anyway). It still takes its place
    // in the ranking below, exactly as in BEAM's code.
    if (line.trim() === "") blankLines++;
    else {
      for (let i = 0; i < reference.length; i++) {
        if (used.has(i)) continue;
        calls++;
        if (await same(reference[i] as string, line)) {
          hit = i;
          break;
        }
      }
    }
    if (hit === null) systemCanon.push(line);
    else {
      systemCanon.push(reference[hit] as string);
      used.add(hit);
    }
  }
  return { systemCanon, matched: used.size, calls, blankLines };
}

export interface RefOrderingMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  /** Kendall tau-b of the two rankings; null where SciPy returns NaN (e.g. a constant ranking). */
  tauB: number | null;
  /** (tau-b + 1) / 2, BEAM's reported event-ordering score; null when tau-b is undefined. */
  tauNorm: number | null;
  /** tau_norm x F1 (computed by BEAM's code, not reported by it). */
  finalScore: number | null;
  /** The rankings compared (one entry per distinct event or line). */
  referenceRanks: number[];
  systemRanks: number[];
}

/**
 * The arithmetic of `event_ordering_score` on aligned lists, with Python's semantics: items are
 * compared as strings (so duplicate lines collapse), the union keeps first occurrences in order,
 * an item's rank is its last 1-based position, and an item missing from a list gets the shared tie
 * rank len(union) + 1. Tau-b is SciPy's `kendalltau(variant="b")`.
 */
export function refOrderingMetrics(
  referenceCanon: readonly string[],
  systemCanon: readonly string[],
): RefOrderingMetrics {
  const refSet = new Set(referenceCanon);
  const sysSet = new Set(systemCanon);
  const tp = [...refSet].filter((x) => sysSet.has(x)).length;
  const fp = systemCanon.filter((x) => !refSet.has(x)).length;
  const fn = referenceCanon.filter((x) => !sysSet.has(x)).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  const union = [...new Set([...referenceCanon, ...systemCanon])];
  const tieRank = union.length + 1;
  const toRank = (seq: readonly string[]): number[] => {
    const rank = new Map<string, number>();
    for (const [i, item] of seq.entries()) rank.set(item, i + 1);
    return union.map((u) => rank.get(u) ?? tieRank);
  };
  const referenceRanks = toRank(referenceCanon);
  const systemRanks = toRank(systemCanon);
  const tauB = kendallTauB(referenceRanks, systemRanks);
  const tauNorm = tauB === null ? null : (tauB + 1) / 2;
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    tauB,
    tauNorm,
    finalScore: tauNorm === null ? null : tauNorm * f1,
    referenceRanks,
    systemRanks,
  };
}

export interface RefOrdering extends RefOrderingMetrics {
  /** Lines of the answer (`llm_response.split("\n")`, blank lines included). */
  lines: number;
  blankLines: number;
  /** Lines matched to a reference event. */
  matched: number;
  /** Equivalence calls made. */
  calls: number;
}

/**
 * `evaluate_event_ordering` -> `event_ordering_score(align_type="llm")`: the answer's lines (split at
 * "\n", every line) are aligned to the reference events (the question's rubric) and compared.
 */
export async function refEventOrdering(
  reference: readonly string[],
  response: string,
  same: Equivalence,
): Promise<RefOrdering> {
  const lines = response.split("\n");
  const aligned = await alignWithEquivalence(reference, lines, same);
  return {
    ...refOrderingMetrics(reference, aligned.systemCanon),
    lines: lines.length,
    blankLines: aligned.blankLines,
    matched: aligned.matched,
    calls: aligned.calls,
  };
}

// ---------------------------------------------------------------- question ----

/** A judge's verdict on one rubric item; `score` null = no usable reply (after the retry). */
export interface RefItemVerdict {
  score: number | null;
  reason: string;
}

export interface RefQuestionResult {
  method: "llm-judge" | "tau-norm";
  /** The question's score; null when a rubric item got no usable verdict. */
  score: number | null;
  itemScores: number[] | null;
  itemReasons: string[] | null;
  ordering: RefOrdering | null;
  reason: string;
}

const fmt = (v: number | null) => (v === null ? "undefined" : String(Number(v.toFixed(4))));

/**
 * Scores one answer as BEAM's code does. Event ordering: `tau_norm`, from aligning the answer's
 * lines with the rubric's events (an undefined tau-b, NaN in BEAM's code, scores 0). Every other
 * ability: `llm_judge_score`, one judge call per rubric item, in order.
 */
export async function refScoreQuestion(
  ability: string,
  rubric: readonly string[],
  response: string,
  judge: { item(rubricItem: string): Promise<RefItemVerdict>; same: Equivalence },
): Promise<RefQuestionResult> {
  if (ability === "event-ordering") {
    const o = await refEventOrdering(rubric, response, judge.same);
    const counts = `${o.matched} of ${o.lines} answer lines matched ${o.tp}/${rubric.length} events; precision ${fmt(o.precision)}, recall ${fmt(o.recall)}, F1 ${fmt(o.f1)}`;
    return {
      method: "tau-norm",
      score: o.tauNorm ?? 0,
      itemScores: null,
      itemReasons: null,
      ordering: o,
      reason:
        o.tauNorm === null
          ? `tau-b undefined (NaN in BEAM's code), scored 0; ${counts}`
          : `tau_norm ${fmt(o.tauNorm)} (tau-b ${fmt(o.tauB)}); ${counts}`,
    };
  }
  const scores: number[] = [];
  const reasons: string[] = [];
  const failed: string[] = [];
  for (const [i, item] of rubric.entries()) {
    const v = await judge.item(item);
    reasons.push(v.reason);
    if (v.score === null) failed.push(`item ${i + 1}: ${v.reason}`);
    else scores.push(v.score);
  }
  if (failed.length)
    return {
      method: "llm-judge",
      score: null,
      itemScores: null,
      itemReasons: reasons,
      ordering: null,
      reason: `no usable verdict for ${failed.length} of ${rubric.length} rubric items (${failed.join("; ")})`,
    };
  return {
    method: "llm-judge",
    score: refItemsScore(scores),
    itemScores: scores,
    itemReasons: reasons,
    ordering: null,
    reason: `rubric items ${scores.map(fmt).join(", ")}`,
  };
}
