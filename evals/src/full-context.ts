/**
 * The "no memory system" baseline: a model reads a question's whole conversation history (about
 * 115,000 tokens per LongMemEval-S question) and answers. Writes records.jsonl in the harness's
 * format, so `official-lme.ts` grades it like any run and the two can be compared directly.
 *
 *   tsx src/full-context.ts --model openrouter/deepseek/deepseek-v4-flash --out DIR
 *        [--units FILE] [--limit N] [--concurrency 4]
 *
 * Needs OPENROUTER_API_KEY_EVAL (or OPENROUTER_API_KEY). Resumable: questions already in DIR are
 * skipped. Records the provider-reported cost of every call.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { planDataset } from "./datasets/index.js";
import type { EvalUnit } from "./types.js";
import { mapPool } from "./util.js";

const SYSTEM = `You answer questions about a user from the full record of their past conversations with an assistant. The record is below, oldest session first, each session with the date it took place.

Answer from the record only. When the question needs counting, totals, durations or the order of events, work it out carefully from every relevant session before answering. When something changed over time, the latest information counts unless the question asks about the past. If the record does not contain the answer, say that it does not. Keep the answer to one or two sentences.`;

/** The whole history as plain text: sessions oldest first, each turn as "role: text". */
export function transcript(unit: EvalUnit): string {
  return unit.sessions
    .map((s, i) => {
      const date = s.messages[0]?.createdAt.slice(0, 10) ?? "unknown date";
      const turns = s.messages.map((m) => `${m.peer}: ${m.content}`).join("\n");
      return `## Session ${i + 1} (${date})\n${turns}`;
    })
    .join("\n\n");
}

interface Reply {
  text: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}

async function ask(model: string, key: string, history: string, query: string): Promise<Reply> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: model.replace(/^openrouter\//, ""),
        messages: [
          { role: "system", content: `${SYSTEM}\n\n# Conversation record\n\n${history}` },
          { role: "user", content: query },
        ],
        max_tokens: 4000,
        temperature: 0,
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: body.choices?.[0]?.message?.content ?? "",
        costUsd: body.usage?.cost ?? null,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      };
    }
    if (attempt >= 4 || (res.status !== 429 && res.status < 500))
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      model: { type: "string" },
      out: { type: "string" },
      units: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
    },
  });
  if (!v.model || !v.out)
    throw new Error("usage: full-context.ts --model M --out DIR [--units FILE]");
  const key = process.env.OPENROUTER_API_KEY_EVAL ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY_EVAL (or OPENROUTER_API_KEY) is not set");
  await mkdir(v.out, { recursive: true });
  const recordsPath = join(v.out, "records.jsonl");
  const done = new Set(
    (await readFile(recordsPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { unit: string; error: string | null })
      .filter((r) => !r.error)
      .map((r) => r.unit),
  );
  let planned = await planDataset("longmemeval", {
    order: "file",
    offset: 0,
    ...(v.limit ? { limit: Number(v.limit) } : {}),
  });
  if (v.units) {
    const wanted = new Set(
      (await readFile(v.units, "utf8"))
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    planned = planned.filter((s) => wanted.has(s.id));
  }
  const todo = planned.filter((s) => !done.has(s.id));
  await writeFile(
    join(v.out, "run.json"),
    JSON.stringify(
      { kind: "full-context", model: v.model, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.error(
    `full context with ${v.model}: ${todo.length} of ${planned.length} questions to ask`,
  );
  let n = 0;
  let spent = 0;
  await mapPool(todo, Number(v.concurrency), async (source) => {
    const unit = await source.load();
    const history = transcript(unit);
    for (const q of unit.questions) {
      const t0 = performance.now();
      let rec: {
        answer: string | null;
        error: string | null;
        costUsd?: number | null;
        inputTokens?: number;
        outputTokens?: number;
      };
      try {
        const r = await ask(v.model as string, key, history, q.query);
        spent += r.costUsd ?? 0;
        rec = {
          answer: r.text,
          error: null,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
        };
      } catch (err) {
        rec = { answer: null, error: (err as Error).message };
      }
      const row = {
        unit: unit.id,
        id: q.id,
        category: q.category,
        kind: q.kind,
        question: q.question,
        gold: q.gold,
        latencyMs: Math.round(performance.now() - t0),
        ...rec,
      };
      await appendFile(recordsPath, `${JSON.stringify(row)}\n`);
      n++;
      console.error(
        `[${n}/${todo.length}] ${row.error ? "ERR" : "ok "} ${q.category.padEnd(26)} $${spent.toFixed(3)}`,
      );
    }
  });
}

// Run as a command, not when imported (tests import transcript()).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
