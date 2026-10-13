/**
 * Re-grades a LongMemEval run with the benchmark's own judge, so scores can be set next to
 * numbers others publish: gpt-4o-2024-08-06, temperature 0, the per-type prompts below, and
 * "yes" anywhere in the reply counts as correct. Our rubric (rubric.ts) stays the default for
 * comparing our own runs; this is for comparing with the outside world.
 *
 *   tsx src/official-lme.ts <run dir> [--judge-model gpt-4o-2024-08-06] [--concurrency 8]
 *
 * Needs OPENAI_API_KEY (and OPENAI_BASE_URL for an OpenAI-compatible endpoint serving the same
 * model, e.g. Recall's operator route /admin/v1/openai, which runs it through OpenRouter). Writes <run dir>/official-lme.json and prints accuracy overall and by type.
 *
 * The prompt templates are copied verbatim from LongMemEval (src/evaluation/evaluate_qa.py,
 * https://github.com/xiaowu0162/LongMemEval), MIT License, Copyright (c) 2024 Di Wu:
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files, to deal in the Software without restriction, subject to
 * the condition that the above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mapPool, wilson95 } from "./util.js";

const STANDARD =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const TEMPORAL =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const UPDATE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const PREFERENCE =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const ABSTENTION =
  "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";

interface Rec {
  id: string;
  category: string;
  question: string;
  gold: string;
  answer: string | null;
  error: string | null;
}

/** The official prompt for one question; abstention questions are the ones whose id ends in _abs. */
export function officialPrompt(r: Rec): string {
  const template = r.id.endsWith("_abs")
    ? ABSTENTION
    : r.category === "temporal-reasoning"
      ? TEMPORAL
      : r.category === "knowledge-update"
        ? UPDATE
        : r.category === "single-session-preference"
          ? PREFERENCE
          : STANDARD;
  const parts = [r.question, r.gold, r.answer ?? ""];
  return template.replace(/\{\}/g, () => parts.shift() ?? "");
}

/** OpenAI, or an OpenAI-compatible endpoint serving the same model (OPENAI_BASE_URL). */
const BASE_URL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");

async function judge(prompt: string, model: string, key: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        n: 1,
        temperature: 0,
        max_tokens: 10,
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return body.choices[0]?.message.content ?? "";
    }
    if (attempt >= 5 || (res.status !== 429 && res.status < 500))
      throw new Error(`judge: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "judge-model": { type: "string", default: "gpt-4o-2024-08-06" },
      concurrency: { type: "string", default: "8" },
    },
  });
  const dir = positionals[0];
  if (!dir) throw new Error("usage: official-lme.ts <run dir> [--judge-model M] [--concurrency N]");
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const recs = readFileSync(join(dir, "records.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec);
  // The latest record per question wins (a resumed run appends its retries).
  const latest = [...new Map(recs.map((r) => [r.id, r])).values()];
  const model = values["judge-model"] as string;
  const graded = await mapPool(latest, Number(values.concurrency), async (r) => {
    // A failed request is wrong, as in the official script (an empty response cannot match).
    const reply = r.error ? "" : await judge(officialPrompt(r), model, key);
    return {
      id: r.id,
      category: r.category,
      correct: !r.error && reply.toLowerCase().includes("yes"),
      reply,
    };
  });
  const by = new Map<string, { n: number; ok: number }>();
  for (const g of graded) {
    const cat = g.id.endsWith("_abs") ? "abstention" : g.category;
    const b = by.get(cat) ?? { n: 0, ok: 0 };
    b.n++;
    if (g.correct) b.ok++;
    by.set(cat, b);
  }
  const ok = graded.filter((g) => g.correct).length;
  const summary = {
    judge: model,
    prompts: "LongMemEval evaluate_qa.py (official)",
    n: graded.length,
    correct: ok,
    accuracy: ok / graded.length,
    ci95: wilson95(ok, graded.length),
    byCategory: Object.fromEntries([...by].map(([c, b]) => [c, { ...b, accuracy: b.ok / b.n }])),
  };
  writeFileSync(join(dir, "official-lme.json"), JSON.stringify({ summary, graded }, null, 2));
  console.log(
    `official LongMemEval judge (${model}): ${(summary.accuracy * 100).toFixed(1)}% of ${graded.length}`,
  );
  for (const [c, b] of [...by].sort())
    console.log(
      `  ${c.padEnd(28)} ${String(b.ok).padStart(3)}/${String(b.n).padEnd(3)} ${((b.ok / b.n) * 100).toFixed(1)}%`,
    );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
