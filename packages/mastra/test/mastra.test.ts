import { fileURLToPath } from "node:url";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { RequestContext } from "@mastra/core/request-context";
import { createMockModel, MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { Recall } from "@recall-memory/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../../sdk/test/harness.js";
import { RecallMemory, recallTools } from "../src/index.js";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const fresh = () =>
  new Recall({
    baseURL: server.url,
    workspaceId: `mastra-${Math.random().toString(36).slice(2, 9)}`,
    retryBaseDelay: 5,
  });

/** A request context naming the user (resource) and the conversation (thread), as auth middleware would. */
const run = (userId: string, sessionId?: string) => {
  const requestContext = new RequestContext();
  requestContext.set("mastra__resourceId", userId);
  if (sessionId) requestContext.set("mastra__threadId", sessionId);
  return requestContext;
};

type Prompt = { role: string; content: unknown }[];
/** A model that always answers `text` and records the prompts it was sent. */
const textModel = (text: string) => {
  const prompts: Prompt[] = [];
  const spy = (call: { prompt: Prompt }) => prompts.push(call.prompt);
  return {
    model: createMockModel({ mockText: text, version: "v2", spyGenerate: spy, spyStream: spy }),
    prompts,
  };
};
const systemTexts = (prompt: Prompt) =>
  prompt.filter((m) => m.role === "system").map((m) => m.content as string);
const stored = async (recall: Recall, sessionId: string) =>
  (await (await recall.session(sessionId).messages()).toArray()).map((m) => [m.peerId, m.content]);

const agentWith = (model: unknown, memory: RecallMemory, extra: Record<string, unknown> = {}) =>
  new Agent({
    id: "assistant",
    name: "Assistant",
    instructions: "You are a helpful assistant.",
    model: model as never,
    inputProcessors: [memory],
    outputProcessors: [memory],
    ...extra,
  });

describe("RecallMemory processor", () => {
  it("adds what Recall knows to the run and stores the turn (generate)", async () => {
    const recall = fresh();
    await recall.peer("alice").conclusions.create("Is vegetarian.");
    const { model, prompts } = textModel("A mushroom risotto for four.");
    const agent = agentWith(model, new RecallMemory({ recall }));
    const result = await agent.generate("My parents visit on Saturday. Plan a dinner for four.", {
      requestContext: run("alice", "chat-1"),
    });
    expect(result.text).toBe("A mushroom risotto for four.");

    const system = systemTexts(prompts[0]!);
    expect(system[0]).toBe("You are a helpful assistant.");
    expect(system.some((s) => s.includes("Is vegetarian."))).toBe(true);
    expect(await stored(recall, "chat-1")).toEqual([
      ["alice", "My parents visit on Saturday. Plan a dinner for four."],
      ["assistant", "A mushroom risotto for four."],
    ]);
    expect((await recall.peer("assistant").getConfiguration()).observeMe).toBe(false);
  });

  it("works with stream, and with ids given as options or found by functions", async () => {
    const recall = fresh();
    await recall.peer("u-1").conclusions.create("Has a dog called Bram.");
    const { model, prompts } = textModel("Bram can come along.");
    const memory = new RecallMemory({
      recall,
      userId: ({ requestContext }) => requestContext?.get("user") as string | undefined,
      sessionId: "hike",
    });
    const requestContext = new RequestContext();
    requestContext.set("user", "u-1");
    const stream = await agentWith(model, memory).stream("Can I bring my dog on the hike?", {
      requestContext,
    });
    expect(await stream.text).toBe("Bram can come along.");
    expect(systemTexts(prompts[0]!).some((s) => s.includes("Bram"))).toBe(true);
    expect(await stored(recall, "hike")).toEqual([
      ["u-1", "Can I bring my dog on the hike?"],
      ["assistant", "Bram can come along."],
    ]);
  });

  it("uses the run's memory.resource and memory.thread when the agent has Mastra memory", async () => {
    const recall = fresh();
    const { model } = textModel("Hello Bob.");
    const agent = agentWith(model, new RecallMemory({ recall }), { memory: new MockMemory() });
    await agent.generate("Hi, I'm Bob.", { memory: { resource: "bob", thread: "t-1" } });
    expect(await stored(recall, "t-1")).toEqual([
      ["bob", "Hi, I'm Bob."],
      ["assistant", "Hello Bob."],
    ]);
  });

  it("does nothing without a user, and keeps the run going when Recall is down", async () => {
    const { model, prompts } = textModel("Hi.");
    const recall = fresh();
    await agentWith(model, new RecallMemory({ recall })).generate("Hello");
    expect(systemTexts(prompts[0]!)).toEqual(["You are a helpful assistant."]);

    const down = new Recall({ baseURL: "http://127.0.0.1:9", maxRetries: 0, timeout: 2_000 });
    const onError = vi.fn();
    const result = await agentWith(model, new RecallMemory({ recall: down, onError })).generate(
      "Hello?",
      { requestContext: run("alice", "s") },
    );
    expect(result.text).toBe("Hi.");
    expect(onError).toHaveBeenCalledTimes(2); // reading memory, then storing the turn
  });
});

describe("recallTools", () => {
  it("search, ask and remember, called directly", async () => {
    const recall = fresh();
    const tools = recallTools({ recall, userId: "alice" });
    // The execution context Mastra passes to a tool; these tools only read its request context.
    const ctx = (requestContext: RequestContext) => ({ requestContext }) as never;
    const context = ctx(new RequestContext());
    expect(await tools.askMemory.execute!({ question: "Where do I live?" }, context)).toEqual({
      answer: null,
    });
    expect(await tools.rememberFact.execute!({ fact: "Lives in Utrecht." }, context)).toMatchObject(
      {
        saved: true,
        id: expect.any(String),
      },
    );
    const found = (await tools.searchMemory.execute!({ query: "Utrecht" }, context)) as {
      facts: { content: string }[];
    };
    expect(found.facts.map((f) => f.content)).toContain("Lives in Utrecht.");
    const asked = (await tools.askMemory.execute!({ question: "Where do I live?" }, context)) as {
      answer: string;
    };
    expect(asked.answer).toContain("Utrecht");

    // Without a userId the tools take the run's resource id, and need one.
    const fromRun = recallTools({ recall });
    const mine = (await fromRun.searchMemory.execute!({ query: "Utrecht" }, ctx(run("alice")))) as {
      facts: unknown[];
    };
    expect(mine.facts.length).toBeGreaterThan(0);
    await expect(
      fromRun.searchMemory.execute!({ query: "x" }, ctx(new RequestContext())),
    ).rejects.toThrow(/who the user is/);
  });

  it("are called by an agent in its tool loop", async () => {
    const recall = fresh();
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const streamOf = (parts: unknown[]) =>
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
    const offered: string[] = [];
    // First call: save the fact with the remember tool. After the tool result: answer.
    const step = ({ prompt, tools }: { prompt: Prompt; tools?: { name: string }[] }) => {
      offered.push(...(tools ?? []).map((t) => t.name));
      const toolName = tools?.find((t) => /remember/i.test(t.name))?.name ?? "rememberFact";
      return prompt.some((m) => m.role === "tool")
        ? {
            content: [{ type: "text", text: "Noted: no peanuts." }],
            finishReason: "stop",
          }
        : {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName,
                input: JSON.stringify({ fact: "Is allergic to peanuts." }),
              },
            ],
            finishReason: "tool-calls",
          };
    };
    const model = new MastraLanguageModelV2Mock({
      doGenerate: (async (call: Parameters<typeof step>[0]) => ({
        ...step(call),
        usage,
        warnings: [],
      })) as never,
      doStream: (async (call: Parameters<typeof step>[0]) => {
        const { content, finishReason } = step(call);
        const parts = content.map((c) =>
          c.type === "text"
            ? [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: (c as { text: string }).text },
                { type: "text-end", id: "t" },
              ]
            : [c],
        );
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            ...parts.flat(),
            { type: "finish", finishReason, usage },
          ]),
        };
      }) as never,
    });
    const memory = new RecallMemory({ recall });
    const agent = agentWith(model, memory, { tools: recallTools({ recall }) });
    const result = await agent.generate("I'm allergic to peanuts, remember that.", {
      requestContext: run("carol", "c-1"),
      maxSteps: 3,
    });
    expect(result.text).toBe("Noted: no peanuts.");
    expect(offered).toEqual(expect.arrayContaining(["searchMemory", "askMemory", "rememberFact"]));
    const facts = await (await recall.peer("carol").conclusions.list()).toArray();
    expect(facts.map((f) => f.content)).toContain("Is allergic to peanuts.");
  });
});

describe("guide example", () => {
  it("examples/guides/mastra.ts runs", async () => {
    const file = fileURLToPath(new URL("../../../examples/guides/mastra.ts", import.meta.url));
    const mod = (await import(file)) as { main: (r: Recall) => Promise<unknown> };
    expect(await mod.main(fresh())).toBeDefined();
  }, 60_000);
});
