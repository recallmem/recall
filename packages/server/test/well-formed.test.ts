import { afterEach, describe, expect, it } from "vitest";
import { wellFormed } from "../src/lib/well-formed.js";
import type { LlmRequest } from "../src/llm/types.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * Text cut between the two halves of an emoji leaves a lone surrogate, which providers reject as
 * invalid JSON: one such message made a memory-building job fail five times in production.
 */

const party = "🎉";
const high = party.slice(0, 1);
const low = party.slice(1);

describe("wellFormed", () => {
  it("repairs half-cut characters and keeps whole ones", () => {
    expect(wellFormed(`cut ${high}`)).toBe("cut �");
    expect(wellFormed(`${low} tail`)).toBe("� tail");
    expect(wellFormed(`a ${party} b`)).toBe(`a ${party} b`);
    expect(wellFormed("plain")).toBe("plain");
  });
});

let s: ApiServer | null = null;
afterEach(async () => {
  s?.ctx.llm.mock.respondWith(null);
  await s?.close();
  s = null;
});

describe("model calls", () => {
  it("never send a half-cut character to the provider", async () => {
    s = await createTestServer();
    const seen: LlmRequest[] = [];
    s.ctx.llm.mock.respondWith((req) => {
      seen.push(req);
      return { text: "ok" };
    });
    await s.ctx.llm.complete({
      task: "chat_low",
      workspaceId: null,
      system: `rules ${low}`,
      context: `facts ${high}`,
      messages: [{ role: "user", content: `question ${party} ${high}` }],
    });
    const sent = JSON.stringify(seen[0]);
    expect(sent).not.toMatch(/\\ud8|\\udc|\\udb|\\udd|\\ude|\\udf/i);
    expect(seen[0]!.messages[0]!.content).toBe(`question ${party} �`);
  });
});
