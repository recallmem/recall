import { describe, expect, it } from "vitest";
import { transcript } from "../src/full-context.js";
import type { EvalUnit } from "../src/types.js";

describe("full-context baseline", () => {
  it("gives the model every session, oldest first, dated, with who said what", () => {
    const unit: EvalUnit = {
      id: "lme-x",
      dataset: "longmemeval",
      peers: [
        { id: "user", observeMe: true },
        { id: "assistant", observeMe: false },
      ],
      sessions: [
        {
          id: "s01",
          messages: [
            { peer: "user", content: "I adopted a cat.", createdAt: "2023-05-20T10:00:00.000Z" },
            {
              peer: "assistant",
              content: "Congratulations!",
              createdAt: "2023-05-20T10:00:01.000Z",
            },
          ],
        },
        {
          id: "s02",
          messages: [
            {
              peer: "user",
              content: "The cat is called Miso.",
              createdAt: "2023-06-02T09:00:00.000Z",
            },
          ],
        },
      ],
      questions: [],
    };
    expect(transcript(unit)).toBe(
      "## Session 1 (2023-05-20)\nuser: I adopted a cat.\nassistant: Congratulations!\n\n## Session 2 (2023-06-02)\nuser: The cat is called Miso.",
    );
  });
});
