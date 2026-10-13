import { MockProvider } from "../llm/providers/mock.js";
import type { LlmRequest } from "../llm/types.js";
import type { ExtractionOut, FactOut } from "./prompt.js";

/**
 * Offline extraction for the mock provider (no API key, deterministic tests).
 * A small rule set turns first-person statements into third-person facts
 * ("I live in Berlin" -> "alice lives in Berlin"), reinforces exact repeats,
 * supersedes single-valued attributes (where someone lives, works, ...), and
 * keeps those attributes on the peer card.
 */

export interface TranscriptLine {
  n: number;
  peer: string;
  time: string;
  context: boolean;
  text: string;
}

export function parseTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\[m(\d+)\] (\S+) (\S+?)( \(context\))?: (.*)$/);
    if (m) out.push({ n: Number(m[1]), peer: m[2]!, time: m[3]!, context: !!m[4], text: m[5]! });
    else if (out.length && line.startsWith("  ")) out.at(-1)!.text += ` ${line.trim()}`;
  }
  return out;
}

export function section(text: string, header: string): string | null {
  const i = text.indexOf(`${header}:\n`);
  if (i < 0) return null;
  const rest = text.slice(i + header.length + 2);
  const end = rest.search(/\n[A-Z][A-Z _]+(?: \([a-z ]+\))?:(?:\n| )/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

interface Known {
  handle: string;
  content: string;
}

function parseKnown(context: string): Map<string, Known[]> {
  const known = new Map<string, Known[]>();
  let speaker: string | null = null;
  for (const line of context.split("\n")) {
    const header = line.match(/^(\S+):$/);
    if (header && header[1] !== "KNOWN FACTS") {
      speaker = header[1]!;
      known.set(speaker, []);
      continue;
    }
    const f = line.match(/^(F\d+) (?:\d{4}-\d{2}-\d{2} )?(.*)$/);
    if (f && speaker) known.get(speaker)!.push({ handle: f[1]!, content: f[2]! });
  }
  return known;
}

const MODALS = new Set([
  "will",
  "would",
  "can",
  "could",
  "should",
  "might",
  "may",
  "must",
  "just",
  "also",
  "really",
  "never",
  "always",
  "usually",
  "recently",
  "finally",
  "still",
  "already",
  "often",
  "sometimes",
  "didn't",
  "won't",
  "can't",
]);
const IRREGULAR: Record<string, string> = {
  have: "has",
  do: "does",
  go: "goes",
  be: "is",
  "don't": "doesn't",
};

function thirdPerson(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower]!;
  if (MODALS.has(lower) || /ed$/.test(lower)) return verb;
  if (/(s|sh|ch|x|z|o)$/.test(lower)) return `${verb}es`;
  if (/[^aeiou]y$/.test(lower)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}

/** "I live in Berlin" -> "alice lives in Berlin"; null when the sentence is not a statement about the speaker. */
export function firstPersonToFact(name: string, sentence: string): string | null {
  let s = sentence
    .trim()
    .replace(
      /^(?:also|actually|btw|by the way|oh|and|so|then|well|anyway|honestly|now|ps)[,:]?\s+/i,
      "",
    )
    .replace(/^[^.:]{1,30}:\s+(?=(?:I|My)\b)/, "")
    .replace(/[.!]+$/, "");
  if (!s || s.endsWith("?")) return null;
  if (/^I(?:'d| would| can| could|'ll be| will be happy| am happy to|'m happy to)\b/i.test(s))
    return null;
  s = s.replace(/^I just moved to\b/i, "I live in").replace(/^I moved to\b/i, "I live in");
  let fact: string | null = null;
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^(?:I'm|I am)\s+(.+)$/i, (m) => `${name} is ${m[1]}`],
    [/^(?:I've|I have)\s+(.+)$/i, (m) => `${name} has ${m[1]}`],
    [/^I was\s+(.+)$/i, (m) => `${name} was ${m[1]}`],
    [/^My\s+(.+)$/i, (m) => `${name}'s ${m[1]}`],
    [
      /^I\s+(\S+)\s*(.*)$/i,
      (m) => {
        const verb = m[1]!;
        const rest = m[2] ?? "";
        if (MODALS.has(verb.toLowerCase()) && rest) return `${name} ${verb} ${rest}`.trim();
        return `${name} ${thirdPerson(verb)} ${rest}`.trim();
      },
    ],
  ];
  for (const [re, build] of rules) {
    const m = s.match(re);
    if (m) {
      fact = build(m);
      break;
    }
  }
  if (!fact) return null;
  fact = fact
    .replace(/\bmy\b/gi, "their")
    .replace(/\bme\b/g, "them")
    .replace(/\bI'm\b/g, `${name} is`)
    .replace(/\s+/g, " ")
    .trim();
  return fact.split(" ").length >= 3 ? fact : null;
}

/** Attributes that hold one value at a time; a new value supersedes the old. */
const SINGLE_VALUED: { re: RegExp; label: string; prefix: "ATTRIBUTE" | "IDENTITY" }[] = [
  { re: /^(\S+) lives in (.+)$/, label: "Location", prefix: "ATTRIBUTE" },
  { re: /^(\S+) works as (?:an? )?(.+)$/, label: "Occupation", prefix: "ATTRIBUTE" },
  { re: /^(\S+) works at (.+)$/, label: "Employer", prefix: "ATTRIBUTE" },
  { re: /^(\S+)'s name is (.+)$/, label: "Name", prefix: "IDENTITY" },
  { re: /^(\S+) is (\d+) years old$/, label: "Age", prefix: "ATTRIBUTE" },
  { re: /^(\S+)'s favou?rite (\w+) is (.+)$/, label: "Favorite", prefix: "ATTRIBUTE" },
];

function attribute(fact: string): { key: string; card: string } | null {
  for (const a of SINGLE_VALUED) {
    const m = fact.match(a.re);
    if (!m) continue;
    const label = a.label === "Favorite" ? `Favorite ${m[2]}` : a.label;
    const value = a.label === "Favorite" ? m[3]! : m[2]!;
    return {
      key: `${m[1]!.toLowerCase()}|${label.toLowerCase()}`,
      card: `${a.prefix}: ${label}: ${value}`,
    };
  }
  return null;
}

function category(fact: string): FactOut["category"] {
  if (attribute(fact)) return "identity";
  if (/\b(likes?|loves?|enjoys?|prefers?|hates?|doesn't like|dislikes?|favou?rite)\b/i.test(fact))
    return "preference";
  if (
    /\b(brother|sister|wife|husband|partner|friend|mother|father|mom|dad|daughter|son|dog|cat|kids?)\b/i.test(
      fact,
    )
  ) {
    return "relationship";
  }
  if (/\b(will|going to|plans?|planning)\b/i.test(fact)) return "plan";
  return "other";
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function offlineExtraction(req: LlmRequest): ExtractionOut {
  const context = req.context ?? "";
  const lines = parseTranscript(req.messages.map((m) => m.content).join("\n"));
  const known = parseKnown(context);
  const facts: FactOut[] = [];
  const cards = new Map<string, { add: string[]; remove: string[] }>();
  const cardsUsed = !context.includes("cards: not used");
  for (const line of lines) {
    if (line.context) continue;
    const mine = known.get(line.peer) ?? [];
    let perMessage = 0;
    for (const sentence of line.text.split(/(?<=[.!?])\s+/)) {
      const content = firstPersonToFact(line.peer, sentence);
      if (!content || perMessage >= 3) continue;
      perMessage++;
      const same = mine.find((k) => norm(k.content) === norm(content));
      const attr = attribute(content);
      const old = attr
        ? mine.find((k) => attribute(k.content)?.key === attr.key && k !== same)
        : undefined;
      const action: FactOut["action"] = same ? "reinforce" : old ? "supersede" : "add";
      facts.push({
        about: line.peer,
        content,
        level: "explicit",
        category: category(content),
        confidence: 0.9,
        importance: attr ? 4 : 3,
        source_messages: [line.n],
        action,
        target: same?.handle ?? old?.handle ?? null,
      });
      if (attr && cardsUsed) {
        const edit = cards.get(line.peer) ?? { add: [], remove: [] };
        edit.add.push(attr.card);
        cards.set(line.peer, edit);
      }
    }
  }
  const targets = lines.filter((l) => !l.context);
  const peers = [...new Set(targets.map((l) => l.peer))];
  const topic =
    targets
      .find((l) => l.text.split(" ").length > 3)
      ?.text.split(" ")
      .slice(0, 10)
      .join(" ") ?? "";
  const synopsis = `${peers.join(" and ")} talked about: ${topic.replace(/[.!?]+$/, "")}.`;
  let short: string | null = null;
  if (context.includes("short_summary: requested")) {
    const prev = section(context, "PREVIOUS SUMMARY") ?? "";
    const earlier = (
      section(context, "EARLIER MESSAGES NOT YET IN THE SUMMARY (synopses)") ?? ""
    ).replace(/^\d{4}-\d{2}-\d{2}: /gm, "");
    const words = `${prev.startsWith("(none") ? "" : prev} ${earlier} ${synopsis}`
      .trim()
      .split(/\s+/);
    short = words.slice(-200).join(" ");
  }
  return {
    facts,
    cards: [...cards].map(([peer, e]) => ({ peer, ...e })),
    synopsis: context.includes("synopsis: requested") ? synopsis : null,
    short_summary: short,
  };
}

MockProvider.register("reasoner", (req) => ({ json: offlineExtraction(req) }));
