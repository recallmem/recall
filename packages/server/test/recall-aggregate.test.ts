import { describe, expect, it } from "vitest";
import { isAggregate, LEVELS, planFor } from "../src/recall/prompts.js";

describe("counting and total questions", () => {
  it("are recognised in English and Dutch", () => {
    for (const q of [
      "How many projects have I led?",
      "How much did I spend on my bike in total?",
      "What did the trips cost altogether?",
      "List all the books I mentioned.",
      "Hoeveel planten heb ik gekocht?",
    ])
      expect(isAggregate(q), q).toBe(true);
    for (const q of ["Where does Alice live?", "What is my sister's name?", "When is the launch?"])
      expect(isAggregate(q), q).toBe(false);
  });

  it("widen retrieval on the one-call levels only", () => {
    const q = "How many plants did I buy last month?";
    for (const level of ["minimal", "low", "medium"] as const) {
      const plan = planFor(level, q);
      expect(plan.facts).toBe(Math.round(LEVELS[level].facts * 1.5));
      expect(plan.snippets).toBe(Math.round(LEVELS[level].snippets * 1.5));
      expect(plan.budget).toBeGreaterThan(LEVELS[level].budget);
      expect(plan.rounds).toBe(0);
    }
    // The search loop of high and max finds more on its own.
    expect(planFor("high", q)).toBe(LEVELS.high);
    expect(planFor("low", "Where do I live?")).toBe(LEVELS.low);
  });
});
