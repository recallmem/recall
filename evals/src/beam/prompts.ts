import { BEAM_NUGGETS_V1 } from "./protocol.js";
import { snapNugget } from "./scoring.js";

/**
 * Judge prompts of BEAM scoring protocol beam-nuggets-v1 (`--beam-protocol ours`; the default is
 * BEAM's own code, see reference.ts). The protocol follows the paper (section 2.4): rubric nuggets
 * scored 0 / 0.5 / 1, and an equivalence check ("same event or topic") that aligns the events in
 * an answer with the reference events for Kendall tau-b. The wording below is our own, not the
 * paper's listings, so scores are comparable across systems run through this harness and only
 * approximately with published BEAM numbers.
 */
export const BEAM_JUDGE_VERSION = BEAM_NUGGETS_V1;

export const NUGGET_SYSTEM = `You grade an AI assistant's answer against a checklist. The assistant answers questions about a long earlier conversation with a user. Each checklist item is a nugget: one atomic thing a correct answer must contain or do.

Give every nugget exactly one score:
1 = the answer fully satisfies the nugget;
0.5 = it partly satisfies it (the right idea but incomplete, vague, or only partly correct);
0 = it does not satisfy it (missing, wrong, or contradicting it).

Rules:
- Judge each nugget on its own, using only what the answer says. Do not use outside knowledge and do not reward length or confidence.
- The nugget's wording tells you what is required: a fact to state, a point to mention, a behaviour to show. Numbers, names and dates must match; an equivalent wording or an exactly convertible unit is fine.
- If a nugget says the answer should say that the information is not available in the conversation, only an answer that clearly says so satisfies it. An answer that invents a specific answer scores 0 for it.
- If a nugget asks the answer to flag contradictory information or ask for clarification, the answer must do that explicitly.

Reply with one JSON object and nothing else:
{"scores":[<one number per nugget, in order>],"reason":"<one short sentence>"}`;

export function nuggetPrompt(
  question: string,
  reference: string,
  nuggets: readonly string[],
  response: string,
): string {
  return `Question: ${question}

Reference answer (for context; the nuggets are what you score): ${reference.trim() || "(none)"}

Nuggets:
${nuggets.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Assistant's answer:
${response.trim() || "(empty answer)"}

Score all ${nuggets.length} nugget${nuggets.length === 1 ? "" : "s"}.`;
}

/** First balanced JSON object in a reply (models sometimes wrap it in prose or a code fence). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          // not JSON; try the next brace
        }
        break;
      }
    }
  }
  return null;
}

/** Parses the nugget judge's reply; null unless it has exactly `count` valid scores. */
export function parseNuggetScores(
  text: string,
  count: number,
): { scores: number[]; reason: string } | null {
  const obj = extractJsonObject(text);
  const raw = obj?.scores;
  if (!Array.isArray(raw) || raw.length !== count) return null;
  const scores = raw.map(snapNugget);
  if (scores.some((s) => s === null)) return null;
  return {
    scores: scores as number[],
    reason: typeof obj?.reason === "string" ? obj.reason.slice(0, 300) : "",
  };
}

export const ALIGN_SYSTEM = `You compare the order of events in an AI assistant's answer with a reference list of events. The reference events are numbered in their true chronological order.

Step 1. List the distinct events or topics the answer mentions, in the order the answer mentions them. Use short labels in the answer's own wording, one item per event. If the answer numbers or bullets its list, follow that order.
Step 2. For each reference event, give the number of the answer item that denotes the same event or topic (the same thing, not merely a related one), or null if the answer does not mention it. One answer item can match at most one reference event.

Reply with one JSON object and nothing else:
{"items":["<label 1>","<label 2>",...],"matches":[<item number or null for reference event 1>,<for event 2>,...]}
"matches" must have exactly one entry per reference event.`;

export function alignmentPrompt(
  question: string,
  events: readonly string[],
  response: string,
): string {
  return `Question: ${question}

Reference events, in true order:
${events.map((e, i) => `${i + 1}. ${e}`).join("\n")}

Assistant's answer:
${response.trim() || "(empty answer)"}`;
}

/** Parses the aligner's reply; null unless it is well formed for `events` reference events. */
export function parseAlignment(
  text: string,
  events: number,
): { items: string[]; matches: (number | null)[] } | null {
  const obj = extractJsonObject(text);
  if (!obj || !Array.isArray(obj.items) || !Array.isArray(obj.matches)) return null;
  const items = obj.items.map((x) => String(x));
  if (obj.matches.length !== events) return null;
  const matches: (number | null)[] = [];
  for (const m of obj.matches) {
    if (m === null || m === undefined || m === "" || m === "null") {
      matches.push(null);
      continue;
    }
    const n = typeof m === "string" ? Number(m) : m;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > items.length) return null;
    matches.push(n);
  }
  return { items, matches };
}
