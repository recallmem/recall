# Recall evals

A head-to-head memory benchmark that talks plain REST to **any Honcho-v3-compatible base URL**.
The same client code, questions, judge and cost rules measure Honcho and Recall, so the two
reports are directly comparable. It has no dependency on either product's SDK.

Datasets: **LongMemEval-S** (500 questions, ~115k-token histories), **LoCoMo** (10 long
conversations, 1,986 questions) and **BEAM** (100 synthetic conversations of 100K to 10M tokens,
2,000 questions across ten memory abilities, scored the way BEAM's own evaluation code scores them; see
[BEAM](#beam) below).

## Quick start

```bash
pnpm install
pnpm --filter @recall-memory/evals download        # into evals/data/ (gitignored); LongMemEval-S is ~277 MB
pnpm --filter @recall-memory/evals download --dataset beam --beam-split 100k,500k,1m   # BEAM, ~270 MB

# Offline smoke test: starts a throwaway Recall on the mock provider, asks 5 questions, stops it.
# No keys, nothing leaves the machine. Accuracy is meaningless; it proves the pipeline runs.
pnpm --filter @recall-memory/evals smoke
pnpm --filter @recall-memory/evals smoke --dataset longmemeval --limit 5
pnpm --filter @recall-memory/evals smoke --dataset beam --limit 10     # needs the BEAM 100K download

# What would a run cost? Offline, nothing is sent; run this before every paid run.
pnpm --filter @recall-memory/evals estimate --dataset longmemeval --limit 50 --level low
pnpm --filter @recall-memory/evals estimate --dataset beam --beam-split 100k

# A real run. The judge needs a provider key in the environment (any provider the server supports).
export OPENAI_API_KEY=...
pnpm --filter @recall-memory/evals bench \
  --target-url http://localhost:8000 --label recall \
  --dataset longmemeval --limit 50 --level low --concurrency 4 \
  --judge-model openai/gpt-4o-2024-08-06

# The same run against Honcho (cloud or self-hosted):
pnpm --filter @recall-memory/evals bench \
  --target-url https://api.honcho.dev --api-key "$HONCHO_API_KEY" --label honcho \
  --dataset longmemeval --limit 50 --level low --concurrency 4 \
  --judge-model openai/gpt-4o-2024-08-06

# Side-by-side tables:
pnpm --filter @recall-memory/evals compare evals/results/<recall-run>/results.json evals/results/<honcho-run>/results.json
```

`--help` (run the CLI with no arguments) lists every flag. The main ones: `--target-url`,
`--api-key`, `--dataset longmemeval|locomo|beam`, `--beam-split 100k|500k|1m|10m` (beam only),
`--scoring rubric|beam|both`, `--beam-protocol ref|ours` (beam only), `--limit` (questions), `--level
minimal|low|medium|high|max`, `--concurrency` (workspaces in parallel), `--judge-model`, `--out`.
Results go to `evals/results/<date>-<run>-<label>/` (`results.json`, `results.md`, and
`records.jsonl` with one line per question). `--resume` continues an interrupted run.

Results stay on your machine unless you ask otherwise. `--vault` also pushes each run (every 10
minutes and at the end) to a `bench-results` branch of your checkout's `origin`, creating the branch
the first time, so a lost machine does not lose a paid run; once that branch exists, later runs in
clones of the same repository push to it without the flag. `--no-vault` turns that off again.

To ask many times without paying for ingestion again, ingest once with `--keep` and pass that run's id
(`run.json` in its output directory) to later runs as `--reuse <run-id>`: a workspace that already holds
all its messages is asked directly (only the wait for idle remains), a missing one is ingested, one that
holds only part of its messages fails, and `--reuse` never deletes a workspace. The cost estimate leaves
out the ingestion of reused workspaces. Answers then depend on whatever the server stored at ingest time,
so re-ingest after changing anything that runs in the background (extraction, summaries).

For a fair comparison use the **same** `--dataset/--limit/--types/--level/--judge-model/--observe-others`
on both targets; `compare` prints a warning when the settings differ.

## What a run does

For every conversation (LoCoMo, BEAM) or question (LongMemEval):

1. Creates an **isolated workspace** (`ev-<run>-<unit>`), the peers (LongMemEval: `user` observed,
   `assistant` not; LoCoMo: both speakers observed) and one session per original session.
2. **Ingests** the messages in chronological order with their **original timestamps** (`created_at`),
   100 per request, with an `Idempotency-Key` (servers that ignore it are unaffected). Empty turns are
   dropped and over-long messages split.
3. **Waits until background processing is idle** via `GET /queue/status`. With the `wait_ms`
   extension the server holds the request and reports `idle`; on a server without it the harness
   polls the work-unit counts (two idle readings in a row, or counts frozen with nothing in progress).
   `--dream` additionally schedules a dream per observed peer and waits again.
4. **Asks each question** with `POST /peers/{peer}/chat` at `--level` (LongMemEval: through `user`,
   with the question date prepended; LoCoMo: through the speaker the question names), and records the
   answer, client-side latency and any error.
5. **Judges** the answer (below), reads the metered usage, and deletes the workspace (`--keep` to keep it).

`--limit N` picks questions round-robin across question types (deterministically; for BEAM, across the
ten abilities), so even a 5-question sample touches every type and every target sees the same questions. `--order file` takes them in file
order; `--types` and `--offset` narrow the selection.

## BEAM

**BEAM** ("Beyond a Million Tokens: Benchmarking and Enhancing Long-Term Memory in LLMs", Tavakoli, Salemi,
Ye, Abdalla, Zamani and Mitchell, ICLR 2026, [arXiv:2510.27246](https://arxiv.org/abs/2510.27246)) is a set of
100 synthetic user-assistant conversations in four lengths, with 20 validated probing questions each (two per
memory ability), 2,000 in all.

| Split (`--beam-split`) | Hugging Face | Conversations | Questions | Messages (this loader) | Tokens (o200k) |
| --- | --- | --- | --- | --- | --- |
| `100k` (the paper's "128K") | [Mohammadta/BEAM](https://huggingface.co/datasets/Mohammadta/BEAM) split `100K` | 20 | 400 | 5,751 | 2.58M |
| `500k` | same, split `500K` | 35 | 700 | 38,096 | 17.5M |
| `1m` | same, split `1M` | 35 | 700 | 74,671 | 36.0M |
| `10m` | [Mohammadta/BEAM-10M](https://huggingface.co/datasets/Mohammadta/BEAM-10M) | 10 | 200 | 208,895 | 107.6M |

**License.** Both dataset cards say **CC BY-SA 4.0** (the paper itself is CC BY 4.0). The data is downloaded on
demand into `evals/data/` (gitignored) and never redistributed from this repository. The test fixture
(`fixtures/beam-sample.json`) is synthetic, written for these tests, not copied from the dataset.

**Download.** The datasets are parquet on Hugging Face. `download` reads them from the Hugging Face
datasets-server JSON API, one conversation per request (with retries), and stores a JSON array per split with only
the fields the harness uses (`conversation_id`, `conversation_seed`, `chat`, `probing_questions`); the generator's
plans, narratives and the second copy of the user turns are left out. It refuses a conversation the API truncated.
The API serves the latest revision of the dataset (cards last modified 2026-01-30); record the date of your
download with your results. The **10M** split is too large for that API (rows of ~900 MB), so fetch its two parquet
files and convert them with `tools/beam-parquet-to-json.py` (it needs `pyarrow`; the header of the script has the
exact commands). The 10M loader was checked against the real files, but nothing has been run on it: ingesting 108M
tokens costs well over $100 at Recall's measured rates.

**How a conversation becomes a workspace.** One workspace per conversation, peers `user` (observed) and
`assistant` (not observed), exactly like LongMemEval. Every batch of the dataset's chat (one sub-plan of the
conversation) is a session. Sessions start at 09:00 UTC on the batch's `time_anchor` date and turns are 30 seconds
apart, so every message gets a real, strictly increasing `created_at`. In 100K/500K/1M the anchors are already
increasing and distinct; in 10M some anchors go backwards, and such a session is placed just after the previous one.
The trailing plan markers the generator appended to user turns (` ->-> 3,28`) are removed, blank turns are dropped
and turns over 20k characters are split. All of a conversation's selected questions are asked in its workspace,
through `user`, with `The current date is <date of the last message>.` prepended (as for LoCoMo).

**Selection.** `--limit N` round-robins across the ten abilities in file order of the conversations, so `--limit 10`
asks one question per ability of the first conversation and `--limit 20` is that conversation's 20 questions; a
workspace holds all its selected questions, so small samples ingest few conversations. `--per-unit N` takes at most
N (ability-stratified) questions from every conversation to spread a sample over all of them. `--types` takes
ability names: `abstention`, `contradiction-resolution`, `event-ordering`, `information-extraction`,
`instruction-following`, `knowledge-update`, `multi-hop-reasoning` (the dataset key says "multi-session"),
`preference-following`, `summarization`, `temporal-reasoning`.

**Scoring** (`--scoring`; for BEAM the default is `both`, so a run also carries our pass/fail rubric-v1 verdict).
BEAM's metric, as the paper describes it (section 2.4):

* every question has rubric **nuggets**, atomic criteria derived from the ideal answer. The judge gives each nugget
  0 (not satisfied), 0.5 (partly) or 1 (fully); a question scores the mean of its nuggets, an ability the mean over its
  questions, and the **overall score is the unweighted mean of the ten abilities** (the "Average" row of the paper's
  Table 1 is exactly that);
* **event ordering** is the exception: a judge aligns the events in the answer with the reference events and the
  score is **Kendall tau-b** between the two orders.

How the scores are computed is the **BEAM protocol** (`--beam-protocol`, recorded in every report and record):

**`ref` (default, protocol `beam-ref-b2da22e`): BEAM's own evaluation code.** `src/beam/reference.ts` ports
[mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM) at commit b2da22e
(`src/evaluation/compute_metrics.py`, `report_results.py`; MIT, notice kept in the file), with its judge prompts
copied verbatim:

* every rubric item gets its own judge call with BEAM's `unified_llm_judge_base_prompt` (the only message, temperature
  0); the reply is read like BEAM's `parse_json_response` (with a json_repair-like fallback) and the question scores the
  mean of its item scores (`llm_judge_score`), whatever number the judge gave;
* **event ordering** (`event_ordering_score` with LLM alignment): the answer is split at newlines; each line in turn is
  compared, with BEAM's yes/no `llm_equivalence` prompt, to every still-unmatched reference event (the question's
  rubric, in order) and replaced by the first one the judge calls the same. Tau-b (SciPy's `kendalltau`, variant b) is
  taken between the two rankings over the union of events and lines, where an item's rank is its last position and
  anything missing from a list shares rank `len(union) + 1`; the score is `tau_norm` = (tau-b + 1) / 2. BEAM's
  precision, recall, F1 and `final_score` (tau_norm x F1) are stored in `records.jsonl` and shown in the report, but are
  not part of the score, as in BEAM's report;
* an ability is the mean over its questions and the overall score is the mean of the ten abilities;
* BEAM's code judges with `gpt-4.1-mini` at temperature 0: use `--judge-model openai/gpt-4.1-mini` (it honours
  `OPENAI_API_KEY` and `OPENAI_BASE_URL`), and the report says whether the judge matches.

Where it differs from BEAM's code: an undefined tau-b (SciPy's NaN, e.g. a one-event union, which would make BEAM's
ability mean NaN) scores 0 and says so in the record; blank answer lines are not sent to the judge and match nothing
(they still take their place in the ranking), which only saves calls; a judge reply that cannot be read is asked once
more and otherwise leaves the question unscored (BEAM's code would stop); a failed request scores 0; BEAM's code also
computes `llm_judge_score` for event ordering without reporting it, and those calls are skipped here. BEAM's report
averages each conversation first and then the conversations, which is the same number whenever every conversation has
its two questions per ability (a full split), but not for samples (`--limit`, `--per-unit`).

**`ours` (protocol `beam-nuggets-v1`, the earlier default):** our own prompts (`src/beam/prompts.ts`), not BEAM's.

* One call scores all nuggets of a question (JSON, one number per nugget, snapped to 0 / 0.5 / 1).
* A single call lists the events of the answer in order and says which one denotes each reference event (null when
  none does); one answer item matches at most one event.
* We rank the reference events 1..n and the answer's items by position; a reference event the answer leaves out is
  **tied after the last item** and an item that matches no event is **tied after the last event**, so a missing event
  stops contributing ordered pairs (recall) and an invented one that precedes a real event counts as a disorder.
  Perfect order is 1, the exact reverse -1, and undefined (nothing matched) counts as 0. Negative values are **clipped
  to 0**; the raw tau-b is kept in `records.jsonl`.
* Failed requests score 0; a judge reply that cannot be parsed after one retry is left out and reported.

Reports add a **BEAM scoring** table (per ability, `n`, score, bootstrap 95% interval, share of questions with full
credit; overall = mean of the abilities), and `compare` adds a per-ability delta table and warns when the protocols
differ. A `--resume`d run keeps the protocol it started with. Every record stores its rubric, so
`tsx src/cli.ts rejudge <run dir> --beam-protocol ref` re-scores a finished run's stored answers with BEAM's own
scoring (same judge model, nothing asked again): it rewrites `records.jsonl`, `results.json` and `results.md`, keeps
the previous ones as `records.<old protocol>.jsonl` and `results.<old protocol>.json/.md`, logs its progress, and
continues where it stopped if interrupted (`--concurrency N` questions at once, one judge call in flight each). To
try another judge without touching the run, `tsx src/rejudge.ts <results dir> --scoring beam --judge-model
provider/model [--beam-protocol ref|ours]` writes only `rejudge-beam.json`.

Known noise in the data: the questions and answer keys are LLM-generated and only partly hand-checked, and some are
inconsistent (for example a temporal question whose ideal answer says 4 weeks while its rubric says 8). Treat
differences of a few points as noise, and expect the weakest abilities (contradiction resolution, event ordering,
temporal reasoning) to be low for every system.

## The judge

The pass/fail judge described here applies to every dataset (for BEAM it runs next to BEAM's own scoring when
`--scoring both`; the per-ability mapping is: abstention to the abstention rule, knowledge update to the update rule,
temporal reasoning to the temporal rule, instruction and preference following to the preference rule, everything else
standard).

A fixed, versioned rubric (`src/rubric.ts`, printed in every report as `rubric-v1`): the judge gets the
question, the reference answer and the response and must output `VERDICT: yes|no`. Rules by question
type: an equivalent answer is correct and a missing part, a contradiction, a hedge or "I don't know" is
not; temporal questions allow an off-by-one in day/week/month counts; knowledge-update questions want the
latest value stated as current; preference questions need the user's relevant details used, not every
point; **abstention** questions (LongMemEval `_abs`, LoCoMo category 5) are correct only if the system
declines or flags the false premise. Abstention is reported as its own row, and "Answerable only"
excludes it.

The judge is any model the server's `LlmClient` can reach: `--judge-model provider/model` with
`anthropic`, `openai`, `gemini`, `openrouter`, `groq`, `deepseek` or `compat/<model>` (a local
OpenAI-compatible endpoint via `RECALL_COMPAT_BASE_URL`). Use one judge for all targets. The wording is
ours, modelled on the LongMemEval paper's criteria but **not** the official prompt, so numbers are
comparable across targets run through this harness, not with figures vendors publish from their own judges.
`--judge-model mock` selects a crude lexical stand-in for smoke tests; reports label it as not an accuracy
measurement.

## Cost accounting

* **Recall** (`GET /v3/workspaces/{id}/usage`, exact): usage is read once processing is idle
  (everything up to there is *ingest* cost) and again after the questions (the difference is *query*
  cost). Reported: total, per 100 messages ingested, per query, background LLM calls and input tokens per
  100 messages, chat calls and input tokens per query, and any unpriced calls (then the cost is a lower
  bound). The models per task come from the same endpoint.
* **Honcho** (estimate; its API reports no usage): `ingested tokens x $2.00 / 1M + per-query fee by
  level`, with the prices in `src/honcho-pricing.ts` (single source, with its origin in a comment).
* Every report also prices the **same workload at Honcho's list price**, so a Recall report shows
  measured cost next to what the identical ingest and queries would cost on Honcho's managed service.
* The judge's own tokens and cost are reported separately and never counted against the system.

`--cost-model auto` (default) probes the server; force `recall` or `honcho` to override.

### Estimating and capping spend

Before a paid run, `estimate` (above) prints the workload (messages, tokens) and an expected cost; `run` prints the same
estimate for the work still to do before it starts (`--no-estimate` hides it) and `--max-usd N` refuses to start when
the expected cost exceeds N. The rates are those measured on Recall's default models (`src/estimate.ts` documents them; they were measured on LoCoMo, so treat the result
as +/-50% for BEAM and LongMemEval-S until a pilot of a few workspaces confirms it). During a run,
`tools/meter-proxy.mjs` sits between OpenAI and everything that calls it: point the server **and** the harness's
judge at it (`OPENAI_BASE_URL=http://127.0.0.1:8456/v1`) and it logs every call with its tokens and USD (prices in
`tools/openai-prices.json`). With `--budget-usd N` it refuses (HTTP 402, nothing forwarded) once the logged spend
reaches N, so a run cannot cross a hard cap; `curl localhost:8456/__meter` reports the running total and
`python3 -I tools/summarize-tokens.py <log> [since] [until]` breaks a log down by endpoint and model.

```bash
node tools/meter-proxy.mjs 8456 spend.jsonl --budget-usd 100 &
```

## Report

`results.md` / `compare` have the same fixed tables for every target: settings (target, dataset and
selection, level, server models, judge and rubric, cost model), accuracy overall / answerable-only /
per question type with Wilson 95% intervals (errors count as wrong), chat latency p50 / p95 / mean / max,
ingestion volume and time per 100 messages, and cost. Small samples have wide intervals: read them.

## Limits to keep in mind

* The benchmarks are saturated and noisy (an audit found ~6% of LoCoMo's answer key wrong, and judges that
  accept some wrong answers). Treat differences of a few points on small `--limit`s as noise.
* BEAM conversations take far longer to process than LoCoMo or LongMemEval ones, so `--drain-timeout` defaults to
  1200 s (100k), 3600 s (500k), 7200 s (1m) and 28800 s (10m); a workspace that is still busy after that is asked anyway
  and counted under "Not idle in time" in the report.
* Hosted systems may change models between runs; record `--note` with anything the report cannot see.
* Latency is measured by the client, includes the network, and depends on `--concurrency`.
* Recall metering is exact for the work the server did; Honcho's cost is its list price, not its bill.

## Development

```bash
pnpm --filter @recall-memory/evals typecheck
pnpm --filter @recall-memory/evals test      # includes a fake Honcho-compatible server and, for BEAM,
                                             # a fake Hugging Face datasets-server; no network, no keys
```

The BEAM tests (`test/beam*.test.ts`, `test/estimate.test.ts`) use a small synthetic fixture in the dataset's
format (`fixtures/beam-sample.json`): loader mapping and timestamps, the Python-literal parser, selection
determinism, Kendall tau-b and partial-credit aggregation (checked against SciPy's documented example and the paper's
"Average" row), the judge prompts' parsers, the runner and report, and the downloader.

The judge imports `LlmClient` from `@recall-memory/server` (workspace dependency); typecheck and tests
resolve it from the server's sources, so no build is needed first.
