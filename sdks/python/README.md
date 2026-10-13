# recall-mem

Python SDK for [Recall](https://recallmem.dev), reasoning memory for AI agents. Recall speaks the v3
memory REST API; this SDK wraps it with `Recall` / `AsyncRecall` clients and `Peer`, `Session`, `Scope`
and `SessionContext` objects, each with a sync and an async (`.aio`) form.

```python
from recall_memory import Recall
```

Python 3.10+, runtime dependencies `httpx` and `pydantic` v2.

## Install

```bash
uv pip install recall-mem        # or: pip install recall-mem
```

The package is `recall-mem` on PyPI; you import it as `recall_memory`.

## Quickstart

Create an API key at <https://app.recallmem.dev/keys> and export it as `RECALL_API_KEY`. The SDK talks to
Recall's hosted API, `https://api.recallmem.dev`, unless you say otherwise:

```python
from recall_memory import Recall

recall = Recall(workspace_id="my-app")  # reads RECALL_API_KEY; no network call yet

alice = recall.peer("alice")  # handles are lazy: no network call
bot = recall.peer("bot")
session = recall.session("chat-1")  # no network call either

session.add_peers([alice, bot])
session.add_messages(
    [
        alice.message("I moved to Utrecht last month and I love cycling."),
        bot.message("Utrecht is great for cycling!"),
    ]
)

recall.wait_for_idle()  # block until reasoning has finished

print(alice.chat("Where does Alice live?"))  # -> "Alice lives in Utrecht."

# Build the next prompt: recent messages + what is known about Alice, in OpenAI or Anthropic shape.
ctx = session.context(peer_target=alice, tokens=4000)
messages = ctx.to_openai(assistant=bot)  # or ctx.to_anthropic(assistant=bot)
```

Running your own server instead? Point the client at it (`npx tsx packages/server/src/main.ts` starts one on
`localhost:8000` with an embedded database):

```python
recall = Recall(base_url="http://localhost:8000", workspace_id="my-app")  # or: export RECALL_URL=http://localhost:8000
```

One round trip per agent turn (store the new messages and get the next context back):

```python
result = session.turn([alice.message("Actually, I now live in Amersfoort.")], peer_target=alice)
prompt = result.context.to_openai(assistant=bot)
```

Streaming, evidence and structured answers:

```python
for chunk in alice.chat_stream("What does Alice like?"):
    print(chunk, end="")

answer = alice.chat("Where does Alice live?", include_evidence=True)
answer.content, answer.evidence, answer.citations, answer.confidence, answer.abstained

from pydantic import BaseModel


class Home(BaseModel):
    city: str


home = alice.chat("Where does Alice live?", response_format=Home)  # -> Home | None
```

Prompt converters (`card_format="python"` gives the reference SDK's list-repr for the peer card):

```python
ctx.to_openai(assistant=bot)  # system blocks, then user/assistant messages
ctx.to_anthropic(assistant=bot)  # same shape as the reference SDK
client.messages.create(model=..., max_tokens=1024, **ctx.to_anthropic_params(assistant=bot))
# -> {"system": "<peer_card>...</peer_card>", "messages": [alternating user/assistant turns]}
```

Cost and background work:

```python
usage = recall.usage()  # GET /v3/workspaces/{id}/usage: model calls and tokens by task and model
usage.billed  # hosted service: billed_usd, learning.message_tokens, chat.by_level["low"].questions
usage.total.cost_usd  # a server of your own: provider cost (None on the hosted service)
recall.queue_status()  # counts of pending / running / finished work
recall.wait_for_idle(timeout=30)  # server-side long-poll, no sleep loops
```

## Async

Every sync object has an `.aio` twin with the same methods as coroutines, and `AsyncRecall` is a
standalone async client:

```python
from recall_memory import AsyncRecall

async with AsyncRecall(workspace_id="my-app") as recall:
    alice = await recall.peer("alice")
    session = await recall.session("chat-1", peers=[alice])
    await session.add_messages([alice.message("I adopted a dog named Pixel.")])
    await recall.wait_for_idle()
    stream = await alice.chat_stream("What pets does Alice have?")
    async for chunk in stream:
        print(chunk, end="")
    async for s in await recall.sessions():  # pages iterate lazily
        print(s.id)
```

Or keep a sync client and use its async view, `recall.aio`:

```python
recall = Recall(workspace_id="my-app")


async def main():
    alice = await recall.aio.peer("alice")
    print(await alice.chat("Where does Alice live?"))  # alice is a PeerAio
```

## Configuration

Arguments win over the environment, which wins over the defaults. Only `RECALL_*` variables are read;
variables that belong to other products are ignored, so their keys are never sent to Recall.

| Setting | Argument | Environment (first match wins) | Default |
|---|---|---|---|
| Server URL | `base_url` | `RECALL_URL`, `RECALL_BASE_URL` | `https://api.recallmem.dev` (hosted) |
| API key | `api_key` | `RECALL_API_KEY` | none (no auth header; the hosted API needs one, from <https://app.recallmem.dev/keys>) |
| Workspace | `workspace_id` | `RECALL_WORKSPACE_ID`, `RECALL_WORKSPACE` | `"default"` |
| Timeout | `timeout` (seconds) | | `60` |
| Retries | `max_retries` | | `2` |

Self-hosters set `RECALL_URL=http://localhost:8000` once and leave the code alone.

Also: `default_headers`, `default_query`, `http_client` (an `httpx.Client`, or `httpx.AsyncClient` for
`AsyncRecall`), and `auto_create=True` (see below).

## Behaviour worth knowing

* **Handles are lazy.** `recall.peer("x")` and `recall.session("x")` never touch the network
  (unless you pass `metadata` / `configuration` / `peers` / `scopes`, which upsert in one call).
* **Reads never write.** `peer.get_metadata()`, `session.refresh()`, `recall.get_metadata()` raise
  `NotFoundError` for things that do not exist instead of creating them, and the workspace is not
  created behind your back. `Recall(auto_create=True)` switches to get-or-create.
* **More of the API.** `peer.delete()` erases a peer and what was learned about it, and
  `recall.create_key(workspace_id=..., peer_id=..., session_id=...)` mints a scoped key
  (`POST /v3/keys`).
* **Retries cannot duplicate writes.** `add_messages`, `upload_file` and `turn` send an
  auto-generated `Idempotency-Key` (pass `idempotency_key=` to choose your own), reused across
  retries, so a reply lost to a timeout never stores a batch twice. Writes the server cannot
  de-duplicate (`conclusions.create`, `session.clone`) are only retried when the request provably
  never reached it (connection failures, 429, 503).
* **Backoff has jitter** and honours `Retry-After` (seconds or HTTP date); the retry policy covers
  timeouts, connection errors and 429/500/502/503/504.
* **Batches are chunked for you**: more than 100 messages / conclusions / scope sessions are sent in
  ordered batches.
* **Errors** carry `status`, `code`, `body` and, when the server sends one, `request_id`. The
  timeout/connection classes are `RecallTimeoutError` / `RecallConnectionError` (the short
  names `TimeoutError` / `ConnectionError` remain importable from `recall_memory`, without
  shadowing the builtins under `import *`).
* **New calls**: `wait_for_idle()` and `add_messages(..., wait=True)`, `usage()`, `session.turn(...)`,
  `recall.webhooks` with `construct_webhook_event(...)` to verify deliveries, `AsyncRecall`, page
  helpers `iter_all(limit=)` / `to_list(limit=)`, context managers (`with Recall() as p`).
* **Peer cards in prompts** are rendered as `- fact` lines (identical to the TypeScript SDK) rather than
  Python's list repr; pass `card_format="python"` to get the old text.

Iterating a page object (`for s in recall.sessions()`) fetches every page;
use `page.get_next_page()`, `iter_all(limit=n)` or `size=` when you want to stay in control.

## Errors

| Status | Class |
|---|---|
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` (the server also uses 401 for authorization failures) |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 422 | `UnprocessableEntityError` |
| 429 | `RateLimitError` (`.retry_after`) |
| 5xx | `ServerError` |
| other | `APIError` |
| client timeout / network | `RecallTimeoutError` / `RecallConnectionError` |

All derive from `RecallError`.

## Development

```bash
uv venv && uv pip install -e '.[dev]'
.venv/bin/pytest                      # unit tests (httpx.MockTransport) + end-to-end tests
.venv/bin/pytest -m "not integration" # unit tests only
.venv/bin/ruff check . && .venv/bin/mypy src
```

The integration tests start the real TypeScript server (`npx tsx packages/server/src/main.ts`, in-memory
database, offline mock LLM, free port) and are skipped when node/npx are not available.
