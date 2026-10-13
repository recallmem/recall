import { z } from "zod";
import { isoDay, isoMinute } from "./util.js";

/**
 * The extraction call. One call per session batch covers every speaker and
 * every observer. Layout, from most to least stable:
 *   system  - fixed instructions and a worked example: byte-identical on every
 *             call, the prefix providers cache (with the output schema)
 *   context - known facts (F handles) and cards per speaker, app instructions,
 *             summary requests
 *   message - the compact transcript
 */

export const FACT_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "plan",
  "event",
  "skill",
  "instruction",
  "state",
  "other",
] as const;

export const EXTRACTION_SYSTEM = `You keep long-term memory about the participants ("peers") of conversations. A peer may be a person, an AI agent, a bot or a service; refer to every peer by its id exactly as written.

Input: KNOWN FACTS already stored per speaker (handles F1, F2, ...) with each speaker's profile CARD, then a TRANSCRIPT of new messages, one per line: [mN] <peer> <UTC time>: <text>. Continuation lines are indented. Lines marked (context) are earlier or unobserved messages: use them only to understand the others, never as a source.

Return JSON:
facts: what the new messages reveal about their authors that is worth remembering beyond this conversation. Per fact:
- about: the peer the fact describes; it must have written one of the source messages. Never record as a peer's fact what another peer said or assumed about them. Exception: when a peer accepts or answers someone's proposal or question ("yes", "the second one"), the accepted details are that peer's statement.
- content: one standalone sentence with the peer id as subject, e.g. "alice adopted a dog named Rover". Replace pronouns and relative times ("yesterday", "next week") with names and absolute dates based on the message time. Keep qualifiers (reason, place, people, time, tools). One fact per item.
- level: "explicit" when stated; "deductive" when it follows with near certainty from what was stated (works as a nurse -> works in healthcare). Never speculate.
- category: identity, preference, relationship, plan, event, skill, instruction (how the peer wants to be treated), state (temporary condition), or other.
- confidence: 0 to 1; 1 = plainly stated, lower for hedged, joking or hypothetical statements.
- importance: 1 to 5; 5 = identity, health, close relationships, long-term goals, standing instructions; 1 = trivia.
- source_messages: the N of each [mN] line the fact comes from.
- action: "add" for new information (target null); "reinforce" when it repeats a KNOWN FACT unchanged (target = that handle); "supersede" when it changes, corrects, ends or contradicts a KNOWN FACT about the same peer: moved, changed job or opinion, cancelled or completed plan (target = the outdated handle; content = the new state, standalone). When the target bundles several details and only some change, the new content restates the details that still hold, so nothing true is lost.
Do record concrete events and activities (what the peer did, read, made, visited, attended or bought, with whom, and the absolute date), and specifics such as names, titles, places, origins, relationship status and numbers: memory questions usually ask about exactly these. Skip greetings, thanks, small talk, questions that reveal nothing, generic offers of help, how the conversation itself proceeds, and things true of almost anyone. Returning no facts is correct when nothing qualifies.

cards: edits to the profile cards of speakers, only for stable facts likely to hold for months: [{peer, add, remove}]. Entries start with IDENTITY:, ATTRIBUTE:, RELATIONSHIP: or INSTRUCTION:, use the form "PREFIX: Label: value" (e.g. "ATTRIBUTE: Location: Berlin"), and stay under 200 characters. Only what the peer stated or accepted about itself. remove = exact existing entries that are now wrong. Usually [].

synopsis: if requested, 1 to 3 sentences on what the new messages covered (topics, decisions, requests, open questions); otherwise null.
short_summary: if requested, the PREVIOUS SUMMARY updated with any earlier synopses and the new messages so it covers the whole conversation: the most important facts, preferences, decisions and open threads, at most 200 words, no preamble; otherwise null.

EXAMPLE (illustration only; never output its content)
KNOWN FACTS
coach:
(none)
CARD coach: (empty)
noor:
F1 2025-02-10 noor lives in Lyon
F2 2025-02-10 noor works as a pharmacist
CARD noor: ATTRIBUTE: Location: Lyon
synopsis: requested
TRANSCRIPT
[m1] coach 2025-06-03T08:00Z: Morning! How is Lyon treating you?
[m2] noor 2025-06-03T08:01Z: We moved to Porto last week. Still a pharmacist, of course.
[m3] coach 2025-06-03T08:02Z: So you'll be surfing every weekend now?
[m4] noor 2025-06-03T08:03Z: Ha, no. My sister Lina flies in on Friday to see the flat.
Output (coach's guess about surfing is not recorded: noor never said it):
{"facts":[{"about":"noor","content":"noor lives in Porto, having moved from Lyon in the week of 2025-05-26","level":"explicit","category":"identity","confidence":1,"importance":4,"source_messages":[2],"action":"supersede","target":"F1"},
{"about":"noor","content":"noor works as a pharmacist","level":"explicit","category":"identity","confidence":1,"importance":4,"source_messages":[2],"action":"reinforce","target":"F2"},
{"about":"noor","content":"noor expects a visit from sister Lina, who flies to Porto on 2025-06-06 to see the new flat","level":"explicit","category":"plan","confidence":0.9,"importance":3,"source_messages":[4],"action":"add","target":null}],
"cards":[{"peer":"noor","add":["ATTRIBUTE: Location: Porto","RELATIONSHIP: Sister: Lina"],"remove":["ATTRIBUTE: Location: Lyon"]}],
"synopsis":"noor moved from Lyon to Porto; noor's sister Lina visits on 2025-06-06.","short_summary":null}`;

export const FactOut = z.object({
  about: z.string(),
  content: z.string(),
  level: z.enum(["explicit", "deductive"]),
  category: z.enum(FACT_CATEGORIES),
  confidence: z.number(),
  importance: z.number(),
  source_messages: z.array(z.number()),
  action: z.enum(["add", "reinforce", "supersede"]),
  target: z.string().nullable(),
});
export type FactOut = z.infer<typeof FactOut>;

export const CardEditOut = z.object({
  peer: z.string(),
  add: z.array(z.string()),
  remove: z.array(z.string()),
});

export const ExtractionOut = z.object({
  facts: z.array(FactOut),
  cards: z.array(CardEditOut),
  synopsis: z.string().nullable(),
  short_summary: z.string().nullable(),
});
export type ExtractionOut = z.infer<typeof ExtractionOut>;

export interface PromptMessage {
  index: number;
  peerName: string;
  createdAt: Date;
  content: string;
  context: boolean;
}

/** Content may not forge transcript lines: continuation lines are indented. */
function oneLine(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/\n+/g, "\n  ").trim();
}

export function formatTranscript(messages: PromptMessage[]): string {
  const lines = messages.map(
    (m) =>
      `[m${m.index}] ${m.peerName} ${isoMinute(m.createdAt)}${m.context ? " (context)" : ""}: ${oneLine(m.content)}`,
  );
  return `TRANSCRIPT\n${lines.join("\n")}`;
}

export interface KnownFact {
  handle: string;
  content: string;
  validFrom: Date | null;
}

export interface SpeakerContext {
  name: string;
  facts: KnownFact[];
  card: string[] | null;
}

export function formatContext(args: {
  speakers: SpeakerContext[];
  instructions: string[];
  synopsis: boolean;
  shortSummary: { previous: string | null; earlier: string[] } | null;
  summaryInstructions: string | null;
  cardInstructions: string | null;
}): string {
  const parts: string[] = ["KNOWN FACTS"];
  for (const s of args.speakers) {
    parts.push(`${s.name}:`);
    if (s.facts.length) {
      for (const f of s.facts)
        parts.push(`${f.handle} ${f.validFrom ? `${isoDay(f.validFrom)} ` : ""}${f.content}`);
    } else parts.push("(none)");
    if (s.card) parts.push(`CARD ${s.name}: ${s.card.length ? s.card.join(" | ") : "(empty)"}`);
  }
  if (args.instructions.length) {
    parts.push(`APPLICATION INSTRUCTIONS FOR FACT EXTRACTION:\n${args.instructions.join("\n")}`);
  }
  if (args.cardInstructions)
    parts.push(`APPLICATION INSTRUCTIONS FOR CARDS:\n${args.cardInstructions}`);
  const wants: string[] = [];
  if (!args.speakers.some((s) => s.card)) wants.push("cards: not used, return []");
  if (args.synopsis) wants.push("synopsis: requested");
  if (args.shortSummary) wants.push("short_summary: requested");
  if (wants.length) parts.push(wants.join("; "));
  if (args.shortSummary) {
    parts.push(
      `PREVIOUS SUMMARY:\n${args.shortSummary.previous ?? "(none: this is the start of the conversation)"}`,
    );
    if (args.shortSummary.earlier.length) {
      parts.push(
        `EARLIER MESSAGES NOT YET IN THE SUMMARY (synopses):\n${args.shortSummary.earlier.join("\n")}`,
      );
    }
  }
  if ((args.synopsis || args.shortSummary) && args.summaryInstructions) {
    parts.push(`APPLICATION INSTRUCTIONS FOR SUMMARIES:\n${args.summaryInstructions}`);
  }
  return parts.join("\n");
}

/** Output budget: room for a few facts per message plus the requested summaries, never more. */
export function extractionMaxTokens(
  targetMessages: number,
  synopsis: boolean,
  shortSummary: boolean,
): number {
  const facts = 160 + 130 * targetMessages;
  return Math.min(6000, facts + (synopsis ? 120 : 0) + (shortSummary ? 400 : 0));
}
