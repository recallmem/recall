import { afterEach, describe, expect, it } from "vitest";
import { countTokens } from "../src/lib/tokens.js";
import { drainQueue } from "../src/queue/worker.js";
import { splitMessage } from "../src/reasoner/index.js";
import { normKey } from "../src/reasoner/util.js";
import { createTestServer } from "./helpers.js";

/**
 * What reaches the extractor: an answer to a question is not skipped as an acknowledgement,
 * a long message is read whole, and a minus sign is not punctuation.
 */

let s: Awaited<ReturnType<typeof createTestServer>> | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const start = async () => {
  s = await createTestServer({
    RECALL_REASONER_MAX_DELAY_MS: "0",
    RECALL_SUMMARIES_ENABLED: "false",
    RECALL_DREAMS_ENABLED: "false",
  });
  const r = await s.request("POST", "/v3/workspaces/w/sessions", {
    id: "s1",
    peers: { maya: { observe_me: true }, assistant: { observe_me: false } },
  });
  expect(r.status).toBeLessThan(300);
  return s;
};

const say = async (messages: { peer_id: string; content: string }[]) => {
  const r = await s!.request("POST", "/v3/workspaces/w/sessions/s1/messages", { messages });
  expect(r.status).toBe(201);
  await drainQueue(s!.ctx);
};

const transcripts = () =>
  s!.ctx.llm.mock.calls
    .filter((c) => c.req.task === "reasoner")
    .map((c) => String(c.req.messages.at(-1)?.content ?? ""));

describe("answers to questions", () => {
  it("sends a yes that answers a question in the same batch to extraction", async () => {
    await start();
    await say([
      { peer_id: "assistant", content: "Did you end up adopting the dog from the shelter?" },
      { peer_id: "maya", content: "Yes!" },
    ]);
    const [t] = transcripts();
    expect(t).toContain("adopting the dog");
    expect(t).toMatch(/\] maya [^\n]*: Yes!/);
  });

  it("sends a no that answers a question asked in an earlier batch to extraction", async () => {
    await start();
    await say([{ peer_id: "assistant", content: "Are you still vegetarian?" }]);
    expect(transcripts()).toHaveLength(0);
    await say([{ peer_id: "maya", content: "nope" }]);
    const [t] = transcripts();
    expect(t).toContain("(context): Are you still vegetarian?");
    expect(t).toMatch(/\] maya [^\n]*: nope/);
  });

  it("still skips an acknowledgement that answers nothing", async () => {
    await start();
    await say([
      { peer_id: "assistant", content: "Here is the recipe you asked for." },
      { peer_id: "maya", content: "ok thanks" },
    ]);
    expect(transcripts()).toHaveLength(0);
  });
});

describe("long messages", () => {
  const filler = (word: string, n: number) => Array.from({ length: n }, () => word).join(" ");

  it("reach the extractor whole, middle included", async () => {
    await start();
    const content = [
      filler("Some background about my week at work.", 120),
      "My favourite instrument is the contrabassoon.",
      filler("More background about the garden and the weather.", 120),
    ].join("\n");
    await say([{ peer_id: "maya", content }]);
    const all = transcripts().join("\n");
    expect(all).toContain("contrabassoon");
    expect(all).not.toContain("[…]");
  });

  it("are split into parts within the limit, losing no words", () => {
    const content = `${filler("alpha beta gamma", 900)} vibraphone ${filler("delta epsilon", 900)}`;
    const parts = splitMessage(content, countTokens(content), 1500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(countTokens(p)).toBeLessThanOrEqual(1500);
    expect(parts.join(" ").split(/\s+/)).toEqual(content.split(/\s+/));
  });
});

describe("comparison keys", () => {
  it("keep a minus sign in front of a number", () => {
    expect(normKey("Alice's balance is +100")).not.toBe(normKey("Alice's balance is -100"));
    expect(normKey("Alice's balance is −100")).toBe(normKey("alice's balance is -100"));
    expect(normKey("Temperature: -5 degrees")).toBe("temperature -5 degrees");
  });

  it("still treat hyphens between words and numbers as punctuation", () => {
    expect(normKey("E-mail  me")).toBe("e mail me");
    expect(normKey("pages 10-20")).toBe("pages 10 20");
  });
});
