import { describe, expect, it } from "vitest";
import {
  alignmentPrompt,
  extractJsonObject,
  nuggetPrompt,
  parseAlignment,
  parseNuggetScores,
} from "../src/beam/prompts.js";
import { BEAM_NUGGETS_V1 } from "../src/beam/protocol.js";
import {
  BEAM_ABILITIES,
  kendallTauB,
  nuggetQuestionScore,
  orderingScore,
  orderingTauB,
  snapNugget,
  summarizeBeam,
} from "../src/beam/scoring.js";
import { LexicalJudge } from "../src/judge.js";

describe("Kendall tau-b", () => {
  it("is 1 for the same order, -1 for the reverse", () => {
    expect(kendallTauB([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(kendallTauB([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
  });

  it("matches SciPy's documented tie-corrected example", () => {
    // scipy.stats.kendalltau([12, 2, 1, 12, 2], [1, 4, 7, 1, 0]) -> -0.47140452079103173
    expect(kendallTauB([12, 2, 1, 12, 2], [1, 4, 7, 1, 0])).toBeCloseTo(-0.47140452079103173, 12);
  });

  it("returns exactly what SciPy's kendalltau(variant='b') returns, ties included", () => {
    // scipy 1.16.1 (the version BEAM pins) and 1.18.1: kendalltau(x, y, variant="b", method="auto").statistic
    const cases: [number[], number[], number | null][] = [
      [[1, 2, 3, 4, 5], [3, 1, 2, 5, 4], 0.39999999999999997],
      [[1, 2, 3, 5], [1, 4, 3, 5], 0.6666666666666669],
      [[1, 2, 3, 4, 4], [2, 1, 4, 4, 3], 0.4444444444444444],
      [[1, 2, 3, 4, 6, 6], [2, 6, 1, 6, 3, 4], 0.07142857142857144],
      [[1, 2, 3, 4, 5, 6, 7], [7, 7, 7, 1, 2, 3, 7], -0.16903085094570333],
      [[1, 2, 3, 6, 6], [1, 3, 2, 6, 5], 0.7378647873726218],
      // NaN in SciPy: a constant ranking, or a single item
      [[1, 2], [2, 2], null],
      [[1, 3], [3, 3], null],
      [[1], [1], null],
    ];
    for (const [x, y, want] of cases) expect(kendallTauB(x, y)).toBe(want);
  });

  it("corrects for ties in one ranking: 9 concordant pairs, 1 tied pair out of 10", () => {
    expect(kendallTauB([1, 2, 3, 4, 5], [1, 2, 2, 4, 5])).toBeCloseTo(9 / Math.sqrt(10 * 9), 12);
  });

  it("is undefined (null) when a ranking is constant or there are fewer than two items", () => {
    expect(kendallTauB([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(kendallTauB([1], [1])).toBeNull();
    expect(kendallTauB([], [])).toBeNull();
    expect(() => kendallTauB([1, 2], [1])).toThrow();
  });
});

describe("event-ordering score", () => {
  it("perfect order scores 1 and the exact reverse -1 (which scores 0 once clipped)", () => {
    const perfect = orderingTauB({ events: 4, items: 4, matches: [1, 2, 3, 4] });
    expect(perfect).toMatchObject({ tauB: 1, matched: 4, absent: 0, extra: 0 });
    expect(orderingScore(perfect)).toBe(1);
    const reversed = orderingTauB({ events: 4, items: 4, matches: [4, 3, 2, 1] });
    expect(reversed.tauB).toBe(-1);
    expect(orderingScore(reversed)).toBe(0);
  });

  it("an event left out is tied after everything the answer mentions, so it adds no ordered pairs", () => {
    // events 3 and 4 are missing: ranks [1,2,3,4] vs [1,2,3,3]; 5 concordant pairs, one tied pair
    const r = orderingTauB({ events: 4, items: 2, matches: [1, 2, null, null] });
    expect(r).toMatchObject({ matched: 2, absent: 2, extra: 0 });
    expect(r.tauB).toBeCloseTo(5 / Math.sqrt(6 * 5), 12);
  });

  it("which events are missing matters: leaving out early ones is worse than leaving out late ones", () => {
    const lateMissing = orderingTauB({ events: 4, items: 2, matches: [1, 2, null, null] });
    const earlyMissing = orderingTauB({ events: 4, items: 2, matches: [null, null, 1, 2] });
    expect(earlyMissing.tauB as number).toBeLessThan(lateMissing.tauB as number);
  });

  it("an invented item listed before real events counts as disorder", () => {
    // reference ranks [1,2,3(extra)] vs answer ranks [2,3,1]: 1 concordant, 2 discordant pairs
    const r = orderingTauB({ events: 2, items: 3, matches: [2, 3] });
    expect(r).toMatchObject({ matched: 2, absent: 0, extra: 1 });
    expect(r.tauB).toBeCloseTo(-1 / 3, 12);
  });

  it("an answer item denotes at most one event; out-of-range matches count as absent", () => {
    const r = orderingTauB({ events: 3, items: 3, matches: [1, 1, 9] });
    expect(r).toMatchObject({ matched: 1, absent: 2, extra: 2 });
  });

  it("is undefined, and scores 0, when nothing in the answer matches", () => {
    const r = orderingTauB({ events: 3, items: 0, matches: [null, null, null] });
    expect(r.tauB).toBeNull();
    expect(orderingScore(r)).toBe(0);
  });
});

describe("nugget scoring", () => {
  it("accepts exactly the paper's three levels", () => {
    expect([0, 0.5, 1, "0.5", "1"].map(snapNugget)).toEqual([0, 0.5, 1, 0.5, 1]);
    expect([0.7, -1, 2, "", "yes", null, Number.NaN].map(snapNugget)).toEqual(Array(7).fill(null));
  });

  it("scores a question as the mean of its nuggets (partial credit)", () => {
    expect(nuggetQuestionScore([1, 0.5, 0, 1])).toBe(0.625);
    expect(nuggetQuestionScore([])).toBeNull();
  });
});

describe("aggregation per ability and overall", () => {
  it("reproduces the BEAM paper's Average row: the unweighted mean of the ten ability scores", () => {
    // Table 1, Qwen2.5 vanilla at 100K: ten ability scores and the printed average 0.280
    const qwenVanilla100k = [0.3, 0.031, 0.192, 0.425, 0.4, 0.437, 0.222, 0.554, 0.128, 0.112];
    const items = BEAM_ABILITIES.map((ability, i) => ({
      ability,
      score: qwenVanilla100k[i] as number,
    }));
    const s = summarizeBeam(items);
    expect(s.overall.mean).toBeCloseTo(0.2801, 4);
    expect(s.overall.abilitiesCovered).toBe(10);
  });

  it("weights abilities equally, not questions", () => {
    const s = summarizeBeam([
      { ability: "abstention", score: 1 },
      { ability: "abstention", score: 1 },
      { ability: "abstention", score: 1 },
      { ability: "summarization", score: 0 },
    ]);
    expect(s.overall.mean).toBe(0.5);
    expect(s.overall.questionMean).toBe(0.75);
    expect(s.overall.abilitiesCovered).toBe(2);
    expect(s.abilities.map((a) => [a.ability, a.n, a.mean])).toEqual([
      ["abstention", 3, 1],
      ["summarization", 1, 0],
    ]);
  });

  it("excludes questions without a verdict but reports them, and tracks full credit", () => {
    const s = summarizeBeam([
      { ability: "knowledge-update", score: 1 },
      { ability: "knowledge-update", score: 0.5 },
      { ability: "knowledge-update", score: null },
    ]);
    const row = s.abilities[0];
    expect(row).toMatchObject({ n: 2, unscored: 1, mean: 0.75, fullCredit: 0.5 });
  });

  it("lists abilities in the paper's order and flags partial coverage", () => {
    const s = summarizeBeam([
      { ability: "temporal-reasoning", score: 0.2 },
      { ability: "abstention", score: 0.8 },
    ]);
    expect(s.abilities.map((a) => a.ability)).toEqual(["abstention", "temporal-reasoning"]);
    expect(s.overall.abilitiesTotal).toBe(10);
    expect(s.overall.abilitiesCovered).toBe(2);
  });

  it("bootstrap intervals are reproducible and contain the mean", () => {
    const items = [0, 0.5, 1, 1, 0.5, 0, 1].map((score) => ({ ability: "summarization", score }));
    const a = summarizeBeam(items);
    const b = summarizeBeam(items);
    expect(a).toEqual(b);
    const row = a.abilities[0];
    expect(row?.ci95?.[0]).toBeLessThanOrEqual(row?.mean as number);
    expect(row?.ci95?.[1]).toBeGreaterThanOrEqual(row?.mean as number);
    expect(summarizeBeam([]).overall.mean).toBeNull();
  });
});

describe("judge prompts and replies", () => {
  it("lists every nugget in the prompt and asks for one score per nugget", () => {
    const p = nuggetPrompt("Q?", "ref", ["first", "second"], "my answer");
    expect(p).toContain("1. first");
    expect(p).toContain("2. second");
    expect(p).toContain("Score all 2 nuggets");
    expect(p).toContain("my answer");
    expect(nuggetPrompt("Q?", "", ["only"], "").includes("(empty answer)")).toBe(true);
  });

  it("parses scores from bare JSON, a fenced block, or prose around it", () => {
    expect(parseNuggetScores('{"scores":[1,0.5,0],"reason":"ok"}', 3)).toEqual({
      scores: [1, 0.5, 0],
      reason: "ok",
    });
    expect(
      parseNuggetScores('Here you go:\n```json\n{"scores": [0, 1], "reason": "a {b}"}\n```', 2)
        ?.scores,
    ).toEqual([0, 1]);
  });

  it("rejects replies with the wrong count or an invalid score", () => {
    expect(parseNuggetScores('{"scores":[1,0]}', 3)).toBeNull();
    expect(parseNuggetScores('{"scores":[1,0.7]}', 2)).toBeNull();
    expect(parseNuggetScores("1, 0.5", 2)).toBeNull();
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("parses an alignment and validates the item numbers", () => {
    expect(parseAlignment('{"items":["a","b","c"],"matches":[2,null,"1"]}', 3)).toEqual({
      items: ["a", "b", "c"],
      matches: [2, null, 1],
    });
    expect(parseAlignment('{"items":["a"],"matches":[2]}', 1)).toBeNull(); // item 2 does not exist
    expect(parseAlignment('{"items":["a"],"matches":[1,1]}', 1)).toBeNull(); // wrong length
    expect(parseAlignment('{"items":"a","matches":[1]}', 1)).toBeNull();
    expect(alignmentPrompt("Q?", ["x", "y"], "ans")).toContain("2. y");
  });
});

describe("offline lexical BEAM judge, beam-nuggets-v1 (smoke tests only)", () => {
  const judge = new LexicalJudge({ beamProtocol: BEAM_NUGGETS_V1 });
  it("scores nuggets 0 / 0.5 / 1 by word overlap", async () => {
    const v = await judge.beam({
      question: "Q",
      response: "The first sprint ends on March 29 and uses Flask",
      spec: {
        ability: "information-extraction",
        reference: "r",
        nuggets: [
          "LLM response should state: sprint ends March 29",
          "LLM response should state: Django deployment pipeline schedule",
          "LLM response should state: Flask project sprint rewrite plan",
        ],
      },
    });
    expect(v.method).toBe("nuggets");
    expect(v.nuggetScores).toEqual([1, 0, 0.5]);
    expect(v.score).toBeCloseTo(0.5, 12);
  });

  it("orders events by matching them to the lines of a numbered answer", async () => {
    const spec = {
      ability: "event-ordering",
      reference: "r",
      nuggets: [],
      events: ["Project setup", "Database design", "Deployment"],
    };
    const good = await judge.beam({
      question: "Q",
      response: "1) Project setup done 2) Database design done 3) Deployment done",
      spec,
    });
    expect(good).toMatchObject({ method: "tau-b", tauB: 1, score: 1 });
    const bad = await judge.beam({
      question: "Q",
      response: "1. Deployment\n2. Database design\n3. Project setup",
      spec,
    });
    expect(bad.tauB).toBe(-1);
    expect(bad.score).toBe(0);
  });
});
