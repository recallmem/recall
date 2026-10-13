import { fileURLToPath } from "node:url";
import { Recall } from "@recall-memory/sdk";
import { generateText, isStepCount, streamText, type Tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../../sdk/test/harness.js";
import { recallContext, recallMiddleware, recallTools, saveTurn } from "../src/index.js";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const fresh = () =>
  new Recall({
    baseURL: server.url,
    workspaceId: `ai-sdk-${Math.random().toString(36).slice(2, 9)}`,
    retryBaseDelay: 5,
  });

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const answer = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});
const toolCall = (toolName: string, input: object) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
const finish = (unified: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified, raw: undefined },
  usage,
});
/** Calls a tool's execute function directly, as the AI SDK does. */
const run = async <I, O>(t: Tool<I, O>, input: I) =>
  (await t.execute!(input, { toolCallId: "t1", messages: [], context: {} })) as O;
const systemTexts = (prompt: { role: string; content: unknown }[]) =>
  prompt.filter((m) => m.role === "system").map((m) => m.content as string);
const stored = async (recall: Recall, sessionId: string) =>
  (await (await recall.session(sessionId).messages()).toArray()).map((m) => [m.peerId, m.content]);

describe("recallTools", () => {
  it("remember, search and ask, called directly", async () => {
    const recall = fresh();
    const tools = recallTools({ recall, userId: "alice" });
    expect(Object.keys(tools)).toEqual(["searchMemory", "askMemory", "rememberFact"]);

    // Nothing is known yet: empty results, not errors.
    expect(await run(tools.searchMemory, { query: "Utrecht" })).toEqual({
      facts: [],
      messages: [],
    });
    expect(await run(tools.askMemory, { question: "Where do I live?" })).toEqual({
      answer: null,
    });

    const saved = await run(tools.rememberFact, { fact: "Lives in Utrecht." });
    expect(saved).toMatchObject({ saved: true, id: expect.any(String) });
    const found = await run(tools.searchMemory, { query: "Where does alice live?" });
    expect(found.facts.map((f) => f.content)).toContain("Lives in Utrecht.");
    const asked = await run(tools.askMemory, { question: "Where do I live?" });
    expect(asked.answer).toContain("Utrecht");
  });

  it("run inside generateText's tool loop", async () => {
    const recall = fresh();
    await recall.peer("alice").conclusions.create("Is vegetarian.");
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall("searchMemory", { query: "diet" }),
        answer("You are vegetarian, so: risotto."),
      ],
    });
    const result = await generateText({
      model,
      tools: recallTools({ recall, userId: "alice" }),
      stopWhen: isStepCount(3),
      prompt: "What should I cook tonight?",
    });
    expect(result.text).toBe("You are vegetarian, so: risotto.");
    const offered = model.doGenerateCalls[0]!.tools!.map((t) => t.name);
    expect(offered).toEqual(["searchMemory", "askMemory", "rememberFact"]);
    const output = result.steps[0]!.toolResults[0]!.output as { facts: { content: string }[] };
    expect(output.facts.map((f) => f.content)).toContain("Is vegetarian.");
  });

  it("require a user id", () => {
    expect(() => recallTools({ recall: fresh(), userId: "" })).toThrow(/userId/);
  });
});

describe("recallMiddleware", () => {
  it("adds what Recall knows to the prompt and stores the turn (generateText)", async () => {
    const recall = fresh();
    await recall.peer("alice").conclusions.create("Is vegetarian.");
    const model = new MockLanguageModelV4({ doGenerate: answer("A mushroom risotto for four.") });
    const { text } = await generateText({
      model: wrapLanguageModel({
        model,
        middleware: recallMiddleware({ recall, userId: "alice", sessionId: "chat-1" }),
      }),
      system: "You are a helpful assistant.",
      prompt: "My parents visit on Saturday. Plan a dinner for four.",
    });
    expect(text).toBe("A mushroom risotto for four.");

    const prompt = model.doGenerateCalls[0]!.prompt;
    const system = systemTexts(prompt);
    expect(system[0]).toBe("You are a helpful assistant.");
    expect(system[1]).toContain("Is vegetarian.");
    expect(prompt.at(-1)!.role).toBe("user");

    expect(await stored(recall, "chat-1")).toEqual([
      ["alice", "My parents visit on Saturday. Plan a dinner for four."],
      ["assistant", "A mushroom risotto for four."],
    ]);
    // Recall reads the assistant's replies but does not learn about the assistant.
    expect((await recall.peer("assistant").getConfiguration()).observeMe).toBe(false);
  });

  it("stores only the final answer of a streamed tool loop, once", async () => {
    const recall = fresh();
    await recall.peer("alice").conclusions.create("Has a dog called Bram.");
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "searchMemory",
                input: JSON.stringify({ query: "dog" }),
              },
              finish("tool-calls"),
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Bram can come " },
              { type: "text-delta", id: "t", delta: "along." },
              { type: "text-end", id: "t" },
              finish("stop"),
            ],
          }),
        },
      ],
    });
    const result = streamText({
      model: wrapLanguageModel({
        model,
        middleware: recallMiddleware({ recall, userId: "alice", sessionId: "walk" }),
      }),
      tools: recallTools({ recall, userId: "alice" }),
      stopWhen: isStepCount(3),
      prompt: "Can I bring my dog on the hike?",
    });
    expect(await result.text).toBe("Bram can come along.");
    expect(model.doStreamCalls).toHaveLength(2);
    // Both steps of the turn get the same memory block.
    const blocks = model.doStreamCalls.map((c) => systemTexts(c.prompt)[0]);
    expect(blocks[0]).toContain("Bram");
    expect(blocks[1]).toBe(blocks[0]);
    expect(await stored(recall, "walk")).toEqual([
      ["alice", "Can I bring my dog on the hike?"],
      ["assistant", "Bram can come along."],
    ]);
  });

  it("adds nothing for a new user, and can only read or only store", async () => {
    const recall = fresh();
    const model = new MockLanguageModelV4({ doGenerate: answer("Hello!") });
    await generateText({
      model: wrapLanguageModel({
        model,
        middleware: recallMiddleware({ recall, userId: "newcomer", sessionId: "s1", store: false }),
      }),
      prompt: "Hi there",
    });
    expect(systemTexts(model.doGenerateCalls[0]!.prompt)).toEqual([]);
    expect(await stored(recall, "s1")).toEqual([]);

    await generateText({
      model: wrapLanguageModel({
        model,
        middleware: recallMiddleware({
          recall,
          userId: "newcomer",
          sessionId: "s1",
          context: false,
        }),
      }),
      prompt: "Hi again",
    });
    expect(await stored(recall, "s1")).toEqual([
      ["newcomer", "Hi again"],
      ["assistant", "Hello!"],
    ]);
    expect(() => recallMiddleware({ recall, userId: "x", store: true })).toThrow(/sessionId/);
  });

  it("keeps the model call going when Recall is unreachable", async () => {
    const down = new Recall({ baseURL: "http://127.0.0.1:9", maxRetries: 0, timeout: 2_000 });
    const onError = vi.fn();
    const model = new MockLanguageModelV4({ doGenerate: answer("Still here.") });
    const { text } = await generateText({
      model: wrapLanguageModel({
        model,
        middleware: recallMiddleware({ recall: down, userId: "alice", sessionId: "s", onError }),
      }),
      prompt: "Hello?",
    });
    expect(text).toBe("Still here.");
    expect(onError).toHaveBeenCalledTimes(2); // reading memory, then storing the turn
  });
});

describe("recallContext and saveTurn", () => {
  it("read memory as text and store a turn by hand", async () => {
    const recall = fresh();
    expect(await recallContext({ recall, userId: "bob" })).toBe("");
    await saveTurn(
      { recall, userId: "bob", sessionId: "c" },
      { user: "I play the cello.", assistant: "Lovely!" },
    );
    await recall.peer("bob").conclusions.create("Plays the cello.");
    const text = await recallContext({ recall, userId: "bob", query: "music" });
    expect(text).toContain("Plays the cello.");
    expect(text).toContain("bob");
    expect(await stored(recall, "c")).toEqual([
      ["bob", "I play the cello."],
      ["assistant", "Lovely!"],
    ]);
  });

  it("split a message longer than Recall's limit", async () => {
    const recall = fresh();
    const long = "a".repeat(30_000);
    await saveTurn({ recall, userId: "bob", sessionId: "long" }, { user: long });
    const messages = await stored(recall, "long");
    expect(messages.map(([, c]) => c!.length)).toEqual([24_000, 6_000]);
  });
});

describe("guide example", () => {
  it("examples/guides/vercel-ai-sdk.ts runs", async () => {
    const file = fileURLToPath(
      new URL("../../../examples/guides/vercel-ai-sdk.ts", import.meta.url),
    );
    const mod = (await import(file)) as { main: (r: Recall) => Promise<unknown> };
    expect(await mod.main(fresh())).toBeDefined();
  }, 60_000);
});
