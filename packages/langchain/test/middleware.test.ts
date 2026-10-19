import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { Recall } from "@recall-memory/sdk";
import { createAgent } from "langchain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "../../sdk/test/harness.js";
import { recallTools } from "../src/index.js";
import { recallMiddleware, safeId } from "../src/middleware.js";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const fresh = () =>
  new Recall({
    baseURL: server.url,
    workspaceId: `lc-mw-${Math.random().toString(36).slice(2, 9)}`,
    retryBaseDelay: 5,
  });

/** A chat model that answers from a script and keeps every prompt it was given. */
class ScriptedChatModel extends BaseChatModel {
  prompts: BaseMessage[][] = [];
  constructor(private readonly responses: AIMessage[]) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.prompts.push([...messages]);
    const message = this.responses.shift();
    if (!message) throw new Error("the script ran out of answers");
    return { generations: [{ message, text: message.text }] };
  }
  override bindTools(): this {
    return this;
  }
  override withConfig(): this {
    return this;
  }
}

const ask = (text: string) => ({ messages: [new HumanMessage(text)] });
const systemText = (prompt: BaseMessage[] | undefined) =>
  prompt?.find((m) => SystemMessage.isInstance(m))?.text ?? "";

describe("recallMiddleware", () => {
  it("adds memory before the run and records the exchange after it", async () => {
    const recall = fresh();
    const model = new ScriptedChatModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: "remember_fact", args: { fact: "Is vegetarian." } }],
      }),
      new AIMessage("Noted: vegetarian. How about a mushroom risotto?"),
      new AIMessage("A lentil curry, since you are vegetarian."),
    ]);
    const agent = createAgent({
      model,
      tools: recallTools({ recall, userId: "alice" }),
      systemPrompt: "You plan dinners.",
      middleware: [recallMiddleware({ recall })],
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "dinner:1" }, context: { userId: "alice" } };

    await agent.invoke(ask("I'm vegetarian. What should I cook tonight?"), config);
    // The first prompt had no memory yet: alice was unknown.
    expect(systemText(model.prompts[0])).toBe("You plan dinners.");

    const sessionId = await safeId("dinner:1");
    expect(sessionId).toMatch(/^dinner-1-[0-9a-f]{10}$/); // the thread id, made a valid Recall id
    const session = recall.session(sessionId);
    const stored = await (await session.messages()).toArray();
    // The tool call and its result are not recorded.
    expect(stored.map((m) => [m.peerId, m.content])).toEqual([
      ["alice", "I'm vegetarian. What should I cook tonight?"],
      ["assistant", "Noted: vegetarian. How about a mushroom risotto?"],
    ]);
    expect((await recall.peer("assistant").getConfiguration()).observeMe).toBe(false);

    const out = await agent.invoke(ask("And tomorrow?"), config);
    const memory = systemText(model.prompts.at(-1));
    expect(memory.startsWith("You plan dinners.\n\n<memory>")).toBe(true);
    expect(memory.toLowerCase()).toContain("vegetarian");
    expect(await (await session.messages()).toArray()).toHaveLength(4);
    // The memory reaches the model only: it is not kept in the agent's state.
    expect(JSON.stringify(out)).not.toContain("<memory>");
  });

  it("works with a fixed user and session and no system prompt", async () => {
    const recall = fresh();
    await recall.peer("bob").conclusions.create("Is called Bob.");
    const model = new ScriptedChatModel([new AIMessage("Hello Bob.")]);
    const agent = createAgent({
      model,
      tools: [],
      middleware: [recallMiddleware({ recall, userId: "bob", sessionId: "chat-bob" })],
    });
    await agent.invoke(ask("Hi!"));
    const memory = systemText(model.prompts[0]);
    expect(memory.startsWith("<memory>")).toBe(true);
    expect(memory).toContain("Is called Bob.");
    expect(await (await recall.session("chat-bob").messages()).toArray()).toHaveLength(2);
  });

  it("stores an exchange once when it is recorded twice", async () => {
    const recall = fresh();
    const middleware = recallMiddleware({
      recall,
      userId: "alice",
      sessionId: "chat-1",
      read: false,
    });
    const state = {
      messages: [
        new HumanMessage({ content: "Hi", id: "h1" }),
        new AIMessage({ content: "Hello", id: "a1" }),
      ],
    };
    const afterAgent = middleware.afterAgent as (state: unknown, runtime: unknown) => Promise<void>;
    await afterAgent(state, {});
    await afterAgent(state, {});
    expect(await (await recall.session("chat-1").messages()).toArray()).toHaveLength(2);
  });

  it("needs a user and a session before the model runs", async () => {
    const recall = fresh();
    const model = new ScriptedChatModel([new AIMessage("ok")]);
    const agent = (options: Parameters<typeof recallMiddleware>[0]) =>
      createAgent({ model, tools: [], middleware: [recallMiddleware({ recall, ...options })] });

    await expect(agent({}).invoke(ask("Hi"))).rejects.toThrow(/does not know the user/);
    await expect(agent({}).invoke(ask("Hi"), { context: { userId: "alice" } })).rejects.toThrow(
      /needs a session/,
    );
    await expect(
      agent({ read: false }).invoke(ask("Hi"), { context: { userId: "alice" } }),
    ).rejects.toThrow(/needs a session/);
    expect(model.prompts).toEqual([]);

    const out = await agent({ record: false, userIdKey: "uid" }).invoke(ask("Hi"), {
      context: { uid: "alice" },
    });
    expect(out.messages.at(-1)?.text).toBe("ok");
  });

  it("goes on without Recall when it is down", async () => {
    const down = new Recall({
      baseURL: "http://127.0.0.1:9",
      workspaceId: "w",
      maxRetries: 0,
      timeout: 2_000,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const model = new ScriptedChatModel([new AIMessage("Still here.")]);
      const agent = createAgent({
        model,
        tools: [],
        middleware: [recallMiddleware({ recall: down, userId: "u", sessionId: "s" })],
      });
      const out = await agent.invoke(ask("Hi"));
      expect(out.messages.at(-1)?.text).toBe("Still here.");
      expect(warn.mock.calls.map((c) => String(c[0]).split(":")[1]?.trim())).toEqual([
        "could not read memory, going on without it",
        "could not record the exchange",
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
