import { MockProvider, type MockReply } from "../llm/providers/mock.js";
import type { LlmRequest } from "../llm/types.js";
import { queryTerms } from "./util.js";

/**
 * Offline responders for the chat_* tasks, so the server answers without an API
 * key and tests are deterministic. They read the same context block a real model
 * would: pick the pack lines that overlap the question and quote them with their
 * markers; say so plainly when nothing overlaps.
 */

interface Line {
  label: string;
  kind: "fact" | "history" | "excerpt";
  text: string;
}

function parsePack(context: string): Line[] {
  const out: Line[] = [];
  let section = "";
  let lastExcerpt: string | null = null;
  for (const raw of context.split("\n")) {
    if (raw.startsWith("## ")) {
      section = raw.slice(3).trim();
      lastExcerpt = null;
      continue;
    }
    const m = raw.match(/^\[([FMS]\d+)\]\s*(.*)$/);
    if (section === "Facts" || section === "No longer true") {
      if (m)
        out.push({ label: m[1]!, kind: section === "Facts" ? "fact" : "history", text: m[2]! });
    } else if (section === "Conversation log") {
      if (m)
        out.push({
          label: m[1]!,
          kind: "excerpt",
          text: m[2]!.replace(/^\d{4}-\d{2}-\d{2}:\s*/, ""),
        });
    } else if (section === "Excerpts") {
      if (m) {
        lastExcerpt = m[1]!;
        out.push({ label: lastExcerpt, kind: "excerpt", text: m[2]! });
      } else if (lastExcerpt && raw.trim())
        out.push({ label: lastExcerpt, kind: "excerpt", text: raw.trim() });
    }
  }
  return out;
}

const stem = (w: string) => (w.length > 4 ? w.slice(0, 4) : w);

function overlap(terms: string[], text: string): number {
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem));
  return terms.filter((t) => words.has(stem(t))).length;
}

/** Strips "2026-03-02 " dates and trailing tags, keeping a "was" note only when asked for. */
function factText(line: string, keepWas: boolean): string {
  let t = line.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").replace(/^\([^)]*\)\s+/, "");
  if (!keepWas) t = t.replace(/\s*\(was: .*\)\s*$/, "");
  return t.replace(/\s*\((?:inferred|uncertain)\)/g, "").trim();
}

function questionOf(req: LlmRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  const content = first && "content" in first ? first.content : "";
  const q = content.match(/Question:\s*([\s\S]*?)(?:\n\nReply with a single JSON|$)/);
  return (q?.[1] ?? content).trim();
}

/** A value that satisfies a JSON Schema, filled from the best-matching fact where it is a string. */
function fill(schema: Record<string, unknown>, hint: string): unknown {
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== "null")
    : schema.type;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return fill(schema.anyOf[0] as Record<string, unknown>, hint);
  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, fill(v, hint)]));
    }
    case "array":
      return [];
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return hint || "unknown";
  }
}

export function offlineChatReply(req: LlmRequest): MockReply {
  const question = questionOf(req);
  const hasToolResults = req.messages.some((m) => m.role === "tool");
  // What the model can see: the pack, tool results ("## Facts" is their implicit heading), and the
  // research appended to the question when the tool loop ran out of rounds.
  const extra = req.messages.flatMap((m) => {
    if (m.role === "tool") return [`## Facts\n${m.content}`];
    const tail =
      m.role === "user"
        ? m.content.split("Additional material retrieved while researching")[1]
        : undefined;
    return tail ? [`## Facts\n${tail}`] : [];
  });
  const material = [req.context ?? "", ...extra].join("\n");

  // Tool levels: search once, then answer from what came back.
  if (req.tools?.length && !hasToolResults && req.messages.length === 1) {
    return {
      toolCalls: [
        { id: "call_mock_1", name: "search_memory", input: { query: question, top_k: 8 } },
      ],
    };
  }

  const all = parsePack(material);
  // A word found in most lines (typically the person's name) does not discriminate between them.
  const common = (t: string) =>
    all.length >= 3 && all.filter((l) => overlap([t], l.text) > 0).length > all.length * 0.6;
  const terms = queryTerms(question).filter((t) => !common(t));
  const wantsPast =
    /\b(used to|previous|before|formerly|originally|earlier|vroeger|eerder)\b/i.test(question);
  const lines = all.filter((l) => wantsPast || l.kind !== "history");
  const need = terms.length >= 4 ? 2 : 1;
  const scored = lines
    .map((l) => ({ l, s: overlap(terms, l.text) }))
    .filter((x) => x.s >= need)
    .sort((a, b) => b.s - a.s || (a.l.kind === "fact" ? -1 : 1));

  const best: Line[] = [];
  for (const { l } of scored) {
    if (best.length >= 3) break;
    if (!best.some((b) => b.label === l.label)) best.push(l);
  }

  if (req.jsonSchema)
    return { json: fill(req.jsonSchema.schema, best[0] ? factText(best[0].text, false) : "") };
  if (!best.length) return { text: "I don't have any information about that in memory." };
  const body = best
    .map((l) => {
      const t = factText(l.text, wantsPast).replace(/^\w+:\s+/, (m) =>
        l.kind === "excerpt" ? "" : m,
      );
      return `${t.endsWith(".") ? t.slice(0, -1) : t} [${l.label}]`;
    })
    .join("; ");
  return { text: `${body}.` };
}

let registered = false;
export function registerOfflineChat(): void {
  if (registered) return;
  registered = true;
  for (const level of ["minimal", "low", "medium", "high", "max"]) {
    MockProvider.register(`chat_${level}`, (req) => offlineChatReply(req));
  }
}
