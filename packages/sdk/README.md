# @recall-memory/sdk

TypeScript client for [Recall](https://recallmem.dev), reasoning memory for AI agents. It speaks the v3
memory REST API, so it also works against any server that implements that API.

```sh
npm install @recall-memory/sdk
```

ESM, zero runtime dependencies, Node 20+ (anything with global `fetch`).

## Quick start

```ts
import { Recall } from "@recall-memory/sdk";

// Talks to Recall's hosted API (https://api.recallmem.dev). Get a key at https://app.recallmem.dev/keys.
const recall = new Recall({ apiKey: process.env.RECALL_API_KEY });
const alice = recall.peer("alice"); // lazy: no request is made
const bot = recall.peer("bot");
const session = recall.session("chat-1");

// One round trip per agent turn: store the message, get the next prompt's context back.
const { context } = await session.turn([alice.message("I moved to Utrecht last month.")], {
  peerTarget: alice,
  tokens: 4000,
});
const reply = await openai.chat.completions.create({
  model: "gpt-5-mini",
  messages: context.toOpenAI(bot), // or context.toAnthropicParams(bot)
});

await recall.waitForIdle(); // background reasoning has caught up
console.log(await alice.chat("Where do I live?")); // "Utrecht"
```

## Configuration

`new Recall({ apiKey, baseURL, workspaceId, timeout, maxRetries, ... })`. Each falls back to the environment:
`RECALL_API_KEY`, `RECALL_URL` (or `RECALL_BASE_URL`), `RECALL_WORKSPACE_ID`, then the defaults: the hosted API at
`https://api.recallmem.dev` and workspace `default`. An explicit option always wins. Only `RECALL_*` variables are
read; variables that belong to other products are ignored, so their keys are never sent to Recall.
The hosted API needs a key; sign up and create one at <https://app.recallmem.dev>.

To use a server you run yourself, set `RECALL_URL=http://localhost:8000` or pass the URL:

```ts
const recall = new Recall({ baseURL: "http://localhost:8000" }); // self-hosted
```

## Behaviour worth knowing

- **Handles are lazy.** `peer()`, `session()` and `scope()` make no request (so nothing is created by a typo).
  Options such as `metadata` travel with the handle's first call, and a message built with
  `peer.message()` carries them too: the session sends them before storing it, so a peer created
  with `configuration: { observeMe: false }` is never learned from. `await recall.peer("x")` still works.
  `new Recall({ autoCreate: true })` switches to get-or-create: the workspace and each handle's resource
  are created on first use (so, for example, `getCard()` of a new peer is `null` instead of a 404).
- **What memory is read is checked before sending.** `scope` cannot be combined with `sessions` or `session`
  (`TypeError`), and `sessions: []` is sent as "recall nothing", never dropped.
- **Retries cannot duplicate writes.** Message creation carries an auto-generated `Idempotency-Key`, so a retry
  after a timeout returns the original messages. Retries use full-jitter backoff and honour `Retry-After`;
  requests that are not idempotent are retried only after a 429.
- **`session.turn(messages, opts)`** stores messages and returns the session context in one request.
- **`waitForIdle()`** waits (server-side long poll) until extraction and summaries finish; `addMessages(..., { wait: true })` does it inline.
- **`usage()`** returns model calls and tokens by task and model. On the hosted service, `billed` is what the
  workspace was charged (`billedUsd`, message tokens learned, questions per level) and `costUsd` is `null`;
  on a server of your own, `costUsd` is the provider cost and `billed` is `null`.
- **Batching.** More than 100 messages are sent in ordered batches.
- **Prompt builders.** `toOpenAI(assistant)`, `toAnthropic(assistant)` and `toAnthropicParams(assistant)`
  (`{ system, messages }`, ready for `anthropic.messages.create`).
- **Structured output** takes a JSON Schema, or `{ jsonSchema, parse }` for a typed result, e.g. with zod:
  `{ jsonSchema: z.toJSONSchema(S), parse: (d) => S.parse(d) }`.
- **Errors** are `NotFoundError`, `RateLimitError`, ... (plus `APIError`, `RecallTimeoutError`, `RecallConnectionError`) with `status`, `code`, `body` and `requestId`.

## Surface

| | |
|---|---|
| `Recall` | `peer` `session` `scope` `peers` `sessions` `scopes` `getScope` `workspaces` `deleteWorkspace` `search` `chat` `chatStream` `queueStatus` `waitForIdle` `scheduleDream` `usage` `createKey` `getMetadata`/`setMetadata`/`getConfiguration`/`setConfiguration`/`refresh` `conclusions` `webhooks` |
| `Peer` | `chat` `chatStream` `message` `search` `sessions` `getCard` `setCard` `representation` `context` `conclusions` `conclusionsOf(target)` `delete` (erase the peer; Recall only) + metadata/configuration accessors |
| `Session` | `addMessages` `turn` `messages` `getMessage` `updateMessage` `uploadFile` `context` `summaries` `search` `representation` `addPeers` `setPeers` `removePeers` `peers` `get/setPeerConfiguration` `clone` `delete` `queueStatus` `waitForIdle` |
| `Scope` | `addSessions` `removeSession` `sessions` `status` |
| `ConclusionsView` | `list` `query` `get` `getMany` `derived` `create` `delete` `representation` |
| `SessionContext` | `messages` `summary` `peerRepresentation` `peerCard` `toOpenAI` `toAnthropic` `toAnthropicParams` |
| helpers | `Page` (async-iterable), `DialecticStream`, `verifyWebhookSignature`, `constructWebhookEvent` |

List methods return a `Page`: `for await (const x of page)` walks every page, `page.items` is just this one.

## Develop

`pnpm --filter @recall-memory/sdk test` starts the real server in-process (embedded Postgres, offline mock model)
and exercises the SDK against it.
