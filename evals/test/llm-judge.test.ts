import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createJudge } from "../src/judge.js";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A fake OpenAI-compatible /chat/completions endpoint that replies with the scripted texts in order. */
async function fakeProvider(replies: string[]) {
  const requests: { body: { messages: { role: string; content: string }[] } }[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) });
    const text = replies[Math.min(requests.length - 1, replies.length - 1)] ?? "";
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
        usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
      }),
    );
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    env: {
      RECALL_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
      RECALL_COMPAT_API_KEY: "k",
      RECALL_PRICING_JSON: JSON.stringify({ "compat/judge-1": { input: 1, output: 2 } }),
    },
  };
}

describe("LlmJudge through the server's LlmClient", () => {
  it("sends the rubric prompt, parses the verdict and reports tokens and priced cost", async () => {
    const p = await fakeProvider(["VERDICT: yes\nREASON: same degree"]);
    const judge = createJudge("compat/judge-1", p.env);
    const v = await judge.judge({
      kind: "temporal",
      question: "How many days between the trips?",
      gold: "18 days",
      response: "19 days.",
    });
    expect(v).toMatchObject({
      correct: true,
      reason: "same degree",
      inputTokens: 120,
      outputTokens: 12,
    });
    expect(v.costUsd).toBeCloseTo((120 * 1 + 12 * 2) / 1_000_000, 10);
    const sent = p.requests[0]?.body.messages ?? [];
    expect(sent[0]?.role).toBe("system");
    expect(sent.at(-1)?.content).toContain("off by exactly one");
    expect(sent.at(-1)?.content).toContain("Reference answer: 18 days");
  });

  it("retries once on an unparseable verdict, then gives up without a verdict", async () => {
    const bad = await fakeProvider(["I think so", "Still not a verdict"]);
    const v = await createJudge("compat/judge-1", bad.env).judge({
      kind: "standard",
      question: "q",
      gold: "a",
      response: "b",
    });
    expect(bad.requests).toHaveLength(2);
    expect(v.correct).toBeNull();
    expect(v.inputTokens).toBe(240); // both attempts are accounted for
    server?.close();

    const recovered = await fakeProvider(["unsure", "VERDICT: no\nREASON: wrong"]);
    const r = await createJudge("compat/judge-1", recovered.env).judge({
      kind: "standard",
      question: "q",
      gold: "a",
      response: "b",
    });
    expect(r.correct).toBe(false);
  });

  it("reports unpriced models as unknown cost rather than free", async () => {
    const p = await fakeProvider(["VERDICT: yes"]);
    const env = { ...p.env, RECALL_PRICING_JSON: undefined };
    const v = await createJudge("compat/judge-1", env).judge({
      kind: "standard",
      question: "q",
      gold: "a",
      response: "a",
    });
    expect(v.costUsd).toBeNull();
  });
});
