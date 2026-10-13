# @recall-memory/ai-sdk

[Recall](https://recallmem.dev) memory for the [Vercel AI SDK](https://ai-sdk.dev): a middleware that adds what Recall
knows about the user to each request and stores every turn, and tools the model can call to search memory, ask it
a question and save a fact.

```sh
npm install @recall-memory/ai-sdk @recall-memory/sdk
```

Works with `ai` 7 (and `zod` 3.25+ or 4), on Node 22+. Set `RECALL_API_KEY` (create a key at
<https://app.recallmem.dev/keys>).

## Quick start

```ts
import { recallMiddleware, recallTools } from "@recall-memory/ai-sdk";
import { generateText, isStepCount, wrapLanguageModel } from "ai";

// In your route handler: who the user is, and which conversation this is.
const memory = { userId: "user-8412", sessionId: "chat-20261013-a91f" };
const { text } = await generateText({
  model: wrapLanguageModel({ model: yourModel, middleware: recallMiddleware(memory) }),
  tools: recallTools(memory), // searchMemory, askMemory, rememberFact
  stopWhen: isStepCount(5),
  prompt: "My parents visit on Saturday. Can you plan a dinner for four?",
});
```

The model now starts every request knowing what the user said in earlier conversations, and Recall learns from
this one. `wrapLanguageModel` takes a model instance (from a provider package or `gateway(...)`), not a model id
string.

## Exports

| Export | What it does |
|---|---|
| `recallMiddleware(options)` | Language model middleware. Before each call it adds what Recall knows about the user, biased towards their latest message, as a system message after your instructions. After the final step (not after tool-call steps) it stores the user's latest message and the reply in the session. Works with `generateText`, `streamText` and `ToolLoopAgent`. |
| `recallTools(options)` | `{ searchMemory, askMemory, rememberFact }` for `tools`: search facts and the user's messages, ask a question about the user (answered from memory), save one fact. |
| `recallContext(options)` | The memory block as a string (`""` when nothing is known yet), for `system`, `instructions` or a `prepareCall`. Takes a `query` to bias it. |
| `saveTurn(options, { user, assistant })` | Stores one exchange by hand, for example from `onEnd`. |

## Options

All functions take the same options:

| Option | |
|---|---|
| `userId` | **Required.** The person, as a Recall peer id: your own stable user id. |
| `sessionId` | The conversation, as a Recall session id. Needed to store turns. |
| `recall` | A `Recall` client from `@recall-memory/sdk`. Default: one per process, from `RECALL_API_KEY`, `RECALL_URL` and `RECALL_WORKSPACE_ID`. |
| `assistantId` | The assistant's peer (default `"assistant"`), created with `observeMe: false`: Recall reads its replies as context but learns nothing about it. |
| `maxConclusions` | Most facts in the memory block. |

`recallMiddleware` also takes `context: false` (only store turns), `store: false` (only read memory) and
`onError` (called when Recall cannot be reached; the model call always goes on, without memory if need be).
`recallTools` also takes `reasoningLevel` for `askMemory`.

Create the middleware and tools per request, so each request reads and writes the right person's memory. For an
agent defined once, pass the ids as call options and add memory in `prepareCall`:

```ts
const agent = new ToolLoopAgent({
  model,
  callOptionsSchema: z.object({ userId: z.string(), sessionId: z.string() }),
  prepareCall: ({ options, ...settings }) => ({
    ...settings,
    model: wrapLanguageModel({ model, middleware: recallMiddleware(options) }),
    tools: recallTools(options),
  }),
});
await agent.generate({ prompt, options: { userId, sessionId } });
```

## Learn more

- Guide with tested code: <https://recallmem.dev/guides/vercel-ai-sdk>
- Docs: <https://recallmem.dev/docs>
- The TypeScript SDK: [`@recall-memory/sdk`](https://www.npmjs.com/package/@recall-memory/sdk)

MIT licensed.
