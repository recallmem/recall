import { type ChatLevel, LEVELS, type LevelPlan } from "./prompts.js";
import { type TimeWindow, timeWindow } from "./time-window.js";

/**
 * The shape of a question, read in code (no model call), which decides how the pack is built:
 *
 * - `lookup`: one fact or a few; the default.
 * - `ordering`: in what order things happened; facts and excerpts oldest first, the conversation
 *   log, and replaced facts as evidence of what came before.
 * - `counting`: how many, in total, every; retrieval goes wider, since the items are spread
 *   over many conversations.
 * - `summary`: an overview or how something developed; oldest first, with the conversation log.
 *
 * Any shape can come with a time window ("last week", "in May"): what memory has from that time
 * is pulled in on top of what matches the question's words and meaning.
 */
export type QuestionKind = "lookup" | "ordering" | "counting" | "summary";

export interface QuestionShape {
  kind: QuestionKind;
  window: TimeWindow | null;
  /** Replaced facts are evidence, not noise. */
  historical: boolean;
  /** Facts and excerpts are listed oldest first, with the conversation log. */
  chronological: boolean;
}

const ORDERING =
  /\b(order(?!\s+to\b)|ordered|sequence|chronolog\w*|timeline|step by step|walk me through|brought up|came up|volgorde|tijdlijn|chronologisch|achtereenvolgens)\b/i;
/** "Which did I do first, X or Y?", "what came before the move": a question about order. */
const WHICH_FIRST =
  /\b(?:which|welke?)\b[^?]{0,80}?\b(?:first|earlier|later|eerst|eerder)\b|\b(?:came|happened|occurred|kwam|gebeurde)\s+(?:first|earlier|later|before|after|eerst|eerder|voor|na)\b/i;
const OVERVIEW =
  /\b(summar\w*|overview|recap|so far|over time|throughout|progress(ed|ion)?|evolv\w*|developed|journey|history of|samenvat\w*|overzicht|tot nu toe|verloop|ontwikkeld)\b/i;
const AGGREGATE =
  /\b(how many|how much|in total|totals?|altogether|combined|all (?:the|my|of my)|every|list (?:all|every)|hoeveel|in totaal|bij elkaar|alle)\b/i;
const HISTORICAL =
  /\b(used to|previous(?:ly)?|prior|formerly|former|before|earlier|originally|initially|at first|in the past|back then|no longer|anymore|any more|changed?|switched?|moved from|replaced?|history|how has|ever|old(?:er)?|first|vroeger|eerder|voorheen|vorige?|oorspronkelijk|eerst|veranderd|gewisseld|niet meer|ooit|toen|oude?)\b/i;

/** Does the question ask in what order things happened or came up? */
export const isOrdering = (q: string): boolean => ORDERING.test(q) || WHICH_FIRST.test(q);
/** Does the question ask for an overview, a summary or how something developed? */
export const isOverview = (q: string): boolean => isOrdering(q) || OVERVIEW.test(q);
/** Does the question count or add up items that may be spread over many conversations? */
export const isAggregate = (q: string): boolean => AGGREGATE.test(q);
/** Does the question reach into the past, where superseded facts are evidence rather than noise? */
export const isHistorical = (q: string): boolean => HISTORICAL.test(q);

export function shapeOf(query: string, now: Date = new Date()): QuestionShape {
  const window = timeWindow(query, now);
  const kind: QuestionKind = isOrdering(query)
    ? "ordering"
    : OVERVIEW.test(query)
      ? "summary"
      : isAggregate(query)
        ? "counting"
        : "lookup";
  return {
    kind,
    window,
    historical: isHistorical(query) || kind === "ordering" || window !== null,
    chronological: kind === "ordering" || kind === "summary" || window !== null,
  };
}

/**
 * The plan for one question. The one-call levels shape retrieval by the question (still one
 * model call): counting and totals need every matching item, often spread over many sessions, so
 * they retrieve wider; ordering questions keep more of what was replaced, since the earlier state
 * is part of the sequence. Tool-using levels search for themselves.
 */
export function planFor(level: ChatLevel, query: string): LevelPlan {
  const plan = LEVELS[level];
  if (plan.rounds > 0) return plan;
  const wide = isAggregate(query)
    ? {
        ...plan,
        facts: Math.round(plan.facts * 1.5),
        snippets: Math.round(plan.snippets * 1.5),
        budget: Math.round((plan.budget * 4) / 3),
        inputCap: Math.round((plan.inputCap * 4) / 3),
        multiQuery: true,
      }
    : plan;
  return isOrdering(query) ? { ...wide, history: Math.max(4, wide.history * 2) } : wide;
}
