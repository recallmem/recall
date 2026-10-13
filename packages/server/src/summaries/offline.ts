import { MockProvider } from "../llm/providers/mock.js";
import { section } from "../reasoner/offline.js";

/**
 * Offline summaries for the mock provider: the synopsis names the speakers
 * and the opening words of the new messages; the short summary appends it to
 * the previous one (newest 200 words). Condensing keeps the first 300 words.
 */
MockProvider.register("summary", (req) => {
  const text = req.messages.map((m) => m.content).join("\n");
  if (!req.jsonSchema) {
    const body = text.slice(text.indexOf("\n") + 1);
    return { text: body.split(/\s+/).slice(0, 300).join(" ") };
  }
  const lines = text
    .split("\n")
    .slice(1)
    .map((l) => l.match(/^(\S+) \S+: (.*)$/))
    .filter((m) => m !== null);
  const peers = [...new Set(lines.map((m) => m[1]!))];
  const first = lines.find((m) => (m[2] ?? "").split(" ").length > 3)?.[2] ?? "";
  const topic = first
    .split(" ")
    .slice(0, 10)
    .join(" ")
    .replace(/[.!?]+$/, "");
  const synopsis = `${peers.join(" and ")} talked about: ${topic}.`;
  const prev = section(req.context ?? "", "PREVIOUS SUMMARY") ?? "";
  const short = `${prev.startsWith("(none") ? "" : prev} ${synopsis}`
    .trim()
    .split(/\s+/)
    .slice(-200)
    .join(" ");
  return { json: { short_summary: short, synopsis } };
});
