import { MockProvider } from "../llm/providers/mock.js";
import type { DreamOut } from "./index.js";

/**
 * Offline dreams for the mock provider: exact duplicates (ignoring case and
 * punctuation) are merged, two or more stated likes become an inductive
 * preference pattern, and "X likes Y" next to "X doesn't like Y" is recorded
 * as a contradiction.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function offlineDream(text: string): DreamOut {
  const facts = text
    .split("\n")
    .map((l) => l.match(/^(D\d+) \[[^\]]*\] (.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({ handle: m[1]!, content: m[2]! }));
  const out: DreamOut = {
    merge: [],
    supersede: [],
    inductive: [],
    contradictions: [],
    card: { add: [], remove: [] },
  };
  const byText = new Map<string, string[]>();
  for (const f of facts)
    byText.set(norm(f.content), [...(byText.get(norm(f.content)) ?? []), f.handle]);
  for (const [, ids] of byText) {
    if (ids.length > 1)
      out.merge.push({ ids, content: facts.find((f) => f.handle === ids[0])!.content });
  }
  const likes = facts
    .map((f) => ({ f, m: f.content.match(/^(\S+) (?:likes|loves|enjoys) (.+)$/) }))
    .filter((x) => x.m);
  const subjects = new Set(likes.map((x) => x.m![1]));
  for (const who of subjects) {
    const mine = likes.filter((x) => x.m![1] === who);
    if (mine.length >= 2) {
      out.inductive.push({
        content: `${who} has several stated enjoyments: ${mine.map((x) => x.m![2]).join("; ")}`,
        sources: mine.map((x) => x.f.handle),
        confidence: mine.length >= 5 ? "high" : mine.length >= 3 ? "medium" : "low",
      });
    }
  }
  for (const a of likes) {
    const b = facts.find((f) => norm(f.content) === norm(`${a.m![1]} doesn't like ${a.m![2]}`));
    if (b) {
      out.contradictions.push({
        content: `${a.m![1]} both likes and does not like ${a.m![2]}`,
        sources: [a.f.handle, b.handle],
      });
    }
  }
  return out;
}

MockProvider.register("dream", (req) => ({
  json: offlineDream(req.messages.map((m) => m.content).join("\n")),
}));

MockProvider.register("card", (req) => {
  const facts = req.messages.map((m) => m.content).join("\n");
  // A brief update: the old brief, then the new facts as sentences, oldest first.
  if (facts.startsWith("NEW FACTS")) {
    const old = /BRIEF:\n([\s\S]*)$/.exec(req.context ?? "")?.[1]?.trim();
    const lines = facts
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^- \S+ (?:\[event [^\]]+\] )?/, "").trim());
    return {
      json: { brief: [old && old !== "(empty)" ? old : "", ...lines].filter(Boolean).join(" ") },
    };
  }
  const card: string[] = [];
  for (const m of facts.matchAll(/^- (?:\[[^\]]*\] )?(\S+) lives in (.+)$/gm))
    card.push(`ATTRIBUTE: Location: ${m[2]}`);
  for (const m of facts.matchAll(/^- (?:\[[^\]]*\] )?(\S+) works as (?:an? )?(.+)$/gm))
    card.push(`ATTRIBUTE: Occupation: ${m[2]}`);
  return { json: { card } };
});
