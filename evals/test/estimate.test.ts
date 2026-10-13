import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import beam from "../fixtures/beam-sample.json" with { type: "json" };
import { planBeam } from "../src/datasets/beam.js";
import { DEFAULT_RATES, estimateRun, renderEstimate } from "../src/estimate.js";

describe("cost estimate", () => {
  it("prices the selected workload offline from the documented rates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "est-"));
    const file = join(dir, "beam-100k.json");
    await writeFile(file, JSON.stringify(beam));
    const plan = await planBeam(file, "100k", { limit: 25 });
    const e = await estimateRun(plan, {
      dataset: "beam",
      beamSplit: "100k",
      level: "low",
      scoring: "both",
    });
    expect(e).toMatchObject({ units: 2, questions: 25, sessions: 3, messages: 12 });
    expect(e.usd.ingest).toBeCloseTo((e.tokens / 1e6) * DEFAULT_RATES.ingestUsdPerMTok, 12);
    expect(e.usd.query).toBeCloseTo(25 * DEFAULT_RATES.queryUsd, 12);
    expect(e.usd.judge).toBeCloseTo(
      25 * (DEFAULT_RATES.judgeRubricUsd + DEFAULT_RATES.judgeBeamUsd),
      12,
    );
    expect(e.usd.total).toBeCloseTo(e.usd.system + e.usd.judge, 12);
    expect(e.highTotal).toBeCloseTo(e.usd.system * DEFAULT_RATES.highFactor + e.usd.judge, 12);

    const text = renderEstimate(e);
    expect(text).toContain("beam 100K");
    expect(text).toContain("25 questions in 2 workspaces");

    const rubricOnly = await estimateRun(plan, {
      dataset: "beam",
      beamSplit: "100k",
      level: "low",
      scoring: "rubric",
    });
    expect(rubricOnly.usd.judge).toBeCloseTo(25 * DEFAULT_RATES.judgeRubricUsd, 12);
    const cheaper = await estimateRun(plan, {
      dataset: "beam",
      level: "low",
      scoring: "beam",
      rates: { ingestUsdPerMTok: 0 },
    });
    expect(cheaper.usd.ingest).toBe(0);

    // --reuse: workspaces that already hold their messages are not ingested again.
    const allReused = await estimateRun(plan, {
      dataset: "beam",
      beamSplit: "100k",
      level: "low",
      scoring: "both",
      reused: new Set(plan.map((u) => u.id)),
    });
    expect(allReused).toMatchObject({ reused: 2, questions: 25, tokens: e.tokens });
    expect(allReused.usd.ingest).toBe(0);
    expect(allReused.usd.query).toBeCloseTo(e.usd.query, 12);
    expect(renderEstimate(allReused)).toContain("2 workspace(s) reused");
  });
});
