/**
 * Re-grades an existing run's answers with another rubric or judge, without
 * asking the questions again. Usage:
 *   tsx src/rejudge.ts <results dir> [--rubric strict|lenient] [--judge-model provider/model] [--concurrency 8]
 *   tsx src/rejudge.ts <results dir> --scoring beam [--beam-protocol ref|ours] [--judge-model provider/model]
 * Writes <dir>/rejudge-<rubric>.json (or rejudge-beam.json) and prints per-type accuracy, plus the
 * overall score reweighted to LoCoMo's full category mix when the run is LoCoMo. It leaves the run's
 * own files alone; `cli.ts rejudge` rewrites them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BEAM_PROTOCOL, parseBeamProtocol } from "./beam/protocol.js";
import { summarizeBeam } from "./beam/scoring.js";
import { isMockModel, type Judge, judgeConfig, LexicalJudge, LlmJudge } from "./judge.js";
import type { RubricName } from "./rubric.js";
import type { JudgeKind } from "./types.js";
import { wilson95 } from "./util.js";

/** Non-abstention LoCoMo questions per category in the full dataset (locomo10.json). */
const LOCOMO_MIX: Record<string, number> = {
  "single-hop": 841,
  temporal: 321,
  "multi-hop": 282,
  "open-domain": 96,
};

interface Rec {
  id: string;
  category: string;
  kind: JudgeKind;
  question: string;
  gold: string;
  answer: string | null;
  error: string | null;
  /** BEAM runs: the rubric the question was scored against. */
  beam?: {
    ability: string;
    nuggets: string[];
    events: string[] | null;
    reference: string;
    rubric?: string[];
  } | null;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rubric: { type: "string", default: "lenient" },
    scoring: { type: "string", default: "rubric" },
    "beam-protocol": { type: "string", default: DEFAULT_BEAM_PROTOCOL },
    "judge-model": { type: "string", default: process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-4.1" },
    concurrency: { type: "string", default: "8" },
  },
});
const dir = positionals[0];
if (!dir)
  throw new Error("usage: rejudge.ts <results dir> [--rubric strict|lenient] [--judge-model p/m]");
const rubric = values.rubric as RubricName;
const judgeModel = values["judge-model"] as string;
const beamProtocol = parseBeamProtocol(values["beam-protocol"] as string);
if (!beamProtocol) throw new Error("--beam-protocol must be ref or ours");
const judge: Judge = isMockModel(judgeModel)
  ? new LexicalJudge({ beamProtocol }) // offline stand-in, for trying the script without a key
  : new LlmJudge(judgeModel, judgeConfig(), rubric, { beamProtocol });
const recs: Rec[] = readFileSync(join(dir, "records.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

if (values.scoring === "beam") {
  const scored: { ability: string; score: number | null }[] = new Array(recs.length);
  let nextBeam = 0;
  await Promise.all(
    Array.from({ length: Number(values.concurrency) }, async () => {
      while (nextBeam < recs.length) {
        const i = nextBeam++;
        const r = recs[i] as Rec;
        if (!r.beam) {
          scored[i] = { ability: r.category, score: null };
          continue;
        }
        if (r.error || r.answer == null) {
          scored[i] = { ability: r.beam.ability, score: 0 }; // failed requests score 0, as in the main report
          continue;
        }
        const v = await judge.beam({
          question: r.question,
          response: r.answer,
          spec: {
            ability: r.beam.ability,
            nuggets: r.beam.nuggets,
            reference: r.beam.reference,
            ...(r.beam.events ? { events: r.beam.events } : {}),
            ...(r.beam.rubric ? { rubric: r.beam.rubric } : {}),
          },
        });
        scored[i] = { ability: r.beam.ability, score: v.score };
      }
    }),
  );
  const summary = summarizeBeam(scored.filter((x) => x.ability));
  writeFileSync(
    join(dir, "rejudge-beam.json"),
    JSON.stringify(
      { dir, protocol: beamProtocol, judge: judge.settings.model, ...summary },
      null,
      2,
    ),
  );
  console.log(
    `${dir.split("/").pop()}  [${beamProtocol}, ${judge.settings.model}]  overall ${summary.overall.mean?.toFixed(3)} (mean of ${summary.overall.abilitiesCovered}/${summary.overall.abilitiesTotal} abilities, ${summary.overall.questions} questions)`,
  );
  for (const a of summary.abilities)
    console.log(`   ${a.ability.padEnd(26)} n=${String(a.n).padEnd(4)} ${a.mean?.toFixed(3)}`);
  process.exit(0);
}

const verdicts = new Array<boolean>(recs.length);
let next = 0;
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < recs.length) {
      const i = next++;
      const r = recs[i]!;
      if (r.error || r.answer == null) {
        verdicts[i] = false; // failed requests count as wrong, as in the main report
        continue;
      }
      const v = await judge.judge({
        kind: r.kind,
        question: r.question,
        gold: r.gold,
        response: r.answer,
      });
      verdicts[i] = v.correct === true;
    }
  }),
);

const byCat = new Map<string, { n: number; ok: number }>();
recs.forEach((r, i) => {
  const c = byCat.get(r.category) ?? { n: 0, ok: 0 };
  c.n++;
  if (verdicts[i]) c.ok++;
  byCat.set(r.category, c);
});
const ok = verdicts.filter(Boolean).length;
const rows = [...byCat].map(([category, c]) => ({
  category,
  ...c,
  accuracy: c.ok / c.n,
  ci95: wilson95(c.ok, c.n),
}));
let reweighted: number | null = null;
if (rows.every((r) => r.category in LOCOMO_MIX)) {
  const w = rows.reduce((s, r) => s + LOCOMO_MIX[r.category]!, 0);
  reweighted = rows.reduce((s, r) => s + r.accuracy * LOCOMO_MIX[r.category]!, 0) / w;
}
const out = {
  dir,
  rubric: judge.settings.rubric,
  judge: judge.settings.model,
  n: recs.length,
  correct: ok,
  accuracy: ok / recs.length,
  reweightedToLocomoMix: reweighted,
  byCategory: rows,
};
writeFileSync(join(dir, `rejudge-${rubric}.json`), JSON.stringify(out, null, 2));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(
  `${dir.split("/").pop()}  [${out.rubric}, ${out.judge}]  overall ${ok}/${recs.length} = ${pct(out.accuracy)}${reweighted == null ? "" : `  | reweighted to LoCoMo mix: ${pct(reweighted)}`}`,
);
for (const r of rows)
  console.log(`   ${r.category.padEnd(12)} ${r.ok}/${r.n} = ${pct(r.accuracy)}`);
