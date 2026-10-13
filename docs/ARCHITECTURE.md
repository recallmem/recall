# Recall — architecture

Recall is reasoning memory for stateful agents. It serves the v3 memory REST API (workspaces,
peers, sessions, messages, chat and context), so any client written for that API works by
changing the base URL, and it adds the extensions listed at the end of this page.

## Goals

| | Target |
|---|---|
| Background reasoning per 100 messages | ≤ 8 LLM calls, ≤ 25k input tokens |
| Chat at the default level | 1 call, ≤ 5k input tokens, ~1–2 s |
| Streaming chat | the answer is generated once |
| Knowledge updates and contradictions | resolved at ingest (supersession), not hours later |
| Abstention | an explicit "I don't know" with a confidence |
| Search | hybrid (vector + `simple` full text, fused with RRF) everywhere |
| Self-hosting | one process; embedded Postgres; works offline |
| Writes | `Idempotency-Key` honoured, so retries never duplicate messages or answers |
| Cost | every model call metered and visible per workspace |

`test/reasoner-budget.test.ts` and `test/recall-budget.test.ts` hold the server to the first two
rows on the mock model.

## Stack

TypeScript on Node 22, Hono (HTTP), Drizzle (query building), Postgres 16+ with
pgvector, or PGlite (embedded Postgres in WASM) when no `RECALL_DATABASE_URL`
is set. The job queue lives in Postgres (`FOR UPDATE SKIP LOCKED`), so there is
no Redis. Zod validates every request body. LLM access is provider-neutral:
Anthropic, OpenAI, Gemini, OpenRouter, xAI, Groq, DeepSeek, Together, Fireworks, or any
OpenAI-compatible server; each task routes to the cheapest configured model unless overridden.

## Key design decisions

1. **One extraction call per session batch, for all observers.** Recall batches a session's
   unreasoned messages (by token threshold or idle time), makes one structured call, and files
   the resulting conclusions into every observer's collection. No message is sent twice and
   embeddings are computed once.
2. **Update-aware extraction.** The extraction call sees the most similar
   existing conclusions about each speaker and returns operations: `add`,
   `reinforce` (same fact again → `times_derived++`), `supersede` (fact
   changed → old row gets `valid_to` + `superseded_by`), plus inline deductions
   and peer-card updates. Knowledge updates are correct immediately; dreams only
   consolidate.
3. **Bi-temporal conclusions with provenance.** Each conclusion stores
   `valid_from`/`valid_to`, `superseded_by`, source message ids, confidence,
   importance and category. Recall prefers current facts but can answer "what
   did X use to prefer".
4. **Retrieval first, agent loop last.** Chat at `minimal`/`low`/`medium` is
   one hybrid retrieval (vector + full text + recency/importance, fused with
   RRF) followed by a single LLM call with a stable, cacheable prefix. `high`
   and `max` add a bounded tool loop. Answers are cached against a per-collection
   memory version.
5. **Incremental summaries and bounded dreams.** Each block of messages is
   summarised once; session context assembles blocks within the token budget.
   Dreams (the "night shift") cluster what changed since the last dream and make one
   structured call per cluster, under a hard token budget.
6. **Everything metered.** Every LLM and embedding call records tokens and cost
   in `llm_usage`, exposed at `GET /v3/workspaces/{id}/usage`.

## Prompt layout and caching

Every LLM call is laid out static-first, so providers can cache the part that all calls of a task
share (`src/llm/cache.ts`, the providers in `src/llm/providers/`):

1. tool definitions and the output schema, the same for every call of the task;
2. `system`: fixed instructions, byte-identical on every call (reasoner and chat end with a worked example);
3. `context`: per-call material (known facts, cards, the memory pack, app instructions, summaries);
4. messages: transcript or question, with today's date.

The end of `system` gets a cache breakpoint once the prefix before it reaches the provider's
minimum: 1,024 tokens on OpenAI GPT-5.6 and later, 512 to 4,096 on Claude depending on the model.
On OpenAI those models are switched to explicit mode, because their default writes the whole
prompt to cache at 1.25x input on every call and never reads the shared prefix back. Older OpenAI
models cache on their own. Anthropic gets `cache_control`, and OpenRouter gets the same markers for
Claude and GPT-5.6+, plus `session_id` for sticky routing. Gemini, DeepSeek, Groq, Together and
Fireworks cache prefixes automatically and are sent nothing extra. Tool loops (`cacheContext`)
also mark the pack and each finished round. The cache key (`prompt_cache_key`, `session_id`) is
`recall:<task>`, or `recall:<task>:<workspace>` when tenant content is cached. Cache reads and
writes are metered separately (`cacheReadTokens`, `cacheWriteTokens`).

Static prefixes today (o200k, including schema and tools): reasoner 1,548 tokens; chat 1,135
(1,530 with the tools at `high`/`max`); dream 611, summary 192, card 166. The last three are too
short to cache on OpenAI, so they are sent with no breakpoint and pay no write.

When you edit a prompt:

- Never put dates, ids, names, settings or per-call text in a `system` string; they go in
  `context` or the messages. `test/prompt-cache.test.ts` builds requests from two workspaces
  through the real code paths and fails if anything before the breakpoint differs.
- Keep the reasoner and chat instructions at 1,024 tokens or more (the same test checks).
  Below that, every call pays full price for the whole prefix again.
- A new instruction text, tool list or schema simply starts a new cache entry: one write per task.
  That is fine at deploy time, but never vary them per call.
- Chat level budgets count the answering rules, not the worked example (`RULES_TOKENS`,
  `EXAMPLE_TOKENS`), so the example can grow without shrinking the memory pack.

## Multi-tenancy (hosted mode)

Accounts are the tenant boundary. Every workspace has an `account_id` and names are unique per
account, so a workspace is identified by `(account, name)` (`WsKey`). The caller's account comes from
the credential: a `pk_live_`/`pk_test_` API key (SHA-256 lookup, short in-process cache, per-key
token-bucket rate limit) or, for JWTs (`recall token`) and auth-disabled installs, the built-in
`default` account. All by-name workspace lookups go through one resolver (`core/tenancy.ts` `wsIs`
and `core/workspaces.ts` `findWorkspace`/`ensureWorkspace`); `test/tenancy-source.test.ts` rejects
raw name comparisons. Everything below a workspace is reached through its internal id, so background
jobs are isolated by construction. Admin rights (an `ad` JWT or an unscoped API key) never reach past
the caller's account.

Spend is attributed to the account when usage is recorded (`llm_usage.account_id`), so a monthly cap
survives workspace deletion. Over budget, chat answers 402 and the worker reschedules the account's
token-spending jobs (`reason`, `summarize`, `dream`, `embed`) without counting an attempt. Webhooks
of hosted accounts are signed with a per-account secret. The operator manages accounts and keys at
`/admin/v1` (`RECALL_ADMIN_TOKEN`). Every table has Row Level Security enabled with no policies, so
a managed Postgres provider's data-API roles see nothing while the server, as table owner, is
unaffected.

Customers can also sign up themselves at `/app` (magic-link email, users and account memberships,
server-rendered dashboard). With Stripe configured, accounts created there are billed from prepaid
credit: an append-only `credit_ledger` (integer micro-USD, one idempotency key per reasoning batch,
chat request or Stripe payment) whose balance is cached on `billing_accounts` and changed by the same
statement. A zero balance is a second spend block next to the monthly cap (`BudgetGuard.blocked`
returns `budget` or `credit`), so chat's 402 and the worker's pause are shared.

## Layout

```
packages/server/src/
  config.ts            env config; per-task model routing
  context.ts           AppContext: db, llm, embeddings, logger, queue
  db/                  schema.ts (Drizzle), migrations/*.sql, client.ts (pool + migrator)
  lib/                 ids, tokens (o200k_base), errors, time, json helpers
  llm/                 provider-neutral LLM + embedding clients, pricing, mock
  http/                app.ts (Hono), auth, pagination, filters, idempotency (chat replay), routes/*
  core/                CRUD services: workspaces, peers, sessions, messages, conclusions, scopes, webhooks;
                       tenancy (account-scoped resolver), accounts (budgets, usage), apikeys
  queue/               Postgres job queue + worker loop + work-unit claims
  reasoner/            batch extraction, conclusion upserts, peer cards
  consolidate/         dreams
  summaries/           incremental session summaries
  recall/              hybrid search, representation, chat (fast path + tool loop), session context
  webhooks/            signed delivery with retries
  billing/             prepaid ledger, Stripe Checkout/webhook/portal, auto top-up (hosted)
  http/dashboard/      /app: magic-link sign-in, sessions + CSRF, server-rendered pages;
                       console.ts: the operator console at /app/admin (RECALL_OPERATOR_EMAILS;
                       read models in core/operator.ts, suspension in core/suspend.ts)
  mcp/                 MCP endpoint (streamable HTTP, stateless) served by the same process: the curated
                       eight tools (tools.ts) and, opt-in, the 40-tool `full` profile (full/); kit.ts is shared
  cli.ts, cli/         `recall` command: start, token, doctor, accounts, keys, init, config and the
                       resource commands (workspace, peer, session, conclusion, queue); plain `fetch`, no SDK
  serve.ts             shared "run the API + worker" used by main.ts and `recall start`
packages/sdk/          @recall-memory/sdk: zero-dependency TypeScript client
sdks/python/           recall-mem: Python client (sync and async)
integrations/          Claude Code and Codex plugins (hooks + MCP bridge, plain Node), OpenClaw, Hermes,
                       Agent Skill; the Claude Code catalogue is .claude-plugin/marketplace.json
evals/                 benchmark harness (LongMemEval-S, BEAM, LoCoMo)
```

## Extensions beyond the v3 memory API (all additive)

- `Idempotency-Key` header on message create, turns and chat: the same key with the same request
  returns the first response again (nothing is stored or charged twice); with a different request, 409.
  Message keys live on the message rows; chat answers are kept a day in `idempotency_records`, per
  credential, replayed with `Idempotent-Replayed: true` (a duplicate while the first runs is a 409).
- `GET /v3/workspaces/{id}/usage` — calls and tokens by task and model; provider cost on a
  self-hosted server, and what was charged (`billed`) on a prepaid hosted account.
- `POST /v3/workspaces/{id}/sessions/{sid}/turn` — store messages and return the
  next prompt context in one round trip.
- `GET /v3/workspaces/{id}/queue/status?wait_ms=N` — long-poll until idle; the
  response then also carries `idle` (true if it ended because processing finished) and
  `failed_work_units` (units that failed for good, e.g. during a provider outage, so the
  memory has holes).
- `POST /v3/workspaces/{id}/queue/retry` — queue those failed units again (at most three
  manual retries per unit); returns `{"retried": n}`.
- `POST /mcp` — Model Context Protocol (Streamable HTTP) with eight memory tools; same
  bearer token as the API, defaults from `X-Recall-Workspace-ID` / `X-Recall-User-Name` /
  `X-Recall-Session-ID`. In hosted mode it is also an OAuth 2.1 protected resource: MCP clients
  sign in through the dashboard and get audience-bound, rotating tokens (`http/routes/oauth.ts`,
  `core/oauth*.ts`). `X-Recall-MCP-Profile: full` (or `?profile=full`) serves all 40 tools
  instead (workspaces, peers, sessions, conclusions, scopes); reads there never create anything.
- Chat responses may include `citations`, `confidence` and `abstained` in
  addition to `content`/`evidence`.
- `GET /v3/workspaces/{id}`, `GET …/peers/{id}`, `GET …/sessions/{id}`: reads that never create
  (the base API only has get-or-create). `DELETE …/peers/{id}` erases a peer and what was learned
  from and about it. Webhook deliveries carry `X-Recall-Event-Id` (stable across retries).
- `RECALL_CORS_ORIGINS` restricts browser origins.
- `GET /metrics` (Prometheus) and, in hosted mode, `/app` (dashboard) and `POST /billing/stripe/webhook`.
- Hosted mode: `GET /v3/usage` and `GET /v3/account` (account-admin keys), `pk_` API keys
  (also minted by `POST /v3/keys` when called with an account-admin key), `402` when a monthly
  budget is spent, `429` + `Retry-After` per key, and the operator API under `/admin/v1`.
