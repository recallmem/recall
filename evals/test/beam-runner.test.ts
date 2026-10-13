import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import beam from "../fixtures/beam-sample.json" with { type: "json" };
import { BEAM_NUGGETS_V1, BEAM_REF, type BeamProtocol } from "../src/beam/protocol.js";
import { MemoryApi } from "../src/client.js";
import { planBeam } from "../src/datasets/beam.js";
import { LexicalJudge } from "../src/judge.js";
import { buildResults, renderComparison, renderMarkdown } from "../src/report.js";
import type { ScoringMode } from "../src/results.js";
import { type RunOptions, runAll } from "../src/runner.js";
import { type FakeOptions, type FakeServer, startFakeServer } from "./fake-server.js";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  runId: "b1",
  dataset: "beam",
  level: "low",
  concurrency: 2,
  questionConcurrency: 4,
  drainTimeoutMs: 10_000,
  chatTimeoutMs: 5_000,
  observeOthers: false,
  dream: false,
  cleanup: true,
  meterUsage: true,
  pollMs: 20,
  stallMs: 200,
  log: () => undefined,
  ...over,
});

async function run(
  fakeOpts: FakeOptions,
  runOpts: Partial<RunOptions> = {},
  select: Parameters<typeof planBeam>[2] = {},
  beamProtocol: BeamProtocol = BEAM_NUGGETS_V1,
) {
  fake = await startFakeServer(fakeOpts);
  const api = new MemoryApi(fake.url);
  const dir = await mkdtemp(join(tmpdir(), "beam-run-"));
  const file = join(dir, "beam-100k.json");
  await writeFile(file, JSON.stringify(beam));
  const units = await planBeam(file, "100k", select);
  const out = await runAll(api, new LexicalJudge({ beamProtocol }), units, opts(runOpts));
  return { api, ...out };
}

const settings = (scoring: ScoringMode, label = "fake") => ({
  label,
  note: null,
  startedAt: "a",
  finishedAt: "b",
  target: { url: "x", authenticated: false },
  dataset: "beam" as const,
  beamSplit: "100k" as const,
  scoring,
  selection: {
    limit: null,
    offset: 0,
    types: null,
    order: "stratified" as const,
    questions: 40,
    units: 2,
  },
  level: "low",
  concurrency: 2,
  questionConcurrency: 4,
  observeOthers: false,
  dream: false,
  judge: { kind: "lexical-offline" as const, model: "none" },
  costModel: "recall-metered" as const,
});

// An answer that gets some nuggets right and lists events in order.
const answer = (_peer: string, query: string) =>
  query.includes("event-ordering") || query.includes("Question c1-event")
    ? "1) Project setup 2) Database design 3) Deployment"
    : "My first sprint ends on March 29. The dashboard responds in around 250ms after caching. Two columns: category and notes.";

describe("running BEAM through the harness", () => {
  it("ingests each conversation as one workspace and asks all its questions through the user peer", async () => {
    const { records, units } = await run({ mode: "recall", answer }, { scoring: "both" });
    const f = fake as FakeServer;
    expect(units.map((u) => u.workspace).sort()).toEqual([
      "ev-b1-beam-100k-c1",
      "ev-b1-beam-100k-c2",
    ]);
    expect(units.every((u) => u.error === null && u.sessions > 0)).toBe(true);
    expect(records).toHaveLength(40);

    const posts = f.calls.filter(
      (c) => c.method === "POST" && c.path.endsWith("/messages") && c.path.includes("c1"),
    );
    expect(posts.map((p) => p.body.messages[0].created_at)).toEqual([
      "2024-03-15T09:00:00.000Z",
      "2024-04-05T09:00:00.000Z",
    ]);
    // peers: user observed, assistant not
    const chats = f.calls.filter((c) => c.path.endsWith("/chat"));
    expect(chats).toHaveLength(40);
    expect(chats.every((c) => c.path.includes("/peers/user/chat"))).toBe(true);
    // each conversation is asked "after" its own last message
    const queryOf = (conv: string) => chats.find((c) => c.path.includes(`-${conv}/`))?.body.query;
    expect(queryOf("c1")).toMatch(/^The current date is 2024-04-05\./);
    expect(queryOf("c2")).toMatch(/^The current date is 2024-06-01\./);
  });

  it("records the pass/fail verdict and BEAM's partial-credit score side by side with --scoring both", async () => {
    const { records } = await run({ mode: "recall", answer }, { scoring: "both" });
    const info = records.find((r) => r.id === "beam-100k-c1-information-extraction-1");
    expect(info?.correct).toBe(true);
    expect(info?.beam).toMatchObject({
      ability: "information-extraction",
      method: "nuggets",
      score: 1,
      nuggetScores: [1],
    });
    const multi = records.find((r) => r.id === "beam-100k-c1-multi-hop-reasoning-1");
    // "Two columns" is in the answer, the quoted column names are only partly there
    expect(multi?.beam?.nuggetScores?.[0]).toBe(1);
    expect(multi?.beam?.score).toBeGreaterThan(0);
    const order = records.find((r) => r.id === "beam-100k-c1-event-ordering-1");
    expect(order?.beam).toMatchObject({
      method: "tau-b",
      tauB: 1,
      score: 1,
      matched: 3,
      absent: 0,
    });
    // every record carries what is needed to re-score it
    expect(order?.beam?.events).toEqual(["Project setup", "Database design", "Deployment"]);
    expect(info?.beam?.nuggets).toEqual(["LLM response should state: March 29"]);
  });

  it("with --scoring beam only BEAM's score is recorded", async () => {
    const { records } = await run({ mode: "recall", answer }, { scoring: "beam" });
    expect(records.every((r) => r.correct === null && r.beam?.score !== null)).toBe(true);
    const results = buildResults(settings("beam"), records, []);
    expect(results.settings.beamScoring).toBe(BEAM_NUGGETS_V1);
    const md = renderMarkdown(results);
    expect(md).toContain("## BEAM scoring");
    expect(md).not.toContain("| Question type |");
    expect(md).toContain("BEAM nuggets 0/0.5/1 + Kendall tau-b");
  });

  it("scores with BEAM's own algorithm under beam-ref-b2da22e and says so in the report", async () => {
    const { records, units } = await run(
      { mode: "recall", answer },
      { scoring: "both" },
      {},
      BEAM_REF,
    );
    expect(records.every((r) => r.beam?.protocol === BEAM_REF)).toBe(true);
    const info = records.find((r) => r.id === "beam-100k-c1-information-extraction-1");
    expect(info?.beam).toMatchObject({ method: "llm-judge", score: 1, nuggetScores: [1] });
    // The one-line answer is one line for BEAM's alignment: it matches the first event only.
    const order = records.find((r) => r.id === "beam-100k-c1-event-ordering-1");
    expect(order?.beam).toMatchObject({ method: "tau-norm", matched: 1, absent: 2, extra: 0 });
    expect(order?.beam?.score).toBeCloseTo(0.908248290463863, 15);
    expect(order?.beam?.refOrdering).toMatchObject({ lines: 1, precision: 1, f1: 0.5 });
    const failed = await run({ mode: "recall", failChat: true }, { scoring: "beam" }, {}, BEAM_REF);
    expect(
      failed.records.every(
        (r) => r.beam?.score === 0 && r.beam.protocol === BEAM_REF && r.beam.method !== "nuggets",
      ),
    ).toBe(true);

    const results = buildResults(settings("both"), records, units);
    expect(results.settings.beamScoring).toBe(BEAM_REF);
    const md = renderMarkdown(results);
    expect(md).toContain("Protocol beam-ref-b2da22e: BEAM's own evaluation code");
    expect(md).toContain("`tau_norm` = (Kendall tau-b + 1) / 2");
    expect(md).toContain("an offline lexical stand-in, not a real judge");
    expect(md).toContain("final_score (tau_norm x F1)");
    // a nuggets-v1 run is not comparable with it
    const old = buildResults(
      settings("both"),
      (await run({ mode: "recall", answer }, { scoring: "both" })).records,
      units,
    );
    expect(renderComparison(results, old)).toContain("BEAM protocol");
  });

  it("with --scoring rubric (the default) no BEAM score is recorded", async () => {
    const { records } = await run({ mode: "recall", answer });
    expect(records.every((r) => r.beam === null && r.correct !== null)).toBe(true);
  });

  it("scores a question that could not be answered as 0, and counts a failed workspace the same way", async () => {
    const failedChat = await run({ mode: "recall", failChat: true }, { scoring: "both" });
    expect(failedChat.records).toHaveLength(40);
    expect(
      failedChat.records.every((r) => r.error?.startsWith("chat failed") && r.beam?.score === 0),
    ).toBe(true);
    const failedIngest = await run({ mode: "recall", failMessages: true }, { scoring: "both" });
    expect(failedIngest.records).toHaveLength(40);
    expect(
      failedIngest.records.every(
        (r) => r.error?.includes("workspace failed") && r.beam?.score === 0,
      ),
    ).toBe(true);
  });

  it("reports the score per ability and overall, and compares two runs", async () => {
    const { records, units } = await run({ mode: "recall", answer }, { scoring: "both" });
    const a = buildResults(settings("both", "recall"), records, units);
    const beamSummary = a.summary.beam;
    expect(beamSummary?.abilities.map((x) => x.ability)).toHaveLength(10);
    expect(beamSummary?.overall.abilitiesCovered).toBe(10);
    // the overall score is the mean of the ten ability means
    const means = (beamSummary?.abilities ?? []).map((x) => x.mean as number);
    expect(beamSummary?.overall.mean).toBeCloseTo(means.reduce((x, y) => x + y, 0) / 10, 12);

    const md = renderMarkdown(a);
    for (const heading of ["## BEAM scoring", "## Accuracy", "## Cost"])
      expect(md).toContain(heading);
    expect(md).toContain("| event-ordering | 4 |");
    expect(md).toContain("**Overall** (mean of 10 abilities)");
    expect(md).toContain("beam 100K: 40 questions");

    const b = buildResults(settings("both", "other"), records, units);
    const cmp = renderComparison(a, b);
    expect(cmp).toContain("| Ability | recall | other | Delta (other - recall) |");
    expect(cmp).not.toContain("Not directly comparable");
    const c = buildResults({ ...settings("rubric", "rubric-only") }, records, units);
    expect(renderComparison(a, c)).toContain("scoring");
  });
});
