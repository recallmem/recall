import { readFile } from "node:fs/promises";
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
import { slug } from "../util.js";

interface LocomoTurn {
  speaker: string;
  text: string;
  blip_caption?: string;
}

interface LocomoQa {
  question: string;
  answer?: string | number | null;
  adversarial_answer?: string;
  category: number;
}

export interface LocomoSample {
  sample_id: string;
  conversation: Record<string, unknown> & { speaker_a: string; speaker_b: string };
  qa: LocomoQa[];
}

/** Category numbers follow the LoCoMo paper's task_eval code (5 = adversarial / unanswerable). */
export const LOCOMO_CATEGORIES: Record<number, { name: string; kind: JudgeKind }> = {
  1: { name: "multi-hop", kind: "standard" },
  2: { name: "temporal", kind: "temporal" },
  3: { name: "open-domain", kind: "standard" },
  4: { name: "single-hop", kind: "standard" },
  5: { name: "abstention", kind: "abstention" },
};
export const LOCOMO_CATEGORY_ORDER = [
  "single-hop",
  "multi-hop",
  "temporal",
  "open-domain",
  "abstention",
];

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

/** "1:56 pm on 8 May, 2023" -> "2023-05-08T13:56:00.000Z". */
export function parseLocomoDate(value: string): string {
  const m = value.match(/(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i);
  const month = m ? MONTHS.indexOf((m[5] as string).toLowerCase()) : -1;
  if (!m || month < 0) throw new Error(`unrecognised LoCoMo date: ${JSON.stringify(value)}`);
  let hour = Number(m[1]) % 12;
  if ((m[3] as string).toLowerCase() === "pm") hour += 12;
  return new Date(Date.UTC(Number(m[6]), month, Number(m[4]), hour, Number(m[2]))).toISOString();
}

/** The speaker a question is about: the one it names, else the first speaker. */
export function pickPeer(question: string, speakers: readonly [string, string]): string {
  const named = speakers.filter((s) =>
    new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question),
  );
  return named.length === 1 ? (named[0] as string) : speakers[0];
}

export function sampleToUnit(sample: LocomoSample, only?: ReadonlySet<number>): EvalUnit {
  const conv = sample.conversation;
  const speakers = [conv.speaker_a, conv.speaker_b] as const;
  const peerIds = new Map(speakers.map((s) => [s, slug(s, 60) || "speaker"]));
  if (peerIds.get(speakers[0]) === peerIds.get(speakers[1])) {
    peerIds.set(speakers[1], `${peerIds.get(speakers[1])}-2`);
  }

  const sessions: EvalSession[] = [];
  let lastMs = 0;
  for (let n = 1; Array.isArray(conv[`session_${n}`]); n++) {
    const turns = conv[`session_${n}`] as LocomoTurn[];
    const startMs = Date.parse(parseLocomoDate(String(conv[`session_${n}_date_time`])));
    if (startMs > lastMs) lastMs = startMs;
    const messages: EvalMessage[] = [];
    for (const turn of turns) {
      const peer = peerIds.get(turn.speaker);
      if (!peer) continue;
      const text = turn.blip_caption
        ? `${turn.text} [shared image: ${turn.blip_caption}]`
        : turn.text;
      for (const part of splitContent(text)) {
        if (!part.trim()) continue;
        messages.push({
          peer,
          content: part,
          createdAt: new Date(startMs + messages.length * 1000).toISOString(),
        });
      }
    }
    if (messages.length) sessions.push({ id: `session-${String(n).padStart(2, "0")}`, messages });
  }

  const questions: EvalQuestion[] = [];
  sample.qa.forEach((qa, i) => {
    if (only && !only.has(i)) return;
    const cat = LOCOMO_CATEGORIES[qa.category] ?? {
      name: `category-${qa.category}`,
      kind: "standard",
    };
    const abstain = cat.kind === "abstention";
    questions.push({
      id: `${sample.sample_id}-q${i}`,
      category: cat.name,
      kind: cat.kind,
      question: qa.question,
      // Questions are asked "after" the conversation, like LongMemEval's question_date; without
      // this, relative answers ("10 years ago") get computed from the real current date.
      query: lastMs
        ? `The current date is ${new Date(lastMs).toISOString().slice(0, 10)}.\n${qa.question}`
        : qa.question,
      gold: abstain
        ? `The conversation never says this, so the question cannot be answered. (A tempting wrong answer would be: ${qa.adversarial_answer ?? "n/a"}.)`
        : String(qa.answer ?? ""),
      peer: peerIds.get(pickPeer(qa.question, speakers)) as string,
    });
  });

  return {
    id: `locomo-${slug(sample.sample_id, 40)}`,
    dataset: "locomo",
    peers: speakers.map((s) => ({ id: peerIds.get(s) as string, observeMe: true })),
    sessions,
    questions,
  };
}

/**
 * Selects questions from locomo10.json. Questions are taken conversation by
 * conversation (so `--limit 5` ingests only the first conversation), interleaving
 * categories inside each one.
 */
export async function planLocomo(path: string, opts: SelectOptions): Promise<UnitSource[]> {
  const samples = JSON.parse(await readFile(path, "utf8")) as LocomoSample[];
  const flat = samples.flatMap((sample, s) =>
    sample.qa.map((qa, q) => ({
      s,
      q,
      category: LOCOMO_CATEGORIES[qa.category]?.name ?? `category-${qa.category}`,
    })),
  );

  const order = opts.order ?? "stratified";
  let chosen: typeof flat;
  if (order === "file") {
    chosen = selectItems(flat, (i) => i.category, LOCOMO_CATEGORY_ORDER, {
      ...opts,
      order: "file",
    });
  } else {
    // Stratify within each conversation, then concatenate conversations in file order.
    const perSample = samples.map((_, s) =>
      selectItems(
        flat.filter((i) => i.s === s),
        (i) => i.category,
        LOCOMO_CATEGORY_ORDER,
        { types: opts.types, order: "stratified" },
      ),
    );
    const all = (
      opts.perUnit ? perSample.map((qs) => qs.slice(0, opts.perUnit)) : perSample
    ).flat();
    const start = opts.offset ?? 0;
    chosen = all.slice(start, opts.limit === undefined ? undefined : start + opts.limit);
  }

  const bySample = new Map<number, Set<number>>();
  for (const c of chosen) {
    if (!bySample.has(c.s)) bySample.set(c.s, new Set());
    bySample.get(c.s)?.add(c.q);
  }
  return [...bySample.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([s, qs]) => {
      const sample = samples[s] as LocomoSample;
      return {
        id: `locomo-${slug(sample.sample_id, 40)}`,
        questionCount: qs.size,
        load: async () => sampleToUnit(sample, qs),
      };
    });
}
