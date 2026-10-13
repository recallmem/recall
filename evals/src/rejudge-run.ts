import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BeamProtocol, LEGACY_BEAM_PROTOCOL, parseBeamProtocol } from "./beam/protocol.js";
import { planDataset } from "./datasets/index.js";
import { createJudge, type Judge, LexicalJudge } from "./judge.js";
import { beamProtocols, buildResults, renderMarkdown } from "./report.js";
import type { QuestionRecord, Results, RunSettings, UnitRecord } from "./results.js";
import { beamFailed, judgeAnswer, judgingNeeded } from "./runner.js";
import type { EvalQuestion } from "./types.js";
import { formatDuration, mapPool, readJsonl } from "./util.js";

export interface RejudgeOptions {
  /**
   * Re-score every answered BEAM question whose score was not made with this protocol (BEAM runs
   * only). Without it, only the judgements that failed are redone, with the run's own protocol.
   */
  beamProtocol?: BeamProtocol;
  /** Questions judged at once. A question keeps one judge call in flight per judgement. */
  concurrency: number;
  log: (line: string) => void;
  /** Default: the run's own judge model, scoring BEAM with the target protocol. */
  judge?: Judge;
  /** The run's questions by id. Default: read from the downloaded dataset, else rebuilt from the records. */
  questions?: (
    units: ReadonlySet<string>,
    settings: RunSettings,
  ) => Promise<Map<string, EvalQuestion>>;
  /** Rewrite records.jsonl after this many judged questions, so an interrupted rejudge keeps its work. Default 25. */
  checkpointEvery?: number;
}

export interface RejudgeOutcome {
  /** Answers judged again. */
  judged: number;
  /** Judgements still missing afterwards (or BEAM scores still under another protocol). */
  left: number;
  /** The run's BEAM protocol afterwards (null without BEAM scoring). */
  protocol: string | null;
  /** The rewritten results, or null when there was nothing to do. */
  results: Results | null;
  /** Copies of the previous files, written when the protocol changed. */
  backups: string[];
}

/** The latest record per key: a unit or question run again replaces its earlier attempt. */
export const latestBy = <T>(items: T[], key: (t: T) => string) => [
  ...new Map(items.map((t) => [key(t), t])).values(),
];

export async function readResultsFile(path: string): Promise<Results> {
  const data = JSON.parse(await readFile(path, "utf8")) as Results;
  if (data.schema !== 1) throw new Error(`${path} is not a results.json written by this harness`);
  return data;
}

/** A question as the run asked it, rebuilt from its record (for when the dataset is not at hand). */
export function questionFromRecord(r: QuestionRecord): EvalQuestion {
  const b = r.beam;
  return {
    id: r.id,
    category: r.category,
    kind: r.kind,
    query: r.question,
    question: r.question,
    gold: r.gold,
    peer: r.peer,
    ...(b
      ? {
          beam: {
            ability: b.ability,
            nuggets: b.nuggets,
            reference: b.reference,
            ...(b.events ? { events: b.events } : {}),
            ...(b.rubric ? { rubric: b.rubric } : {}),
          },
        }
      : {}),
  };
}

async function datasetQuestions(
  units: ReadonlySet<string>,
  s: RunSettings,
): Promise<Map<string, EvalQuestion>> {
  const sources = (
    await planDataset(s.dataset, {
      order: "file",
      offset: 0,
      ...(s.beamSplit ? { beamSplit: s.beamSplit } : {}),
    })
  ).filter((src) => units.has(src.id));
  const out = new Map<string, EvalQuestion>();
  for (const src of sources) for (const q of (await src.load()).questions) out.set(q.id, q);
  return out;
}

const sameStrings = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Judges a finished run's stored answers again without asking anything: the judgements whose
 * calls failed, or (with `beamProtocol`) every BEAM score under another protocol. Rewrites
 * records.jsonl, results.json and results.md in `dir`; when the BEAM protocol changes, the previous
 * files are first copied to `records.<old protocol>.jsonl`, `results.<old protocol>.json` and `.md`.
 */
export async function rejudgeRun(dir: string, opts: RejudgeOptions): Promise<RejudgeOutcome> {
  const { log } = opts;
  const old = await readResultsFile(join(dir, "results.json"));
  const s = old.settings;
  const scoring = s.scoring ?? "rubric";
  const records = latestBy(
    await readJsonl<QuestionRecord>(join(dir, "records.jsonl")),
    (r) => r.id,
  );
  const units = latestBy(await readJsonl<UnitRecord>(join(dir, "units.jsonl")), (u) => u.unit);

  const hasBeam = scoring !== "rubric";
  if (opts.beamProtocol && !hasBeam)
    throw new Error("this run has no BEAM scores (--scoring rubric); --beam-protocol cannot apply");
  const recorded = s.beamScoring ?? beamProtocols(records)[0] ?? LEGACY_BEAM_PROTOCOL;
  const runProtocol = hasBeam ? parseBeamProtocol(recorded) : null;
  if (hasBeam && !runProtocol && !opts.beamProtocol)
    throw new Error(`unknown BEAM protocol ${recorded}; pass --beam-protocol`);
  const target: BeamProtocol | null = opts.beamProtocol ?? runProtocol;

  const judge =
    opts.judge ??
    (s.judge.kind === "lexical-offline"
      ? new LexicalJudge(target ? { beamProtocol: target } : {})
      : createJudge(s.judge.model, process.env, target ? { beamProtocol: target } : {}));
  if (target && judge.settings.beamProtocol !== target)
    throw new Error(`the judge scores BEAM with ${judge.settings.beamProtocol}, not ${target}`);

  const want = opts.beamProtocol;
  const todo = records
    .map((r) => ({ r, redo: judgingNeeded(r, scoring, want) }))
    .filter((x) => x.redo.rubric || x.redo.beam);
  // Failed requests keep their 0 under the new protocol; only the label changes.
  const relabel = want
    ? records.filter(
        (r) => r.error !== null && r.beam && (r.beam.protocol ?? LEGACY_BEAM_PROTOCOL) !== want,
      )
    : [];
  const beamTodo = todo.filter((x) => x.redo.beam).length;
  log(
    `${todo.length} of ${records.length} answers to judge${want ? ` (${beamTodo} BEAM scores with ${want})` : ""}; judge ${judge.settings.model}`,
  );
  if (!todo.length && !relabel.length && !(want && want !== s.beamScoring))
    return { judged: 0, left: 0, protocol: s.beamScoring ?? null, results: null, backups: [] };

  // The questions come from the dataset, as in the run; the records hold a copy as the fallback.
  const wanted = new Set([...todo.map((x) => x.r.unit), ...relabel.map((r) => r.unit)]);
  let questions = new Map<string, EvalQuestion>();
  try {
    questions = await (opts.questions ?? datasetQuestions)(wanted, s);
  } catch (err) {
    log(
      `dataset not available (${(err as Error).message.split("\n")[0]}); using the questions stored in records.jsonl`,
    );
  }
  const questionFor = (r: QuestionRecord): EvalQuestion => {
    const q = questions.get(r.id);
    // Only when it is the question the run scored (a re-downloaded dataset may differ).
    if (q && (!r.beam || (q.beam && sameStrings(q.beam.nuggets, r.beam.nuggets)))) return q;
    return questionFromRecord(r);
  };

  const backups: string[] = [];
  if (want && runProtocol !== want) {
    for (const [name, ext] of [
      ["records", "jsonl"],
      ["results", "json"],
      ["results", "md"],
    ] as const) {
      const from = join(dir, `${name}.${ext}`);
      const to = join(dir, `${name}.${recorded}.${ext}`);
      if ((await exists(from)) && !(await exists(to))) {
        await copyFile(from, to);
        backups.push(to);
      }
    }
    if (backups.length) log(`kept the ${recorded} files as ${backups.join(", ")}`);
  }

  for (const r of relabel) r.beam = beamFailed(questionFor(r), scoring, want as BeamProtocol);

  const writeRecords = () =>
    writeFile(join(dir, "records.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  let writes: Promise<unknown> = Promise.resolve();
  const every = opts.checkpointEvery ?? 25;
  const started = Date.now();
  let lastLog = started;
  let done = 0;
  let beamCalls = 0;
  let tokens = 0;
  let costUsd: number | null = 0;
  await mapPool(todo, opts.concurrency, async ({ r, redo }) => {
    const before = { tokens: r.judgeInputTokens + r.judgeOutputTokens, cost: r.judgeCostUsd };
    await judgeAnswer(judge, r, questionFor(r), scoring, redo);
    done++;
    if (redo.beam) beamCalls += r.beam?.judge?.calls ?? 0;
    tokens += r.judgeInputTokens + r.judgeOutputTokens - before.tokens;
    costUsd =
      costUsd === null || r.judgeCostUsd === null || before.cost === null
        ? null
        : costUsd + r.judgeCostUsd - before.cost;
    const now = Date.now();
    if (done % 10 === 0 || done === todo.length || now - lastLog > 30_000) {
      lastLog = now;
      log(
        `judged ${done} of ${todo.length} in ${formatDuration(now - started)}: ${beamCalls} BEAM judge calls, ${tokens.toLocaleString("en-US")} tokens, ${costUsd === null ? "cost unknown" : `$${costUsd.toFixed(4)}`}`,
      );
    }
    if (every > 0 && done % every === 0) writes = writes.then(writeRecords);
  });
  await writes;
  await writeRecords();

  const left = records.filter((r) => {
    const n = judgingNeeded(r, scoring, want);
    return n.rubric || n.beam;
  }).length;
  const { harnessVersion: _h, rubric: _r, serverModels: _m, beamScoring: _b, ...settings } = s;
  const results = buildResults(
    { ...settings, beamScoring: hasBeam ? target : null },
    records,
    units,
  );
  await writeFile(join(dir, "results.json"), JSON.stringify(results, null, 2));
  await writeFile(join(dir, "results.md"), renderMarkdown(results));
  log(`wrote ${join(dir, "results.json")}; ${left} answers still to judge`);
  return {
    judged: todo.length,
    left,
    protocol: results.settings.beamScoring ?? null,
    results,
    backups,
  };
}
