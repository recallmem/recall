# Contributing to Recall

Recall is memory for AI agents: a server that learns what is true about each person from
conversations and answers questions about them with sources, plus the SDKs, plugins and benchmark
harness around it. Bug reports, fixes, integrations and documentation improvements are all
welcome. This guide gets you from a fresh clone to a reviewed pull request;
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains how the server works.

## Before you start

- **Bugs and small fixes:** open a pull request, or an issue if you are not sure how to fix it.
- **Larger changes** (a new endpoint, a change to how memory is built or answered, a new
  integration): open an issue first and describe the problem, so we can agree on the approach
  before you spend time on it.
- **Security problems:** do not open an issue. See [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing of contributions

This repository has two licences (see [LICENSE.md](LICENSE.md)), and a contribution is licensed
under the licence of the directory it changes:

- changes to `packages/server/` are contributed under the
  [Functional Source License 1.1, Apache 2.0 future licence](packages/server/LICENSE.md), like
  the rest of the server, and become Apache 2.0 with the version they ship in;
- changes anywhere else (`packages/sdk/`, `sdks/`, `integrations/`, `examples/`, `evals/`, the
  documentation and the tooling) are contributed under the MIT licence.

### Sign off your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org) instead of a
contributor licence agreement. By adding a `Signed-off-by` line to a commit you certify that you
wrote the change, or otherwise have the right to submit it under the licence above, as the DCO
1.1 sets out. Use your real name and an email address you can be reached at:

```bash
git commit -s -m "Explain why the queue retries failed units"
# adds: Signed-off-by: Your Name <you@example.com>
```

Every commit in a pull request needs the line. Forgot it? `git commit --amend -s` fixes the last
commit, and `git rebase --signoff main` signs off every commit on your branch.

## Set up

You need Node 22, pnpm 10 (`corepack enable` gives you the version `package.json` pins) and, for
the Python SDK, Python 3.10 or newer. Docker is optional.

```bash
pnpm install
pnpm dev            # server with reload on http://localhost:8000
```

That is all: with no configuration the server uses an embedded Postgres in `./.recall` and a
deterministic mock model, so everything except the quality of the answers works offline. Add a
provider key (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or
`OPENROUTER_API_KEY`) to get real answers; `.env.example` documents every setting. With Postgres
and pgvector instead: `docker compose up --build`.

## Layout

| Path | What |
|---|---|
| `packages/server` | The server: REST API, job queue, reasoning, answers, the night shift, MCP, CLI, dashboard, billing |
| `packages/server/public`, `packages/server/scripts/site` | The website and docs (static HTML built by Python scripts) |
| `packages/sdk` | TypeScript SDK, published as `@recall-memory/sdk` |
| `sdks/python` | Python SDK, published as `recall-mem` (import `recall_memory`) |
| `integrations` | Claude Code, Codex, OpenClaw, Hermes and Agent Skill integrations, MCP manifests |
| `examples` | The code of every guide on the website, run by the SDK tests |
| `evals` | Benchmark harness (LongMemEval, BEAM, LoCoMo) |
| `docs` | Architecture and SDK releases |
| `scripts/readme-assets.py` | Draws the README's images in `.github/assets/` |

## Rules that are not negotiable

- **Original work only.** Do not copy code, prompts or text from other projects unless their
  licence allows it and the notice comes along (as `evals/src/beam/reference.ts` does for BEAM's
  MIT code). Write every LLM prompt yourself.
- **No invented numbers.** Every benchmark figure on the website and in the README comes from
  `EVALS` in `packages/server/scripts/site/pages.py`, and every figure there from a full,
  recorded run. `python3 scripts/readme-assets.py` copies them into the README's images and table.
- **No secrets in the repository.** Keys and connection strings live in the environment, never in
  code, tests or examples. Use obvious placeholders (`pk_live_...`, `sk-...`).
- **Privacy first.** Never log message content, API keys or tokens. Log errors through
  `safeErr` (`src/lib/log-safety.ts`), which keeps a failed query's statement but not its values.

## Conventions

- TypeScript strict, ESM, Node 22; imports end in `.js`.
- Request bodies are Zod schemas parsed with `parseBody`/`parseQuery` (`src/http/validate.ts`);
  errors are `ApiError` (`src/lib/errors.ts`), which becomes `{"detail": "..."}`. Every route goes
  through `guard(ctx, policy)` from `src/http/auth.ts`.
- Database: Drizzle or `rows<T>(db, sql\`...\`)` for raw SQL. A schema change is a new
  `src/db/migrations/NNNN_*.sql` mirrored in `src/db/schema.ts`; migrations run on start.
- Background work is enqueued with `enqueue(tx, job)` in the same transaction as the data it
  depends on.
- Model calls only go through `ctx.llm` (`complete`/`structured`/`stream`) with a `task` and
  `workspaceId`, so every call is metered. Never call a provider SDK directly.
- Token counts use `countTokens` (o200k_base) from `src/lib/tokens.ts`.
- Comments explain why, in plain sentences; match the density of the code around them.

## Check your change

```bash
pnpm lint                     # Biome; pnpm format fixes what it can
pnpm typecheck
pnpm test                     # server, SDK and evals suites (in-memory Postgres, mock model)
python3 -m pip install -e "sdks/python[dev]" && python3 -m pytest sdks/python/tests -q
```

Run one server test while you work: `cd packages/server && npx vitest run test/api-peers.test.ts`.
Tests use `createTestServer()` (in-memory PGlite, mock model); set `RECALL_TEST_DATABASE_URL` to run
the suite against a real Postgres with pgvector. CI (`.github/workflows/ci.yml`) runs all of the
above on every push and pull request that changes more than Markdown or `docs/`; the Python
integrations (`.github/workflows/python-integrations.yml`) run when Python code or the guides'
examples change, and weekly.

### The website

`public/home.html` is generated: edit `scripts/site/index.tpl.html`, then run
`python3 scripts/site/build.py` (from `packages/server`). The evals, DPA, security and 404 pages
come from `scripts/site/pages.py`; docs, privacy, terms and support are hand-written HTML in
`public/`. The content security policy allows no inline styles or scripts, so all styling goes in
`public/site.css` and behaviour in `public/site.js`. Preview with
`cd packages/server/public && python3 -m http.server 8765` and open `/home.html`. The legal pages
(terms, privacy, DPA) are changed by the maintainers only.

### The dashboard

Server-rendered with `hono/html` in `src/http/dashboard/` (`views.ts` holds the layout, the
stylesheet and most pages). It works without JavaScript; forms carry a CSRF token.

## Pull requests

- Keep a change to one purpose. Write the commit message as what changed and why, in full
  sentences, and sign it off.
- Add or update tests for new behaviour, and the docs or README when users will notice the change.
- CI must be green before a maintainer reviews and merges. The hosted service is deployed by the
  maintainers after merge.
- SDK releases are tags; see [`docs/RELEASING.md`](docs/RELEASING.md).
