# @recall-memory/mastra

[Recall](https://recallmem.dev) memory for [Mastra](https://mastra.ai) agents: a processor that adds what Recall
knows about the user to each run and stores every turn, and tools the agent can call to search memory, ask it a
question and save a fact.

```sh
npm install @recall-memory/mastra @recall-memory/sdk
```

Works with `@mastra/core` 1.x (and `zod` 3.25+ or 4), on Node 22.13+. Set `RECALL_API_KEY` (create a key at
<https://app.recallmem.dev/keys>).

## Quick start

```ts
import { Agent } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { RecallMemory, recallTools } from "@recall-memory/mastra";

const memory = new RecallMemory(); // reads RECALL_API_KEY
const agent = new Agent({ id: "assistant", name: "Assistant", instructions: "You are helpful.", model,
  tools: { ...recallTools() }, inputProcessors: [memory], outputProcessors: [memory] });

const requestContext = new RequestContext(); // usually filled in by your auth middleware
requestContext.set(MASTRA_RESOURCE_ID_KEY, "user-8412"); // the user
requestContext.set(MASTRA_THREAD_ID_KEY, "chat-20261013-a91f"); // the conversation
await agent.generate("Can you plan a dinner for four on Saturday?", { requestContext });
```

## Exports

| Export | What it does |
|---|---|
| `RecallMemory` | A processor. As an input processor it adds what Recall knows about the user, biased towards their message, as a system message. As an output processor it stores the user's message and the agent's reply in the session. Put the same instance in `inputProcessors` and `outputProcessors`. |
| `recallTools(options)` | `{ searchMemory, askMemory, rememberFact }` for the agent's `tools`: search facts and the user's messages, ask a question about the user (answered from memory), save one fact. |

## Options

| Option | |
|---|---|
| `userId` | The person, as a Recall peer id: a string, or a function `({ requestContext }) => string \| undefined`. Default: the run's resource id (`MASTRA_RESOURCE_ID_KEY` in the request context, or `memory.resource` when the agent has Mastra memory). |
| `sessionId` | The conversation, as a Recall session id, given the same way. Default: the run's thread id (`MASTRA_THREAD_ID_KEY`, or `memory.thread`). |
| `recall` | A `Recall` client from `@recall-memory/sdk`. Default: one per process, from `RECALL_API_KEY`, `RECALL_URL` and `RECALL_WORKSPACE_ID`. |
| `assistantId` | The assistant's peer (default `"assistant"`), created with `observeMe: false`: Recall reads its replies as context but learns nothing about it. |

`RecallMemory` also takes `context: false` (only store turns), `store: false` (only read memory),
`maxConclusions` and `onError` (called when Recall cannot be reached; the run always goes on, without memory if
need be). Without a user id it does nothing. `recallTools` also takes `reasoningLevel` for `askMemory`, and
throws a clear error when it cannot tell who the user is.

## Learn more

- Guide with tested code: <https://recallmem.dev/guides/mastra>
- Docs: <https://recallmem.dev/docs>
- The TypeScript SDK: [`@recall-memory/sdk`](https://www.npmjs.com/package/@recall-memory/sdk)

MIT licensed.
