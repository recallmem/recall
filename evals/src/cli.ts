#!/usr/bin/env -S node --import tsx
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type BeamProtocol,
  DEFAULT_BEAM_PROTOCOL,
  LEGACY_BEAM_PROTOCOL,
  parseBeamProtocol,
} from "./beam/protocol.js";
import { BEAM_ABILITIES } from "./beam/scoring.js";
import { MemoryApi } from "./client.js";
import { planDataset } from "./datasets/index.js";
import { downloadAll } from "./download.js";
import { estimateRun, renderEstimate } from "./estimate.js";
import { createJudge, isMockModel, judgeConfig } from "./judge.js";
import { rejudgeRun } from "./rejudge-run.js";
import { buildResults, renderComparison, renderMarkdown } from "./report.js";
import type { QuestionRecord, Results, RunSettings, ScoringMode, UnitRecord } from "./results.js";
import { type RunOptions, runAll, storedUnits, workspaceName } from "./runner.js";
import {
  BEAM_SPLITS,
  type BeamSplit,
  DATASET_NAMES,
  type DatasetName,
  isBeamSplit,
} from "./sources.js";
import { LEVELS, type ReasoningLevel } from "./types.js";
import { formatDuration, readJsonl, slug } from "./util.js";
import { Vault } from "./vault.js";

/** Seconds to wait for a BEAM conversation's background processing, by conversation length. */
const BEAM_DRAIN_TIMEOUT_S: Record<BeamSplit, number> = {
  "100k": 1200,
  "500k": 3600,
  "1m": 7200,
  "10m": 28800,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "results");

const USAGE = `Memory benchmark for any Honcho-compatible server.

  download [--dataset longmemeval|locomo|beam|all] [--beam-split 100k,500k,1m,10m|all] [--force]
      Fetch the datasets into evals/data/ (LongMemEval-S is about 277 MB). BEAM comes from the
      Hugging Face datasets-server, one conversation per request (100K 14 MB, 500K 84 MB, 1M ~170 MB;
      default splits 100k,500k,1m). The 10M split cannot be served that way, see the README.

  run --dataset longmemeval|locomo|beam [options]
      --beam-split S           BEAM only: conversation length 100k|500k|1m|10m (required for beam)
      --scoring MODE           rubric (pass/fail rubric-v1) | beam (BEAM's own scores) | both. Default:
                               both for beam, rubric otherwise
      --beam-protocol P        how BEAM's scores are computed (beam only):
                                 ref  = BEAM's own evaluation code (commit b2da22e) with its judge prompts:
                                        one judge call per rubric item (llm_judge_score), event ordering
                                        tau_norm from line-by-line yes/no alignment (protocol
                                        beam-ref-b2da22e; the default, use --judge-model openai/gpt-4.1-mini
                                        to match BEAM's judge)
                                 ours = this harness's earlier prompts, one call per question, tau-b
                                        clipped at 0 (beam-nuggets-v1)
                               --resume keeps the protocol the run started with
      --target-url URL         server base URL (default http://localhost:8000; env EVAL_TARGET_URL)
      --api-key KEY            bearer token, if the server needs one (env EVAL_API_KEY)
      --limit N                number of questions (default: all). Selection is deterministic and
                               round-robin across question types, identical for every target
      --offset N               skip the first N selected questions
      --per-unit N             at most N questions from each conversation (stratified), so a
                               sample covers every conversation instead of the first ones
      --types a,b              only these question types (e.g. temporal-reasoning,abstention; for beam
                               the abilities: abstention, event-ordering, knowledge-update, ...)
      --order stratified|file  how --limit picks questions (default stratified)
      --level LEVEL            reasoning_level for chat: minimal|low|medium|high|max (default low)
      --concurrency N          workspaces processed in parallel (default 4)
      --question-concurrency N questions in flight inside one workspace (default 1)
      --judge-model P/M        judge model, e.g. openai/gpt-4o-2024-08-06, openai/gpt-4.1-mini,
                               openrouter/<model>, compat/<model> (env EVAL_JUDGE_MODEL).
                               "mock" selects an offline lexical judge for smoke tests only.
      --cost-model auto|recall|honcho
                               recall = read GET /usage (exact); honcho = estimate from the
                               published price list (default auto: probe the server)
      --observe-others         peers also build views of each other (default off)
      --dream                  schedule a dream for each observed peer before asking
      --label NAME             name shown in reports (default: target host)
      --note TEXT              free text recorded in the report (e.g. the server's models)
      --out DIR                output directory (default evals/results/<run>-<label>)
      --resume                 continue a previous run in --out: finished workspaces are skipped,
                               failed ones are asked again in their stored messages
      --cleanup                delete the benchmark workspaces afterwards. By default they are kept, so
                               a later run can ask again with --reuse (remove them with \`cleanup\`)
      --vault                  also push the run to the bench-results branch of the checkout's origin
                               (created when missing), every 10 minutes and at the end. Optional:
                               without it a run is pushed only when origin already has that branch
      --no-vault               never push the run to a branch
      --plan JSON              Recall retrieves with these settings, e.g. '{"facts":60,"budget":12000}'
                               (X-Recall-Plan; the account must be enabled by the operator)
      --team A,W               Recall answers with two models together: A works the question out,
                               W checks that against memory and writes the answer (X-Recall-Team)
      --answer-model P/M       Recall answers with this model (X-Recall-Answer-Model; the account must
                               be enabled by the operator), e.g. openrouter/<vendor>/<model>
      --reuse RUN_ID           ask again in the workspaces an earlier run kept (RUN_ID is in its
                               run.json): a workspace that already holds its messages is not ingested
                               again, a missing one is ingested, and nothing is deleted afterwards
      --stored-only            with --reuse: skip the units whose workspaces no longer hold their messages
      --units FILE             only these units (one unit id per line, e.g. lme-6aeb4375_abs)
      --trust-stored           with --reuse: do not count the stored messages again (for workspaces an
                               earlier --stored-only run verified; saves a request per session)
      --drain-timeout S        seconds to wait for background processing (default 900; beam: 1200 for
                               100k, 3600 for 500k, 7200 for 1m, 28800 for 10m)
      --quality-window N       stop starting workspaces when, over the last N answers, 10% or more are
                               empty or accuracy is 30 points below the first N (default 40; 0 = off)
      --strict-drain           a workspace still processing after --drain-timeout fails instead of being
                               asked on half-built memory (it stays stored; --resume asks it later)
      --max-usd N              refuse to start when the estimated cost (see the estimate command) exceeds N
      --no-estimate            do not print the cost estimate before the run
      --chat-timeout S         seconds per chat request (default 180)

  estimate --dataset ... [selection flags as for run] [--level L]
      Offline cost estimate for the selected workload (messages, tokens, USD for ingest, queries and
      judge). Nothing is sent anywhere; run it before every paid run.

  vault save <dir>... [--name NAME] [--log FILE]
      Copy finished or partial run directories to the bench-results branch of origin (created when
      missing) and push them (run does this by itself with --vault; this is for older runs and
      other machines).

  rejudge <run dir> [--beam-protocol ref|ours] [--concurrency N] [--vault | --no-vault]
      Judge the stored answers of a finished run again and rewrite records.jsonl, results.json and
      results.md, with the run's own judge model. Nothing is asked again. Without --beam-protocol: only
      the answers whose judge calls failed (e.g. the judge's account ran out of credit). With it (BEAM
      runs): every BEAM score not yet made with that protocol, e.g. to move a beam-nuggets-v1 run to
      BEAM's own scoring; the previous files are kept as records.<old protocol>.jsonl and
      results.<old protocol>.json/.md, and an interrupted rejudge continues where it stopped.
      --concurrency N questions judged at once (default 8; each makes its BEAM judge calls one at a time).

  cleanup --run RUN_ID [--yes] [--target-url URL] [--api-key KEY]
      Delete the workspaces a run kept (lists them without --yes).

  report <results.json> [--out FILE]      re-render the Markdown summary
  compare <a.json> <b.json> [--out FILE]  side-by-side tables for two runs
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const int = (v: string | undefined, name: string, min = 0): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}`);
  return n;
};

/** URL without credentials or query string, safe to print and store. */
function publicUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return fail(`invalid --target-url: ${raw}`);
  }
}

async function cmdDownload(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dataset: { type: "string", default: "all" },
      "beam-split": { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const names: DatasetName[] =
    values.dataset === "all"
      ? DATASET_NAMES
      : DATASET_NAMES.includes(values.dataset as DatasetName)
        ? [values.dataset as DatasetName]
        : fail(`--dataset must be one of ${DATASET_NAMES.join(", ")}, all`);
  const requested = values["beam-split"];
  const beamSplits: BeamSplit[] | undefined =
    requested === undefined
      ? undefined
      : requested === "all"
        ? [...BEAM_SPLITS]
        : requested.split(",").map((x) => {
            const split = x.trim().toLowerCase();
            return isBeamSplit(split)
              ? split
              : fail(`--beam-split must be a list of ${BEAM_SPLITS.join(", ")} or all`);
          });
  await downloadAll(names, { force: values.force, beamSplits, log: (l) => console.error(l) });
}

interface SelectionFlags {
  dataset?: string;
  "beam-split"?: string;
  scoring?: string;
  limit?: string;
  offset?: string;
  "per-unit"?: string;
  types?: string;
  order?: string;
}

/** The flags that decide which questions are asked; shared by `run` and `estimate`. */
function parseSelection(v: SelectionFlags) {
  const dataset = v.dataset as DatasetName;
  if (!DATASET_NAMES.includes(dataset))
    fail(`--dataset must be one of ${DATASET_NAMES.join(", ")}`);
  if (v.order !== "stratified" && v.order !== "file") fail("--order must be stratified or file");
  let beamSplit: BeamSplit | undefined;
  if (dataset === "beam") {
    const raw = v["beam-split"]?.toLowerCase();
    if (!raw || !isBeamSplit(raw)) fail(`--beam-split must be one of ${BEAM_SPLITS.join(", ")}`);
    beamSplit = raw as BeamSplit;
  } else if (v["beam-split"]) fail("--beam-split only applies to --dataset beam");
  const scoring = (v.scoring ?? (dataset === "beam" ? "both" : "rubric")) as ScoringMode;
  if (!["rubric", "beam", "both"].includes(scoring)) fail("--scoring must be rubric, beam or both");
  if (scoring !== "rubric" && dataset !== "beam")
    fail("--scoring beam|both needs --dataset beam (the nuggets exist only there)");
  const types = v.types
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (dataset === "beam" && types) {
    const bad = types.filter((t) => !(BEAM_ABILITIES as readonly string[]).includes(t));
    if (bad.length)
      fail(`unknown BEAM ability ${bad.join(", ")}; use ${BEAM_ABILITIES.join(", ")}`);
  }
  const limit = int(v.limit, "limit", 1);
  const offset = int(v.offset, "offset") ?? 0;
  const perUnit = int(v["per-unit"], "per-unit", 1);
  const select = {
    limit,
    offset,
    types,
    order: v.order as "stratified" | "file",
    ...(perUnit ? { perUnit } : {}),
    ...(beamSplit ? { beamSplit } : {}),
  };
  return { dataset, beamSplit, scoring, types, limit, offset, perUnit, select };
}

async function cmdRun(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      "target-url": { type: "string" },
      "api-key": { type: "string" },
      dataset: { type: "string" },
      "beam-split": { type: "string" },
      scoring: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      "per-unit": { type: "string" },
      types: { type: "string" },
      order: { type: "string", default: "stratified" },
      level: { type: "string", default: "low" },
      concurrency: { type: "string", default: "4" },
      "question-concurrency": { type: "string", default: "1" },
      "judge-model": { type: "string" },
      "beam-protocol": { type: "string" },
      "cost-model": { type: "string", default: "auto" },
      "observe-others": { type: "boolean", default: false },
      dream: { type: "boolean", default: false },
      label: { type: "string" },
      note: { type: "string" },
      out: { type: "string" },
      resume: { type: "boolean", default: false },
      keep: { type: "boolean", default: true },
      cleanup: { type: "boolean", default: false },
      vault: { type: "boolean", default: false },
      "no-vault": { type: "boolean", default: false },
      reuse: { type: "string" },
      "stored-only": { type: "boolean", default: false },
      units: { type: "string" },
      "trust-stored": { type: "boolean", default: false },
      "answer-model": { type: "string" },
      plan: { type: "string" },
      team: { type: "string" },
      "drain-timeout": { type: "string" },
      "strict-drain": { type: "boolean", default: false },
      "quality-window": { type: "string", default: "40" },
      "max-usd": { type: "string" },
      "no-estimate": { type: "boolean", default: false },
      "chat-timeout": { type: "string", default: "180" },
    },
  });

  const { dataset, beamSplit, scoring, types, limit, offset, perUnit, select } = parseSelection(v);
  const level = v.level as ReasoningLevel;
  if (!LEVELS.includes(level)) fail(`--level must be one of ${LEVELS.join(", ")}`);
  if (v.plan !== undefined) {
    try {
      if (typeof JSON.parse(v.plan) !== "object") throw new Error();
    } catch {
      fail("--plan must be a JSON object");
    }
  }
  if (!["auto", "recall", "honcho"].includes(v["cost-model"] as string))
    fail("--cost-model must be auto, recall or honcho");
  let beamProtocol: BeamProtocol = DEFAULT_BEAM_PROTOCOL;
  const requestedProtocol = v["beam-protocol"];
  if (requestedProtocol !== undefined) {
    if (scoring === "rubric")
      fail("--beam-protocol applies to BEAM's own scores (--dataset beam, --scoring beam|both)");
    beamProtocol =
      parseBeamProtocol(requestedProtocol) ?? fail("--beam-protocol must be ref or ours");
  }

  const targetUrl = (
    v["target-url"] ??
    process.env.EVAL_TARGET_URL ??
    "http://localhost:8000"
  ).replace(/\/+$/, "");
  const apiKey = v["api-key"] ?? process.env.EVAL_API_KEY;
  const label = v.label ?? process.env.EVAL_LABEL ?? slug(new URL(targetUrl).host, 40);

  let judgeModel = v["judge-model"] ?? process.env.EVAL_JUDGE_MODEL;
  if (!judgeModel) {
    const fallback = judgeConfig().models.chat_low;
    if (isMockModel(fallback)) {
      fail(
        "no judge configured. Set --judge-model provider/model (with that provider's API key in the environment), or --judge-model mock for an offline smoke test.",
      );
    }
    judgeModel = fallback;
    console.error(
      `note: no --judge-model given, using ${judgeModel} (cheapest model of the configured providers)`,
    );
  }
  let judge: ReturnType<typeof createJudge>;
  try {
    judge = createJudge(judgeModel, process.env, { beamProtocol });
  } catch (err) {
    return fail(`cannot use judge model ${judgeModel}: ${(err as Error).message}`);
  }

  // Output directory and run id (kept across --resume so workspace names stay stable).
  const startedAtDefault = new Date().toISOString();
  let runId = Date.now().toString(36);
  let startedAt = startedAtDefault;
  const out = resolve(
    v.out ?? join(RESULTS_DIR, `${startedAtDefault.slice(0, 10)}-${runId}-${label}`),
  );
  await mkdir(out, { recursive: true });
  const runFile = join(out, "run.json");
  const prior = v.resume
    ? await readFile(runFile, "utf8").then(
        (t) => JSON.parse(t) as { runId: string; startedAt: string },
        () => null,
      )
    : null;
  if (prior) {
    runId = prior.runId;
    startedAt = prior.startedAt;
  }
  // --reuse: the workspaces are named after the run that created them (see workspaceName).
  if (v.reuse !== undefined) {
    if (!/^[a-z0-9]+$/i.test(v.reuse))
      fail("--reuse takes the run id of an earlier run (run.json)");
    if (prior && prior.runId !== v.reuse)
      fail(`--resume continues run ${prior.runId}; it cannot switch to --reuse ${v.reuse}`);
    runId = v.reuse;
  }
  await writeFile(runFile, JSON.stringify({ runId, startedAt }, null, 2));

  const log = (line: string) => console.error(line);
  const api = new MemoryApi(targetUrl, apiKey);

  // Fail fast when nothing is listening, instead of retrying every workspace.
  try {
    await fetch(`${targetUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    fail(`cannot reach ${targetUrl}: ${(err as Error).message}`);
  }

  // Which cost model applies? A server with the usage endpoint reports exact cost.
  let costModel: RunSettings["costModel"];
  const requested = v["cost-model"];
  if (requested === "recall") costModel = "recall-metered";
  else if (requested === "honcho") costModel = "honcho-list-estimate";
  else {
    const probe = workspaceName(runId, "probe");
    await api
      .createWorkspace(probe, { eval_run: runId, eval_unit: "probe" })
      .catch((e) => fail(`cannot create a workspace on ${targetUrl}: ${(e as Error).message}`));
    costModel = (await api.usage(probe).catch(() => null))
      ? "recall-metered"
      : "honcho-list-estimate";
    await api.deleteWorkspace(probe).catch(() => undefined);
  }
  log(`cost model: ${costModel}`);

  let planned = await planDataset(dataset, select);
  if (v.units) {
    const wanted = new Set(
      (await readFile(v.units, "utf8"))
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    planned = planned.filter((s) => wanted.has(s.id));
    if (planned.length < wanted.size)
      log(`--units: ${wanted.size - planned.length} listed unit(s) are not in the selection`);
  }
  if (v["trust-stored"] && v.reuse === undefined) fail("--trust-stored needs --reuse");
  if (v["stored-only"] && !v["trust-stored"]) {
    if (v.reuse === undefined) fail("--stored-only needs --reuse");
    // Only the units whose workspaces still hold their messages: nothing is ingested again.
    const stored = await storedUnits(api, runId, planned);
    log(`--stored-only: ${stored.size} of ${planned.length} workspaces hold their messages`);
    planned = planned.filter((s) => stored.has(s.id));
  }
  if (planned.length === 0) fail("the selection is empty");

  const recordsPath = join(out, "records.jsonl");
  const unitsPath = join(out, "units.jsonl");
  if (!v.resume) await Promise.all([writeFile(recordsPath, ""), writeFile(unitsPath, "")]);
  const priorRecords = v.resume ? await readJsonl<QuestionRecord>(recordsPath) : [];
  const priorUnits = v.resume ? await readJsonl<UnitRecord>(unitsPath) : [];
  // A resumed run keeps the BEAM protocol it started with, so its scores stay comparable.
  const priorBeam = priorRecords.find((r) => r.beam)?.beam;
  if (priorBeam && scoring !== "rubric") {
    const prior = priorBeam.protocol ?? LEGACY_BEAM_PROTOCOL;
    if (requestedProtocol !== undefined && prior !== beamProtocol)
      fail(
        `this run was scored with ${prior}; finish it with that protocol, then re-score it with rejudge --beam-protocol`,
      );
    if (prior !== beamProtocol) {
      beamProtocol = parseBeamProtocol(prior) ?? fail(`unknown BEAM protocol ${prior} in records`);
      judge = createJudge(judgeModel, process.env, { beamProtocol });
    }
  }
  // Finished = answered without errors; a unit with failed questions (an outage) is asked again.
  const finished = new Set(
    priorUnits
      .filter((u) => {
        const recs = priorRecords.filter((r) => r.unit === u.unit);
        return u.error === null && recs.length > 0 && recs.every((r) => r.error === null);
      })
      .map((u) => u.unit),
  );
  const todo = planned.filter((s) => !finished.has(s.id));
  const totalQuestions = planned.reduce((n, s) => n + s.questionCount, 0);
  const remainingQuestions = todo.reduce((n, s) => n + s.questionCount, 0);
  log(
    `${dataset}${beamSplit ? ` ${beamSplit}` : ""}: ${totalQuestions} questions in ${planned.length} workspaces${finished.size ? ` (${finished.size} already done)` : ""}, level ${level}, target ${publicUrl(targetUrl)}`,
  );
  const protocolNote = scoring === "rubric" ? "" : `, BEAM protocol ${beamProtocol}`;
  if (judge.settings.kind === "lexical-offline")
    log(
      `judge: offline lexical stand-in (smoke test only, accuracy is not meaningful)${protocolNote}`,
    );
  else log(`judge: ${judge.settings.model}${protocolNote}`);

  // Large conversations need longer to drain; an explicit flag always wins.
  const drainTimeoutS =
    int(v["drain-timeout"], "drain-timeout", 1) ??
    (beamSplit ? BEAM_DRAIN_TIMEOUT_S[beamSplit] : 900);

  if (judge.settings.kind === "llm" && todo.length > 0 && !v["no-estimate"]) {
    const reused = v.reuse !== undefined ? await storedUnits(api, runId, todo) : undefined;
    const estimate = await estimateRun(todo, { dataset, beamSplit, level, scoring, reused });
    log(renderEstimate(estimate));
    const maxUsd = Number(v["max-usd"]);
    if (v["max-usd"] !== undefined && !(maxUsd >= 0)) fail("--max-usd must be a number >= 0");
    if (v["max-usd"] !== undefined && estimate.usd.total > maxUsd)
      fail(
        `the estimated cost $${estimate.usd.total.toFixed(2)} exceeds --max-usd ${maxUsd}; narrow the selection (--limit, --per-unit) or raise the cap`,
      );
  }

  const opts: RunOptions = {
    runId,
    dataset,
    level,
    concurrency: int(v.concurrency, "concurrency", 1) as number,
    questionConcurrency: int(v["question-concurrency"], "question-concurrency", 1) as number,
    drainTimeoutMs: drainTimeoutS * 1000,
    strictDrain: v["strict-drain"] as boolean,
    qualityGuard: {
      window: int(v["quality-window"], "quality-window", 0) as number,
      maxEmptyShare: 0.1,
      maxAccuracyDrop: 0.3,
    },
    chatTimeoutMs: (int(v["chat-timeout"], "chat-timeout", 1) as number) * 1000,
    observeOthers: v["observe-others"] as boolean,
    dream: v.dream as boolean,
    cleanup: v.cleanup === true && v.reuse === undefined,
    // A resumed unit asks again in what it already stored instead of storing it twice.
    reuse: v.reuse !== undefined || v.resume === true,
    trustStored: v["trust-stored"] as boolean,
    ...(v["answer-model"] ? { answerModel: v["answer-model"] as string } : {}),
    ...(v.plan ? { plan: v.plan } : {}),
    ...(v.team ? { team: v.team } : {}),
    meterUsage: costModel === "recall-metered",
    scoring,
    log,
  };

  // A spent monthly budget pauses background work and refuses chat (402): every answer would be
  // an error, so do not start. Accounts whose key cannot read the budget skip this check.
  if (todo.length > 0) {
    const budget = await api.budget().catch(() => null);
    if (budget?.exceeded)
      fail(
        `the account's monthly budget is spent ($${budget.spentUsd.toFixed(2)} of $${budget.limitUsd}); raise it before running`,
      );
    if (budget?.limitUsd != null)
      log(
        `budget: $${(budget.limitUsd - budget.spentUsd).toFixed(2)} of $${budget.limitUsd} left this month`,
      );
  }

  // With the vault, results leave this machine while the run goes: every 10 minutes, at the end,
  // and on Ctrl-C.
  const vault = await openVault(v, log);
  if (!vault && !v["no-vault"])
    log(
      v.vault
        ? "vault: cannot push to bench-results (not a git checkout with a remote); keep --out safe yourself"
        : "vault: off (origin has no bench-results branch; --vault creates it); keep --out safe yourself",
    );
  const checkpoint = vault ? setInterval(() => void vault.save(out), 10 * 60_000) : null;
  checkpoint?.unref();
  const onSignal = (signal: NodeJS.Signals) => {
    log(`${signal}: saving what is done; continue with --resume --out ${out}`);
    void writes.then(() => vault?.save(out)).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let answered = 0;
  const started = Date.now();
  // Appends are chained so lines never interleave and all land before we exit.
  let writes: Promise<unknown> = Promise.resolve();
  const append = (path: string, row: unknown) => {
    writes = writes.then(() => appendFile(path, `${JSON.stringify(row)}\n`)).catch(() => undefined);
  };
  const run = await runAll(api, judge, todo, opts, {
    onQuestion: (r) => {
      answered++;
      const mark = r.error ? "ERR" : r.correct === null ? "???" : r.correct ? "ok " : "no ";
      log(
        `[${answered}/${remainingQuestions}] ${mark} ${r.category.padEnd(26)} ${r.latencyMs !== null ? `${r.latencyMs} ms` : r.error?.slice(0, 80)}`,
      );
      append(recordsPath, r);
    },
    onUnit: (u) => {
      append(unitsPath, u);
    },
  });

  await writes;
  if (checkpoint) clearInterval(checkpoint);
  if (run.stopped) {
    await vault?.save(out);
    log(
      `stopped early: ${run.units.length} of ${todo.length} workspaces ran. Fix the cause (provider, budget) and continue with --resume --out ${out}`,
    );
    process.exit(1);
  }
  // The latest record wins: a unit that was run again replaces its earlier (failed) attempt.
  const latest = <T>(items: T[], key: (t: T) => string) => [
    ...new Map(items.map((t) => [key(t), t])).values(),
  ];
  const records = latest(
    [...priorRecords.filter((r) => finished.has(r.unit)), ...run.records],
    (r) => r.id,
  );
  const units = latest(
    [...priorUnits.filter((u) => finished.has(u.unit)), ...run.units],
    (u) => u.unit,
  );
  const results = buildResults(
    {
      label,
      note: v.note ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      target: { url: publicUrl(targetUrl), authenticated: Boolean(apiKey) },
      dataset,
      beamSplit: beamSplit ?? null,
      scoring,
      beamScoring: scoring === "rubric" ? null : beamProtocol,
      selection: {
        limit: limit ?? null,
        offset,
        perUnit: perUnit ?? null,
        types: types ?? null,
        order: select.order,
        questions: totalQuestions,
        units: planned.length,
      },
      level,
      concurrency: opts.concurrency,
      questionConcurrency: opts.questionConcurrency,
      observeOthers: opts.observeOthers,
      dream: opts.dream,
      judge: { kind: judge.settings.kind, model: judge.settings.model },
      answerModel: opts.answerModel ?? null,
      plan: opts.plan ?? null,
      team: opts.team ?? null,
      costModel,
    },
    records,
    units,
  );
  await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
  const md = renderMarkdown(results);
  await writeFile(join(out, "results.md"), md);
  console.log(md);
  log(
    `finished in ${formatDuration(Date.now() - started)}; wrote ${join(out, "results.json")} and results.md`,
  );
  await vault?.save(out);

  const failed = results.summary.ingest.failedWorkspaces;
  if (failed) log(`warning: ${failed} workspace(s) failed; their questions are counted as errors`);
  const cleaned = units.filter((u) => u.cleanedUp === false).length;
  if (cleaned)
    log(
      `warning: could not delete ${cleaned} workspace(s) (servers that delete asynchronously may need a retry); names start with ev-${runId}-`,
    );
  if (results.summary.latencyMs.n === 0) process.exit(1);
}

async function cmdEstimate(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      dataset: { type: "string" },
      "beam-split": { type: "string" },
      scoring: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      "per-unit": { type: "string" },
      types: { type: "string" },
      order: { type: "string", default: "stratified" },
      level: { type: "string", default: "low" },
      "ingest-usd-per-mtok": { type: "string" },
      "query-usd": { type: "string" },
    },
  });
  const { dataset, beamSplit, scoring, select } = parseSelection(v);
  const level = v.level as ReasoningLevel;
  if (!LEVELS.includes(level)) fail(`--level must be one of ${LEVELS.join(", ")}`);
  const planned = await planDataset(dataset, select);
  if (planned.length === 0) fail("the selection is empty");
  const num = (raw: string | undefined, name: string) => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fail(`--${name} must be a number >= 0`);
  };
  const estimate = await estimateRun(planned, {
    dataset,
    beamSplit,
    level,
    scoring,
    rates: {
      ...(num(v["ingest-usd-per-mtok"], "ingest-usd-per-mtok") !== undefined && {
        ingestUsdPerMTok: num(v["ingest-usd-per-mtok"], "ingest-usd-per-mtok") as number,
      }),
      ...(num(v["query-usd"], "query-usd") !== undefined && {
        queryUsd: num(v["query-usd"], "query-usd") as number,
      }),
    },
  });
  console.log(renderEstimate(estimate));
}

async function readResults(path: string): Promise<Results> {
  const data = JSON.parse(await readFile(path, "utf8")) as Results;
  if (data.schema !== 1) fail(`${path} is not a results.json written by this harness`);
  return data;
}

async function emit(text: string, outPath: string | undefined) {
  if (outPath) {
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(outPath, text);
    console.error(`wrote ${outPath}`);
  }
  console.log(text);
}

async function cmdCleanup(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      run: { type: "string" },
      yes: { type: "boolean", default: false },
      "target-url": { type: "string" },
      "api-key": { type: "string" },
    },
  });
  if (!v.run || !/^[a-z0-9]+$/i.test(v.run)) fail("usage: cleanup --run RUN_ID [--yes]");
  const targetUrl = (
    v["target-url"] ??
    process.env.EVAL_TARGET_URL ??
    "http://localhost:8000"
  ).replace(/\/+$/, "");
  const api = new MemoryApi(targetUrl, v["api-key"] ?? process.env.EVAL_API_KEY);
  const ids = await api.listRunWorkspaces(v.run);
  console.error(`${ids.length} workspace(s) of run ${v.run} on ${publicUrl(targetUrl)}`);
  if (!v.yes) {
    for (const id of ids.slice(0, 20)) console.error(`  ${id}`);
    if (ids.length > 20) console.error(`  ... and ${ids.length - 20} more`);
    console.error("nothing deleted; add --yes to delete them");
    return;
  }
  let deleted = 0;
  for (const id of ids) {
    try {
      // A workspace that still has sessions cannot be deleted.
      for (const session of await api.listSessions(id)) await api.deleteSession(id, session);
      await api.deleteWorkspace(id);
      deleted++;
    } catch (err) {
      console.error(`  ${id}: ${(err as Error).message}`);
    }
  }
  console.error(`deleted ${deleted} of ${ids.length}`);
  if (deleted < ids.length) process.exit(1);
}

async function cmdRejudge(argv: string[]) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "beam-protocol": { type: "string" },
      concurrency: { type: "string", default: "8" },
      vault: { type: "boolean", default: false },
      "no-vault": { type: "boolean", default: false },
    },
  });
  const dir = positionals[0];
  if (!dir)
    fail(
      "usage: rejudge <run dir> [--beam-protocol ref|ours] [--concurrency N] [--vault | --no-vault]",
    );
  const raw = v["beam-protocol"];
  const beamProtocol =
    raw === undefined
      ? undefined
      : (parseBeamProtocol(raw) ?? fail("--beam-protocol must be ref or ours"));
  const log = (line: string) => console.error(line);
  let outcome: Awaited<ReturnType<typeof rejudgeRun>>;
  try {
    outcome = await rejudgeRun(dir, {
      ...(beamProtocol ? { beamProtocol } : {}),
      concurrency: int(v.concurrency, "concurrency", 1) as number,
      log,
    });
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!outcome.results) {
    log("nothing to judge");
    return;
  }
  await (await openVault(v, log))?.save(dir);
  if (outcome.left) process.exit(1);
}

/**
 * The results branch a run or rejudge pushes to, if any: none with --no-vault; with --vault the
 * bench-results branch of origin, created when missing; otherwise that branch only when origin
 * already has it, so a fresh clone or a fork pushes nothing unless asked.
 */
async function openVault(
  v: { vault?: boolean; "no-vault"?: boolean },
  log: (line: string) => void,
): Promise<Vault | null> {
  if (v["no-vault"]) return null;
  return Vault.open({ log, create: v.vault === true }).catch(() => null);
}

async function cmdVault(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: "string" }, log: { type: "string" } },
  });
  const [sub, ...dirs] = positionals;
  if (sub !== "save" || dirs.length === 0)
    fail("usage: vault save <dir>... [--name NAME] [--log FILE]");
  if (dirs.length > 1 && (values.name || values.log))
    fail("--name and --log apply to a single directory");
  const vault = await Vault.open();
  if (!vault) fail("not inside a git checkout with an origin remote");
  let failed = 0;
  for (const dir of dirs) {
    const ok = await vault.save(dir, {
      ...(values.name ? { name: values.name } : {}),
      ...(values.log ? { log: values.log } : {}),
    });
    if (!ok) failed++;
  }
  if (failed) process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "download":
      return cmdDownload(rest);
    case "run":
      return cmdRun(rest);
    case "estimate":
      return cmdEstimate(rest);
    case "report": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { out: { type: "string" } },
      });
      if (positionals.length !== 1) fail("usage: report <results.json> [--out FILE]");
      return emit(renderMarkdown(await readResults(positionals[0] as string)), values.out);
    }
    case "vault":
      return cmdVault(rest);
    case "cleanup":
      return cmdCleanup(rest);
    case "rejudge":
      return cmdRejudge(rest);
    case "compare": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { out: { type: "string" } },
      });
      if (positionals.length !== 2) fail("usage: compare <a.json> <b.json> [--out FILE]");
      const [a, b] = await Promise.all(positionals.map(readResults));
      return emit(renderComparison(a as Results, b as Results), values.out);
    }
    default:
      console.error(USAGE);
      process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
