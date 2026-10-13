import { fileURLToPath } from "node:url";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BasePromptValueInterface } from "@langchain/core/prompt_values";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { RunnableLambda, RunnableWithMessageHistory } from "@langchain/core/runnables";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { Recall } from "@recall-memory/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../../sdk/test/harness.js";
import { RecallChatMessageHistory, RecallRetriever, recallTools } from "../src/index.js";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const fresh = () =>
  new Recall({
    baseURL: server.url,
    workspaceId: `langchain-${Math.random().toString(36).slice(2, 9)}`,
    retryBaseDelay: 5,
  });

const shape = (messages: BaseMessage[]) => messages.map((m) => [m.getType(), m.text]);

describe("RecallChatMessageHistory", () => {
  it("stores human and AI messages in a Recall session and reads them back", async () => {
    const recall = fresh();
    const history = new RecallChatMessageHistory({ recall, sessionId: "chat-1", userId: "alice" });
    expect(await history.getMessages()).toEqual([]);

    await history.addMessages([
      new SystemMessage("You are helpful."),
      new HumanMessage("I moved to Utrecht last month."),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "search_memory", args: { query: "city" } }],
      }),
      new ToolMessage({ content: "{}", tool_call_id: "c1" }),
      new AIMessage("Welcome to Utrecht!"),
    ]);
    await history.addUserMessage("Any tips for cafés?");

    const messages = await history.getMessages();
    expect(shape(messages)).toEqual([
      ["human", "I moved to Utrecht last month."],
      ["ai", "Welcome to Utrecht!"],
      ["human", "Any tips for cafés?"],
    ]);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[1]).toBeInstanceOf(AIMessage);
    const stored = await (await recall.session("chat-1").messages()).toArray();
    expect(stored.map((m) => m.peerId)).toEqual(["alice", "assistant", "alice"]);
    expect((await recall.peer("assistant").getConfiguration()).observeMe).toBe(false);

    // With a token budget: Recall's context for the session (recent messages, summary when there is one).
    const budgeted = new RecallChatMessageHistory({
      recall,
      sessionId: "chat-1",
      userId: "alice",
      tokens: 2_000,
    });
    expect(shape(await budgeted.getMessages())).toEqual(shape(messages));
  });

  it("gives RunnableWithMessageHistory the conversation so far", async () => {
    const recall = fresh();
    const prompts: BaseMessage[][] = [];
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", "You are a helpful assistant."],
      new MessagesPlaceholder("history"),
      ["human", "{input}"],
    ]);
    const spy = RunnableLambda.from((value: BasePromptValueInterface) => {
      prompts.push(value.toChatMessages());
      return value;
    });
    const model = new FakeListChatModel({ responses: ["Nice to meet you, Sam.", "You are Sam."] });
    const chat = new RunnableWithMessageHistory({
      runnable: prompt.pipe(spy).pipe(model),
      getMessageHistory: (sessionId: string) =>
        new RecallChatMessageHistory({ recall, sessionId, userId: "sam" }),
      inputMessagesKey: "input",
      historyMessagesKey: "history",
    });
    const config = { configurable: { sessionId: "intro" } };
    await chat.invoke({ input: "Hi, I'm Sam." }, config);
    const second = await chat.invoke({ input: "What is my name?" }, config);
    expect(second.text).toBe("You are Sam.");
    expect(shape(prompts[1]!)).toEqual([
      ["system", "You are a helpful assistant."],
      ["human", "Hi, I'm Sam."],
      ["ai", "Nice to meet you, Sam."],
      ["human", "What is my name?"],
    ]);
    const stored = await (await recall.session("intro").messages()).toArray();
    expect(stored.map((m) => [m.peerId, m.content])).toEqual([
      ["sam", "Hi, I'm Sam."],
      ["assistant", "Nice to meet you, Sam."],
      ["sam", "What is my name?"],
      ["assistant", "You are Sam."],
    ]);
  });

  it("clear() deletes the session", async () => {
    const recall = fresh();
    const history = new RecallChatMessageHistory({ recall, sessionId: "temp", userId: "alice" });
    await history.clear(); // nothing to clear yet
    await history.addMessages([new HumanMessage("Remember this?")]);
    await history.clear();
    expect(await history.getMessages()).toEqual([]);
  });

  it("never serializes the client or its API key", () => {
    const recall = new Recall({ baseURL: server.url, apiKey: "rk_test_do_not_serialize" });
    const history = new RecallChatMessageHistory({ recall, sessionId: "s", userId: "alice" });
    const retriever = new RecallRetriever({ recall, userId: "alice", k: 3 });
    for (const serialized of [
      JSON.stringify(history.toJSON()),
      JSON.stringify(retriever.toJSON()),
    ]) {
      expect(serialized).not.toContain("rk_test_do_not_serialize");
    }
  });

  it("requires a session and a user", () => {
    expect(
      () => new RecallChatMessageHistory({ recall: fresh(), sessionId: "", userId: "a" }),
    ).toThrow(/sessionId/);
    expect(
      () => new RecallChatMessageHistory({ recall: fresh(), sessionId: "s", userId: "" }),
    ).toThrow(/userId/);
  });
});

describe("RecallRetriever", () => {
  it("returns facts and the user's messages as documents", async () => {
    const recall = fresh();
    const retriever = new RecallRetriever({ recall, userId: "alice", k: 4 });
    expect(await retriever.invoke("Where does alice live?")).toEqual([]); // nothing known yet

    await recall.peer("alice").conclusions.create("Lives in Utrecht.");
    await recall
      .session("s1")
      .addMessages([recall.peer("alice").message("The canals in Utrecht are lovely in spring.")]);

    const docs = await retriever.invoke("Utrecht");
    const facts = docs.filter((d) => d.metadata.kind === "fact");
    const messages = docs.filter((d) => d.metadata.kind === "message");
    expect(facts.map((d) => d.pageContent)).toContain("Lives in Utrecht.");
    expect(messages.map((d) => d.pageContent)).toContain(
      "The canals in Utrecht are lovely in spring.",
    );
    expect(messages[0]!.metadata).toMatchObject({ source: "recall", sessionId: "s1" });
    expect(docs[0]!.metadata.kind).toBe("fact"); // facts first

    const onlyFacts = new RecallRetriever({ recall, userId: "alice", include: ["facts"] });
    expect((await onlyFacts.invoke("Utrecht")).every((d) => d.metadata.kind === "fact")).toBe(true);
  });
});

describe("recallTools", () => {
  it("search, ask and remember", async () => {
    const recall = fresh();
    const tools = recallTools({ recall, userId: "alice" });
    expect(tools.map((t) => t.name)).toEqual(["search_memory", "ask_memory", "remember_fact"]);
    const [search, ask, remember] = tools;

    expect(await ask.invoke({ question: "Where do I live?" })).toBe(
      "Nothing is remembered about this user yet.",
    );
    expect(await remember.invoke({ fact: "Lives in Utrecht." })).toBe("Saved: Lives in Utrecht.");
    const found = JSON.parse((await search.invoke({ query: "Utrecht" })) as string);
    expect(found.facts.map((f: { content: string }) => f.content)).toContain("Lives in Utrecht.");
    expect(await ask.invoke({ question: "Where do I live?" })).toContain("Utrecht");

    // A model that supports tool calling takes them as they are.
    const model = new FakeListChatModel({ responses: ["ok"] });
    expect(model.bindTools(tools)).toBeDefined();
  });
});

describe("guide example", () => {
  it("examples/guides/langchain-js.ts runs", async () => {
    const file = fileURLToPath(
      new URL("../../../examples/guides/langchain-js.ts", import.meta.url),
    );
    const mod = (await import(file)) as { main: (r: Recall) => Promise<unknown> };
    expect(await mod.main(fresh())).toBeDefined();
  }, 60_000);
});
