"""The comparison pages: /compare (compare.html) and /compare/<slug> (compare/<slug>.html), written
by pages.py.

Every fact about another product comes from that product's own public pages (or a paper), listed
under SOURCES with the date they were read (CHECKED). A fact that could not be checked there is
left out. Recall's prices come from prices.py (the defaults in src/config.ts) and its benchmark
figures from EVALS in pages.py, so neither can drift from the rest of the site. When a source
changes, change the figure here and the date in CHECKED together.

In the text, [[key]] cites SOURCES[key]: it becomes a numbered link to the page's source list.
"""

import html
import re

from prices import PRICES, usd, usd2

CHECKED = "13 October 2026"

SOURCES = {
    # Honcho (Plastic Labs)
    "honcho-site": ("Honcho home page, pricing section", "https://honcho.dev"),
    "honcho-evals": ("Honcho evals page", "https://honcho.dev/evals/"),
    "honcho-blog": (
        "Plastic Labs, Benchmarking Honcho (19 December 2025)",
        "https://plasticlabs.ai/blog/research/Benchmarking-Honcho",
    ),
    "honcho-github": ("Honcho repository README", "https://github.com/plastic-labs/honcho"),
    "honcho-selfhost": (
        "Honcho docs, self-hosting",
        "https://honcho.dev/docs/v3/contributing/self-hosting",
    ),
    # Mem0
    "mem0-pricing": ("Mem0 pricing page", "https://mem0.ai/pricing"),
    "mem0-github": ("Mem0 repository README", "https://github.com/mem0ai/mem0"),
    "mem0-bench": (
        "Mem0 memory-benchmarks repository (README and results/platform)",
        "https://github.com/mem0ai/memory-benchmarks",
    ),
    "mem0-docs": ("Mem0 Platform overview", "https://docs.mem0.ai/platform/overview"),
    # Zep
    "zep-pricing": ("Zep pricing page", "https://www.getzep.com/pricing"),
    "zep-research": ("Zep research page", "https://www.getzep.com/research"),
    "zep-concepts": ("Zep docs, concepts", "https://help.getzep.com/concepts"),
    "zep-docs": ("Zep docs home", "https://help.getzep.com/"),
    "zep-oss": (
        "Zep, A new direction for Zep's open source strategy (2 April 2025)",
        "https://www.getzep.com/blog/announcing-a-new-direction-for-zeps-open-source-strategy/",
    ),
    # Letta
    "letta-pricing": ("Letta pricing", "https://docs.letta.com/letta-code/pricing"),
    "letta-docs": ("Letta docs home", "https://docs.letta.com/"),
    "letta-memory": ("Letta docs, memory and dreaming", "https://docs.letta.com/configuration/memory"),
    "letta-selfhost": ("Letta docs, self-hosting", "https://docs.letta.com/self-hosting"),
    "letta-sdk": ("Letta Agent SDK quickstart", "https://docs.letta.com/agent-sdk/quickstart"),
    "letta-github": ("Letta repository", "https://github.com/letta-ai/letta"),
    "letta-code": ("Letta Code repository", "https://github.com/letta-ai/letta-code"),
    "letta-blog": (
        "Letta, Benchmarking AI Agent Memory: Is a Filesystem All You Need? (12 August 2025)",
        "https://www.letta.com/blog/benchmarking-ai-agent-memory",
    ),
}

P = {k: usd(v) for k, v in PRICES.items() if k != "ingest_min_tokens"}
MIN_TOKENS = f"{PRICES['ingest_min_tokens']:.0f}"
LEVELS = ["minimal", "low", "medium", "high", "max"]


def recall_rows(evals, repo_url):
    """Recall's side of every "at a glance" table."""
    return {
        "what": "A memory API. It learns what is true about each person from your agent's conversations and answers questions about them, with sources, in one model call.",
        "hosted": "Yes. Data is stored in Frankfurt (EU).",
        "self": f'Yes. The server is source-available under the FSL-1.1-ALv2 (each version becomes Apache 2.0 after two years); the SDKs and integrations are MIT. <a href="/docs#self-host">Self-hosting</a>, <a href="{repo_url}">source</a>.',
        "pricing": f'Pay as you go from prepaid credit: learning {P["ingest_per_mtok"]} per 1M message tokens, questions {P["minimal"]} to {P["max"]} by level. Context, search, storage and the night shift are included. <a href="/#pricing">Pricing</a>.',
        "free": f'{P["signup_credit"]} of credit once, no card needed.',
        "api": 'The v3 memory REST API, which Honcho\'s clients also speak; TypeScript and Python SDKs, an MCP server, and plugins for Claude Code and Codex.',
    }


def recall_bench(evals):
    lme, b100, b500, loc = evals["longmemeval"], evals["beam100k"], evals["beam500k"], evals["locomo"]
    return {
        "lme": f'<a href="/evals#longmemeval">{lme["score"]:.1f}%</a> (455 of 500)',
        "lme_how": "LongMemEval's official judge, gpt-4o-2024-08-06 with the benchmark's own prompts",
        "b100": f'<a href="/evals#beam">{b100["score"]:.3f}</a> (all 400 questions)',
        "b500": f'<a href="/evals#beam500k">{b500["score"]:.3f}</a> (all 700 questions)',
        "beam_how": "BEAM's own evaluation code and judge prompts, graded by gpt-4.1-mini as BEAM's code does",
        "locomo": f'Not run in full. On a <a href="/evals#locomo">75-question sample</a>: {loc["strict"]:.1f}% with a strict judge, {loc["lenient"]:.1f}% with a lenient one',
        "none": "Not run yet",
    }


# ---------------------------------------------------------------------------- the four products


def honcho(evals, repo_url):
    r = recall_bench(evals)
    their_prices = {"ingest": 2.00, "minimal": 0.001, "low": 0.01, "medium": 0.05, "high": 0.10, "max": 0.50}
    tokens, questions = 1_000_000, 500
    ours = tokens * PRICES["ingest_per_mtok"] / 1e6 + questions * PRICES["low"]
    theirs = tokens * their_prices["ingest"] / 1e6 + questions * their_prices["low"]
    level_rows = "".join(
        f'<tr><td>A question at <code>{lv}</code></td><td class="n">{P[lv]}</td><td class="n">{usd(their_prices[lv])}</td></tr>'
        for lv in LEVELS
    )
    return {
        "slug": "honcho",
        "name": "Honcho",
        "maker": "Plastic Labs",
        "pages": "Plastic Labs' own public pages",
        "short": "The same v3 API. Lower list prices on Recall; an AGPL licence and BEAM results up to 10M tokens on Honcho.",
        "site": "https://honcho.dev",
        "desc": "Recall and Honcho side by side: prices, published benchmark results, hosting, licences, API compatibility and when to choose Honcho instead.",
        "intro": "Honcho, by Plastic Labs, is a memory API for agents. Recall implements Honcho's v3 REST API, so the two take the same requests and code moves between them by changing the base URL and the key.",
        "glance": {
            "what": "A memory and reasoning API for agents, by Plastic Labs. Its ingestion price includes reasoning by Neuromancer, Plastic Labs' own model.[[honcho-site]]",
            "hosted": "Yes, at app.honcho.dev.[[honcho-site]]",
            "self": "Yes. Open source under the AGPL-3.0. Needs Postgres with pgvector and at least one LLM provider key; the Docker setup also runs Redis for caching.[[honcho-github]][[honcho-selfhost]]",
            "pricing": "Pay as you go: ingestion $2.00 per 1M tokens, questions $0.001 to $0.50 by level. <code>context()</code> and dreaming are included.[[honcho-site]]",
            "free": "$5 of credit for a new account, and $5 more every month once a card is added. Startups that raised less than $5M can apply for $1,000 of credit.[[honcho-site]]",
            "api": "The v3 REST API, a Python SDK (<code>honcho-ai</code>), a TypeScript SDK (<code>@honcho-ai/sdk</code>) and a CLI.[[honcho-github]]",
        },
        "pricing": f"""
<p>Both price learning by the token and questions by reasoning level, with the same five levels, and both include context. Recall bills each message as at least {MIN_TOKENS} tokens.</p>
<div class="table-scroll"><table>
<thead><tr><th>What you pay for</th><th>Recall</th><th>Honcho[[honcho-site]]</th></tr></thead>
<tbody>
<tr><td>Learning from messages, per 1M tokens</td><td class="n">{P["ingest_per_mtok"]}</td><td class="n">$2.00</td></tr>
{level_rows}
<tr><td>Context for a prompt</td><td>Included</td><td>Included</td></tr>
<tr><td>Background consolidation</td><td>Included (the night shift)</td><td>Included (dreaming)</td></tr>
<tr><td>Free credit</td><td>{P["signup_credit"]} once</td><td>$5, then $5 a month with a card on file</td></tr>
</tbody></table></div>
<p><b>A worked example.</b> A support assistant that learns from {tokens:,} message tokens a month and asks {questions} questions at <code>low</code> pays {usd2(ours)} on Recall ({usd2(tokens * PRICES["ingest_per_mtok"] / 1e6)} + {usd2(questions * PRICES["low"])}) and {usd2(theirs)} on Honcho at its list prices ($2.00 + {usd2(questions * their_prices["low"])}), if Honcho counts the same tokens. Honcho's monthly $5 of credit, with a card on file, covers most of that bill; Recall's {P["signup_credit"]} is given once.</p>""",
        "bench": [
            ("LongMemEval-S", r["lme"], "90.4% (500 questions)[[honcho-blog]]",
             f'Recall: {r["lme_how"]}. Honcho: GPT-4o with the paper\'s prompt; answers by Claude Haiku 4.5, memory built by gemini-2.5-flash-lite.[[honcho-blog]]',
             "The closest of any pair on these pages: the same questions and a GPT-4o judge. The answer models differ, and both figures are self-reported."),
            ("BEAM 100K", r["b100"], "0.630 (400 questions)[[honcho-evals]]",
             f'Recall: {r["beam_how"]}. Honcho: graded per the BEAM paper, judge model not named; answers by Claude Haiku 4.5.[[honcho-evals]]',
             "Roughly: both use BEAM's scoring, but Honcho does not name its judge model."),
            ("BEAM 500K", r["b500"], "0.646[[honcho-evals]]", "As for BEAM 100K. Plastic Labs' blog gives 0.649.[[honcho-blog]]",
             "Roughly, as for BEAM 100K."),
            ("BEAM 1M", r["none"], "0.618[[honcho-evals]]", "As for BEAM 100K.", "Recall has no figure to compare."),
            ("BEAM 10M", r["none"], "0.409[[honcho-evals]]", "As for BEAM 100K.", "Recall has no figure to compare."),
            ("LoCoMo", r["locomo"], "89.9% (1,540 questions)[[honcho-evals]]",
             "Honcho: judged by an LLM, model not named.[[honcho-evals]]", "No: Recall has no full LoCoMo run."),
        ],
        "bench_note": "Honcho also reports 92.6% on LongMemEval-S with Gemini 3 Pro, without the full setup on the page.[[honcho-evals]] Plastic Labs publishes its configuration and raw results on GitHub, linked from its evals page.[[honcho-evals]]",
        "deploy": """
<p><b>Hosted.</b> Both run a hosted service. Recall stores data in Frankfurt (EU); its models run through providers in the United States (see the <a href="/dpa">data processing agreement</a>).</p>
<p><b>Self-hosted.</b> Honcho's server is open source under the AGPL-3.0, an OSI licence.[[honcho-github]] Recall's server is source-available under the Functional Source License: you may run it in production for your own products and change it, but not offer it to others as a competing memory service, and each version becomes Apache 2.0 two years after release. Honcho needs Postgres with pgvector and refuses to start without an LLM provider configured.[[honcho-selfhost]] Recall runs as one process with Postgres and pgvector or an embedded database, and without a provider key it runs on an offline mock model, which is enough to try the API.</p>""",
        "api": """
<p>Recall implements Honcho's v3 REST API: the same paths, bodies, errors, filters and pagination, and Honcho's MCP tool names. We ran Honcho's own published clients, <code>honcho-ai</code> and <code>@honcho-ai/sdk</code> version 2.5.1, against Recall with only the base URL and the API key changed, and a whole app worked; the TypeScript run is a test in Recall's repository that runs on every change. The differences that matter (reads that do not create, different models, bounded peer cards, retried webhooks, self-hosting settings) are in <a href="/guides/switch-from-honcho">Switch from Honcho</a>.</p>""",
        "them": [
            "You want an open-source licence. Honcho's server is AGPL-3.0; Recall's server is source-available and may not be offered to others as a competing memory service.",
            "You need results at very long histories. Honcho publishes BEAM figures at 1M and 10M tokens; Recall has not run those yet.",
            "Your usage is small and steady. Honcho's $5 of credit every month, with a card on file, can cover it; Recall's free credit is given once.",
            "You are a startup that qualifies for Honcho's $1,000 credit programme, or you want Plastic Labs' own reasoning model.",
        ],
        "us": [
            f"You want lower list prices: Recall charges less for learning ({P['ingest_per_mtok']} against $2.00 per 1M tokens) and for a question at every level.",
            "You want answers you can check: chat can return citations, a confidence, and an explicit \"I don't know\", and facts carry the dates they were true.",
            "You want your data stored in the EU.",
            "Either way, trying the other is a change of base URL and key.",
        ],
    }


def mem0(evals, repo_url):
    r = recall_bench(evals)
    return {
        "slug": "mem0",
        "name": "Mem0",
        "maker": "Mem0",
        "pages": "Mem0's own public pages",
        "short": "Monthly plans by request count and an Apache-2.0 library, against pay-per-use and written answers.",
        "site": "https://mem0.ai",
        "desc": "Recall and Mem0 side by side: prices, published benchmark results, hosting, licences, APIs and when to choose Mem0 instead.",
        "intro": "Mem0 is a memory layer for AI apps. It distills conversations into memories and returns the most relevant ones when your agent asks. It comes as a managed platform and as an Apache-2.0 library and server.",
        "glance": {
            "what": "A memory layer that turns conversations into stored memories (facts) and returns the relevant ones on search, scoped by user, agent, app and run.[[mem0-docs]]",
            "hosted": "Yes, the Mem0 Platform at app.mem0.ai.[[mem0-github]]",
            "self": "Yes. The library (<code>pip install mem0ai</code>, <code>npm install mem0ai</code>) and a self-hosted server (Docker Compose) are Apache 2.0.[[mem0-github]] On-prem deployment of the platform is an Enterprise option.[[mem0-pricing]]",
            "pricing": "Monthly plans by request count: Hobby free, Starter $19, Pro $249, Enterprise custom.[[mem0-pricing]]",
            "free": "Hobby: 10,000 add requests and 1,000 retrieval requests a month, no card needed.[[mem0-pricing]]",
            "api": "Mem0's own API: add, search and update memories. Python and TypeScript SDKs and a CLI.[[mem0-github]][[mem0-docs]] Not compatible with Recall's API.",
        },
        "pricing": f"""
<p>The two price different things. Mem0 sells monthly plans with an allowance of add requests (storing a new memory) and retrieval requests (fetching memories for a context).[[mem0-pricing]] Recall has no monthly fee: it charges per message token learned and per question, and context and search are included.</p>
<div class="table-scroll"><table>
<thead><tr><th>Mem0 plan[[mem0-pricing]]</th><th>Price a month</th><th>Add requests a month</th><th>Retrieval requests a month</th></tr></thead>
<tbody>
<tr><td>Hobby</td><td class="n">Free</td><td class="n">10,000</td><td class="n">1,000</td></tr>
<tr><td>Starter</td><td class="n">$19</td><td class="n">50,000</td><td class="n">5,000</td></tr>
<tr><td>Pro (adds graph memory, Dream consolidation, analytics)</td><td class="n">$249</td><td class="n">500,000</td><td class="n">50,000</td></tr>
<tr><td>Enterprise (adds on-prem deployment, SSO, audit logs)</td><td class="n">Custom</td><td class="n">Unlimited</td><td class="n">Unlimited</td></tr>
</tbody></table></div>
<p>Recall: learning {P["ingest_per_mtok"]} per 1M message tokens (a message counts as at least {MIN_TOKENS} tokens), a question {P["minimal"]} at <code>minimal</code>, {P["low"]} at <code>low</code> (the default) and up to {P["max"]} at <code>max</code>; context, search, storage and the night shift included; {P["signup_credit"]} of credit to start. A retrieval in Mem0 returns memories for your own model to read; the closest Recall calls, context and search, are included in the price, and a Recall question also writes the answer. Which costs less depends on how long your messages are and how often you ask.</p>""",
        "bench": [
            ("LongMemEval", r["lme"] + " on LongMemEval-S", "94.4% (472 of 500) in the README; the per-question results file gives 93.4% (467 of 500)[[mem0-bench]]",
             f'Recall: {r["lme_how"]}. Mem0: Mem0\'s managed platform, top-200 retrieval, answers and PASS/FAIL verdicts by gpt-5 in Mem0\'s own harness; the README does not say which LongMemEval variant.[[mem0-bench]]',
             "No: a different judge model and grading prompt, and the variant is not named."),
            ("LoCoMo", r["locomo"], "92.5% (1,425 of 1,540)[[mem0-bench]]", "Mem0's harness, top-200 retrieval.[[mem0-bench]]",
             "No: Recall has no full LoCoMo run."),
            ("BEAM 1M", r["none"], "0.641 average score, 700 questions[[mem0-bench]]", "Mem0's harness, top-200 retrieval.[[mem0-bench]]",
             "Recall has no figure to compare."),
            ("BEAM 10M", r["none"], "0.486 average score, 200 questions[[mem0-bench]]", "Mem0's harness, top-200 retrieval.[[mem0-bench]]",
             "Recall has no figure to compare."),
        ],
        "bench_note": "Mem0's README says these scores reflect its managed platform, which includes optimizations not available in the open-source SDK.[[mem0-github]] Mem0 publishes no BEAM 100K or 500K figure that we found, and Recall has not run BEAM at 1M or 10M, so the two have no BEAM split in common.",
        "deploy": """
<p><b>Hosted.</b> Mem0 runs the Mem0 Platform; on-prem deployment of it is part of Enterprise.[[mem0-pricing]] Recall runs a hosted service with data stored in Frankfurt (EU).</p>
<p><b>Self-hosted.</b> Mem0's library and self-hosted server are Apache 2.0, an OSI licence; you bring the vector database, the LLM and the hosting.[[mem0-github]][[mem0-pricing]] Recall's server is source-available under the Functional Source License (each version Apache 2.0 after two years) and needs only Postgres with pgvector, or an embedded database, plus your model provider keys.</p>""",
        "api": """
<p>Mem0 has its own API: you add memories, search them and update them, scoped by user, agent, app and run.[[mem0-docs]] It is not compatible with Recall's API, so moving means changing your calls. A Mem0 user maps to a Recall peer and a run or conversation to a session. If you kept the conversations, send them to Recall's messages endpoint and Recall learns from them; memories you want kept word for word can go in as conclusions (<code>POST …/conclusions</code>).</p>""",
        "them": [
            "You want an Apache-2.0 library that runs inside your own process, or a fully open-source server.",
            "A free monthly allowance fits your app: Mem0's Hobby plan includes 10,000 add requests and 1,000 retrieval requests a month.",
            "You prefer a fixed monthly price by request count to paying per token and per question.",
            "You want graph memory with entity linking (Pro and up), or you weigh Mem0's higher published LongMemEval figure, measured on its own harness and judge.",
        ],
        "us": [
            "You want Recall to write the answer, with citations, a confidence and an explicit \"I don't know\", in one model call.",
            "You want facts with dates: when a fact stops being true it is closed, and the history stays visible.",
            "You want no monthly fee, data stored in the EU, or the v3 memory API that Honcho's clients also speak.",
        ],
    }


def zep(evals, repo_url):
    r = recall_bench(evals)
    return {
        "slug": "zep",
        "name": "Zep",
        "maker": "Zep",
        "pages": "Zep's own public pages",
        "short": "A temporal knowledge graph with enterprise options, against answers with sources and a self-hostable server.",
        "site": "https://www.getzep.com",
        "desc": "Recall and Zep side by side: prices, published benchmark results, hosting, licences, APIs and when to choose Zep instead.",
        "intro": "Zep builds a temporal knowledge graph for each user from chat messages and business data, and returns a block of relevant context for your agent's prompt. It is a hosted service; its graph engine, Graphiti, is open source.",
        "glance": {
            "what": "A context platform that keeps a temporal knowledge graph per user (and shared graphs), built from messages and business data, and assembles a context block from it.[[zep-concepts]][[zep-docs]]",
            "hosted": "Yes, Zep Cloud. Enterprise adds your own encryption keys (BYOK) or Zep running in your own cloud (BYOC).[[zep-pricing]]",
            "self": "Zep Community Edition is no longer maintained (since April 2025; the repository stays Apache 2.0). Graphiti, the graph framework Zep is built on, is Apache 2.0.[[zep-oss]]",
            "pricing": "Credits per episode sent: free, Flex $125 a month, Flex Plus $375 a month, Enterprise custom. Retrieval and storage use no credits.[[zep-pricing]]",
            "free": "10,000 credits a month, with lower limits and lower processing priority.[[zep-pricing]]",
            "api": "Zep's own API: users, threads, messages and graphs. Python, TypeScript and Go SDKs; a Memory MCP server, with seats by plan.[[zep-concepts]][[zep-docs]][[zep-pricing]] Not compatible with Recall's API.",
        },
        "pricing": f"""
<p>Zep charges credits for what you send: an episode (a chat message, a JSON payload or a block of text) uses 1 credit per 350 bytes or part of it. Retrieval, storage, threads, users and graph storage use none.[[zep-pricing]] Recall charges per message token learned and per question; context, search and storage are included.</p>
<div class="table-scroll"><table>
<thead><tr><th>Zep plan[[zep-pricing]]</th><th>Price a month</th><th>Credits included</th><th>More credits</th></tr></thead>
<tbody>
<tr><td>Free</td><td class="n">$0</td><td class="n">10,000</td><td>No top-up</td></tr>
<tr><td>Flex</td><td class="n">$125</td><td class="n">50,000</td><td>$25 per 10,000</td></tr>
<tr><td>Flex Plus (adds webhooks, analytics, custom extraction instructions)</td><td class="n">$375</td><td class="n">200,000</td><td>$75 per 40,000</td></tr>
<tr><td>Enterprise (lists SOC 2 Type II, a HIPAA BAA, BYOK and BYOC)</td><td class="n">Custom</td><td class="n">Custom</td><td>Negotiated</td></tr>
</tbody></table></div>
<p>Recall: learning {P["ingest_per_mtok"]} per 1M message tokens (a message counts as at least {MIN_TOKENS} tokens), questions from {P["minimal"]} to {P["max"]} by level, no monthly fee, {P["signup_credit"]} of credit to start. Zep returns context for your own model to answer from; the closest Recall calls, context and search, are included in its price.</p>""",
        "bench": [
            ("LongMemEval", r["lme"] + " on LongMemEval-S", "90.2% (451 of 500)[[zep-research]]",
             f'Recall: {r["lme_how"]}. Zep: answers by gpt-5.4 (reasoning medium), judged by gpt-5.4 with chain-of-thought grading; the page does not say which LongMemEval variant.[[zep-research]]',
             "No: a different judge, and the variant is not named."),
            ("LoCoMo", r["locomo"], "94.7% (1,459 of 1,540)[[zep-research]]", "Zep: the same models as its LongMemEval run.[[zep-research]]",
             "No: Recall has no full LoCoMo run."),
        ],
        "bench_note": "Zep's research page also reports retrieval latency and context size per question.[[zep-research]] We found no BEAM result published by Zep.",
        "deploy": """
<p><b>Hosted.</b> Zep Cloud, with options on Enterprise to bring your own encryption keys or to run Zep inside your own cloud account. Zep states it is SOC 2 Type II certified and offers HIPAA BAAs on Enterprise.[[zep-pricing]] Recall runs a hosted service with data stored in Frankfurt (EU).</p>
<p><b>Self-hosted.</b> Zep stopped maintaining Zep Community Edition in April 2025. Graphiti, Zep's temporal knowledge graph framework, is open source under Apache 2.0.[[zep-oss]] Recall's whole server can be self-hosted, source-available under the Functional Source License (each version Apache 2.0 after two years).</p>""",
        "api": """
<p>Zep has its own API: each user has a graph and a thread history; messages added to a thread are ingested into the user's graph; facts are edges, and a fact that a newer one invalidates keeps the time it became invalid.[[zep-concepts]] It is not compatible with Recall's API. A Zep user maps to a Recall peer and a thread to a session. To move, send the conversations you kept to Recall's messages endpoint and Recall learns from them.</p>""",
        "them": [
            "You need a knowledge graph of entities and relationships, with your own entity and edge types, built from business data as well as chat.",
            "You need compliance paperwork or deployment options that Recall does not offer: SOC 2 Type II, a HIPAA BAA, your own encryption keys, or running in your own cloud (Enterprise).",
            "You want to pay per message sent, with retrieval free.",
            "You want a Go SDK.",
        ],
        "us": [
            "You want Recall to write the answer, with citations, a confidence and an explicit \"I don't know\", in one model call.",
            "You want to self-host the whole memory service, not only a graph framework.",
            "You want pay as you go without a monthly plan, data stored in the EU, or the v3 memory API that Honcho's clients also speak.",
        ],
    }


def letta(evals, repo_url):
    r = recall_bench(evals)
    return {
        "slug": "letta",
        "name": "Letta",
        "maker": "Letta",
        "pages": "Letta's own public pages",
        "short": "A platform that runs stateful agents, against a memory service for the agent you already have.",
        "site": "https://www.letta.com",
        "desc": "Recall and Letta side by side: what each is, prices, published benchmark results, hosting, licences and when to choose Letta instead.",
        "intro": "Letta (formerly MemGPT) is a platform for stateful agents: the agent itself runs on Letta and keeps and edits its own memory. Recall is a memory service that an agent you already have calls. They solve different parts of the problem, so this page is mostly about which one fits.",
        "glance": {
            "what": "A platform for building stateful agents that learn from experience. Letta Code is its agent harness.[[letta-docs]][[letta-code]]",
            "hosted": "Yes, Letta Cloud and the Letta API.[[letta-docs]][[letta-pricing]]",
            "self": "Yes. The local runtime or a self-hosted App Server. Apache 2.0.[[letta-selfhost]][[letta-github]][[letta-code]]",
            "pricing": "Free; Pro $20 a month; API Plan $20 a month plus $0.10 per active agent a month, $0.00015 per second of tool execution, and model usage at its token cost; Teams Pro $20 per seat a month; Enterprise custom.[[letta-pricing]]",
            "free": "Free plan with up to 3 stateful agents and limited usage.[[letta-pricing]]",
            "api": "The Letta API and the Letta Agent SDK for TypeScript; Python apps use the App Server's WebSocket protocol.[[letta-sdk]] Not compatible with Recall's API.",
        },
        "pricing": f"""
<p>Letta prices an agent platform: plans, active agents, tool execution time and model usage.[[letta-pricing]] Recall prices a memory service: {P["ingest_per_mtok"]} per 1M message tokens learned and {P["minimal"]} to {P["max"]} per question, with context, search and storage included and no monthly fee. The two do not compare line by line; with Recall your agent and its model run, and are paid for, wherever you run them today.</p>
<div class="table-scroll"><table>
<thead><tr><th>Letta plan[[letta-pricing]]</th><th>Price</th><th>What it includes</th></tr></thead>
<tbody>
<tr><td>Free</td><td class="n">$0</td><td>Up to 3 stateful agents, limited usage, your own API keys</td></tr>
<tr><td>Pro</td><td class="n">$20 a month</td><td>A usage quota, pay-as-you-go overage, up to 20 stateful agents</td></tr>
<tr><td>API Plan</td><td class="n">$20 a month</td><td>Unlimited agents at $0.10 per active agent a month, tool execution at $0.00015 a second, model usage at its token cost</td></tr>
<tr><td>Teams Pro</td><td class="n">$20 a seat a month</td><td>Shared agents and access control</td></tr>
<tr><td>Enterprise</td><td class="n">Custom</td><td>Volume pricing, SSO, dedicated support</td></tr>
</tbody></table></div>""",
        "bench": [
            ("LoCoMo", r["locomo"], "74.0%, an agent with a filesystem, GPT-4o mini[[letta-blog]]",
             "Letta: judge and number of questions not stated in the post.[[letta-blog]]", "No: Recall has no full LoCoMo run."),
            ("LongMemEval-S", r["lme"], "No result found", "—", "Nothing to compare."),
            ("BEAM", f'{r["b100"]} at 100K, {r["b500"]} at 500K', "No result found", "—", "Nothing to compare."),
        ],
        "bench_note": "Letta's post measures how well a simple agent with file tools does on LoCoMo, not Letta's own memory system as a whole.[[letta-blog]]",
        "deploy": """
<p><b>Hosted.</b> Letta Cloud runs your agents. Recall runs only the memory, with data stored in Frankfurt (EU); your agent runs wherever it runs now.</p>
<p><b>Self-hosted.</b> Letta's local runtime and App Server are Apache 2.0; self-hosted agents are not reachable through Letta's web app and are not backed up automatically.[[letta-selfhost]][[letta-github]] Recall's server is source-available under the Functional Source License (each version Apache 2.0 after two years).</p>""",
        "api": """
<p>In Letta you create an agent, then send it messages and stream its replies.[[letta-sdk]] Its memory lives in MemFS, a git-backed memory filesystem the agent inspects and edits, and a background "dreaming" pass consolidates it.[[letta-memory]] Recall has no agent runtime: your agent sends it conversations, reads context for its prompt and asks it questions. Moving from one to the other is a change of architecture, not of settings.</p>""",
        "them": [
            "You want a platform that runs the agent itself, with its state, tools and memory managed for you.",
            "You want an agent that edits its own memory, or you build on Letta Code.",
            "You want an Apache-2.0 runtime you can host.",
        ],
        "us": [
            "You already have an agent, on any framework or model, and want it to remember the people it talks to.",
            "Many people, many conversations: Recall keeps a separate, dated record per person and answers questions about them with sources.",
            "You want memory in Claude, ChatGPT, Cursor, Claude Code or Codex through MCP or a plugin, without moving your agent.",
        ],
    }


PRODUCTS = [honcho, mem0, zep, letta]

GLANCE_ROWS = [
    ("what", "What it is"),
    ("hosted", "Hosted service"),
    ("self", "Self-hosting and licence"),
    ("pricing", "Pricing"),
    ("free", "Free to start"),
    ("api", "API"),
]


# ------------------------------------------------------------------------------------ rendering


def _cite(text, numbered):
    """[[key]] -> a numbered superscript link to the page's source list."""

    def one(m):
        key = m.group(1)
        if key not in SOURCES:
            raise SystemExit(f"versus.py: unknown source {key}")
        if key not in numbered:
            numbered[key] = len(numbered) + 1
        n = numbered[key]
        return f'<sup class="src"><a href="#source-{n}">{n}</a></sup>'

    return re.sub(r"\[\[([a-z0-9-]+)\]\]", one, text)


def _sources(numbered):
    items = "".join(
        f'<li id="source-{n}"><a href="{SOURCES[k][1]}" rel="noopener">{html.escape(SOURCES[k][0])}</a></li>'
        for k, n in sorted(numbered.items(), key=lambda kv: kv[1])
    )
    return f'<ol class="sources">{items}</ol>'


def product_page(page, x, evals, repo_url):
    us = recall_rows(evals, repo_url)
    name = x["name"]
    glance = "".join(
        f"<tr><td><b>{label}</b></td><td>{us[key]}</td><td>{x['glance'][key]}</td></tr>" for key, label in GLANCE_ROWS
    )
    bench = "".join(
        f"<tr><td><b>{b}</b></td><td>{ours}</td><td>{theirs}</td><td>{how}</td><td>{same}</td></tr>"
        for b, ours, theirs, how, same in x["bench"]
    )
    body = f"""
<p class="lede">{x["intro"]}</p>
<p>Every fact about {name} on this page is from {x["pages"]}, linked under <a href="#sources">Sources</a>, as we read them on {CHECKED}. What we could not check there is left out. Tell us at <a href="mailto:support@recallmem.dev">support@recallmem.dev</a> if something has changed.</p>

<h2 id="glance">At a glance</h2>
<div class="table-scroll"><table>
<thead><tr><th></th><th>Recall</th><th>{name}</th></tr></thead>
<tbody>{glance}</tbody></table></div>

<h2 id="pricing">Pricing</h2>
{x["pricing"]}

<h2 id="benchmarks">Published benchmark results</h2>
<p>Each figure is as its maker published it, with its own answer model, judge and harness. None is a rerun, and a different judge alone can move a score by several points, so read the last column before comparing. Recall's runs and method are on <a href="/evals">Evals</a>.</p>
<div class="table-scroll"><table>
<thead><tr><th>Benchmark</th><th>Recall</th><th>{name}</th><th>How each was graded</th><th>Compare directly?</th></tr></thead>
<tbody>{bench}</tbody></table></div>
<p>{x["bench_note"]}</p>

<h2 id="deployment">Hosting and licences</h2>
{x["deploy"]}

<h2 id="api">API</h2>
{x["api"]}

<h2 id="choose-{x["slug"]}">When to choose {name}</h2>
<ul>{"".join(f"<li>{t}</li>" for t in x["them"])}</ul>

<h2 id="choose-recall">When Recall fits better</h2>
<ul>{"".join(f"<li>{t}</li>" for t in x["us"])}</ul>
<p>See <a href="/compare">all comparisons</a>, or try Recall with {P["signup_credit"]} of free credit: <a href="/docs#quickstart">quickstart</a>.</p>
"""
    numbered = {}
    body = _cite(body, numbered)
    body += f"""
<h2 id="sources">Sources</h2>
<p>Read on {CHECKED}.</p>
{_sources(numbered)}
"""
    toc = [
        ("glance", "At a glance"),
        ("pricing", "Pricing"),
        ("benchmarks", "Benchmarks"),
        ("deployment", "Hosting and licences"),
        ("api", "API"),
        (f"choose-{x['slug']}", f"When to choose {name}"),
        ("choose-recall", "When Recall fits better"),
        ("sources", "Sources"),
    ]
    return page(f"compare/{x['slug']}", f"Recall and {name} compared", x["desc"], body, toc=toc, date=CHECKED)


def index_page(page, products, evals, repo_url):
    us = recall_rows(evals, repo_url)
    rows = [("Recall", "", us)] + [(x["name"], f"/compare/{x['slug']}", x["glance"]) for x in products]
    numbered = {}
    table = "".join(
        f'<tr><td><b>{f"<a href={chr(34)}{href}{chr(34)}>{name}</a>" if href else name}</b></td>'
        f"<td>{g['hosted']}</td><td>{g['self']}</td><td>{g['pricing']}</td><td>{g['free']}</td></tr>"
        for name, href, g in rows
    )
    cards = "".join(
        f'<a class="guide-card" href="/compare/{x["slug"]}"><b>Recall and {x["name"]}</b><span>{html.escape(x["short"])}</span></a>'
        for x in products
    )
    body = f"""
<p class="lede">How Recall compares with other memory systems for agents: what each costs, the benchmark results each has published, how each is hosted and licensed, how their APIs relate, and when another one is the better choice.</p>
<div class="guide-cards">{cards}</div>

<h2 id="overview">Side by side</h2>
<div class="table-scroll"><table>
<thead><tr><th></th><th>Hosted service</th><th>Self-hosting and licence</th><th>Pricing</th><th>Free to start</th></tr></thead>
<tbody>{table}</tbody></table></div>

<h2 id="how">How we compare</h2>
<ul>
<li><b>Only what we could check.</b> Every fact about another product is from its own public pages, linked on each comparison, as we read them on {CHECKED}. Prices and plans change; the linked page is what counts.</li>
<li><b>Benchmarks as published.</b> We show each maker's own figures with the answer model, judge and harness they report. None is a rerun. Different judges and question sets move scores by several points, so each table says whether two figures compare directly. Recall's runs and method are on <a href="/evals">Evals</a>, with the charts of every published figure.</li>
<li><b>When to choose them.</b> Each page says when the other product fits better. Recall is not the right tool for every job.</li>
</ul>
<p>Moving from Honcho? Its clients work with Recall after changing the base URL and key: <a href="/guides/switch-from-honcho">Switch from Honcho</a>.</p>
"""
    body = _cite(body, numbered)
    if numbered:
        body += f'<h2 id="sources">Sources</h2><p>Read on {CHECKED}.</p>{_sources(numbered)}'
    return page(
        "compare",
        "Compare Recall",
        "Recall next to Honcho, Mem0, Zep and Letta: pricing, published benchmark results, hosting, licences, APIs and when to choose each.",
        body,
        date=CHECKED,
    )


def render(page, evals, repo_url):
    """{path under public/: html} for the index and one page per product."""
    products = [make(evals, repo_url) for make in PRODUCTS]
    out = {"compare.html": index_page(page, products, evals, repo_url)}
    for x in products:
        out[f"compare/{x['slug']}.html"] = product_page(page, x, evals, repo_url)
    return out
