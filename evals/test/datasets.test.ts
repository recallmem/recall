import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import locomo from "../fixtures/locomo-sample.json" with { type: "json" };
import lme from "../fixtures/longmemeval-sample.json" with { type: "json" };
import { planDataset } from "../src/datasets/index.js";
import {
  type LocomoSample,
  parseLocomoDate,
  pickPeer,
  planLocomo,
  sampleToUnit,
} from "../src/datasets/locomo.js";
import {
  entryToUnit,
  type LongMemEvalEntry,
  parseLongMemEvalDate,
} from "../src/datasets/longmemeval.js";
import { selectItems } from "../src/types.js";

const LME = lme as unknown as LongMemEvalEntry[];
const LOCOMO = locomo as unknown as LocomoSample[];

describe("LongMemEval", () => {
  it("parses dates as UTC", () => {
    expect(parseLongMemEvalDate("2023/05/20 (Sat) 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(() => parseLongMemEvalDate("yesterday")).toThrow();
  });

  it("turns an entry into one workspace with chronological sessions and original timestamps", () => {
    const unit = entryToUnit(LME[0] as LongMemEvalEntry);
    expect(unit.id).toBe("lme-q-degree");
    expect(unit.peers).toEqual([
      { id: "user", observeMe: true },
      { id: "assistant", observeMe: false },
    ]);
    // The noise session is dated earlier, so it is ingested first even though it is listed second.
    expect(unit.sessions.map((s) => s.messages[0]?.createdAt)).toEqual([
      "2023-05-20T02:21:00.000Z",
      "2023-05-21T09:00:00.000Z",
    ]);
    // The whitespace-only turn is dropped; the rest keep their order one second apart.
    const answerSession = unit.sessions[1];
    expect(answerSession?.messages.map((m) => m.peer)).toEqual(["user", "assistant"]);
    expect(answerSession?.messages[1]?.createdAt).toBe("2023-05-21T09:00:01.000Z");
    const q = unit.questions[0];
    expect(q).toMatchObject({ category: "single-session-user", kind: "standard", peer: "user" });
    expect(q?.query).toContain("2023/05/30 (Tue) 23:40");
    expect(q?.query).toContain("What degree did I graduate with?");
  });

  it("separates abstention questions and maps judge kinds; numeric answers become text", () => {
    const abs = entryToUnit(LME[1] as LongMemEvalEntry).questions[0];
    expect(abs).toMatchObject({ category: "abstention", kind: "abstention" });
    const upd = entryToUnit(LME[2] as LongMemEvalEntry).questions[0];
    expect(upd).toMatchObject({ category: "knowledge-update", kind: "update", gold: "3" });
  });
});

describe("LoCoMo", () => {
  it("parses its date format", () => {
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseLocomoDate("12:05 am on 1 January, 2024")).toBe("2024-01-01T00:05:00.000Z");
    expect(parseLocomoDate("12:30 pm on 3 October, 2023")).toBe("2023-10-03T12:30:00.000Z");
  });

  it("asks through the speaker a question names", () => {
    const sp = ["Caroline", "Melanie"] as const;
    expect(pickPeer("What did Melanie research?", sp)).toBe("Melanie");
    expect(pickPeer("What did Caroline and Melanie discuss?", sp)).toBe("Caroline");
    expect(pickPeer("What was the charity race for?", sp)).toBe("Caroline");
  });

  it("builds a unit with both speakers observed, photo captions inline, and category names", () => {
    const unit = sampleToUnit(LOCOMO[0] as LocomoSample);
    expect(unit.peers).toEqual([
      { id: "Caroline", observeMe: true },
      { id: "Melanie", observeMe: true },
    ]);
    expect(unit.sessions).toHaveLength(2);
    expect(unit.sessions[0]?.messages[1]?.content).toContain(
      "[shared image: a photo of a painted sunset]",
    );
    expect(unit.sessions[1]?.messages[0]?.createdAt).toBe("2023-05-12T09:30:00.000Z");
    expect(unit.questions.map((q) => q.category)).toEqual([
      "single-hop",
      "temporal",
      "multi-hop",
      "open-domain",
      "abstention",
    ]);
    expect(unit.questions[0]?.peer).toBe("Melanie");
    expect(unit.questions[3]?.gold).toBe("42");
    const abs = unit.questions[4];
    expect(abs?.kind).toBe("abstention");
    expect(abs?.gold).toContain("self-care is important");
  });
});

describe("selection", () => {
  const items = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, c: "a" })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, c: "b" })),
    { id: "c0", c: "c" },
  ];
  const cat = (x: { c: string }) => x.c;

  it("round-robins across categories so a small limit covers every type", () => {
    const picked = selectItems(items, cat, ["a", "b", "c"], { limit: 4 });
    expect(picked.map((p) => p.id)).toEqual(["a0", "b0", "c0", "a1"]);
  });

  it("supports file order, offset and type filters", () => {
    expect(selectItems(items, cat, [], { order: "file", limit: 2 }).map((p) => p.id)).toEqual([
      "a0",
      "a1",
    ]);
    expect(
      selectItems(items, cat, ["a", "b", "c"], { types: ["b"], offset: 1, limit: 2 }).map(
        (p) => p.id,
      ),
    ).toEqual(["b1", "b2"]);
  });

  it("is deterministic", () => {
    const a = selectItems(items, cat, ["a", "b", "c"], { limit: 6 });
    const b = selectItems(items, cat, ["a", "b", "c"], { limit: 6 });
    expect(a).toEqual(b);
  });
});

describe("planning from files", () => {
  it("plans LongMemEval lazily from the byte index and honours limit and types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-"));
    const file = join(dir, "lme.json");
    await writeFile(file, JSON.stringify(LME));
    const plan = await planDataset("longmemeval", { limit: 2 }, file);
    // Stratified: first of single-session-user, then first of abstention, in category order.
    expect(plan.map((p) => p.id)).toEqual(["lme-q-degree", "lme-q-update"]);
    const unit = await (plan[1] as (typeof plan)[number]).load();
    expect(unit.questions[0]?.id).toBe("q-update");
    const onlyAbs = await planDataset("longmemeval", { types: ["abstention"] }, file);
    expect(onlyAbs.map((p) => p.id)).toEqual(["lme-q-hamster_abs"]);
  });

  it("plans LoCoMo conversation by conversation and loads only the chosen questions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-"));
    const file = join(dir, "locomo.json");
    await writeFile(file, JSON.stringify(LOCOMO));
    const plan = await planLocomo(file, { limit: 3 });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.questionCount).toBe(3);
    const unit = await (plan[0] as (typeof plan)[number]).load();
    expect(unit.questions.map((q) => q.category)).toEqual(["single-hop", "temporal", "multi-hop"]);
  });

  it("explains how to get a missing dataset", async () => {
    await expect(planDataset("locomo", {}, "/nonexistent/locomo10.json")).rejects.toThrow(
      /download/,
    );
  });
});
