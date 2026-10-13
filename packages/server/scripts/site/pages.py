"""Renders the site's secondary pages into public/: evals.html, dpa.html, security.html, 404.html,
and the comparison pages (compare.html, compare/<slug>.html; content in versus.py).

They share the legal pages' layout (header, table of contents, footer). Benchmark figures live in
EVALS below; each one is the result of a recorded run of the harness in evals/.

Usage (from packages/server): python3 scripts/site/pages.py
"""

import html
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
PUBLIC = HERE.parent.parent / "public"
sys.path.insert(0, str(HERE))
from scene import elephant, runs  # noqa: E402
from sprites import svg  # noqa: E402
import compare  # noqa: E402
import versus  # noqa: E402

LOGO = svg("logo")
# The hosted models' public names (CODENAMES in src/llm/codenames.ts).
LUMEN, LOOM, EMBED = compare.ANSWER_MODEL, compare.MEMORY_MODEL, compare.EMBEDDING_MODEL
UPDATED = "10 October 2026"
# The public source repository. The site's generated pages take it from here (build.py: home.html,
# llms.txt; this file: the security page); public/docs.html, the README and the package metadata
# spell it out, and test/site.test.ts checks that they all agree with this value.
REPO_URL = "https://github.com/recallmem/recall"


def page(slug, title, desc, body, toc=None, scripts=False, canonical=True, updated=True, cls="", version=None, date=None):
    links = "".join(f'<a href="#{a}">{html.escape(t)}</a>' for a, t in (toc or []))
    stamp = f"Last updated: {date or UPDATED}" + (f" · Version {version}" if version else "")
    aside = (
        f"""  <aside class="toc" aria-label="On this page">
    <details class="toc-box" open>
      <summary><b>{html.escape(title)}</b></summary>
      <div class="toc-links">{links}</div>
    </details>
  </aside>
"""
        if toc
        else ""
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{html.escape(title)} — Recall</title>
<meta name="description" content="{html.escape(desc)}" />
<meta name="theme-color" content="#0c0b0a" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
{f'<link rel="canonical" href="https://recallmem.dev/{slug}" />' if canonical else '<meta name="robots" content="noindex" />'}
<link rel="stylesheet" href="/site.css" />
</head>
<body>

<header class="nav scrolled" id="nav">
  <div class="wrap">
    <a class="logo" href="/" aria-label="Recall home">{LOGO}Recall</a>
    <nav class="nav-links" aria-label="Main">
      <a href="/#how">Product</a>
      <a href="/evals">Evals</a>
      <a href="/#pricing">Pricing</a>
      <a href="/docs">Docs</a>
    </nav>
  </div>
</header>

<div class="docs{'' if toc else ' docs-single'}{f' {cls}' if cls else ''}">
{aside}  <article class="prose">
<h1>{html.escape(title)}</h1>
{f'<p class="muted">{stamp}</p>' if updated else ''}
{body}
  </article>
</div>

<footer>
  <div class="wrap">
    <div><a class="logo" href="/">{LOGO}Recall</a></div>
    <nav aria-label="Footer">
      <div><b>Recall</b><a href="/">Home</a><a href="/evals">Evals</a><a href="/docs">Docs</a><a href="/compare">Compare</a><span class="muted">Smidt Beheer · KvK 99124254 · VAT NL004444074B96</span></div>
      <div><b>Legal</b><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/dpa">Data processing</a><a href="/security">Security</a></div>
      <div><b>Help</b><a href="/support">Support</a><a href="mailto:support@recallmem.dev">support@recallmem.dev</a></div>
    </nav>
  </div>
</footer>
{'<script src="/site.js" defer></script>' if scripts else ''}
</body>
</html>
"""


# ------------------------------------------------------------------------------------- evals

# Every figure here is from a recorded run of the harness in evals/ (its results.json): run v3 of 11 October 2026
# on the hosted service at level low, answers by Recall Lumen, on the memory Recall Loom built on 10 October.
# "judge" says how each benchmark was graded; the comparison charts show it next to Recall's figure, and the
# home page shortens it ("official judge", "BEAM's own scoring"). Ability scores are the runs' means to six
# decimals (results.json), so the two-decimal bars round from the measured value; the text gives them to
# three.
EVALS = {
    "beam100k": {
        "name": "BEAM 100K",
        "score": 0.683,
        "ci": (0.653, 0.713),
        "scope": "all 400 questions, 20 conversations of about 125,000 tokens",
        "judge": "BEAM's own evaluation code and judge prompts, graded by gpt-4.1-mini as BEAM's code does; all 400 scored",
        "abilities": [
            ("Preference following", 0.89375),
            ("Instruction following", 0.88125),
            ("Abstention", 0.875),
            ("Contradiction resolution", 0.78125),
            ("Information extraction", 0.779167),
            ("Knowledge updates", 0.725),
            ("Multi-hop reasoning", 0.677649),
            ("Temporal reasoning", 0.525),
            ("Summarization", 0.447426),
            ("Event ordering", 0.242082),
        ],
    },
    "locomo": {"strict": 60.0, "lenient": 79.2, "median_s": 1.6},
    # None hides a card (for a benchmark whose run has not finished).
    "beam500k": {
        "score": 0.670,
        "ci": (0.643, 0.695),
        "scope": "all 700 questions",
        "judge": "BEAM's own evaluation code and judge prompts, graded by gpt-4.1-mini as BEAM's code does; all 700 scored",
        "about": (
            "The same benchmark with conversations five times longer, about 500,000 tokens each. We ran all 35 of "
            f"its conversations, 20 questions each, with the same models ({LUMEN} answers, {LOOM} "
            "builds memory) and the same scoring: BEAM's own evaluation code, graded by gpt-4.1-mini. All 700 "
            "questions were scored. Saying \"I don't know\" when the conversation never answered is the strongest "
            "ability at this length; ordering events and summarizing are again the weakest. The best system in the "
            "BEAM paper scores 0.359 at this length."
        ),
        "abilities": [
            ("Abstention", 0.928571),
            ("Preference following", 0.894048),
            ("Information extraction", 0.77898),
            ("Instruction following", 0.764881),
            ("Contradiction resolution", 0.753571),
            ("Knowledge updates", 0.657143),
            ("Multi-hop reasoning", 0.616905),
            ("Temporal reasoning", 0.538095),
            ("Summarization", 0.521361),
            ("Event ordering", 0.244296),
        ],
    },
    "longmemeval": {
        "score": 91.0,
        "ci": (88.2, 93.2),
        "scope": "all 500 questions",
        "judge": "judge gpt-4o-2024-08-06 with LongMemEval's official prompts",
        "about": (
            "LongMemEval-S gives each question its own chat history of about 50 sessions and 100,000 tokens, then asks "
            "about it: facts the user or the assistant mentioned, preferences, updates, dates, and things that were "
            f"never said. We ran all 500 questions, one workspace each, with {LUMEN} answering and "
            f"{LOOM} building memory. The answers are graded by the benchmark's official judge, gpt-4o-2024-08-06 "
            "with the prompts from LongMemEval's own evaluation script, the judge most published LongMemEval-S "
            "figures report; that makes this figure more comparable than our earlier sample, which our own rubric "
            "graded. Recall answered 455 of 500 correctly (95% interval 88.2-93.2%). Two questions were never asked "
            "because a background memory job failed in each workspace (a provider error), and they count as wrong. "
            "The weakest types are questions that combine several sessions (102 of 121) and preferences (26 of 30); "
            "questions about what the assistant itself said are among the strongest (54 of 56)."
        ),
        "types": [
            # Short names for LongMemEval's types: single-session-user, -preference and -assistant.
            ("Abstention", 29 / 30),
            ("Assistant facts", 54 / 56),
            ("User facts", 61 / 64),
            ("Knowledge updates", 67 / 72),
            ("Temporal reasoning", 116 / 127),
            ("Preferences", 26 / 30),
            ("Multi-session", 102 / 121),
        ],
    },
}

# The BEAM paper's own systems at 100K (Tavakoli et al., arXiv:2510.27246, Table 1).
PAPER_100K = [
    ("LIGHT, Llama-4-Maverick (best in the paper)", 0.358),
    ("LIGHT, GPT-4.1-nano", 0.345),
    ("RAG, Llama-4-Maverick", 0.323),
    ("Long context, GPT-4.1-nano", 0.239),
]


def bar_rows(rows, us=True, fmt="{:.2f}"):
    cls = "bar us solo" if us else "bar solo"
    return "\n".join(
        f'<div class="bench-row"><div class="name">{html.escape(n)}</div><div class="{cls}">'
        f'<div class="track"><div class="fill" data-w="{v * 100:.1f}"></div></div>'
        f'<span class="v">{fmt.format(v)}</span></div></div>'
        for n, v in rows
    )


def recall_row(r):
    """Recall's bar in a comparison chart: its figure with scope, models and how it was graded."""
    return compare.row("Recall", r["score"], f'{r["scope"]}; {compare.OURS}; {r["judge"]}', "recall", us=True)


def comparison_section():
    """Recall next to other memory systems and next to models reading the whole history."""
    lme, b100, b500 = EVALS["longmemeval"], EVALS["beam100k"], EVALS["beam500k"]
    charts = [
        compare.chart(
            {
                "id": "compare-longmemeval",
                "title": "longmemeval-s · accuracy",
                "unit": "%",
                "max": 100,
                "groups": compare.memory_groups("LongMemEval-S", recall_row(lme), compare.LONGMEMEVAL_OTHERS["memory"], "longmemeval", {"unit": "%", "max": 100})
                + [{"label": "The model alone, reading the whole history", "short": "model alone, whole history", "kind": "raw", "rows": compare.rows_of(compare.LONGMEMEVAL_OTHERS["raw"])}],
                "note": compare.NOTE
                + " "
                + compare.LONGMEMEVAL_JUDGE
                + " Newer frontier models reading the whole history score higher still (Gemini 3 Pro reached 92.0% in Plastic Labs' run), at a far higher cost per question.",
            }
        ),
        compare.chart(
            {
                "id": "compare-beam100k",
                "title": "beam 100k · score",
                "unit": "score",
                "max": 1,
                "groups": compare.memory_groups("BEAM 100K", recall_row(b100), compare.BEAM100K_OTHERS["memory"], "beam", {"unit": "score", "max": 1})
                + [{"label": "The model alone, reading the whole history", "short": "model alone, whole history", "kind": "raw", "rows": compare.rows_of(compare.BEAM100K_OTHERS["raw"])}],
                "note": compare.NOTE + " BEAM scores are the mean of ten abilities, 0 to 1.",
            }
        ),
    ]
    if b500:
        charts.append(
            compare.chart(
                {
                    "id": "compare-beam500k",
                    "title": "beam 500k · score",
                    "unit": "score",
                    "max": 1,
                    "groups": compare.memory_groups("BEAM 500K", recall_row(b500), compare.BEAM500K_OTHERS["memory"], "beam", {"unit": "score", "max": 1})
                    + [{"label": "The model alone, reading the whole history", "short": "model alone, whole history", "kind": "raw", "rows": compare.rows_of(compare.BEAM500K_OTHERS["raw"])}],
                    "note": compare.NOTE + " Conversations of about 500,000 tokens each.",
                }
            )
        )
    return f"""
<h2 id="compare">How Recall compares</h2>
<p>Recall next to other memory systems, and next to the model alone reading the whole history with no memory system at all. Each chart first lists the systems graded the same way as Recall (LongMemEval-S's GPT-4o judge; BEAM's own scoring), whose numbers compare directly, then every other published figure, which used other judges, answer models or question sets. Hover a bar, or open the table under a chart, for its answer model, judge and question count; every figure links to where it was published.</p>
{chr(10).join(charts)}
"""


def landing_comparison():
    """For the home page: Recall next to other memory systems on each benchmark, one tab each, and
    a last tab with Recall next to models reading the whole history themselves."""
    lme, b100, b500 = EVALS["longmemeval"], EVALS["beam100k"], EVALS["beam500k"]
    pct = {"unit": "%", "max": 100}
    score = {"unit": "score", "max": 1}

    def mem(name, r, others, scale, bench):
        return compare.memory_groups(name, recall_row(r), others, bench, scale)

    def alone(name, r, others, scale):
        return {"label": f"{name} · the model alone, reading the whole history",
                "short": f"{name} · model alone", "kind": "raw", **scale,
                "rows": [recall_row(r)] + compare.rows_of(others[:2])}

    tabs = [
        {"id": "lme", "label": "LongMemEval-S",
         "groups": mem("LongMemEval-S", lme, compare.LONGMEMEVAL_OTHERS["memory"], pct, "longmemeval")},
        {"id": "b100", "label": "BEAM 100K",
         "groups": mem("BEAM 100K", b100, compare.BEAM100K_OTHERS["memory"], score, "beam")},
    ]
    if b500:
        tabs.append({"id": "b500", "label": "BEAM 500K",
                     "groups": mem("BEAM 500K", b500, compare.BEAM500K_OTHERS["memory"], score, "beam")})
    tabs.append(
        {"id": "alone", "label": "vs the model alone",
         "groups": [alone("LongMemEval-S", lme, compare.LONGMEMEVAL_OTHERS["raw"], pct)]
         + ([alone("BEAM 500K", b500, compare.BEAM500K_OTHERS["raw"], score)] if b500 else [])}
    )
    return compare.tabbed_chart(
        {
            "id": "compare-home",
            "label": "compare",
            "title": "same judge first, then everything published",
            "tabs": tabs,
            "note": "Other systems' figures are as their makers published them, each with its own answer model, "
            "judge and harness; none is a rerun, so a few points either way is noise. Hover a bar or open the "
            f"table for each figure's models and grading. For Recall's figures {LUMEN} answers and {LOOM} "
            "builds memory.",
            "more": ("/evals#compare", "All results and method →"),
        }
    )


def evals_page():
    b = EVALS["beam100k"]
    cards = [
        (f"{b['score']:.2f}", "BEAM 100K", "all 400 questions"),
        (f"{EVALS['locomo']['lenient']:.1f}%", "LoCoMo, lenient judge", "75 held-out questions"),
        (f"{EVALS['locomo']['strict']:.1f}%", "LoCoMo, strict judge", "same 75 questions"),
        ("1", "model call per answer", "at the default level"),
    ]
    if EVALS["beam500k"]:
        r = EVALS["beam500k"]
        cards.insert(1, (f"{r['score']:.2f}", "BEAM 500K", r["scope"]))
    if EVALS["longmemeval"]:
        r = EVALS["longmemeval"]
        cards.insert(2, (f"{r['score']:.1f}%", "LongMemEval-S", r["scope"]))
    card_html = "\n".join(
        f'<div class="bigstat"><div class="n">{n}</div><div class="l">{html.escape(l)}<br /><span class="muted">{html.escape(s)}</span></div></div>'
        for n, l, s in cards
    )
    reference = [("Recall (hosted, level low)", b["score"])] + PAPER_100K
    ref_rows = "\n".join(
        f'<div class="bench-row"><div class="name">{html.escape(n)}</div><div class="bar {"us " if i == 0 else ""}solo">'
        f'<div class="track"><div class="fill" data-w="{v * 100:.1f}"></div></div><span class="v">{v:.2f}</span></div></div>'
        for i, (n, v) in enumerate(reference)
    )
    extra = ""
    if EVALS["beam500k"]:
        r = EVALS["beam500k"]
        extra += f"""
<h2 id="beam500k">BEAM 500K</h2>
<p>{html.escape(r["about"])}</p>
<div class="window reveal"><div class="window-bar"><span class="t">beam 500k · {html.escape(r["scope"])}</span></div>
<div class="bench slim">
{bar_rows(r["abilities"])}
<div class="bench-foot"><span>overall {r["score"]:.3f} · 95% interval {r["ci"][0]:.3f}-{r["ci"][1]:.3f}</span><span>hosted · level low · oct 2026</span></div>
</div></div>"""
    if EVALS["longmemeval"]:
        r = EVALS["longmemeval"]
        extra += f"""
<h2 id="longmemeval">LongMemEval-S</h2>
<p>{html.escape(r["about"])}</p>
<div class="window reveal"><div class="window-bar"><span class="t">longmemeval-s · {html.escape(r["scope"])}</span></div>
<div class="bench slim">
{bar_rows(r["types"], fmt="{:.0%}")}
<div class="bench-foot"><span>overall {r["score"]:.1f}% · 95% interval {r["ci"][0]:.1f}-{r["ci"][1]:.1f}%</span><span>hosted · level low · oct 2026</span></div>
</div></div>"""
    toc = [("summary", "Summary"), ("compare", "How Recall compares"), ("beam", "BEAM 100K"), ("reference", "Against the paper")]
    if EVALS["beam500k"]:
        toc.append(("beam500k", "BEAM 500K"))
    if EVALS["longmemeval"]:
        toc.append(("longmemeval", "LongMemEval-S"))
    toc += [("locomo", "LoCoMo"), ("method", "Method"), ("next", "What's next")]
    body = f"""
<p class="lede">Memory is easy to demo and hard to get right. These are the public benchmarks we run Recall on, with how we ran them, what they cost, and where Recall is still weak.</p>

<h2 id="summary">Summary</h2>
<div class="bigstats wide reveal">
{card_html}
</div>
{comparison_section()}
<h2 id="beam">BEAM 100K</h2>
<p><a href="https://arxiv.org/abs/2510.27246">BEAM</a> (ICLR 2026) asks 400 questions about 20 long conversations across ten abilities, from recalling a detail to ordering events, resolving contradictions and knowing when to say "I don't know". We ran {b["scope"]} against the hosted service, with {LUMEN} answering, {LOOM} building memory, and one model call per answer. The scoring is BEAM's own evaluation code, ported from the <a href="https://github.com/mohammadtavakoli78/BEAM">BEAM repository</a> (commit b2da22e) with its judge prompts unchanged: each rubric item of a question is judged on its own and the question scores their mean, and event ordering scores Kendall tau-b, normalised to 0-1, after the judge matches the answer's items to the reference events. The judge is <code>gpt-4.1-mini</code> at temperature 0, the model BEAM's code uses. All 400 questions were scored.</p>
<div class="window reveal"><div class="window-bar"><span class="t">beam 100k · 400 questions</span></div>
<div class="bench slim">
{bar_rows(b["abilities"])}
<div class="bench-foot"><span>overall {b["score"]:.3f} · 95% interval {b["ci"][0]:.3f}-{b["ci"][1]:.3f}</span><span>hosted · level low · oct 2026</span></div>
</div></div>
<p>Strongest: following a user's preferences and standing instructions, and saying "I don't know" when the conversation never answered. Weakest: putting events in order, where BEAM's metric credits only the answer items its judge matches to a reference event, and summarizing long stretches of conversation; this is where we are working now.</p>

<h2 id="reference">Against the paper's systems</h2>
<p>The BEAM paper reports its own systems at 100K: long-context models, retrieval (RAG) and LIGHT, the paper's memory architecture. Recall's bar is the run above ({LUMEN} answers, {LOOM} builds memory), scored with BEAM's own evaluation code and <code>gpt-4.1-mini</code>, the judge that code uses. The paper's systems answer with other models, and none of their figures is a rerun, so treat the gap as indicative rather than exact.</p>
<div class="window reveal"><div class="window-bar"><span class="t">beam 100k · overall</span></div>
<div class="bench slim">
{ref_rows}
<div class="bench-foot"><span>paper: Table 1, arXiv:2510.27246</span><span>higher is better</span></div>
</div></div>
{extra}
<h2 id="locomo">LoCoMo</h2>
<p>On 75 held-out <a href="https://snap-research.github.io/locomo/">LoCoMo</a> questions (15 per conversation: single-hop, multi-hop, temporal and open-domain), self-hosted with {LOOM} for every task and judged by <code>gpt-4.1</code>, Recall answered {EVALS["locomo"]["strict"]:.1f}% correctly under a strict judge and {EVALS["locomo"]["lenient"]:.1f}% under a lenient one, with a median answer time of {EVALS["locomo"]["median_s"]} s. Published LoCoMo scores are usually higher because of lenient judges and an easier question mix.</p>

<h2 id="method">Method</h2>
<ul>
<li><b>System under test.</b> The hosted service at api.recallmem.dev, exactly as customers use it: messages go in through the API, background reasoning runs, then each question is asked through <code>chat</code> at the default <code>low</code> level. The memory for these runs was built on 10 October 2026 and every question asked on 11 October.</li>
<li><b>Models.</b> Answers by {LUMEN}; memory (reasoning over messages, summaries) built by {LOOM}; embeddings by {EMBED}. These are the names of the models the hosted service runs.</li>
<li><b>Scoring.</b> BEAM is scored with BEAM's own evaluation code (protocol <code>beam-ref-b2da22e</code>: ported from the BEAM repository at commit b2da22e, with its judge prompts verbatim). Each rubric item is judged 0, 0.5 or 1 with BEAM's judge prompt and a question scores the mean of its items; event ordering scores Kendall tau-b normalised as (tau + 1) / 2, after the judge aligns the answer's items with the reference events; an ability is the mean of its questions and the overall score the mean of the ten abilities. The judge is <code>openai/gpt-4.1-mini</code> at temperature 0, the model BEAM's code uses, and every question was scored (400 at 100K, 700 at 500K). LongMemEval-S uses the benchmark's official judge, <code>gpt-4o-2024-08-06</code> with the prompts from its <code>evaluate_qa.py</code>; an answer counts as correct when the judge says yes.</li>
<li><b>Isolation.</b> One workspace per BEAM conversation and per LongMemEval-S question, so no memory is shared between them.</li>
<li><b>Between runs.</b> The answering rules follow general lessons we wrote down after reading earlier runs' mistakes (name conflicting statements with their dates, say "I don't know" when the record is silent, read the conversation log for overview questions). Nothing is specific to a question or an answer.</li>
<li><b>Single runs.</b> Each figure is one run, with no repeats. The 95% intervals are {EVALS["beam100k"]["ci"][0]:.3f}-{EVALS["beam100k"]["ci"][1]:.3f} on BEAM 100K, {EVALS["beam500k"]["ci"][0]:.3f}-{EVALS["beam500k"]["ci"][1]:.3f} on BEAM 500K and {EVALS["longmemeval"]["ci"][0]:.1f}-{EVALS["longmemeval"]["ci"][1]:.1f}% on LongMemEval-S, and wider per ability or type.</li>
</ul>

<h2 id="next">What's next</h2>
<p>Event ordering and summaries on BEAM, and LongMemEval-S questions that span several sessions, are what we are improving now. The 1M split follows. New results land on this page, including the ones that do not flatter us.</p>
"""
    return page(
        "evals",
        "Evals",
        "Recall on public memory benchmarks: BEAM, LoCoMo and LongMemEval, with method and cost.",
        body,
        toc=toc,
        scripts=True,
        updated=True,
        date="11 October 2026",
    )


# --------------------------------------------------------------------------------------- dpa

# Every statement here must be true of the running service; change this page together with the
# service it describes.
DPA_TOC = [
    ("scope", "1. Scope"),
    ("roles", "2. Roles"),
    ("instructions", "3. Instructions"),
    ("confidentiality", "4. Confidentiality"),
    ("security", "5. Security"),
    ("subprocessors", "6. Sub-processors"),
    ("transfers", "7. International transfers"),
    ("authorities", "8. Requests from authorities"),
    ("assistance", "9. Assistance"),
    ("breaches", "10. Personal data breaches"),
    ("deletion", "11. Deletion and return"),
    ("audits", "12. Information and audits"),
    ("customer", "13. Your obligations"),
    ("general", "14. Liability, precedence and law"),
    ("annex-1", "Annex 1: Processing details"),
    ("annex-2", "Annex 2: Security measures"),
    ("annex-3", "Annex 3: Sub-processors"),
]

DPA_BODY = """
<p>This data processing agreement ("DPA") is part of the agreement between you, the customer, and Smidt Beheer, trading as Recall ("Recall", "we", "us"), Binnendelta 11M, 1261 WZ Blaricum, the Netherlands (KvK 99124254), under our <a href="/terms">terms of service</a>. It sets out how we process personal data on your behalf, as Article 28 of the General Data Protection Regulation (GDPR) requires.</p>

<h2 id="scope">1. Scope</h2>
<ul>
<li>This DPA applies automatically to every customer who accepts the terms of service, from the moment we process Customer Personal Data. It is concluded electronically and needs no signature. On request we send a countersigned copy.</li>
<li>"Customer Personal Data" means the personal data in the content you or your software send to Recall (messages, files, names and metadata) and in what Recall derives from it (facts, peer cards, summaries and embeddings). Other terms, such as controller, processor and personal data breach, have the meaning the GDPR gives them.</li>
<li>This DPA does not cover the account, billing and usage data we process as a controller. Our <a href="/privacy">privacy policy</a> covers that data.</li>
</ul>

<h2 id="roles">2. Roles</h2>
<p>You are the controller of Customer Personal Data and we are your processor. If you process the data as a processor for someone else, you confirm that your controller has authorised you to engage us, and we are your sub-processor. Annex 1 describes the processing.</p>

<h2 id="instructions">3. Instructions</h2>
<ul>
<li>We process Customer Personal Data only on your documented instructions, also for transfers to countries outside the European Economic Area (EEA). Your instructions are: the terms of service and this DPA; how you use and configure the service through the API, SDKs, MCP server, plugins and dashboard (for example the webhooks you set up and the MCP clients you connect); and other written instructions we agree to.</li>
<li>If EU or member state law requires us to process the data otherwise, we tell you before we do, unless that law forbids it on important grounds of public interest.</li>
<li>We tell you at once if we believe an instruction infringes the GDPR or other data protection law. We may suspend that processing until you confirm or change the instruction.</li>
<li>We do not use Customer Personal Data for our own purposes: not to train AI models, not to sell, not for advertising and not for profiling. We do keep usage figures that identify nobody, such as token and request counts, for billing, capacity planning and security.</li>
</ul>

<h2 id="confidentiality">4. Confidentiality</h2>
<p>Only people who need access to run, support or secure the service can access Customer Personal Data, and each of them is bound by a duty of confidentiality, by contract or by law. They access it only to give support you ask for, to investigate abuse or a security incident, or to comply with the law.</p>

<h2 id="security">5. Security</h2>
<ul>
<li>We take the technical and organisational measures in Annex 2 to protect Customer Personal Data, as Article 32 of the GDPR requires. We may change them, as long as the overall level of protection does not go down.</li>
<li>You are responsible for keeping your API keys, accounts and own systems secure, and for deciding whether these measures are appropriate for the data you send.</li>
</ul>

<h2 id="subprocessors">6. Sub-processors</h2>
<ul>
<li>You give us general written authorisation to engage sub-processors. The current sub-processors are listed in Annex 3.</li>
<li>We tell you at least 30 days before we add or replace a sub-processor, by email to account owners and by updating Annex 3 on this page.</li>
<li>You may object within those 30 days, on reasonable grounds relating to data protection, by email to <a href="mailto:privacy@recallmem.dev">privacy@recallmem.dev</a>. We will discuss your objection with you. If we cannot resolve it, you may end the agreement before the change takes effect, and we refund your unused purchased credit.</li>
<li>We bind each sub-processor by a written contract with data protection obligations that offer at least the same level of protection as this DPA. We remain fully liable to you for the performance of our sub-processors.</li>
</ul>

<h2 id="transfers">7. International transfers</h2>
<ul>
<li>Customer Personal Data is stored in the EU (Frankfurt). Some sub-processors process it in the United States (see Annex 3).</li>
<li>We transfer Customer Personal Data outside the EEA only with safeguards under Chapter V of the GDPR: an adequacy decision, such as the EU-US Data Privacy Framework for certified recipients, or otherwise the European Commission's Standard Contractual Clauses (Decision (EU) 2021/914), Module 3 (processor to processor), with a transfer impact assessment and additional measures where needed.</li>
</ul>

<h2 id="authorities">8. Requests from authorities</h2>
<p>If an authority asks us for Customer Personal Data, we refer it to you where we can. We disclose data only when a law that binds us obliges us to, after checking the request, and we challenge requests that we consider unlawful. We disclose only what is required and tell you about the request, unless the law forbids that.</p>

<h2 id="assistance">9. Assistance</h2>
<ul>
<li><b>Data subjects' requests.</b> The service lets you find, export, correct and delete Customer Personal Data: export in the dashboard, reads through the API, and deletion of a person (peer), a session, a workspace, a single fact or the whole account. If a data subject contacts us directly, we forward the request to you without undue delay and do not answer it ourselves unless you instruct us to.</li>
<li><b>Security, impact assessments and prior consultation.</b> We help you meet your obligations under Articles 32 to 36 of the GDPR, taking into account the nature of the processing and the information available to us, for example with this DPA and its annexes.</li>
<li>Reasonable assistance is free of charge. If a request takes substantial effort, we agree a reasonable fee with you in advance.</li>
</ul>

<h2 id="breaches">10. Personal data breaches</h2>
<ul>
<li>We notify you without undue delay, and at the latest within 48 hours, after we become aware of a personal data breach affecting Customer Personal Data. We send the notice to the email addresses of the account's owners.</li>
<li>The notice describes, as far as we know at that point: the nature of the breach, the categories and approximate number of data subjects and records concerned, the likely consequences, the measures taken or proposed, and a contact point. Where we do not have all the information at once, we provide it in phases without further undue delay.</li>
<li>We take reasonable steps to contain the breach and limit its consequences, and keep you informed. You decide whether to notify the supervisory authority and the data subjects.</li>
</ul>

<h2 id="deletion">11. Deletion and return</h2>
<ul>
<li>While the agreement runs, you can export Customer Personal Data in the dashboard and delete it at any time.</li>
<li>When you delete your account, we delete all Customer Personal Data from our database at once.</li>
<li>If the agreement ends in another way, you can export your data during at least 30 days from our notice, and we delete all Customer Personal Data within 30 days after the agreement ends.</li>
<li>We keep Customer Personal Data longer only where EU or member state law requires it. We then keep it confidential and process it only for that purpose.</li>
</ul>

<h2 id="audits">12. Information and audits</h2>
<ul>
<li>We make available all information necessary to demonstrate compliance with Article 28 of the GDPR and this DPA: this DPA and its annexes, written answers to reasonable questions, and our sub-processors' audit reports and certifications where they are available to us.</li>
<li>If that information is not enough, or a supervisory authority requires it, you may audit us, including by inspection, yourself or through an independent auditor bound by confidentiality. You give at least 30 days' written notice (less after a personal data breach or when an authority requires it). Audits take place during business hours, at most once every 12 months unless there has been a breach or an authority requires more, without access to other customers' data, and at your own cost.</li>
</ul>

<h2 id="customer">13. Your obligations</h2>
<ul>
<li>You have a lawful basis for all processing you instruct us to carry out, and your instructions comply with the law.</li>
<li>You inform the data subjects as Articles 13 and 14 of the GDPR require, including that their data is processed by an AI memory service and the model providers it uses.</li>
<li>You send special categories of personal data, data about criminal convictions, or data about children only where the law allows it and with the safeguards it requires, including a data protection impact assessment where one is required.</li>
<li>You handle data subjects' requests, using the tools of the service, and delete data you no longer need.</li>
</ul>

<h2 id="general">14. Liability, precedence and law</h2>
<ul>
<li><b>Liability.</b> The liability provisions of the terms of service apply to this DPA. They do not limit either party's liability towards data subjects under Article 82 of the GDPR.</li>
<li><b>Precedence.</b> Where this DPA and the terms of service conflict on the processing of personal data, this DPA prevails. Where Standard Contractual Clauses apply, they prevail over this DPA.</li>
<li><b>Duration.</b> This DPA applies for as long as we process Customer Personal Data.</li>
<li><b>Changes.</b> We change this DPA in the same way as the terms of service, with at least 30 days' notice of material changes.</li>
<li><b>Law and courts.</b> Dutch law governs this DPA. Disputes go to the competent court of the Rechtbank Midden-Nederland, unless Standard Contractual Clauses or mandatory law provide otherwise.</li>
</ul>

<h2 id="annex-1">Annex 1: Processing details</h2>
<table>
<tbody>
<tr><td><b>Subject matter</b></td><td>Providing Recall, memory for AI agents, to you.</td></tr>
<tr><td><b>Nature of the processing</b></td><td>Storing and organising the messages and files you send; analysing them with AI models to extract facts, write summaries and peer cards and compute embeddings; searching and answering questions about them; merging and updating memory in the background; sending data to your systems (API responses, webhooks you set up, MCP clients you connect); exporting and deleting data.</td></tr>
<tr><td><b>Purpose</b></td><td>To provide the service under the terms of service.</td></tr>
<tr><td><b>Duration</b></td><td>For the term of the agreement, and until the data is deleted under section 11.</td></tr>
<tr><td><b>Data subjects</b></td><td>The people whose conversations or data you send, typically your end users, your staff and people mentioned in conversations.</td></tr>
<tr><td><b>Types of personal data</b></td><td>Whatever you send: message and file content, the names and identifiers you choose for peers, sessions and workspaces, metadata, and the facts, peer cards, summaries and embeddings derived from them. Special categories of data only if you send them (section 13).</td></tr>
<tr><td><b>Frequency</b></td><td>Continuous, as you use the service.</td></tr>
<tr><td><b>Retention</b></td><td>Until you delete the data or your account, as described in the <a href="/privacy#retention">privacy policy</a>.</td></tr>
<tr><td><b>Location</b></td><td>Storage and application servers in Frankfurt, Germany (EU). Processing by AI model providers in the United States (Annex 3).</td></tr>
</tbody>
</table>

<h2 id="annex-2">Annex 2: Security measures</h2>
<h3 id="annex-2-access">Access to the service</h3>
<ul>
<li>API keys are random, shown once and stored only as SHA-256 hashes. They can be limited to one workspace, peer or session, and revoked at any time.</li>
<li>The dashboard uses passwordless sign-in links that work once and expire after 15 minutes; only their hash is stored. Session cookies are signed, HttpOnly, Secure, SameSite=Lax and <code>__Host-</code> prefixed. Every form is protected against cross-site request forgery, and pages carry a strict Content Security Policy. Accounts have roles (owner, admin, member).</li>
<li>MCP clients connect with OAuth 2.1 and PKCE (S256), with short-lived access tokens and rotating refresh tokens with reuse detection. Tokens are stored as hashes, and connections can be revoked in the dashboard.</li>
<li>Requests are rate-limited, and repeated failed credentials from one network are blocked for a while.</li>
</ul>
<h3 id="annex-2-separation">Separation</h3>
<ul>
<li>Every request is scoped to one account. Automated tests check that one account cannot read another account's data.</li>
<li>The database provider's public data interface cannot read or write our tables: row-level security is on for every table, with no access rules.</li>
</ul>
<h3 id="annex-2-encryption">Encryption</h3>
<ul>
<li>All public endpoints are served over HTTPS (TLS). Requests to model, email and payment providers use HTTPS.</li>
<li>The database provider encrypts stored data at rest.</li>
</ul>
<h3 id="annex-2-minimisation">Data minimisation</h3>
<ul>
<li>IP addresses are not stored in our database. Where a limit needs one, we store a keyed hash.</li>
<li>Card details go directly to Stripe; we never receive them.</li>
<li>Requests to AI models, for text generation and for embeddings, ask OpenRouter to use only model providers that do not collect the data they process.</li>
<li>Customer Personal Data is not used to train models.</li>
</ul>
<h3 id="annex-2-organisation">Organisation and operations</h3>
<ul>
<li>Access to production systems and data is limited to the people who run Recall, and only where their work requires it.</li>
<li>Error alerts to the operator contain the error's name and message, never request bodies.</li>
<li>An automated check monitors that the service is up.</li>
<li>You can delete a person, a session, a workspace, a single fact or the whole account, and export your data, at any time.</li>
<li>Vulnerabilities can be reported under our <a href="/security">security policy</a>.</li>
</ul>

<h2 id="annex-3">Annex 3: Sub-processors</h2>
<table>
<thead><tr><th>Sub-processor</th><th>What it does</th><th>Location</th></tr></thead>
<tbody>
<tr><td>Vercel Inc.</td><td>Runs the API, dashboard and background work, and serves the website</td><td>Frankfurt, Germany (EU); company in the USA</td></tr>
<tr><td>Neon</td><td>Database: stores all Customer Personal Data</td><td>Frankfurt, Germany (EU); company in the USA</td></tr>
<tr><td>OpenRouter, Inc.</td><td>Passes requests to AI models for text generation and embeddings</td><td>USA</td></tr>
<tr><td>OpenAI (through OpenRouter)</td><td>Runs the AI models that build memory and answer questions, and computes embeddings</td><td>USA</td></tr>
<tr><td>Anthropic, PBC (through OpenRouter)</td><td>Runs the AI models that build memory and answer questions</td><td>USA</td></tr>
</tbody>
</table>
<p>These providers do not receive Customer Personal Data and are therefore not sub-processors; we list them for transparency: Resend (sign-in and account emails to account members), Stripe Payments Europe, Ltd., Ireland (payments, invoices and tax), Cloudflare (DNS) and GitHub (an automated uptime check of our health endpoint).</p>
"""


def dpa_page():
    return page(
        "dpa",
        "Data processing agreement",
        "Recall's data processing agreement (GDPR Article 28) for customers who send personal data.",
        DPA_BODY,
        toc=DPA_TOC,
        version="2.0",
        # Annex 3 describes what the model providers do together, not which model runs which task
        # (the hosted models go by their codenames); a sub-processor change is not a new DPA version
        # (section 6).
        date="11 October 2026",
    )


# ---------------------------------------------------------------------------------- security

SECURITY_TOC = [
    ("report", "Report a vulnerability"),
    ("process", "What happens next"),
    ("safe-harbour", "Safe harbour"),
    ("scope", "Scope"),
    ("protections", "How we protect data"),
    ("location", "Where data is kept"),
    ("contact", "Contact"),
]

SECURITY_BODY = """
<p>This page explains how to report a security vulnerability in Recall and how we protect the data our customers trust us with. No system is perfectly secure, so we welcome reports from anyone who finds a weakness.</p>

<h2 id="report">Report a vulnerability</h2>
<p>Email <a href="mailto:security@recallmem.dev">security@recallmem.dev</a>. Please include:</p>
<ul>
<li>what you found and where: the host, endpoint or page, or the plugin or SDK and its version;</li>
<li>the steps to reproduce it, and a proof of concept if you have one;</li>
<li>the impact you think it has;</li>
<li>how we can reach you, and whether you would like to be credited.</li>
</ul>
<p>Do not include other people's personal data beyond what is needed to show the problem. If you came across such data, tell us what you saw and do not keep it.</p>

<h2 id="process">What happens next</h2>
<ul>
<li>We confirm that we received your report within five working days, investigate it, and keep you informed of our progress.</li>
<li>Please keep the details confidential until the problem is fixed. We aim to fix serious problems within 90 days and agree with you when details can be published.</li>
<li>If you want, we credit you once the problem is fixed. We do not currently pay rewards (no bug bounty).</li>
</ul>

<h2 id="safe-harbour">Safe harbour</h2>
<p>If you research and report in good faith and follow the rules below, we will not take legal action against you and will not report you to the police for that research. If someone else takes action against you over it, we will make clear that you acted in line with this policy.</p>
<ul>
<li>Test only against accounts you own, or have explicit permission to test, and use test data.</li>
<li>Do not access, change, delete or keep other people's data beyond the minimum needed to show the problem. Stop as soon as you see such data, and tell us.</li>
<li>Do not disrupt or degrade the service: no denial of service, no load or volume testing, no spam, and keep automated scanning slow and limited.</li>
<li>No social engineering, phishing or physical attacks, and no attacks on our customers, staff or providers.</li>
<li>Use a vulnerability only as far as needed to show it: no backdoors, no persistence, no moving on to other systems.</li>
<li>Do not ask for payment in exchange for not publishing a vulnerability.</li>
<li>Keep within the law.</li>
</ul>

<h2 id="scope">Scope</h2>
<p><b>In scope:</b> recallmem.dev (the website), app.recallmem.dev (the dashboard), api.recallmem.dev (the API, MCP server and OAuth), and the source code we publish: the server, SDKs and integrations at <a href="@REPO_URL@">@REPO_HOST_PATH@</a>, and the plugins at <a href="https://github.com/RedSix6/recall-plugin">github.com/RedSix6/recall-plugin</a>.</p>
<p><b>Out of scope:</b></p>
<ul>
<li>services run by our providers, such as Stripe's payment pages (pay.recallmem.dev and checkout.stripe.com), Vercel, Neon, OpenRouter, Resend and Cloudflare: please report to them directly;</li>
<li>denial of service, load testing and spam;</li>
<li>reports from automated scanners without a demonstrated impact;</li>
<li>missing security headers, cookie flags or email settings (SPF, DKIM, DMARC) without a demonstrated attack;</li>
<li>clickjacking on pages without sensitive actions, self-XSS, and cross-site request forgery on sign-out or other actions without impact;</li>
<li>software versions or banners without a vulnerability;</li>
<li>attacks that need physical access to a device, a compromised device or browser, or control of the victim's network;</li>
<li>wrong or unexpected AI answers, and prompt injection or jailbreaks that only affect your own account. Prompt injection that reaches another account's data is in scope.</li>
</ul>

<h2 id="protections">How we protect data</h2>
<ul>
<li><b>Encryption.</b> All connections to recallmem.dev, app.recallmem.dev and api.recallmem.dev use HTTPS (TLS). Our database provider encrypts stored data at rest.</li>
<li><b>Keys and tokens.</b> API keys are shown once and stored only as SHA-256 hashes. Sign-in links, dashboard sessions and OAuth tokens are stored as hashes too.</li>
<li><b>Sign-in.</b> The dashboard uses passwordless email links that work once and expire after 15 minutes. MCP clients connect with OAuth 2.1 and PKCE, short-lived access tokens and rotating refresh tokens. You can revoke keys and connections in the dashboard.</li>
<li><b>Dashboard.</b> Signed, HttpOnly, Secure session cookies, protection against cross-site request forgery on every form, a strict Content Security Policy, and no third-party scripts.</li>
<li><b>Separation.</b> Every request is scoped to one account, and automated tests check that accounts cannot read each other's data. The database provider's public data interface is locked.</li>
<li><b>Abuse protection.</b> Rate limits, and temporary blocks after repeated failed credentials.</li>
<li><b>Less data.</b> We do not store IP addresses in our database, card details stay with Stripe, the website uses no analytics or tracking, and we do not use customer content to train AI models.</li>
<li><b>Your controls.</b> Export your data, or delete a person, a session, a workspace or your whole account, at any time.</li>
</ul>

<h2 id="location">Where data is kept</h2>
<p>Our database and the servers that run the API and dashboard are in Frankfurt (EU). To build memory and answer questions, text is processed by AI model providers in the United States, through OpenRouter. Some of our providers are US companies and can be subject to US law. We disclose customer data to authorities only when a law that binds us requires it, we challenge requests we consider unlawful, and we tell the customer unless the law forbids it. The <a href="/dpa">data processing agreement</a> lists our sub-processors and the safeguards for transfers.</p>

<h2 id="contact">Contact</h2>
<p><a href="mailto:security@recallmem.dev">security@recallmem.dev</a>. Machine-readable contact details are in our <a href="/.well-known/security.txt">security.txt</a>.</p>
"""


def security_page():
    return page(
        "security",
        "Security",
        "How to report a vulnerability in Recall, our safe-harbour terms, and how we protect customer data.",
        SECURITY_BODY.replace("@REPO_URL@", REPO_URL).replace(
            "@REPO_HOST_PATH@", REPO_URL.removeprefix("https://")
        ),
        toc=SECURITY_TOC,
        version="1.1",
        date="11 October 2026",
    )


# --------------------------------------------------------------------------------------- 404


def lost_elephant():
    g = dict(elephant(0))
    # A question mark above its head, in amber.
    for x, y in [(31, -6), (32, -7), (33, -7), (34, -6), (34, -5), (33, -4), (32, -3), (32, -1)]:
        g[(x, y)] = "l"
    shifted = {(x, y + 8): c for (x, y), c in g.items()}
    return (
        '<svg class="lost-elephant" viewBox="0 0 46 36" shape-rendering="crispEdges" aria-hidden="true">'
        + runs(shifted)
        + "</svg>"
    )


def not_found_page():
    body = f"""
<div class="lost">
{lost_elephant()}
<p class="lede">This page is not in Recall's memory. It may have moved, or it never existed.</p>
<div class="hero-ctas">
  <a class="btn btn-primary" href="/">Home</a>
  <a class="btn btn-ghost" href="/docs">Docs</a>
  <a class="btn btn-ghost" href="/evals">Evals</a>
</div>
</div>
"""
    return page(
        "404", "404 · Never formed", "Page not found.", body, canonical=False, updated=False, cls="lost-page"
    )


def main():
    out = {
        "evals.html": evals_page(),
        "dpa.html": dpa_page(),
        "security.html": security_page(),
        "404.html": not_found_page(),
        **versus.render(page, EVALS, REPO_URL),
    }
    for name, text in out.items():
        if "{{" in text or "style=" in text:
            raise SystemExit(f"{name}: placeholder or inline style left (the CSP allows no inline style)")
        (PUBLIC / name).parent.mkdir(parents=True, exist_ok=True)
        (PUBLIC / name).write_text(text)
    print("written:", ", ".join(out))


if __name__ == "__main__":
    main()
