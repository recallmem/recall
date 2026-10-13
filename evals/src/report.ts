import { BEAM_REF, LEGACY_BEAM_PROTOCOL } from "./beam/protocol.js";
import { type BeamSummary, summarizeBeam } from "./beam/scoring.js";
import type { UsageReport, UsageTotals } from "./client.js";
import { honchoListPrice } from "./honcho-pricing.js";
import type {
  BeamDetail,
  Bucket,
  JudgeSpend,
  QuestionRecord,
  Results,
  RunSettings,
  Summary,
  UnitRecord,
} from "./results.js";
import { RUBRIC_VERSION } from "./rubric.js";
import type { ReasoningLevel } from "./types.js";
import { mean, percentile, sum, wilson95 } from "./util.js";

export const HARNESS_VERSION = "2";

function bucket(records: readonly QuestionRecord[]): Bucket {
  const judged = records.filter((r) => r.correct !== null);
  const correct = judged.filter((r) => r.correct).length;
  return {
    n: judged.length,
    correct,
    accuracy: judged.length ? correct / judged.length : null,
    ci95: wilson95(correct, judged.length),
    errors: records.filter((r) => r.error !== null).length,
    unjudged: records.length - judged.length,
  };
}

const zeroTotals = (): UsageTotals => ({
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  unpriced_calls: 0,
});

function addTotals(into: UsageTotals, t: UsageTotals | undefined, sign = 1): void {
  if (!t) return;
  for (const k of Object.keys(into) as (keyof UsageTotals)[]) into[k] += sign * (t[k] ?? 0);
}

const isChatTask = (task: string) => task.startsWith("chat");

const emptyReport = (): UsageReport => ({ total: zeroTotals(), by_task: {}, items: [] });

/**
 * Splits one workspace's metered usage into background work (everything up to the
 * moment processing went idle) and the question phase (the difference afterwards).
 */
function splitUsage(unit: UnitRecord) {
  const before = unit.usageAfterIngest ?? emptyReport();
  const after = unit.usageFinal ?? before;
  const backgroundLlm = zeroTotals();
  for (const [task, t] of Object.entries(before.by_task)) {
    if (task !== "embedding") addTotals(backgroundLlm, t);
  }
  const chat = zeroTotals();
  for (const [task, t] of Object.entries(after.by_task)) {
    if (!isChatTask(task)) continue;
    addTotals(chat, t);
    addTotals(chat, before.by_task[task], -1);
  }
  // Non-chat work after idle (query-time embeddings, late jobs) is query cost as well.
  const queryRest = zeroTotals();
  addTotals(queryRest, after.total);
  addTotals(queryRest, before.total, -1);
  addTotals(queryRest, chat, -1);
  return {
    background: before.total,
    backgroundLlm,
    chat,
    queryRest,
    complete: Boolean(unit.usageAfterIngest && unit.usageFinal),
  };
}

export function summarize(
  settings: Pick<RunSettings, "level" | "costModel">,
  records: readonly QuestionRecord[],
  units: readonly UnitRecord[],
): Summary {
  const byCategory: Record<string, Bucket> = {};
  for (const cat of [...new Set(records.map((r) => r.category))].sort()) {
    byCategory[cat] = bucket(records.filter((r) => r.category === cat));
  }
  const latencies = records.flatMap((r) => (r.latencyMs !== null ? [r.latencyMs] : []));

  const okUnits = units.filter((u) => u.error === null);
  const messages = sum(units.map((u) => u.messages));
  const tokens = sum(units.map((u) => u.tokens));
  // Reused workspaces (--reuse) were not ingested by this run, so they say nothing about its speed.
  const perHundred = okUnits
    .filter((u) => u.messages > 0 && !u.reused)
    .map((u) => ((u.ingestMs + u.drainMs) / 1000 / u.messages) * 100);

  const queries = records.filter((r) => r.latencyMs !== null).length;
  const level = settings.level as ReasoningLevel;
  const honcho = honchoListPrice(tokens, queries, level);

  let ingestUsd: number;
  let queryUsd: number;
  let unpriced = 0;
  let withoutUsage = 0;
  let llmCalls: number | null = null;
  let inputTokens: number | null = null;
  let chatCalls: number | null = null;
  let chatInput: number | null = null;

  if (settings.costModel === "recall-metered") {
    const bg = zeroTotals();
    const bgLlm = zeroTotals();
    const chat = zeroTotals();
    const rest = zeroTotals();
    for (const u of units) {
      const s = splitUsage(u);
      if (!s.complete) withoutUsage++;
      addTotals(bg, s.background);
      addTotals(bgLlm, s.backgroundLlm);
      addTotals(chat, s.chat);
      addTotals(rest, s.queryRest);
    }
    unpriced = bg.unpriced_calls + chat.unpriced_calls + rest.unpriced_calls;
    ingestUsd = bg.cost_usd;
    queryUsd = chat.cost_usd + rest.cost_usd;
    const hundreds = messages / 100;
    llmCalls = hundreds > 0 ? bgLlm.calls / hundreds : null;
    inputTokens = hundreds > 0 ? bgLlm.input_tokens / hundreds : null;
    chatCalls = queries > 0 ? chat.calls / queries : null;
    chatInput = queries > 0 ? chat.input_tokens / queries : null;
  } else {
    ingestUsd = honcho.ingestUsd;
    queryUsd = honcho.queryUsd;
  }

  const judged = records.filter((r) => r.judgeInputTokens > 0 || r.judgeOutputTokens > 0);
  const judgeCosts = judged.map((r) => r.judgeCostUsd);
  const beamItems = records.flatMap((r) =>
    r.beam ? [{ ability: r.beam.ability, score: r.beam.score }] : [],
  );
  return {
    beam: beamItems.length ? { ...summarizeBeam(beamItems), ...beamDetail(records) } : null,
    accuracy: {
      overall: bucket(records),
      answerable: bucket(records.filter((r) => r.kind !== "abstention")),
      abstention: bucket(records.filter((r) => r.kind === "abstention")),
      byCategory,
    },
    latencyMs: {
      n: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      mean: mean(latencies),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    ingest: {
      workspaces: units.length,
      failedWorkspaces: units.length - okUnits.length,
      sessions: sum(units.map((u) => u.sessions)),
      messages,
      tokens,
      tokensEstimated: units.some((u) => u.tokensEstimated),
      secondsPer100MessagesMedian: percentile(perHundred, 50),
      drainTimeouts: units.filter((u) => u.drainTimedOut).length,
    },
    cost: {
      model: settings.costModel,
      queries,
      ingestUsd,
      queryUsd,
      totalUsd: ingestUsd + queryUsd,
      per100MessagesUsd: messages > 0 ? ingestUsd / (messages / 100) : null,
      perQueryUsd: queries > 0 ? queryUsd / queries : null,
      llmCallsPer100Messages: llmCalls,
      inputTokensPer100Messages: inputTokens,
      chatCallsPerQuery: chatCalls,
      chatInputTokensPerQuery: chatInput,
      unpricedCalls: unpriced,
      workspacesWithoutUsage: withoutUsage,
      honchoListPrice: {
        ...honcho,
        per100MessagesUsd: messages > 0 ? honcho.ingestUsd / (messages / 100) : null,
        perQueryUsd: queries > 0 ? honcho.queryUsd / queries : null,
      },
      judge: {
        calls: judged.length,
        inputTokens: sum(judged.map((r) => r.judgeInputTokens)),
        outputTokens: sum(judged.map((r) => r.judgeOutputTokens)),
        costUsd: judgeCosts.some((c) => c === null) ? null : sum(judgeCosts as number[]),
      },
    },
  };
}

/** The protocol of a BEAM record (records from before it was stored are beam-nuggets-v1). */
const recordProtocol = (r: QuestionRecord): string | null =>
  r.beam ? (r.beam.protocol ?? LEGACY_BEAM_PROTOCOL) : null;

/** The BEAM protocols the records were scored with, in order of first appearance. */
export const beamProtocols = (records: readonly QuestionRecord[]): string[] => [
  ...new Set(records.flatMap((r) => recordProtocol(r) ?? [])),
];

/** Protocols, BEAM's other event-ordering numbers (beam-ref) and the judge spend on BEAM scores. */
function beamDetail(records: readonly QuestionRecord[]): BeamDetail {
  const ordering = records.flatMap((r) =>
    r.beam?.refOrdering && r.beam.score !== null ? [r.beam.refOrdering] : [],
  );
  const avg = (xs: number[]) => sum(xs) / xs.length;
  const spends = records.flatMap((r) => (r.beam?.judge ? [r.beam.judge] : []));
  const judge: JudgeSpend | null = spends.length
    ? {
        calls: sum(spends.map((x) => x.calls)),
        inputTokens: sum(spends.map((x) => x.inputTokens)),
        outputTokens: sum(spends.map((x) => x.outputTokens)),
        costUsd: spends.some((x) => x.costUsd === null)
          ? null
          : sum(spends.map((x) => x.costUsd as number)),
      }
    : null;
  return {
    protocols: beamProtocols(records),
    eventOrdering: ordering.length
      ? {
          n: ordering.length,
          precision: avg(ordering.map((o) => o.precision)),
          recall: avg(ordering.map((o) => o.recall)),
          f1: avg(ordering.map((o) => o.f1)),
          finalScore: avg(ordering.map((o) => (o.tauNorm ?? 0) * o.f1)),
          undefinedTau: ordering.filter((o) => o.tauNorm === null).length,
        }
      : null,
    judge,
  };
}

/** provider/model per task, from the usage endpoint's item list. */
export function serverModels(units: readonly UnitRecord[]): Record<string, string[]> | null {
  const out: Record<string, Set<string>> = {};
  let any = false;
  for (const u of units) {
    const usage: UsageReport | null = u.usageFinal ?? u.usageAfterIngest;
    for (const item of usage?.items ?? []) {
      any = true;
      const set = out[item.task] ?? new Set<string>();
      set.add(`${item.provider}/${item.model}`);
      out[item.task] = set;
    }
  }
  return any ? Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()])) : null;
}

/**
 * `settings.beamScoring` is the run's BEAM protocol; when it is not given it is read from the records
 * (records from before protocols were stored are beam-nuggets-v1).
 */
export function buildResults(
  settings: Omit<RunSettings, "harnessVersion" | "rubric" | "serverModels" | "beamScoring"> & {
    beamScoring?: string | null;
  },
  records: QuestionRecord[],
  units: UnitRecord[],
): Results {
  const scoring = settings.scoring ?? "rubric";
  const full: RunSettings = {
    ...settings,
    scoring,
    beamScoring:
      scoring === "rubric"
        ? null
        : (settings.beamScoring ?? beamProtocols(records)[0] ?? LEGACY_BEAM_PROTOCOL),
    harnessVersion: HARNESS_VERSION,
    rubric: RUBRIC_VERSION,
    serverModels: serverModels(units),
  };
  return { schema: 1, settings: full, summary: summarize(full, records, units), units, records };
}

// ---------------------------------------------------------------- Markdown ----

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const ci = (b: Bucket) =>
  b.ci95 ? `${(b.ci95[0] * 100).toFixed(0)}-${(b.ci95[1] * 100).toFixed(0)}%` : "n/a";
const ms = (v: number | null) =>
  v === null ? "n/a" : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
const usd = (v: number | null, digits = 4) => (v === null ? "n/a" : `$${v.toFixed(digits)}`);
const num = (v: number | null, digits = 1) =>
  v === null ? "n/a" : v.toLocaleString("en-US", { maximumFractionDigits: digits });

/** The run's BEAM protocol (results written before protocols existed used beam-nuggets-v1). */
const protocolOf = (s: RunSettings): string => s.beamScoring ?? LEGACY_BEAM_PROTOCOL;

function scoringText(s: RunSettings): string {
  const rubric = `${s.rubric} pass/fail`;
  const protocol = protocolOf(s);
  const beam =
    protocol === BEAM_REF
      ? `BEAM's reference scoring: llm_judge_score per rubric item, tau_norm for event ordering (${protocol})`
      : `BEAM nuggets 0/0.5/1 + Kendall tau-b (${protocol})`;
  const mode = s.scoring ?? "rubric";
  return mode === "rubric" ? rubric : mode === "beam" ? beam : `${beam}; ${rubric}`;
}

export function settingsRows(s: RunSettings): [string, string][] {
  const models = s.serverModels
    ? Object.entries(s.serverModels)
        .filter(([task]) => task !== "embedding")
        .map(([task, m]) => `${task}=${m.join("+")}`)
        .join(", ") +
      (s.serverModels.embedding ? `, embedding=${s.serverModels.embedding.join("+")}` : "")
    : "not reported by this server";
  return [
    ["Target", `${s.label} (${s.target.url})`],
    [
      "Dataset",
      `${s.dataset}${s.beamSplit ? ` ${s.beamSplit.toUpperCase()}` : ""}: ${s.selection.questions} questions in ${s.selection.units} workspaces`,
    ],
    [
      "Selection",
      `${s.selection.order}${s.selection.limit !== null ? `, limit ${s.selection.limit}` : ""}${s.selection.offset ? `, offset ${s.selection.offset}` : ""}${s.selection.types ? `, types ${s.selection.types.join("/")}` : ""}`,
    ],
    ["Reasoning level", s.level],
    ["Server models", models],
    [
      "Judge",
      s.judge.kind === "llm"
        ? `${s.judge.model}, ${s.rubric}`
        : `lexical overlap (offline, NOT an accuracy measurement), ${s.rubric}`,
    ],
    ["Scoring", scoringText(s)],
    [
      "Cost model",
      s.costModel === "recall-metered"
        ? "metered by the server (exact)"
        : "estimated from Honcho's published price list",
    ],
    ["Observation", `observe_others=${s.observeOthers}, dream before questions=${s.dream}`],
    ["Concurrency", `${s.concurrency} workspaces x ${s.questionConcurrency} questions`],
    ["Run", `${s.startedAt} to ${s.finishedAt}, harness v${s.harnessVersion}`],
  ];
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const score3 = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
const ci3 = (v: [number, number] | null) => (v ? `${v[0].toFixed(3)}-${v[1].toFixed(3)}` : "n/a");

/** The model BEAM's evaluation code judges with (src/llm.py). */
const BEAM_REF_JUDGE_MODEL = "gpt-4.1-mini";

/** How the BEAM scores of a run were computed, for the report. */
function beamMethodText(s: RunSettings): string {
  const judge =
    s.judge.kind === "llm" ? s.judge.model : "an offline lexical stand-in, not a real judge";
  if (protocolOf(s) === BEAM_REF) {
    const sameModel =
      s.judge.kind === "llm" && s.judge.model.split("/").at(-1) === BEAM_REF_JUDGE_MODEL;
    return [
      `Protocol ${BEAM_REF}: BEAM's own evaluation code ([mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM) at commit b2da22e, \`src/evaluation/compute_metrics.py\` and \`report_results.py\`), ported with its judge prompts verbatim.`,
      "Every rubric item is judged on its own with BEAM's unified judge prompt (0, 0.5 or 1) and a question scores the mean of its items (`llm_judge_score`).",
      "Event ordering scores `tau_norm` = (Kendall tau-b + 1) / 2: each line of the answer, in order, is replaced by the first still-unmatched reference event that BEAM's yes/no equivalence prompt calls the same, and tau-b compares the reference and answer rankings over the union of events and lines (anything absent from a list shares the last rank).",
      "An ability is the mean over its questions and the overall score is the unweighted mean of the ten abilities.",
      `Judge: ${judge} at temperature 0${sameModel ? ", the model BEAM's code uses" : s.judge.kind === "llm" ? ` (BEAM's code uses ${BEAM_REF_JUDGE_MODEL}, so figures are not directly comparable with published ones)` : ""}.`,
      "Where this differs from BEAM's code: an undefined tau-b (NaN there) scores 0, blank answer lines are not sent to the judge (they match nothing), and a rubric item whose judge reply cannot be read after one retry leaves the question unscored (BEAM's code would stop).",
    ].join(" ");
  }
  return `Each question scores the mean of its rubric nuggets (0, 0.5 or 1 per nugget, judged by ${judge}); event ordering scores Kendall tau-b between the reference order and the order in the answer, clipped at 0. An ability is the mean over its questions and the overall score is the unweighted mean of the abilities, as in the BEAM paper. Protocol ${protocolOf(s)}: our own judge prompts, so figures are comparable across systems run here and only approximately with published BEAM numbers.`;
}

/** BEAM's own scoring, per ability and overall. */
function renderBeam(b: BeamSummary & BeamDetail, s: RunSettings): string[] {
  const o = b.overall;
  const partial = o.abilitiesCovered < o.abilitiesTotal;
  const out = [
    "## BEAM scoring",
    "",
    beamMethodText(s),
    "",
    table(
      ["Ability", "n", "Score", "95% CI (bootstrap)", "Full credit"],
      [
        ...b.abilities.map((a) => [
          a.ability,
          String(a.n),
          score3(a.mean),
          ci3(a.ci95),
          pct(a.fullCredit),
        ]),
        [
          `**Overall** (mean of ${o.abilitiesCovered}${partial ? ` of ${o.abilitiesTotal}` : ""} abilities)`,
          String(o.questions),
          `**${score3(o.mean)}**`,
          ci3(o.ci95),
          "",
        ],
        ["Mean over all questions", String(o.questions), score3(o.questionMean), "", ""],
      ],
    ),
    "",
  ];
  if (partial)
    out.push(
      `Only ${o.abilitiesCovered} of ${o.abilitiesTotal} abilities are in this sample, so the overall figure is not the benchmark's overall score.`,
      "",
    );
  if ((b.protocols ?? []).length > 1)
    out.push(
      `**Mixed protocols.** These records were scored with ${b.protocols?.join(" and ")}; re-score them with \`rejudge --beam-protocol\` before using the figures.`,
      "",
    );
  const unscored = b.abilities.reduce((n, a) => n + a.unscored, 0);
  if (unscored)
    out.push(`${unscored} answer(s) got no usable verdict from the judge and are excluded.`, "");
  const eo = b.eventOrdering;
  if (eo)
    out.push(
      `Event ordering, BEAM's other numbers (computed by its code, not part of the score): precision ${score3(eo.precision)}, recall ${score3(eo.recall)}, F1 ${score3(eo.f1)}, final_score (tau_norm x F1) ${score3(eo.finalScore)}, mean over ${eo.n} answers${eo.undefinedTau ? `; ${eo.undefinedTau} with an undefined tau-b, scored 0` : ""}.`,
      "",
    );
  if (b.judge)
    out.push(
      `BEAM scoring took ${b.judge.calls.toLocaleString("en-US")} judge calls (${b.judge.inputTokens.toLocaleString("en-US")} input / ${b.judge.outputTokens.toLocaleString("en-US")} output tokens, ${usd(b.judge.costUsd, 2)}).`,
      "",
    );
  out.push(
    "Failed requests score 0. Intervals are percentile bootstraps over questions (2,000 resamples, fixed seed); with 2 questions per ability and conversation they are wide.",
    "",
  );
  return out;
}

export function renderMarkdown(r: Results): string {
  const { settings: s, summary: m } = r;
  const out: string[] = [];
  out.push(`# Memory benchmark: ${s.label} on ${s.dataset}`, "");
  if (s.note) out.push(`> ${s.note}`, "");
  if (s.judge.kind === "lexical-offline") {
    out.push(
      "> **Smoke run.** The judge is a lexical-overlap stand-in and the server (if it is Recall's offline mock provider) answers with canned text. Accuracy here is meaningless; this run only proves the pipeline works.",
      "",
    );
  }
  out.push(
    "## Settings",
    "",
    table(
      ["Setting", "Value"],
      settingsRows(s).map(([k, v]) => [k, v]),
    ),
    "",
  );

  const beamOnly = s.scoring === "beam";
  if (m.beam) out.push(...renderBeam(m.beam, s), "");
  if (!beamOnly) {
    out.push("## Accuracy", "");
    const rowFor = (name: string, b: Bucket) => [
      name,
      String(b.n),
      String(b.correct),
      pct(b.accuracy),
      ci(b),
      String(b.errors),
    ];
    out.push(
      table(
        ["Question type", "n", "Correct", "Accuracy", "95% CI", "Errors"],
        [
          rowFor("**Overall**", m.accuracy.overall),
          rowFor("Answerable only", m.accuracy.answerable),
          ...Object.entries(m.accuracy.byCategory).map(([c, b]) => rowFor(c, b)),
        ],
      ),
      "",
      "Errors (failed requests, failed ingests) count as wrong. The 95% interval is Wilson; with small n it is wide.",
      "",
    );
    const unjudged = m.accuracy.overall.unjudged;
    if (unjudged)
      out.push(
        `${unjudged} answer(s) got no verdict from the judge and are excluded from the table.`,
        "",
      );
  }

  out.push("## Latency (chat)", "");
  out.push(
    table(
      ["Answers", "p50", "p95", "Mean", "Max"],
      [
        [
          String(m.latencyMs.n),
          ms(m.latencyMs.p50),
          ms(m.latencyMs.p95),
          ms(m.latencyMs.mean),
          ms(m.latencyMs.max),
        ],
      ],
    ),
    "",
  );

  out.push("## Ingestion", "");
  out.push(
    table(
      [
        "Workspaces",
        "Sessions",
        "Messages",
        "Tokens",
        "Ingest to idle, s per 100 msgs (median)",
        "Not idle in time",
      ],
      [
        [
          String(m.ingest.workspaces),
          String(m.ingest.sessions),
          String(m.ingest.messages),
          `${m.ingest.tokens.toLocaleString("en-US")}${m.ingest.tokensEstimated ? " (est.)" : ""}`,
          num(m.ingest.secondsPer100MessagesMedian),
          String(m.ingest.drainTimeouts),
        ],
      ],
    ),
    "",
  );

  const c = m.cost;
  out.push("## Cost", "");
  out.push(
    c.model === "recall-metered"
      ? "Measured: every LLM and embedding call the server made for these workspaces, priced from its price book (a lower bound if any call was unpriced)."
      : "Estimated from Honcho's published list price (see `src/honcho-pricing.ts`); the server does not report its own usage.",
    "",
  );
  const honcho = c.honchoListPrice;
  out.push(
    table(
      ["", s.label, "Same workload at Honcho list price"],
      [
        ["Ingest total", usd(c.ingestUsd), usd(honcho.ingestUsd)],
        ["Query total", usd(c.queryUsd), usd(honcho.queryUsd)],
        ["**Total**", usd(c.totalUsd), usd(honcho.totalUsd)],
        ["**Per 100 messages ingested**", usd(c.per100MessagesUsd), usd(honcho.per100MessagesUsd)],
        ["**Per query**", usd(c.perQueryUsd), usd(honcho.perQueryUsd)],
      ],
    ),
    "",
  );
  if (c.model === "recall-metered") {
    out.push(
      table(
        ["Measured work", "Value"],
        [
          ["Background LLM calls per 100 messages", num(c.llmCallsPer100Messages)],
          ["Background input tokens per 100 messages", num(c.inputTokensPer100Messages, 0)],
          ["Chat LLM calls per query", num(c.chatCallsPerQuery, 2)],
          ["Chat input tokens per query", num(c.chatInputTokensPerQuery, 0)],
          ["Unpriced calls", String(c.unpricedCalls)],
        ],
      ),
      "",
    );
    if (c.workspacesWithoutUsage) {
      out.push(
        `${c.workspacesWithoutUsage} workspace(s) had no readable usage; the totals above are lower bounds.`,
        "",
      );
    }
  }
  out.push(
    `Judge (not part of the system's cost): ${c.judge.calls} calls, ${c.judge.inputTokens.toLocaleString("en-US")} input / ${c.judge.outputTokens.toLocaleString("en-US")} output tokens, ${usd(c.judge.costUsd, 2)}.`,
    "",
  );
  return out.join("\n");
}

// ----------------------------------------------------------------- compare ----

/** Settings that must match for two runs to be comparable. */
export function comparabilityIssues(a: RunSettings, b: RunSettings): string[] {
  const issues: string[] = [];
  const check = (name: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y))
      issues.push(`${name}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  };
  check("dataset", a.dataset, b.dataset);
  check("BEAM split", a.beamSplit ?? null, b.beamSplit ?? null);
  check("scoring", a.scoring ?? "rubric", b.scoring ?? "rubric");
  check("BEAM protocol", a.beamScoring ?? null, b.beamScoring ?? null);
  check("questions selected", a.selection, { ...b.selection });
  check("reasoning level", a.level, b.level);
  check("judge", a.judge, b.judge);
  check("rubric", a.rubric, b.rubric);
  check("observe_others", a.observeOthers, b.observeOthers);
  check("dream", a.dream, b.dream);
  return issues;
}

export function renderComparison(a: Results, b: Results): string {
  const out: string[] = [];
  const A = a.settings.label;
  const B = b.settings.label === A ? `${b.settings.label} (2)` : b.settings.label;
  out.push(`# ${A} vs ${B} on ${a.settings.dataset}`, "");
  const issues = comparabilityIssues(a.settings, b.settings);
  if (issues.length) {
    out.push(
      "> **Not directly comparable.** These settings differ between the two runs:",
      ...issues.map((i) => `> - ${i}`),
      "",
    );
  }
  const rows = settingsRows(a.settings).map(([k], i) => [
    k,
    settingsRows(a.settings)[i]?.[1] ?? "",
    settingsRows(b.settings)[i]?.[1] ?? "",
  ]);
  out.push("## Settings", "", table(["Setting", A, B], rows), "");

  out.push("## Accuracy", "");
  const cats = [
    ...new Set([
      ...Object.keys(a.summary.accuracy.byCategory),
      ...Object.keys(b.summary.accuracy.byCategory),
    ]),
  ].sort();
  const cell = (x?: Bucket) => (x ? `${pct(x.accuracy)} (${x.correct}/${x.n})` : "n/a");
  const delta = (x?: Bucket, y?: Bucket) =>
    x?.accuracy != null && y?.accuracy != null
      ? `${((y.accuracy - x.accuracy) * 100).toFixed(1)} pp`
      : "n/a";
  const acc = (name: string, x?: Bucket, y?: Bucket) => [name, cell(x), cell(y), delta(x, y)];
  out.push(
    table(
      ["Question type", A, B, `Delta (${B} - ${A})`],
      [
        acc("**Overall**", a.summary.accuracy.overall, b.summary.accuracy.overall),
        acc("Answerable only", a.summary.accuracy.answerable, b.summary.accuracy.answerable),
        ...cats.map((c) =>
          acc(c, a.summary.accuracy.byCategory[c], b.summary.accuracy.byCategory[c]),
        ),
      ],
    ),
    "",
  );

  if (a.summary.beam && b.summary.beam) {
    const ma = new Map(a.summary.beam.abilities.map((x) => [x.ability, x]));
    const mb = new Map(b.summary.beam.abilities.map((x) => [x.ability, x]));
    const abilities = [...new Set([...ma.keys(), ...mb.keys()])];
    const d3 = (x: number | null | undefined, y: number | null | undefined) =>
      x != null && y != null ? (y - x).toFixed(3) : "n/a";
    out.push(
      "## BEAM scoring",
      "",
      table(
        ["Ability", A, B, `Delta (${B} - ${A})`],
        [
          ...abilities.map((ab) => [
            ab,
            score3(ma.get(ab)?.mean ?? null),
            score3(mb.get(ab)?.mean ?? null),
            d3(ma.get(ab)?.mean, mb.get(ab)?.mean),
          ]),
          [
            "**Overall** (mean of abilities)",
            score3(a.summary.beam.overall.mean),
            score3(b.summary.beam.overall.mean),
            d3(a.summary.beam.overall.mean, b.summary.beam.overall.mean),
          ],
        ],
      ),
      "",
    );
  }

  const la = a.summary.latencyMs;
  const lb = b.summary.latencyMs;
  out.push(
    "## Latency (chat)",
    "",
    table(
      ["", A, B],
      [
        ["p50", ms(la.p50), ms(lb.p50)],
        ["p95", ms(la.p95), ms(lb.p95)],
        ["mean", ms(la.mean), ms(lb.mean)],
      ],
    ),
    "",
  );

  const ca = a.summary.cost;
  const cb = b.summary.cost;
  const kind = (c: Summary["cost"]) => (c.model === "recall-metered" ? "measured" : "estimated");
  out.push(
    "## Cost",
    "",
    table(
      ["", `${A} (${kind(ca)})`, `${B} (${kind(cb)})`],
      [
        ["Per 100 messages ingested", usd(ca.per100MessagesUsd), usd(cb.per100MessagesUsd)],
        ["Per query", usd(ca.perQueryUsd), usd(cb.perQueryUsd)],
        ["Total", usd(ca.totalUsd), usd(cb.totalUsd)],
        [
          "Background LLM calls per 100 messages",
          num(ca.llmCallsPer100Messages),
          num(cb.llmCallsPer100Messages),
        ],
        ["Chat LLM calls per query", num(ca.chatCallsPerQuery, 2), num(cb.chatCallsPerQuery, 2)],
        [
          "Chat input tokens per query",
          num(ca.chatInputTokensPerQuery, 0),
          num(cb.chatInputTokensPerQuery, 0),
        ],
      ],
    ),
    "",
    ...(ca.model === "honcho-list-estimate" || cb.model === "honcho-list-estimate"
      ? [
          'Targets marked "estimated" do not report usage (Honcho\'s managed service among them), so they are costed at their published list price applied to the tokens ingested and queries asked; `n/a` rows are not observable from outside.',
          "",
        ]
      : []),
  );
  return out.join("\n");
}
