import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BEAM_NUGGETS_V1, BEAM_REF, parseBeamProtocol } from "../src/beam/protocol.js";
import {
  BEAM_REF_EQUIVALENCE_SYSTEM,
  BEAM_REF_JUDGE_PROMPT,
  type Equivalence,
  parseJsonResponse,
  parseRefJudgeReply,
  pyFloat,
  refEquivalenceUser,
  refEventOrdering,
  refItemsScore,
  refJudgePrompt,
  refOrderingMetrics,
  refSaysSame,
  refScoreQuestion,
} from "../src/beam/reference.js";
import { createJudge } from "../src/judge.js";
import { rejudgeRun } from "../src/rejudge-run.js";
import { buildResults, renderComparison, renderMarkdown } from "../src/report.js";
import type { QuestionRecord, Results } from "../src/results.js";
import { readJsonl } from "../src/util.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("BEAM's prompts, verbatim", () => {
  // SHA-256 of the strings in BEAM's code at commit b2da22e, read with Python's ast module:
  // src/prompts.py unified_llm_judge_base_prompt, and llm_equivalence's system message and user
  // f-string (rendered with its placeholder names) in src/evaluation/compute_metrics.py.
  it("the per-item judge prompt is unified_llm_judge_base_prompt", () => {
    expect(sha256(BEAM_REF_JUDGE_PROMPT)).toBe(
      "593373c642a288a7b590577d8a8fc92c3f9a2b70e2f64ad6e59a040a6c56b7f5",
    );
    expect(BEAM_REF_JUDGE_PROMPT).toHaveLength(3781);
    expect(BEAM_REF_JUDGE_PROMPT.startsWith("\nYou are an expert evaluator")).toBe(true);
    expect(BEAM_REF_JUDGE_PROMPT).toContain("- RUBRIC CRITERION (what to check): <rubric_item>\n");
    expect(BEAM_REF_JUDGE_PROMPT).toContain("- RESPONSE TO EVALUATE: <llm_response>\n");
    // its trailing spaces are part of the text
    expect(BEAM_REF_JUDGE_PROMPT).toContain("the LLM response should demonstrate. \n");
    expect(BEAM_REF_JUDGE_PROMPT).toContain("3. **Check Compliance**: \n");
    expect(BEAM_REF_JUDGE_PROMPT.endsWith("without any explanation before or after that\n")).toBe(
      true,
    );
  });

  it("the equivalence messages are llm_equivalence's", () => {
    expect(sha256(BEAM_REF_EQUIVALENCE_SYSTEM)).toBe(
      "0863c78c1b27d36c97bb7bfd2d4d6b88ef69b093e92bb4719e665527722413e2",
    );
    expect(BEAM_REF_EQUIVALENCE_SYSTEM).toContain("DO NOT provide any exaplanation.");
    expect(sha256(refEquivalenceUser("{first_paragraph}", "{second_paragraph}"))).toBe(
      "6bf789b815decbeb1c27f5058e2416c2a6e167724c0433b1da27b0abe5cc73df",
    );
    expect(refEquivalenceUser("A", "B")).toBe(
      `First snippet: A \n\n${" ".repeat(23)}Second snippet: B\n${" ".repeat(20)}`,
    );
  });

  it("fills the judge prompt like Python's str.replace: every occurrence, rubric item first", () => {
    const p = refJudgePrompt("costs $& and $1", "The answer");
    expect(p).toContain("- RUBRIC CRITERION (what to check): costs $& and $1\n");
    expect(p).toContain("- RESPONSE TO EVALUATE: The answer\n");
    expect(p).not.toContain("<rubric_item>");
    // a placeholder inside the item is replaced by the second replace, as in BEAM's code
    expect(refJudgePrompt("mentions <llm_response>", "X")).toContain(
      "CRITERION (what to check): mentions X",
    );
  });

  it("an equivalence reply counts as a match when it contains 'yes' in any case", () => {
    expect(["YES", "**Yes**", "yes.", "Eyes"].map(refSaysSame)).toEqual([true, true, true, true]);
    expect(["NO", "", "Nope"].map(refSaysSame)).toEqual([false, false, false]);
  });
});

describe("reading the per-item judge's reply", () => {
  it("returns what BEAM's parse_json_response + json_repair + float() return", () => {
    // Every expected score below is what BEAM's code (parse_json_response, the json_repair 0.44.1
    // fallback and float(reply["score"])) returns for the same text.
    const cases: [string, number][] = [
      ['{"score": 1.0, "reason": "ok"}', 1],
      ['{\n   "score": 0.5,\n   "reason": "partly"\n}', 0.5],
      ['```json\n{\n  "score": 0.0,\n  "reason": "missing"\n}\n```', 0],
      ['```json\n{"score": 1.0, "reason": "x"}\n``` and then {"score": 0}', 1],
      ['Here is my evaluation:\n{"score": 1.0, "reason": "a } b"}', 1],
      ['Here: {"score": 0.5, "reason": "a {b} c"} trailing', 0.5],
      ['{"score": "1.0", "reason": "x"}', 1],
      ['{"score": " 0.5 ", "reason": "x"}', 0.5],
      ['{"score": 0.75, "reason": "not snapped"}', 0.75],
      ['{"score": true, "reason": "x"}', 1],
      ['{"score": 1.0, "reason": "unterminated', 1],
      ["{'score': 1.0, 'reason': 'single quotes'}", 1],
      ['{"score": 1.0, "reason": "trailing comma",}', 1],
      ['{"score": 1.0 "reason": "missing comma"}', 1],
      ['{"reason": "reason first", "score": 0.5}', 0.5],
      ['{"score": 1, "reason": "x"} {"score": 0}', 1],
      ['prefix ```json\n{"score": 0.5}\n```', 0.5],
      ['{"score": 2, "reason": "kept as given"}', 2],
    ];
    for (const [text, score] of cases) expect(parseRefJudgeReply(text)?.score).toBe(score);
    expect(parseRefJudgeReply('{"score": 0.5, "reason": "partly there"}')?.reason).toBe(
      "partly there",
    );
  });

  it("gives no score where BEAM's code would raise (the caller retries once)", () => {
    for (const text of [
      "Score: 1.0",
      '{"reason": "no score"}',
      '{"score": [1.0]}',
      '{"score": null}',
      "",
    ])
      expect(parseRefJudgeReply(text)).toBeNull();
    // BEAM's code raises on a list too; the first-JSON-object fallback reads the score in it
    expect(parseRefJudgeReply('[{"score": 1.0}]')?.score).toBe(1);
  });

  it("parse_json_response and float() themselves", () => {
    expect(parseJsonResponse("```json\n[1, 2]\n```")).toEqual([1, 2]);
    expect(parseJsonResponse('x {"a": 1} y {"b": 2}')).toEqual({ a: 1 });
    expect(() => parseJsonResponse("no json")).toThrow("No valid JSON found in response.");
    expect(() => parseJsonResponse('x {"a": "}" y')).toThrow();
    expect([1, "0.5", " 1e0 ", "+1.", ".5", false].map(pyFloat)).toEqual([1, 0.5, 1, 1, 0.5, 0]);
    expect(["", "one", "0x10", "nan", null, [1], Number.NaN].map(pyFloat)).toEqual(
      Array(7).fill(null),
    );
  });
});

describe("llm_judge_score: one judge call per rubric item", () => {
  const sameNever: Equivalence = async () => false;

  it("is the sum of the item scores over the number of items, in order", async () => {
    const asked: string[] = [];
    const scores: Record<string, number> = { a: 1, b: 0.5, c: 0, d: 0.75 };
    const r = await refScoreQuestion("knowledge-update", ["a", "b", "c", "d"], "answer", {
      item: async (i) => {
        asked.push(i);
        return { score: scores[i] as number, reason: `r-${i}` };
      },
      same: sameNever,
    });
    expect(asked).toEqual(["a", "b", "c", "d"]);
    expect(r).toMatchObject({
      method: "llm-judge",
      score: 0.5625,
      itemScores: [1, 0.5, 0, 0.75],
      itemReasons: ["r-a", "r-b", "r-c", "r-d"],
      ordering: null,
    });
    expect(refItemsScore([1, 0.5, 0])).toBe(0.5);
    expect(refItemsScore([])).toBeNull();
  });

  it("leaves the question unscored when an item gets no usable verdict", async () => {
    const r = await refScoreQuestion("summarization", ["a", "b"], "answer", {
      item: async (i) =>
        i === "b"
          ? { score: null, reason: "unparseable judge output: ?" }
          : { score: 1, reason: "" },
      same: sameNever,
    });
    expect(r.score).toBeNull();
    expect(r.itemScores).toBeNull();
    expect(r.reason).toContain("no usable verdict for 1 of 2 rubric items");
  });
});

/** Stand-in for the equivalence judge: same event when the line contains the event's last word. */
const keyword: Equivalence = async (reference, line) =>
  line.toLowerCase().includes((reference.split(/\s+/).at(-1) ?? "").toLowerCase());

const EVENTS = ["Project setup", "Database design", "Deployment"];

describe("event ordering: align_with_llm + event_ordering_score", () => {
  // Expected values come from running BEAM's own align_with_llm and event_ordering_score (SciPy
  // 1.16.1) on the same inputs with the same keyword stand-in for llm_equivalence.
  const cases: {
    name: string;
    reference: string[];
    response: string;
    canon: string[];
    ranks: [number[], number[]];
    precision: number;
    recall: number;
    f1: number;
    tauNorm: number | null;
    finalScore: number | null;
    calls: number;
  }[] = [
    {
      name: "a header, a blank line and a trailing newline are lines too",
      reference: EVENTS,
      response: "Here is the order:\n\n1. Project setup\n2. Database design\n3. Deployment\n",
      canon: ["Here is the order:", "", "Project setup", "Database design", "Deployment", ""],
      ranks: [
        [1, 2, 3, 6, 6],
        [3, 4, 5, 1, 6],
      ],
      precision: 0.5,
      recall: 1,
      f1: 0.6666666666666666,
      tauNorm: 0.658113883008419,
      finalScore: 0.43874258867227933,
      calls: 6,
    },
    {
      name: "the exact reverse",
      reference: EVENTS,
      response: "1. Deployment\n2. Database design\n3. Project setup",
      canon: ["Deployment", "Database design", "Project setup"],
      ranks: [
        [1, 2, 3],
        [3, 2, 1],
      ],
      precision: 1,
      recall: 1,
      f1: 1,
      tauNorm: 0,
      finalScore: 0,
      calls: 6,
    },
    {
      name: "an event mentioned twice: the second line finds its event taken and stays as it is",
      reference: EVENTS,
      response: "Project setup\nMore on project setup\nDatabase design",
      canon: ["Project setup", "More on project setup", "Database design"],
      ranks: [
        [1, 2, 3, 5],
        [1, 3, 5, 2],
      ],
      precision: 0.6666666666666666,
      recall: 0.6666666666666666,
      f1: 0.6666666666666666,
      tauNorm: 0.6666666666666667,
      finalScore: 0.4444444444444445,
      calls: 4,
    },
    {
      name: "an absent event and an extra line",
      reference: EVENTS,
      response: "Project setup\nA new feature\nDeployment",
      canon: ["Project setup", "A new feature", "Deployment"],
      ranks: [
        [1, 2, 3, 5],
        [1, 5, 3, 2],
      ],
      precision: 0.6666666666666666,
      recall: 0.6666666666666666,
      f1: 0.6666666666666666,
      tauNorm: 0.5,
      finalScore: 0.3333333333333333,
      calls: 5,
    },
    {
      name: "duplicate reference strings collapse and rank at their last position",
      reference: ["Setup", "Setup", "Deployment"],
      response: "Setup\nDeployment\nSetup",
      canon: ["Setup", "Deployment", "Setup"],
      ranks: [
        [2, 3],
        [3, 2],
      ],
      precision: 1,
      recall: 1,
      f1: 1,
      tauNorm: 0,
      finalScore: 0,
      calls: 4,
    },
    {
      name: "a line repeating an event verbatim counts as that event even when unmatched",
      reference: ["Project setup", "Database design"],
      response: "Project setup\nProject setup",
      canon: ["Project setup", "Project setup"],
      ranks: [
        [1, 2],
        [2, 3],
      ],
      precision: 1,
      recall: 0.5,
      f1: 0.6666666666666666,
      tauNorm: 1,
      finalScore: 0.6666666666666666,
      calls: 2,
    },
    {
      name: "a numbered list on one line is one line",
      reference: EVENTS,
      response: "1) Project setup 2) Database design 3) Deployment",
      canon: ["Project setup"],
      ranks: [
        [1, 2, 3],
        [1, 4, 4],
      ],
      precision: 1,
      recall: 0.3333333333333333,
      f1: 0.5,
      tauNorm: 0.908248290463863,
      finalScore: 0.4541241452319315,
      calls: 1,
    },
    {
      name: "blank lines only: a constant ranking, so tau-b is undefined (NaN)",
      reference: ["Project setup"],
      response: "\n\n",
      canon: ["", "", ""],
      ranks: [
        [1, 3],
        [3, 3],
      ],
      precision: 0,
      recall: 0,
      f1: 0,
      tauNorm: null,
      finalScore: null,
      calls: 0,
    },
    {
      name: "a single item: tau-b is undefined (NaN)",
      reference: ["Project setup"],
      response: "Project setup",
      canon: ["Project setup"],
      ranks: [[1], [1]],
      precision: 1,
      recall: 1,
      f1: 1,
      tauNorm: null,
      finalScore: null,
      calls: 1,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const o = await refEventOrdering(c.reference, c.response, keyword);
      expect([o.referenceRanks, o.systemRanks]).toEqual(c.ranks);
      expect({
        precision: o.precision,
        recall: o.recall,
        f1: o.f1,
        tauNorm: o.tauNorm,
        finalScore: o.finalScore,
        calls: o.calls,
      }).toEqual({
        precision: c.precision,
        recall: c.recall,
        f1: c.f1,
        tauNorm: c.tauNorm,
        finalScore: c.finalScore,
        calls: c.calls,
      });
      expect(o.lines).toBe(c.response.split("\n").length);
      // the metrics on the aligned list alone give the same
      expect(refOrderingMetrics(c.reference, c.canon).tauNorm).toBe(c.tauNorm);
    });
  }

  it("asks line by line, each line against the still-free events in reference order, first yes wins", async () => {
    const asked: [string, string][] = [];
    const same: Equivalence = async (r, l) => {
      asked.push([r, l]);
      return keyword(r, l);
    };
    await refEventOrdering(
      EVENTS,
      "Project setup\nMore on project setup\n   \nDatabase design",
      same,
    );
    expect(asked).toEqual([
      ["Project setup", "Project setup"],
      ["Database design", "More on project setup"],
      ["Deployment", "More on project setup"],
      // the whitespace-only line is not sent
      ["Database design", "Database design"],
    ]);
  });

  it("scores tau_norm, and an undefined tau-b as 0 with the reason recorded", async () => {
    const ok = await refScoreQuestion("event-ordering", EVENTS, "1. Deployment\n2. Project setup", {
      item: async () => ({ score: 1, reason: "" }),
      same: keyword,
    });
    expect(ok.method).toBe("tau-norm");
    expect(ok.score).toBe(ok.ordering?.tauNorm);
    expect(ok.reason).toMatch(/^tau_norm /);
    const nan = await refScoreQuestion("event-ordering", ["Project setup"], "Project setup", {
      item: async () => ({ score: 1, reason: "" }),
      same: keyword,
    });
    expect(nan).toMatchObject({ method: "tau-norm", score: 0 });
    expect(nan.ordering?.tauB).toBeNull();
    expect(nan.reason).toContain("tau-b undefined (NaN in BEAM's code), scored 0");
  });
});

// ------------------------------------------------------- through the client ----

let provider: Server | undefined;
afterEach(() => {
  provider?.close();
  provider = undefined;
});

interface SentRequest {
  model: string;
  temperature?: number;
  messages: { role: string; content: string }[];
}

/**
 * A fake OpenAI-compatible judge: equivalence calls (with a system message) answer by the keyword
 * rule; per-item calls answer with `itemReply(rubric item)`.
 */
async function fakeJudge(itemReply: (item: string) => string) {
  const requests: SentRequest[] = [];
  provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as SentRequest;
    requests.push(body);
    const user = body.messages.at(-1)?.content ?? "";
    let text: string;
    if (body.messages[0]?.role === "system") {
      const first = /First snippet: (.*) \n/.exec(user)?.[1] ?? "";
      const second = /Second snippet: (.*)\n/.exec(user)?.[1] ?? "";
      text = (await keyword(first, second)) ? "YES" : "NO";
    } else {
      const item = /- RUBRIC CRITERION \(what to check\): (.*)\n/.exec(user)?.[1] ?? "";
      text = itemReply(item);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "judge-1",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: text } },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
    );
  });
  await new Promise<void>((r) => provider?.listen(0, "127.0.0.1", r));
  const port = (provider.address() as AddressInfo).port;
  return {
    requests,
    env: {
      RECALL_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
      RECALL_COMPAT_API_KEY: "k",
      RECALL_PRICING_JSON: JSON.stringify({ "compat/judge-1": { input: 1, output: 2 } }),
    },
  };
}

const CALL_USD = (100 * 1 + 10 * 2) / 1_000_000;

describe("LlmJudge with beam-ref-b2da22e", () => {
  it("sends one bare prompt per rubric item at temperature 0 and averages the scores", async () => {
    const p = await fakeJudge((item) =>
      item.endsWith("March 29")
        ? '```json\n{"score": 1.0, "reason": "states it"}\n```'
        : '{"score": 0.5, "reason": "partly"}',
    );
    const judge = createJudge("compat/judge-1", p.env);
    expect(judge.settings.beamProtocol).toBe(BEAM_REF);
    const v = await judge.beam({
      question: "When does the sprint end?",
      response: "It ends on March 29.",
      spec: {
        ability: "information-extraction",
        nuggets: ["LLM response should state: March 29", "LLM response should mention: sprint"],
        // the verbatim rubric wins over the trimmed nuggets
        rubric: ["LLM response should state: March 29", "LLM response should mention: sprint "],
        reference: "March 29",
      },
    });
    expect(v).toMatchObject({
      protocol: BEAM_REF,
      method: "llm-judge",
      score: 0.75,
      nuggetScores: [1, 0.5],
      itemReasons: ["states it", "partly"],
      calls: 2,
      inputTokens: 200,
      outputTokens: 20,
    });
    expect(v.costUsd).toBeCloseTo(2 * CALL_USD, 12);
    expect(p.requests).toHaveLength(2);
    for (const r of p.requests) {
      expect(r.temperature).toBe(0);
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]?.role).toBe("user");
    }
    expect(p.requests[1]?.messages[0]?.content).toBe(
      refJudgePrompt("LLM response should mention: sprint ", "It ends on March 29."),
    );
  });

  it("retries an unreadable reply once, then leaves the question unscored", async () => {
    const p = await fakeJudge(() => "I cannot decide");
    const v = await createJudge("compat/judge-1", p.env).beam({
      question: "q",
      response: "a",
      spec: { ability: "summarization", nuggets: ["x"], reference: "" },
    });
    expect(p.requests).toHaveLength(2);
    expect(v.score).toBeNull();
    expect(v.reason).toContain("unparseable judge output: I cannot decide");
    expect(v.calls).toBe(2);
  });

  it("aligns event-ordering answers with BEAM's equivalence messages, one call at a time", async () => {
    const p = await fakeJudge(() => '{"score": 1}');
    const v = await createJudge("compat/judge-1", p.env).beam({
      question: "In what order?",
      response: "1. Project setup\n\n2. Deployment\n3. Database design",
      spec: { ability: "event-ordering", nuggets: EVENTS, events: EVENTS, reference: "" },
    });
    // lines: setup (1 call), blank (none), deployment (2), design (1)
    expect(p.requests).toHaveLength(4);
    const first = p.requests[0];
    expect(first?.temperature).toBe(0);
    expect(first?.messages).toEqual([
      { role: "system", content: BEAM_REF_EQUIVALENCE_SYSTEM },
      { role: "user", content: refEquivalenceUser("Project setup", "1. Project setup") },
    ]);
    const o = refOrderingMetrics(EVENTS, ["Project setup", "", "Deployment", "Database design"]);
    expect(v).toMatchObject({
      method: "tau-norm",
      score: o.tauNorm,
      tauB: o.tauB,
      ordering: { matched: 3, absent: 0, extra: 1 },
      refOrdering: { lines: 4, blankLines: 1, equivalenceCalls: 4, f1: o.f1 },
      calls: 4,
    });
    expect(v.costUsd).toBeCloseTo(4 * CALL_USD, 12);
  });
});

// ---------------------------------------------------------------- rejudge ----

const SETTINGS = {
  label: "fake",
  note: null,
  startedAt: "a",
  finishedAt: "b",
  target: { url: "x", authenticated: false },
  dataset: "beam" as const,
  beamSplit: "100k" as const,
  scoring: "beam" as const,
  selection: {
    limit: null,
    offset: 0,
    types: null,
    order: "stratified" as const,
    questions: 4,
    units: 1,
  },
  level: "low",
  concurrency: 1,
  questionConcurrency: 1,
  observeOthers: false,
  dream: false,
  judge: { kind: "llm" as const, model: "compat/judge-1" },
  costModel: "honcho-list-estimate" as const,
};

/** A question record as runs before protocols were stored wrote it (beam-nuggets-v1, no `protocol`). */
function oldRecord(
  id: string,
  ability: string,
  answer: string | null,
  beam: { score: number | null; nuggets: string[]; events?: string[] },
): QuestionRecord {
  return {
    unit: "beam-100k-c1",
    id,
    category: ability,
    kind: "standard",
    question: `Question ${id}?`,
    gold: "gold",
    peer: "user",
    answer,
    abstained: null,
    confidence: null,
    latencyMs: answer === null ? null : 1000,
    error: answer === null ? "chat failed: HTTP 502" : null,
    correct: null,
    judgeReason: "old reason",
    judgeInputTokens: 50,
    judgeOutputTokens: 5,
    judgeCostUsd: 0.0001,
    beam: {
      ability,
      method: beam.events ? "tau-b" : "nuggets",
      score: beam.score,
      nuggetScores: null,
      tauB: beam.events ? 0.5 : null,
      matched: null,
      absent: null,
      extra: null,
      reason: "old reason",
      nuggets: beam.nuggets,
      events: beam.events ?? null,
      reference: "ref",
    },
  };
}

async function oldRun(): Promise<{ dir: string; old: Results }> {
  const dir = await mkdtemp(join(tmpdir(), "beam-rejudge-"));
  const records = [
    oldRecord("q-info", "information-extraction", "The sprint ends on March 29.", {
      score: 1,
      nuggets: ["LLM response should state: March 29"],
    }),
    oldRecord("q-order", "event-ordering", "1. Project setup\n2. Deployment\n3. Database design", {
      score: 0.5,
      nuggets: EVENTS,
      events: EVENTS,
    }),
    oldRecord("q-update", "knowledge-update", "It moved to Friday.", {
      score: null, // its judge call failed
      nuggets: ["LLM response should state: Friday"],
    }),
    oldRecord("q-abst", "abstention", null, {
      score: 0,
      nuggets: ["LLM response should say: no information"],
    }),
  ];
  const old = buildResults({ ...SETTINGS, beamScoring: BEAM_NUGGETS_V1 }, records, []);
  // as an old harness wrote it: no protocol on the records
  expect(old.records.every((r) => r.beam && !("protocol" in r.beam))).toBe(true);
  await writeFile(join(dir, "results.json"), JSON.stringify(old, null, 2));
  await writeFile(join(dir, "results.md"), renderMarkdown(old));
  await writeFile(
    join(dir, "records.jsonl"),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  await writeFile(join(dir, "units.jsonl"), "");
  return { dir, old };
}

describe("rejudge: re-scoring a stored run with another BEAM protocol", () => {
  it("moves a beam-nuggets-v1 run to BEAM's own scoring without asking the server", async () => {
    const { dir, old } = await oldRun();
    const p = await fakeJudge((item) =>
      item.endsWith("March 29")
        ? '{"score": 1.0, "reason": "yes"}'
        : '{"score": 0.5, "reason": "partly"}',
    );
    const lines: string[] = [];
    const out = await rejudgeRun(dir, {
      beamProtocol: BEAM_REF,
      concurrency: 2,
      log: (l) => lines.push(l),
      judge: createJudge("compat/judge-1", p.env, { beamProtocol: BEAM_REF }),
      questions: async () => {
        throw new Error("dataset file not found: beam-100k.json");
      },
    });
    expect(out).toMatchObject({ judged: 3, left: 0, protocol: BEAM_REF });
    expect(lines.join("\n")).toContain("using the questions stored in records.jsonl");
    expect(lines.join("\n")).toMatch(/judged 3 of 3 in .*: 6 BEAM judge calls/);

    // the previous files are kept under the old protocol's name
    const files = await readdir(dir);
    for (const f of [
      "records.beam-nuggets-v1.jsonl",
      "results.beam-nuggets-v1.json",
      "results.beam-nuggets-v1.md",
    ])
      expect(files).toContain(f);
    expect(await readFile(join(dir, "results.beam-nuggets-v1.json"), "utf8")).toBe(
      JSON.stringify(old, null, 2),
    );

    const recs = await readJsonl<QuestionRecord>(join(dir, "records.jsonl"));
    const by = (id: string) => recs.find((r) => r.id === id)?.beam;
    expect(recs.every((r) => r.beam?.protocol === BEAM_REF)).toBe(true);
    expect(by("q-info")).toMatchObject({ method: "llm-judge", score: 1, nuggetScores: [1] });
    expect(by("q-update")).toMatchObject({ method: "llm-judge", score: 0.5 });
    // a failed request keeps its 0, under the new label
    expect(by("q-abst")).toMatchObject({ method: "llm-judge", score: 0, reason: "no answer" });
    const order = by("q-order");
    const o = refOrderingMetrics(EVENTS, ["Project setup", "Deployment", "Database design"]);
    expect(order).toMatchObject({ method: "tau-norm", score: o.tauNorm, tauB: o.tauB, matched: 3 });
    expect(order?.judge).toMatchObject({ calls: 4, inputTokens: 400 });
    // judge totals add up across judgings; the old BEAM reason is replaced
    const info = recs.find((r) => r.id === "q-info");
    expect(info?.judgeInputTokens).toBe(150);
    expect(info?.judgeReason).toBe("rubric items 1");

    const results = JSON.parse(await readFile(join(dir, "results.json"), "utf8")) as Results;
    expect(results.settings.beamScoring).toBe(BEAM_REF);
    expect(results.summary.beam?.protocols).toEqual([BEAM_REF]);
    expect(results.summary.beam?.judge?.calls).toBe(6);
    const md = await readFile(join(dir, "results.md"), "utf8");
    expect(md).toContain("Protocol beam-ref-b2da22e: BEAM's own evaluation code");
    expect(md).toContain("Judge: compat/judge-1 at temperature 0 (BEAM's code uses gpt-4.1-mini");
    expect(md).toContain("BEAM scoring took 6 judge calls");
    expect(p.requests).toHaveLength(6);

    // Nothing left: a second rejudge with the same protocol has nothing to do.
    const again = await rejudgeRun(dir, {
      beamProtocol: BEAM_REF,
      concurrency: 2,
      log: () => undefined,
      judge: createJudge("compat/judge-1", p.env, { beamProtocol: BEAM_REF }),
    });
    expect(again).toMatchObject({ judged: 0, results: null });
    expect(p.requests).toHaveLength(6);
  });

  it("without --beam-protocol redoes only the failed judgements, keeping the run's protocol", async () => {
    const { dir } = await oldRun();
    const p = await fakeJudge(() => "{}");
    const lexicalRun = await rejudgeRun(dir, {
      concurrency: 1,
      log: () => undefined,
      judge: createJudge("mock", {}, { beamProtocol: BEAM_NUGGETS_V1 }),
      questions: async () => new Map(),
    });
    expect(lexicalRun).toMatchObject({ judged: 1, left: 0, protocol: BEAM_NUGGETS_V1 });
    expect(p.requests).toHaveLength(0);
    expect((await readdir(dir)).some((f) => f.includes(".beam-nuggets-v1."))).toBe(false);
    const recs = await readJsonl<QuestionRecord>(join(dir, "records.jsonl"));
    expect(recs.find((r) => r.id === "q-info")?.beam).not.toHaveProperty("protocol");
    expect(recs.find((r) => r.id === "q-update")?.beam?.protocol).toBe(BEAM_NUGGETS_V1);
    await expect(
      rejudgeRun(dir, {
        beamProtocol: BEAM_REF,
        concurrency: 1,
        log: () => undefined,
        judge: createJudge("mock", {}, { beamProtocol: BEAM_NUGGETS_V1 }),
      }),
    ).rejects.toThrow("scores BEAM with beam-nuggets-v1, not beam-ref-b2da22e");
  });
});

describe("results written under beam-nuggets-v1 still load", () => {
  it("aggregate, render and compare as what they were", async () => {
    const { dir, old } = await oldRun();
    const loaded = JSON.parse(await readFile(join(dir, "results.json"), "utf8")) as Results;
    expect(loaded.settings.beamScoring).toBe(BEAM_NUGGETS_V1);
    // summary as old files have it: no protocol details
    delete loaded.summary.beam?.protocols;
    delete loaded.summary.beam?.eventOrdering;
    delete loaded.summary.beam?.judge;
    const md = renderMarkdown(loaded);
    expect(md).toContain("BEAM nuggets 0/0.5/1 + Kendall tau-b (beam-nuggets-v1)");
    expect(md).toContain("Protocol beam-nuggets-v1: our own judge prompts");
    expect(md).not.toContain("Mixed protocols");
    // rebuilt from the records alone, the protocol is read from them
    const { beamScoring: _b, ...settings } = old.settings;
    const rebuilt = buildResults(settings, old.records, []);
    expect(rebuilt.settings.beamScoring).toBe(BEAM_NUGGETS_V1);
    expect(rebuilt.summary.beam?.overall.mean).toBe(old.summary.beam?.overall.mean);
    // a results file from before the protocol setting existed
    const { beamScoring: _x, ...older } = loaded.settings;
    expect(renderMarkdown({ ...loaded, settings: { ...older } as Results["settings"] })).toContain(
      "(beam-nuggets-v1)",
    );
    // comparing with a beam-ref run names the difference
    const ref = buildResults({ ...SETTINGS, beamScoring: BEAM_REF }, [], []);
    expect(renderComparison(loaded, ref)).toContain(
      'BEAM protocol: "beam-nuggets-v1" vs "beam-ref-b2da22e"',
    );
  });

  it("parses --beam-protocol values", () => {
    expect(["ref", "REF", BEAM_REF, "ours", BEAM_NUGGETS_V1, "x"].map(parseBeamProtocol)).toEqual([
      BEAM_REF,
      BEAM_REF,
      BEAM_REF,
      BEAM_NUGGETS_V1,
      BEAM_NUGGETS_V1,
      null,
    ]);
  });
});
