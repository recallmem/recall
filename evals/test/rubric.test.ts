import { describe, expect, it } from "vitest";
import { createJudge, isMockModel, LexicalJudge } from "../src/judge.js";
import { describeRubric, judgePrompt, parseVerdict, RUBRIC_VERSION } from "../src/rubric.js";

describe("verdict parsing", () => {
  it("reads the two-line format", () => {
    expect(parseVerdict("VERDICT: yes\nREASON: matches the reference")).toEqual({
      correct: true,
      reason: "matches the reference",
    });
    expect(parseVerdict("verdict: No\nreason: wrong city")?.correct).toBe(false);
  });
  it("tolerates markdown and a bare answer, and rejects noise", () => {
    expect(parseVerdict("**VERDICT: yes**")?.correct).toBe(true);
    expect(parseVerdict("No")?.correct).toBe(false);
    expect(parseVerdict("I am not sure")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
});

describe("rubric", () => {
  it("is versioned and has distinct rules per question kind", () => {
    expect(RUBRIC_VERSION).toMatch(/^rubric-v\d+$/);
    const base = judgePrompt("standard", "Q", "A", "R");
    expect(judgePrompt("temporal", "Q", "A", "R")).toContain("off by exactly one");
    expect(judgePrompt("update", "Q", "A", "R")).toContain("latest value");
    expect(judgePrompt("preference", "Q", "A", "R")).toContain("personalised");
    expect(judgePrompt("abstention", "Q", "A", "R")).toContain("cannot be answered");
    expect(base).not.toContain("off by exactly one");
    expect(base).toContain("Reference answer: A");
    expect(judgePrompt("standard", "Q", "A", "  ")).toContain("(empty response)");
    expect(describeRubric()).toContain("[abstention]");
  });
});

describe("offline lexical judge", () => {
  const judge = new LexicalJudge();
  it("marks itself as not an accuracy measurement", () => {
    expect(judge.settings.kind).toBe("lexical-offline");
  });
  it("accepts answers that contain the reference and rejects others", async () => {
    const ok = await judge.judge({
      kind: "standard",
      question: "q",
      gold: "Business Administration",
      response: "You graduated in Business Administration.",
    });
    const no = await judge.judge({
      kind: "standard",
      question: "q",
      gold: "Business Administration",
      response: "I do not know.",
    });
    expect(ok.correct).toBe(true);
    expect(no.correct).toBe(false);
  });
  it("scores abstention by whether the response declines", async () => {
    const declines = await judge.judge({
      kind: "abstention",
      question: "q",
      gold: "n/a",
      response: "You never mentioned a hamster.",
    });
    const answers = await judge.judge({
      kind: "abstention",
      question: "q",
      gold: "n/a",
      response: "Your hamster is called Bob.",
    });
    expect(declines.correct).toBe(true);
    expect(answers.correct).toBe(false);
  });
});

describe("judge selection", () => {
  it("uses the offline judge only for mock models", () => {
    expect(isMockModel("mock")).toBe(true);
    expect(isMockModel("mock/default")).toBe(true);
    expect(isMockModel("anthropic/claude-sonnet-5-5")).toBe(false);
    expect(createJudge("mock").settings.kind).toBe("lexical-offline");
  });
  it("builds an LLM judge through the server's LlmClient and fails fast on a missing key", () => {
    expect(() => createJudge("anthropic/claude-sonnet-5-5", {})).toThrow(/ANTHROPIC_API_KEY/);
    const judge = createJudge("openai/gpt-5-mini", { OPENAI_API_KEY: "sk-test" });
    expect(judge.settings).toMatchObject({
      kind: "llm",
      model: "openai/gpt-5-mini",
      rubric: RUBRIC_VERSION,
    });
  });
  it("rejects a model reference without a provider", () => {
    expect(() => createJudge("gpt-5-mini", {})).toThrow(/provider\/model/);
  });
});
