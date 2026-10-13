import { open } from "node:fs/promises";
import { parseProbingQuestions } from "../beam/pyliteral.js";
import { BEAM_ABILITIES, BEAM_ABILITY_KEYS, type BeamAbility } from "../beam/scoring.js";
import type { BeamSplit } from "../sources.js";
import {
  type EvalMessage,
  type EvalQuestion,
  type EvalSession,
  type EvalUnit,
  type JudgeKind,
  type SelectOptions,
  selectItems,
  splitContent,
  type UnitSource,
} from "../types.js";
import { type ElementSpan, scanJsonArray, slug } from "../util.js";

/**
 * BEAM ("Beyond a Million Tokens", Tavakoli et al. 2025): one synthetic user-assistant conversation per
 * row, 20 probing questions (2 per memory ability). A row, as stored by `download` (the Hugging Face
 * columns the harness uses):
 *
 *   conversation_id, conversation_seed {category,title,theme,subtopics},
 *   chat:  [ batch, ... ]  with  batch = [ {role, content, id, index, question_type, time_anchor}, ... ]
 *          (the 10M split nests it as {plan-N: [{batch_number, time_anchor, turns: [[message...]]}]})
 *   probing_questions: Python-repr dict  { ability: [ {question, rubric: [...], ...}, ... ] }
 */
export interface BeamMessage {
  role?: string;
  content?: string;
  time_anchor?: string | null;
}

export interface BeamRow {
  conversation_id: string | number;
  conversation_seed?: { title?: string; category?: string } | null;
  chat: unknown;
  probing_questions: unknown;
}

// --------------------------------------------------------------- text/time ----

/**
 * User turns end with generator bookkeeping such as " ->-> 3,28" (batch, bullet of the conversation
 * plan the turn was written from). It is not something the user said, so it is not ingested.
 */
const PLAN_MARKER = /\s*->->\s*\d+\s*,\s*\d+\s*$/;
export const cleanBeamText = (content: string): string => content.replace(PLAN_MARKER, "").trim();

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function validDate(y: number, m: number, d: number): number | null {
  const ms = Date.UTC(y, m, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m && back.getUTCDate() === d
    ? ms
    : null;
}

const monthIndex = (name: string): number =>
  MONTHS.findIndex((m) => m === name.toLowerCase() || m.slice(0, 3) === name.toLowerCase());

/** "March-15-2024" / "March 15, 2024" / "15 March 2024" / "2024-03-15" -> UTC midnight in ms; null if unreadable. */
export function parseBeamDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = text.match(/^([A-Za-z]{3,9})\.?[-\s/]+(\d{1,2})(?:st|nd|rd|th)?,?[-\s/]+(\d{4})/);
  if (m && monthIndex(m[1] as string) >= 0)
    return validDate(Number(m[3]), monthIndex(m[1] as string), Number(m[2]));
  m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[-\s/]+([A-Za-z]{3,9})\.?,?[-\s/]+(\d{4})/);
  if (m && monthIndex(m[2] as string) >= 0)
    return validDate(Number(m[3]), monthIndex(m[2] as string), Number(m[1]));
  return null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Sessions start at 09:00 UTC on their anchor date. */
const SESSION_START = 9 * HOUR;
/** Turns are 30 s apart (compressed if a session would not fit into its day). */
const TURN_GAP = 30_000;
/** Used only when a conversation carries no date at all. */
const FALLBACK_START = Date.UTC(2024, 0, 1);

// ------------------------------------------------------------------- chat ----

interface Batch {
  id: string;
  anchor: string | null;
  messages: BeamMessage[];
}

const isMessage = (x: unknown): x is BeamMessage =>
  !!x && typeof x === "object" && ("content" in x || "role" in x);

const firstAnchor = (messages: readonly BeamMessage[]): string | null =>
  messages.find((m) => m?.time_anchor)?.time_anchor ?? null;

/**
 * Normalises the chat column into batches (each becomes one session).
 *  - 100K/500K/1M: a list of batches, each a list of messages;
 *  - a flat list of messages: a new batch starts at every message that carries a new time anchor;
 *  - 10M: {plan-N: [{batch_number, time_anchor, turns: [[message...]]}]} (possibly inside a list).
 */
export function chatToBatches(chat: unknown): Batch[] {
  if (chat && typeof chat === "object" && !Array.isArray(chat)) return planBatches([chat]);
  if (!Array.isArray(chat)) throw new Error("BEAM row has no chat");
  if (chat.length === 0) return [];
  if (chat.every(Array.isArray)) {
    return (chat as unknown[][]).map((b, i) => {
      const messages = b.filter(isMessage);
      return { id: `b${String(i + 1).padStart(2, "0")}`, anchor: firstAnchor(messages), messages };
    });
  }
  if (chat.every(isMessage)) {
    const batches: Batch[] = [];
    let last: string | null = null;
    for (const m of chat as BeamMessage[]) {
      if (m.time_anchor && m.time_anchor !== last) {
        last = m.time_anchor;
        batches.push({
          id: `b${String(batches.length + 1).padStart(2, "0")}`,
          anchor: m.time_anchor,
          messages: [],
        });
      }
      if (batches.length === 0) batches.push({ id: "b01", anchor: null, messages: [] });
      batches[batches.length - 1]?.messages.push(m);
    }
    return batches;
  }
  return planBatches(chat);
}

function planBatches(parts: readonly unknown[]): Batch[] {
  const out: Batch[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const plans = Object.entries(part as Record<string, unknown>)
      .filter(([k, v]) => /^plan-?\d+$/i.test(k) && Array.isArray(v))
      .sort((a, b) => Number(a[0].replace(/\D/g, "")) - Number(b[0].replace(/\D/g, "")));
    for (const [key, batches] of plans) {
      const plan = key.replace(/\D/g, "").padStart(2, "0");
      (
        batches as { batch_number?: number; time_anchor?: string | null; turns?: unknown }[]
      ).forEach((batch, i) => {
        const turns = Array.isArray(batch.turns) ? batch.turns.flat(2).filter(isMessage) : [];
        out.push({
          id: `p${plan}-b${String(batch.batch_number ?? i + 1).padStart(2, "0")}`,
          anchor: batch.time_anchor ?? firstAnchor(turns),
          messages: turns,
        });
      });
    }
  }
  return out;
}

/** Turns batches into sessions with real-looking, strictly increasing timestamps. */
export function batchesToSessions(batches: readonly Batch[]): {
  sessions: EvalSession[];
  lastMs: number;
} {
  const sessions: EvalSession[] = [];
  let prevEnd = Number.NEGATIVE_INFINITY;
  let prevDay = FALLBACK_START - DAY;
  for (const batch of batches) {
    const parts: { peer: string; text: string }[] = [];
    for (const m of batch.messages) {
      const text = cleanBeamText(String(m.content ?? ""));
      if (!text) continue;
      const peer = m.role === "assistant" ? "assistant" : "user";
      for (const part of splitContent(text)) if (part.trim()) parts.push({ peer, text: part });
    }
    if (parts.length === 0) continue;
    // A batch without a readable date follows the previous one by a day.
    const day = parseBeamDate(batch.anchor) ?? prevDay + DAY;
    prevDay = day;
    const start = Math.max(day + SESSION_START, prevEnd + 60_000);
    const gap = Math.min(TURN_GAP, Math.floor((DAY - SESSION_START - HOUR) / parts.length));
    const messages: EvalMessage[] = parts.map((p, j) => ({
      peer: p.peer,
      content: p.text,
      createdAt: new Date(start + j * gap).toISOString(),
    }));
    prevEnd = start + (parts.length - 1) * gap;
    // Named after the date the session actually gets (an anchor that goes backwards, as in 10M, is moved).
    const date = new Date(start).toISOString().slice(0, 10);
    sessions.push({ id: slug(`${batch.id}-${date}`, 80), messages });
  }
  return { sessions, lastMs: Number.isFinite(prevEnd) ? prevEnd : FALLBACK_START };
}

// -------------------------------------------------------------- questions ----

const str = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join("; ");
  return "";
};
const first = (q: Record<string, unknown>, keys: readonly string[]): string => {
  for (const k of keys) {
    const v = str(q[k]);
    if (v) return v;
  }
  return "";
};

const ORDINAL = /^\s*\d+\s*(?:st|nd|rd|th)?\s*[:.)\-–]\s*/i;
const RUBRIC_PREFIX = /^\s*LLM response should (?:state|mention|contain|include)\s*:\s*/i;
const ORDER_CRITERION = /chronological|correct order|right order|in order/i;

/** Reference events of an event-ordering question, in true order. */
export function orderingEvents(q: Record<string, unknown>): string[] {
  const clean = (xs: unknown, strip: RegExp[]): string[] =>
    (Array.isArray(xs) ? xs : [])
      .map((x) => strip.reduce((t, re) => t.replace(re, ""), str(x)).trim())
      .filter(Boolean);
  const tested = clean(q.ordering_tested, [ORDINAL]);
  if (tested.length) return tested;
  const rubric = (Array.isArray(q.rubric) ? q.rubric : []).map(str).filter(Boolean);
  return clean(
    rubric.filter((r) => !ORDER_CRITERION.test(r)),
    [RUBRIC_PREFIX, ORDINAL],
  );
}

const KIND: Record<BeamAbility, JudgeKind> = {
  abstention: "abstention",
  "contradiction-resolution": "standard",
  "event-ordering": "standard",
  "information-extraction": "standard",
  // The "preference" instructions are written for "what a good response takes into account",
  // which is what both instruction and preference questions describe.
  "instruction-following": "preference",
  "knowledge-update": "update",
  "multi-hop-reasoning": "standard",
  "preference-following": "preference",
  summarization: "standard",
  "temporal-reasoning": "temporal",
};

export interface BeamDraft extends Omit<EvalQuestion, "id" | "query" | "peer"> {
  ability: BeamAbility;
  /** 1-based index among the row's questions of this ability. */
  nth: number;
}

/** The row's questions in canonical ability order (file order within an ability). */
export function rowDrafts(row: BeamRow): BeamDraft[] {
  const parsed = parseProbingQuestions(row.probing_questions);
  const byAbility = new Map<BeamAbility, Record<string, unknown>[]>();
  for (const [key, list] of Object.entries(parsed)) {
    const ability = BEAM_ABILITY_KEYS[key];
    if (!ability) continue; // an ability the paper does not define
    const bucket = byAbility.get(ability) ?? [];
    bucket.push(...list.filter((q): q is Record<string, unknown> => !!q && typeof q === "object"));
    byAbility.set(ability, bucket);
  }
  const out: BeamDraft[] = [];
  for (const ability of BEAM_ABILITIES) {
    (byAbility.get(ability) ?? []).forEach((q, i) => {
      const question = first(q, ["question"]);
      if (!question) return;
      const rubric = (Array.isArray(q.rubric) ? q.rubric : []).map(str).filter(Boolean);
      const reference = first(q, [
        "ideal_response",
        "ideal_answer",
        "ideal_summary",
        "answer",
        "expected_compliance",
      ]);
      let gold = reference;
      if (ability === "abstention") gold = first(q, ["why_unanswerable"]) || reference;
      else if (ability === "instruction-following")
        gold = `The user earlier gave this instruction: "${first(q, ["instruction_being_tested"])}". A good response: ${first(q, ["expected_compliance"]) || rubric.join("; ")}`;
      else if (ability === "preference-following")
        gold = `The user's stated preference: "${first(q, ["preference_being_tested"])}". A good response: ${first(q, ["expected_compliance"]) || rubric.join("; ")}`;
      else if (!gold) gold = rubric.join("; ");
      const events = ability === "event-ordering" ? orderingEvents(q) : undefined;
      // BEAM's own code uses the rubric strings exactly as stored.
      const rawRubric = (Array.isArray(q.rubric) ? q.rubric : []).filter(
        (r): r is string => typeof r === "string",
      );
      out.push({
        ability,
        nth: i + 1,
        category: ability,
        kind: KIND[ability],
        question,
        gold,
        beam: {
          ability,
          nuggets: rubric.length ? rubric : [reference || gold].filter(Boolean),
          ...(rawRubric.length ? { rubric: rawRubric } : {}),
          reference: reference || gold,
          ...(events && events.length >= 2 ? { events } : {}),
        },
      });
    });
  }
  return out;
}

// ------------------------------------------------------------------- unit ----

export const beamUnitId = (split: BeamSplit, conversationId: string | number): string =>
  `beam-${split}-c${slug(String(conversationId), 20)}`;

export function rowToUnit(row: BeamRow, split: BeamSplit, only?: ReadonlySet<number>): EvalUnit {
  const { sessions, lastMs } = batchesToSessions(chatToBatches(row.chat));
  const date = new Date(lastMs).toISOString().slice(0, 10);
  const drafts = rowDrafts(row);
  const questions: EvalQuestion[] = [];
  drafts.forEach((d, i) => {
    if (only && !only.has(i)) return;
    const { ability, nth, ...rest } = d;
    questions.push({
      ...rest,
      id: `beam-${split}-c${slug(String(row.conversation_id), 20)}-${ability}-${nth}`,
      // Asked "after" the conversation, like the other datasets' question dates.
      query: `The current date is ${date}.\n${d.question}`,
      peer: "user",
    });
  });
  return {
    id: beamUnitId(split, row.conversation_id),
    dataset: "beam",
    // Only the human's facts matter; the assistant is context, as in a normal chat product.
    peers: [
      { id: "user", observeMe: true },
      { id: "assistant", observeMe: false },
    ],
    sessions,
    questions,
  };
}

// ------------------------------------------------------------------- plan ----

async function readSpan(path: string, span: ElementSpan): Promise<BeamRow> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(span.end - span.start);
    await fh.read(buf, 0, buf.length, span.start);
    return JSON.parse(buf.toString("utf8")) as BeamRow;
  } finally {
    await fh.close();
  }
}

interface IndexedConversation {
  span: ElementSpan;
  id: string | number;
  abilities: BeamAbility[];
}

/**
 * Selects questions from a downloaded BEAM split. Like LongMemEval, `--limit` round-robins across
 * the ten abilities (so even ten questions cover every ability), in file order of the conversations;
 * a unit is one conversation with all its selected questions, so a small sample ingests few
 * conversations. `--per-unit N` instead takes at most N questions (stratified) from every conversation.
 */
export async function planBeam(
  path: string,
  split: BeamSplit,
  opts: SelectOptions,
): Promise<UnitSource[]> {
  const spans = await scanJsonArray(path);
  const index: IndexedConversation[] = [];
  for (const span of spans) {
    const row = await readSpan(path, span);
    index.push({
      span,
      id: row.conversation_id,
      abilities: rowDrafts(row).map((d) => d.ability),
    });
  }
  const flat = index.flatMap((c, ci) => c.abilities.map((ability, q) => ({ c: ci, q, ability })));
  const abilityOf = (i: { ability: string }) => i.ability;
  const order = opts.order ?? "stratified";

  let chosen: typeof flat;
  if (order === "stratified" && opts.perUnit) {
    const perConversation = index.map((_, ci) =>
      selectItems(
        flat.filter((i) => i.c === ci),
        abilityOf,
        BEAM_ABILITIES,
        { types: opts.types, order: "stratified" },
      ).slice(0, opts.perUnit),
    );
    const start = opts.offset ?? 0;
    chosen = perConversation
      .flat()
      .slice(start, opts.limit === undefined ? undefined : start + opts.limit);
  } else {
    chosen = selectItems(flat, abilityOf, BEAM_ABILITIES, { ...opts, order });
  }

  const byConversation = new Map<number, number[]>();
  for (const c of chosen) {
    const list = byConversation.get(c.c) ?? [];
    list.push(c.q);
    byConversation.set(c.c, list);
  }
  return [...byConversation.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ci, qs]) => {
      const conv = index[ci] as IndexedConversation;
      const only = new Set(qs);
      return {
        id: beamUnitId(split, conv.id),
        questionCount: only.size,
        load: async () => rowToUnit(await readSpan(path, conv.span), split, only),
      };
    });
}
