import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import beam from "../fixtures/beam-sample.json" with { type: "json" };
import { parseProbingQuestions, parsePythonLiteral } from "../src/beam/pyliteral.js";
import { BEAM_ABILITIES } from "../src/beam/scoring.js";
import {
  type BeamRow,
  batchesToSessions,
  chatToBatches,
  cleanBeamText,
  orderingEvents,
  parseBeamDate,
  planBeam,
  rowDrafts,
  rowToUnit,
} from "../src/datasets/beam.js";
import { planDataset } from "../src/datasets/index.js";

const ROWS = beam as unknown as BeamRow[];

describe("Python literal parser (probing_questions is a Python repr)", () => {
  it("reads what repr() writes: quotes, escapes, None/True/False, numbers, tuples", () => {
    expect(
      parsePythonLiteral(
        `{'a': [1, -2.5, 3e2, None, True, False], 'b': "it's", 'c': 'say "hi"', 'd': 'it\\'s', 'e': ('x', 'y'), 'f': {}}`,
      ),
    ).toEqual({
      a: [1, -2.5, 300, null, true, false],
      b: "it's",
      c: 'say "hi"',
      d: "it's",
      e: ["x", "y"],
      f: {},
    });
  });

  it("decodes escape sequences and non-ASCII text", () => {
    expect(parsePythonLiteral(String.raw`'line1\nline2\t’s \xe9 \\ done'`)).toBe(
      "line1\nline2\t’s é \\ done",
    );
    expect(parsePythonLiteral(`'Zażółć gęślą jaźń — ünï'`)).toBe("Zażółć gęślą jaźń — ünï");
  });

  it("reads sets as lists and tolerates trailing commas and whitespace", () => {
    expect(parsePythonLiteral(`\n { 'k' : [ 1 , 2 , ] , }\n`)).toEqual({ k: [1, 2] });
    expect(parsePythonLiteral("{1, 2, 3}")).toEqual([1, 2, 3]);
  });

  it("rejects anything that is not a literal", () => {
    expect(() => parsePythonLiteral("{'a': __import__('os')}")).toThrow(/unexpected/);
    expect(() => parsePythonLiteral("{'a': 1} extra")).toThrow(/trailing/);
    expect(() => parsePythonLiteral("{'a': 'unterminated}")).toThrow();
  });

  it("parseProbingQuestions accepts a Python repr, JSON text or an object", () => {
    const expected = { abstention: [{ question: "q" }] };
    expect(parseProbingQuestions("{'abstention': [{'question': 'q'}]}")).toEqual(expected);
    expect(parseProbingQuestions('{"abstention": [{"question": "q"}]}')).toEqual(expected);
    expect(parseProbingQuestions(expected)).toEqual(expected);
    expect(() => parseProbingQuestions("[1, 2]")).toThrow();
  });

  it("reads every question of the fixture's repr strings", () => {
    const parsed = parseProbingQuestions((ROWS[0] as BeamRow).probing_questions);
    expect(Object.keys(parsed)).toHaveLength(10);
    expect(Object.values(parsed).every((qs) => qs.length === 2)).toBe(true);
  });
});

describe("BEAM dates, text and chat shapes", () => {
  it("parses the dataset's time anchors and common spellings, rejecting impossible dates", () => {
    const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
    expect(parseBeamDate("March-15-2024")).toBe(day(2024, 3, 15));
    expect(parseBeamDate("March 15, 2024")).toBe(day(2024, 3, 15));
    expect(parseBeamDate("Sep-05-2024")).toBe(day(2024, 9, 5));
    expect(parseBeamDate("15 March 2024")).toBe(day(2024, 3, 15));
    expect(parseBeamDate("2024-03-15")).toBe(day(2024, 3, 15));
    expect(parseBeamDate("February-30-2024")).toBeNull();
    expect(parseBeamDate("someday")).toBeNull();
    expect(parseBeamDate(null)).toBeNull();
  });

  it("strips the generator's plan marker from turns, and nothing else", () => {
    expect(cleanBeamText("My sprint ends on March 29. ->-> 1,1")).toBe(
      "My sprint ends on March 29.",
    );
    expect(cleanBeamText("Look at ->-> in this arrow")).toBe("Look at ->-> in this arrow");
    expect(cleanBeamText("  plain  ")).toBe("plain");
  });

  const m = (role: string, content: string, time_anchor: string | null = null) => ({
    role,
    content,
    time_anchor,
  });

  it("reads a list of batches (100K/500K/1M), taking each batch's date from its first anchor", () => {
    const batches = chatToBatches([
      [m("user", "a", "March-15-2024"), m("assistant", "b")],
      [m("user", "c", "April-05-2024")],
    ]);
    expect(batches.map((b) => [b.id, b.anchor, b.messages.length])).toEqual([
      ["b01", "March-15-2024", 2],
      ["b02", "April-05-2024", 1],
    ]);
  });

  it("splits a flat message list at every new time anchor", () => {
    const batches = chatToBatches([
      m("user", "a", "March-15-2024"),
      m("assistant", "b"),
      m("user", "c", "April-05-2024"),
      m("assistant", "d"),
    ]);
    expect(batches.map((b) => b.messages.length)).toEqual([2, 2]);
  });

  it("reads the 10M layout: plans of batches of turn groups, in numeric plan order", () => {
    const plan = (n: number) => [
      {
        batch_number: 1,
        time_anchor: null,
        turns: [[m("user", `p${n} u`, `March-0${n}-2024`), m("assistant", `p${n} a`)]],
      },
      { batch_number: 2, time_anchor: `April-0${n}-2024`, turns: [[m("user", `p${n} u2`)]] },
    ];
    for (const chat of [
      [{ "plan-2": plan(2), "plan-1": plan(1), "plan-10": plan(3) }],
      {
        "plan-2": plan(2),
        "plan-1": plan(1),
        "plan-10": plan(3),
      },
    ]) {
      const batches = chatToBatches(chat);
      expect(batches.map((b) => b.id)).toEqual([
        "p01-b01",
        "p01-b02",
        "p02-b01",
        "p02-b02",
        "p10-b01",
        "p10-b02",
      ]);
      // batch-level anchor wins; otherwise the first message's anchor is used
      expect(batches[0]?.anchor).toBe("March-01-2024");
      expect(batches[1]?.anchor).toBe("April-01-2024");
      expect(batches[0]?.messages.map((x) => x.content)).toEqual(["p1 u", "p1 a"]);
    }
  });

  it("gives every message a strictly later timestamp than the one before, even across same-day or undated batches", () => {
    const { sessions, lastMs } = batchesToSessions([
      { id: "b01", anchor: "March-15-2024", messages: [m("user", "a"), m("assistant", "b")] },
      { id: "b02", anchor: "March-15-2024", messages: [m("user", "c")] }, // same day
      { id: "b03", anchor: null, messages: [m("user", "d")] }, // undated: next day
      { id: "b04", anchor: "garbage", messages: [m("user", "   ")] }, // nothing to ingest
      { id: "b05", anchor: "March-01-2024", messages: [m("user", "e")] }, // goes backwards (10M does)
    ]);
    expect(sessions.map((s) => s.id)).toEqual([
      "b01-2024-03-15",
      "b02-2024-03-15",
      "b03-2024-03-16",
      "b05-2024-03-16",
    ]);
    // the backwards anchor is placed just after the previous session instead of in the past
    expect(sessions[3]?.messages[0]?.createdAt).toBe("2024-03-16T09:01:00.000Z");
    const times = sessions.flatMap((s) => s.messages.map((x) => x.createdAt));
    expect(times).toEqual([...times].sort());
    expect(new Set(times).size).toBe(times.length);
    expect(sessions[0]?.messages.map((x) => x.createdAt)).toEqual([
      "2024-03-15T09:00:00.000Z",
      "2024-03-15T09:00:30.000Z",
    ]);
    expect(sessions[1]?.messages[0]?.createdAt).toBe("2024-03-15T09:01:30.000Z");
    expect(sessions[2]?.messages[0]?.createdAt).toBe("2024-03-16T09:00:00.000Z");
    expect(new Date(lastMs).toISOString()).toBe("2024-03-16T09:01:00.000Z");
  });

  it("keeps a very long session inside its day by compressing the gap", () => {
    const many = Array.from({ length: 4000 }, (_, i) => m(i % 2 ? "assistant" : "user", `t${i}`));
    const { sessions } = batchesToSessions([
      { id: "b01", anchor: "March-15-2024", messages: many },
    ]);
    const last = sessions[0]?.messages.at(-1)?.createdAt as string;
    expect(last.slice(0, 10)).toBe("2024-03-15");
  });
});

describe("BEAM rows become workspaces", () => {
  const unit = rowToUnit(ROWS[0] as BeamRow, "100k");

  it("builds one workspace per conversation with a user peer that is observed and an assistant that is not", () => {
    expect(unit.id).toBe("beam-100k-c1");
    expect(unit.dataset).toBe("beam");
    expect(unit.peers).toEqual([
      { id: "user", observeMe: true },
      { id: "assistant", observeMe: false },
    ]);
  });

  it("maps batches to sessions dated by their time anchors, dropping blank turns and plan markers", () => {
    expect(unit.sessions.map((s) => s.id)).toEqual(["b01-2024-03-15", "b02-2024-04-05"]);
    const first = unit.sessions[0];
    expect(first?.messages.map((x) => x.peer)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(first?.messages[0]).toEqual({
      peer: "user",
      content:
        "I'm Craig and I want to build a budget tracker in Flask. My first sprint ends on March 29.",
      createdAt: "2024-03-15T09:00:00.000Z",
    });
    expect(first?.messages.every((x) => !x.content.includes("->->"))).toBe(true);
    expect(unit.sessions[1]?.messages[0]?.createdAt).toBe("2024-04-05T09:00:00.000Z");
  });

  it("asks all 20 questions through the user, after the conversation, with the date in the query", () => {
    expect(unit.questions).toHaveLength(20);
    expect(unit.questions.every((q) => q.peer === "user")).toBe(true);
    const q = unit.questions[0];
    // last message of the conversation is on 2024-04-05
    expect(q?.query).toBe(`The current date is 2024-04-05.\n${q?.question}`);
    expect(unit.questions.map((x) => x.category).slice(0, 4)).toEqual([
      "abstention",
      "abstention",
      "contradiction-resolution",
      "contradiction-resolution",
    ]);
    expect(new Set(unit.questions.map((x) => x.category))).toEqual(new Set(BEAM_ABILITIES));
    expect(new Set(unit.questions.map((x) => x.id)).size).toBe(20);
    expect(unit.questions[0]?.id).toBe("beam-100k-c1-abstention-1");
  });

  it("maps abilities to judge kinds and builds the reference text for our pass/fail rubric", () => {
    const by = (ability: string, n = 0) =>
      unit.questions.filter((q) => q.category === ability)[n] as (typeof unit.questions)[number];
    expect(by("abstention").kind).toBe("abstention");
    expect(by("abstention").gold).toBe("c1-abstention-1 was never discussed.");
    expect(by("knowledge-update").kind).toBe("update");
    expect(by("temporal-reasoning").kind).toBe("temporal");
    expect(by("instruction-following").kind).toBe("preference");
    expect(by("instruction-following").gold).toContain("Always format code snippets");
    expect(by("instruction-following").gold).toContain("syntax highlighting");
    expect(by("preference-following").gold).toContain("I prefer simple, minimal dependencies.");
    expect(by("summarization").gold).toBe(
      "The project started with Flask and SQLite, then added caching.",
    );
    expect(by("multi-hop-reasoning").gold).toBe("Two columns: 'category' and \"notes\".");
    expect(by("information-extraction").kind).toBe("standard");
  });

  it("carries the rubric nuggets for BEAM scoring", () => {
    const by = (ability: string, n = 0) =>
      unit.questions.filter((q) => q.category === ability)[n]?.beam;
    expect(by("multi-hop-reasoning")?.nuggets).toEqual([
      "LLM response should state: Two columns",
      "LLM response should state: 'category' and \"notes\"",
    ]);
    expect(by("information-extraction")?.reference).toBe("My first sprint ends on March 29.");
    expect(by("information-extraction")?.events).toBeUndefined();
  });

  it("takes event-ordering events from ordering_tested, else from the rubric without its ordering criterion", () => {
    const events = unit.questions.filter((q) => q.category === "event-ordering");
    expect(events[0]?.beam?.events).toEqual(["Project setup", "Database design", "Deployment"]);
    expect(events[1]?.beam?.events).toEqual(["Alpha stage", "Beta stage", "Gamma stage"]);
    expect(orderingEvents({ rubric: ["LLM response should mention: Only one"] })).toEqual([
      "Only one",
    ]);
  });

  it("can restrict a unit to chosen questions", () => {
    const only = rowToUnit(ROWS[0] as BeamRow, "100k", new Set([0, 5]));
    expect(only.questions.map((q) => q.id)).toEqual([
      "beam-100k-c1-abstention-1",
      "beam-100k-c1-event-ordering-2",
    ]);
  });

  it("falls back to the rubric as the reference when a question has no ideal answer", () => {
    const [d] = rowDrafts({
      conversation_id: "x",
      chat: [],
      probing_questions:
        "{'information_extraction': [{'question': 'Q?', 'rubric': ['LLM response should state: A', 'LLM response should state: B']}]}",
    });
    expect(d?.gold).toBe("LLM response should state: A; LLM response should state: B");
  });
});

describe("selecting BEAM questions", () => {
  async function fixtureFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "beam-"));
    const file = join(dir, "beam-100k.json");
    await writeFile(file, JSON.stringify(ROWS));
    return file;
  }
  const ids = async (file: string, opts: Parameters<typeof planBeam>[2]) =>
    (await planBeam(file, "100k", opts)).map((u) => `${u.id}:${u.questionCount}`);

  it("round-robins across the ten abilities, so a small limit covers all of them in the first conversation", async () => {
    const file = await fixtureFile();
    expect(await ids(file, { limit: 10 })).toEqual(["beam-100k-c1:10"]);
    const plan = await planBeam(file, "100k", { limit: 10 });
    const unit = await (plan[0] as (typeof plan)[number]).load();
    expect(unit.questions.map((q) => q.category)).toEqual([...BEAM_ABILITIES]);
    // 25 questions: the first conversation's 20, then the first five abilities of the second
    expect(await ids(file, { limit: 25 })).toEqual(["beam-100k-c1:20", "beam-100k-c2:5"]);
  });

  it("is deterministic, and supports offset, types and file order", async () => {
    const file = await fixtureFile();
    expect(await ids(file, { limit: 13 })).toEqual(await ids(file, { limit: 13 }));
    const types = await planBeam(file, "100k", { types: ["temporal-reasoning"], order: "file" });
    expect(types.map((u) => u.questionCount)).toEqual([2, 2]);
    const unit = await (types[1] as (typeof types)[number]).load();
    expect(unit.questions.map((q) => q.id)).toEqual([
      "beam-100k-c2-temporal-reasoning-1",
      "beam-100k-c2-temporal-reasoning-2",
    ]);
    // file order: conversation 1's questions first, ability by ability
    const fileOrder = await planBeam(file, "100k", { order: "file", limit: 3 });
    const loaded = await (fileOrder[0] as (typeof fileOrder)[number]).load();
    expect(loaded.questions.map((q) => q.id)).toEqual([
      "beam-100k-c1-abstention-1",
      "beam-100k-c1-abstention-2",
      "beam-100k-c1-contradiction-resolution-1",
    ]);
    expect(await ids(file, { offset: 18, limit: 4 })).toEqual(["beam-100k-c1:2", "beam-100k-c2:2"]);
  });

  it("--per-unit spreads a sample over every conversation, stratified by ability", async () => {
    const file = await fixtureFile();
    const plan = await planBeam(file, "100k", { perUnit: 3 });
    expect(plan.map((u) => u.questionCount)).toEqual([3, 3]);
    const unit = await (plan[1] as (typeof plan)[number]).load();
    expect(unit.questions.map((q) => q.category)).toEqual([
      "abstention",
      "contradiction-resolution",
      "event-ordering",
    ]);
  });

  it("is reachable through planDataset and explains how to fetch a missing split", async () => {
    const file = await fixtureFile();
    const plan = await planDataset("beam", { limit: 1, beamSplit: "100k" }, file);
    expect(plan).toHaveLength(1);
    await expect(
      planDataset("beam", { beamSplit: "500k" }, "/nonexistent/beam.json"),
    ).rejects.toThrow(/download --dataset beam --beam-split 500k/);
    await expect(planDataset("beam", {}, file)).rejects.toThrow(/--beam-split/);
  });
});
