# @recall-memory/langchain

[Recall](https://recallmem.dev) memory for [LangChain.js](https://js.langchain.com): agent middleware that gives
`createAgent` agents long-term memory of each user, a chat message history stored in Recall sessions, a retriever over
what Recall remembers about the user, and tools for agents.

```sh
npm install @recall-memory/langchain @recall-memory/sdk
```

Works with `@langchain/core` 1.x (and `zod` 3.25+ or 4), on Node 20+; the middleware also needs `langchain` 1.x. Set
`RECALL_API_KEY` (create a key at <https://app.recallmem.dev/keys>).

## Agents: the middleware

```ts
import { createAgent } from "langchain";
import { recallMiddleware } from "@recall-memory/langchain/middleware";

const agent = createAgent({ model, tools, middleware: [recallMiddleware()] });
await agent.invoke(
  { messages: [{ role: "user", content: "Plan my weekend" }] },
  { context: { userId: "user-42" }, configurable: { thread_id: "chat-1" } },
);
```

Before each run it reads the user's peer card and the facts Recall learned that relate to the new message (no model
call) and adds them to the system prompt. After the run it stores the user's message and the agent's final answer in
the thread's Recall session, so Recall keeps learning. Tool calls and their results are not recorded. If Recall cannot
be reached, the run goes on without memory.

| Option | |
|---|---|
| `userId` | The person, as a Recall peer id. Default: read from the run's `context` (key set by `userIdKey`, default `"userId"`). |
| `sessionId` | The Recall session to record into. Default: the run's `thread_id`, made a valid Recall id. |
| `read`, `record` | Add memory to the prompt, and store each exchange (both default `true`). |
| `assistantId` | The assistant's peer (default `"assistant"`); Recall learns nothing about it. |
| `maxConclusions` | Most facts added to the prompt (default 20). |
| `recall`, `onError` | A `Recall` client, and a handler for Recall errors (default: `console.warn`). |

## Chains: history, retriever and tools

```ts
import { RecallChatMessageHistory, RecallRetriever, recallTools } from "@recall-memory/langchain";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";

const userId = "user-8412"; // your own stable user id
const chat = new RunnableWithMessageHistory({
  runnable: prompt.pipe(model), // a prompt with a "history" placeholder
  getMessageHistory: (sessionId) => new RecallChatMessageHistory({ sessionId, userId }),
  inputMessagesKey: "input",
  historyMessagesKey: "history",
});
const facts = await new RecallRetriever({ userId }).invoke("dinner plans"); // what Recall knows
const agentModel = model.bindTools(recallTools({ userId })); // search_memory, ask_memory, remember_fact
```

## Exports

| Export | What it does |
|---|---|
| `RecallChatMessageHistory` | A `BaseListChatMessageHistory` backed by a Recall session. Human messages are stored as the user's, AI messages as the assistant's (system and tool messages are skipped), and Recall learns about the user from them. `getMessages()` returns the conversation; with `tokens` it returns Recall's context instead: a summary of older turns plus the recent messages. `clear()` deletes the session, including the facts learned from it. |
| `RecallRetriever` | A `BaseRetriever` returning the current facts Recall holds about the user and the messages they wrote that match the query, as `Document`s (facts first). Metadata: `kind` (`"fact"` or `"message"`), `id`, `createdAt`, `sessionId`. |
| `recallTools(options)` | `[search_memory, ask_memory, remember_fact]`: search facts and messages, ask a question about the user (answered from memory), save one fact. Plain LangChain tools for `bindTools`, `createAgent` or a tool node. |
| `recallMiddleware(options)` | From `@recall-memory/langchain/middleware`: agent middleware for `createAgent` (above). |

## Options of the history, retriever and tools

| Option | For | |
|---|---|---|
| `userId` | all | **Required.** The person, as a Recall peer id. |
| `recall` | all | A `Recall` client from `@recall-memory/sdk`. Default: one per process, from `RECALL_API_KEY`, `RECALL_URL` and `RECALL_WORKSPACE_ID`. |
| `sessionId` | history | **Required.** The conversation, as a Recall session id. |
| `assistantId` | history | The assistant's peer (default `"assistant"`), created with `observeMe: false`: Recall reads its replies as context but learns nothing about it. |
| `tokens` | history | Return a summary plus the recent messages within this budget instead of every message. |
| `k`, `include` | retriever | Documents of each kind (default 6); `["facts"]`, `["messages"]` or both (default). |
| `reasoningLevel` | tools | The reasoning level for `ask_memory`. |

## Learn more

- Guide with tested code: <https://recallmem.dev/guides/langchain-js>
- Docs: <https://recallmem.dev/docs>
- The TypeScript SDK: [`@recall-memory/sdk`](https://www.npmjs.com/package/@recall-memory/sdk)

MIT licensed.
