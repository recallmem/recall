import type { JudgeKind } from "./types.js";

/**
 * The judging rubric. Fixed and versioned: a result is only comparable with
 * another result that used the same RUBRIC_VERSION, and the version is printed
 * in every report. The wording is our own; it follows the same grading criteria
 * as the LongMemEval paper's judge (equivalence with the reference, per-type
 * allowances, explicit handling of unanswerable questions) but it is NOT the
 * official prompt, so scores here are comparable across targets run through this
 * harness, not with numbers vendors publish from their own judges.
 */
export const RUBRIC_VERSION = "rubric-v1";
/**
 * A generous variant, closer to how published LoCoMo numbers are usually judged
 * (an answer on the right point counts even if a list is incomplete). Reported
 * next to the strict rubric so readers can see how much of a score is leniency.
 */
export const LENIENT_RUBRIC_VERSION = "rubric-lenient-v1";
export type RubricName = "strict" | "lenient";
export const rubricVersion = (r: RubricName) =>
  r === "lenient" ? LENIENT_RUBRIC_VERSION : RUBRIC_VERSION;

export const JUDGE_SYSTEM = `You grade answers produced by an AI assistant that has a long-term memory of a user's conversations. For each item you get the question, the reference answer, and the assistant's response. Decide whether the response is correct, using only the reference answer: do not use outside knowledge and do not reward length or confidence.

Output exactly two lines and nothing else:
VERDICT: yes
REASON: <one short sentence>
(or "VERDICT: no"). Use "yes" only when the response is correct under the rules below.`;

const BASE_RULES = `Rules:
1. The response is correct if it states the information in the reference answer or something equivalent: a paraphrase, an exactly convertible unit, or the same date or number written differently. Extra correct detail is fine.
2. If the reference has several required parts, the response must contain all of them. Missing a part makes it incorrect.
3. The response is incorrect if it contradicts the reference, commits to a different answer, lists alternatives without settling on the right one, or says it does not know or cannot find the information.`;

const KIND_RULES: Record<JudgeKind, string> = {
  standard: BASE_RULES,
  temporal: `${BASE_RULES}
4. This question depends on dates or durations. A count of days, weeks, months or years that is off by exactly one from the reference is still correct. A date is correct if it identifies the same day (or the same week or month, when that is all the reference gives).`,
  update: `${BASE_RULES}
4. The user's situation changed over time and the reference is the latest value. A response that mentions an earlier value as past but gives the reference value as the current one is correct. A response that gives an earlier value as the current one is incorrect.`,
  preference: `The reference answer is not a literal answer. It describes what a good, personalised response should take into account about this user. The response is correct if it uses the user's relevant personal details consistently with the reference; it does not need to cover every point or match the wording. A generic response that ignores the user's details is incorrect.`,
  abstention: `This question cannot be answered from the user's conversations: it asks about something that was never said, or its premise is false. The reference explains why. The response is correct only if it declines to answer, says the information is not available or was not mentioned, or points out the false premise. A response that gives a specific answer as if it were known is incorrect, even if it adds a caveat.`,
};

const LENIENT_RULES = `Rules (grade generously):
1. The response is correct if it conveys the key point of the reference answer, in any wording, even if it is shorter, less detailed, or adds further detail.
2. For answers that are lists, it is correct if it names most of the reference items and nothing that contradicts the reference.
3. For dates and durations, it is correct if it points to the same date or period in any format, including a relative description that resolves to it, or a count off by one.
4. It is incorrect only if it misses the point, contradicts the reference, commits to a different answer, or declines to answer.`;

export function judgePrompt(
  kind: JudgeKind,
  question: string,
  gold: string,
  response: string,
  rubric: RubricName = "strict",
): string {
  const goldLabel =
    kind === "abstention"
      ? "Why it cannot be answered"
      : kind === "preference"
        ? "What a good response takes into account"
        : "Reference answer";
  const rules =
    rubric === "lenient" && (kind === "standard" || kind === "temporal" || kind === "update")
      ? LENIENT_RULES
      : KIND_RULES[kind];
  return `${rules}

Question: ${question}

${goldLabel}: ${gold}

Assistant's response: ${response.trim() || "(empty response)"}`;
}

/** Parses the judge's reply; null when no verdict can be found. */
export function parseVerdict(text: string): { correct: boolean; reason: string } | null {
  const m = text.match(/verdict\s*[:=-]\s*\**\s*(yes|no)\b/i);
  const word = m?.[1] ?? text.trim().match(/^\W*(yes|no)\b/i)?.[1];
  if (!word) return null;
  const reason = text.match(/reason\s*[:=-]\s*(.+)/i)?.[1]?.trim() ?? "";
  return { correct: word.toLowerCase() === "yes", reason: reason.slice(0, 300) };
}

/** Human-readable rubric for reports and docs. */
export function describeRubric(): string {
  return (Object.keys(KIND_RULES) as JudgeKind[])
    .map((k) => `[${k}]\n${KIND_RULES[k]}`)
    .join("\n\n");
}
