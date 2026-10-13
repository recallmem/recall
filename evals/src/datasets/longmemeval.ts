import { open } from "node:fs/promises";
import {
  type EvalMessage,
  type EvalQuestion,
  type EvalUnit,
  type JudgeKind,
  type SelectOptions,
  selectItems,
  splitContent,
  type UnitSource,
} from "../types.js";
import { type ElementSpan, scanJsonArray, slug } from "../util.js";

/** One entry of longmemeval_s_cleaned.json: a question plus its ~50-session haystack. */
export interface LongMemEvalEntry {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string | number;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: string; content: string }[][];
}

export const LONGMEMEVAL_CATEGORIES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "knowledge-update",
  "temporal-reasoning",
  "abstention",
] as const;

/** "2023/05/20 (Sat) 02:21" -> "2023-05-20T02:21:00.000Z". */
export function parseLongMemEvalDate(value: string): string {
  const m = value.match(/(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]{3}\))?\s*(\d{2}):(\d{2})/);
  if (!m) throw new Error(`unrecognised LongMemEval date: ${JSON.stringify(value)}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
}

export function categoryOf(questionId: string, questionType: string): string {
  return questionId.endsWith("_abs") ? "abstention" : questionType;
}

export function kindOf(category: string): JudgeKind {
  switch (category) {
    case "abstention":
      return "abstention";
    case "temporal-reasoning":
      return "temporal";
    case "knowledge-update":
      return "update";
    case "single-session-preference":
      return "preference";
    default:
      return "standard";
  }
}

export function entryToUnit(entry: LongMemEvalEntry): EvalUnit {
  const category = categoryOf(entry.question_id, entry.question_type);
  const sessions = entry.haystack_sessions
    .map((turns, i) => {
      const startMs = Date.parse(parseLongMemEvalDate(entry.haystack_dates[i] as string));
      const messages: EvalMessage[] = [];
      for (const turn of turns) {
        const peer = turn.role === "assistant" ? "assistant" : "user";
        for (const part of splitContent(String(turn.content ?? ""))) {
          if (!part.trim()) continue; // the dataset contains a few empty turns; servers reject them
          // One second apart keeps turn order stable without crossing into the next session.
          const createdAt = new Date(startMs + messages.length * 1000).toISOString();
          messages.push({ peer, content: part, createdAt });
        }
      }
      return {
        startMs,
        session: {
          id: slug(`s${String(i + 1).padStart(2, "0")}-${entry.haystack_session_ids[i] ?? i}`, 80),
          messages,
        },
      };
    })
    .filter((s) => s.session.messages.length > 0)
    // Ingest chronologically, like a real deployment would have seen the conversations.
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => s.session);

  const question: EvalQuestion = {
    id: entry.question_id,
    category,
    kind: kindOf(category),
    question: entry.question,
    query: `The current date is ${entry.question_date}.\n${entry.question}`,
    gold: String(entry.answer),
    peer: "user",
  };
  return {
    id: `lme-${slug(entry.question_id, 40)}`,
    dataset: "longmemeval",
    // Only the human's facts matter; the assistant is context, as in a normal chat product.
    peers: [
      { id: "user", observeMe: true },
      { id: "assistant", observeMe: false },
    ],
    sessions,
    questions: [question],
  };
}

interface IndexedEntry {
  span: ElementSpan;
  id: string;
  category: string;
}

async function indexEntries(path: string): Promise<IndexedEntry[]> {
  const spans = await scanJsonArray(path);
  const fh = await open(path, "r");
  try {
    const out: IndexedEntry[] = [];
    for (const span of spans) {
      // question_id and question_type are the first two keys; the head is enough to read them.
      const head = Buffer.alloc(Math.min(1024, span.end - span.start));
      await fh.read(head, 0, head.length, span.start);
      const text = head.toString("utf8");
      const id = text.match(/"question_id"\s*:\s*"([^"]+)"/)?.[1];
      const type = text.match(/"question_type"\s*:\s*"([^"]+)"/)?.[1];
      if (!id || !type)
        throw new Error(`cannot read question_id/question_type at byte ${span.start}`);
      out.push({ span, id, category: categoryOf(id, type) });
    }
    return out;
  } finally {
    await fh.close();
  }
}

async function readEntry(path: string, span: ElementSpan): Promise<LongMemEvalEntry> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(span.end - span.start);
    await fh.read(buf, 0, buf.length, span.start);
    return JSON.parse(buf.toString("utf8")) as LongMemEvalEntry;
  } finally {
    await fh.close();
  }
}

/** Selects questions from longmemeval_s_cleaned.json; each is read from disk only when its unit runs. */
export async function planLongMemEval(path: string, opts: SelectOptions): Promise<UnitSource[]> {
  const index = await indexEntries(path);
  const chosen = selectItems(index, (e) => e.category, LONGMEMEVAL_CATEGORIES, opts);
  return chosen.map((e) => ({
    id: `lme-${slug(e.id, 40)}`,
    questionCount: 1,
    load: async () => entryToUnit(await readEntry(path, e.span)),
  }));
}
