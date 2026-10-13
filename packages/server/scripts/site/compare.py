"""Comparison charts: Recall next to other memory systems and next to models reading the whole
history themselves. Every figure that is not ours is as its maker or a paper published it, with
its source; none of them is a rerun. Recall's own figures come from EVALS in pages.py.

Chart form: emphasis bars (Recall in amber, everything else in two greys: memory systems, and
models with no memory system). Palette checked with the dataviz validator against the panel
(#171410): normal-vision and colour-blind separation >= 15.7, every fill >= 3:1 against it.
Each row is labelled directly and carries its details in a hover tip; the table view under
each chart holds the same details for keyboards and screen readers, so nothing depends on colour
or on the pointer.
"""

import html
import pathlib
import re


def _codenames():
    """The public names of the hosted service's models, read from CODENAMES in
    src/llm/codenames.ts, the one place they are set (the server shows the same names)."""
    src = (pathlib.Path(__file__).resolve().parents[2] / "src" / "llm" / "codenames.ts").read_text()
    found = dict(re.findall(r'(\w+): \{ id: "[^"]+", name: "([^"]+)" \}', src))
    if not {"answer", "memory", "embedding"} <= found.keys():
        raise SystemExit("src/llm/codenames.ts: CODENAMES not found")
    return found


CODENAMES = _codenames()
ANSWER_MODEL = CODENAMES["answer"]
MEMORY_MODEL = CODENAMES["memory"]
EMBEDDING_MODEL = CODENAMES["embedding"]

# Sources: key -> (label, url). Every figure below was checked against its source on 2026-10-10.
SOURCES = {
    "lme-paper": (
        "LongMemEval paper (Wu et al., ICLR 2025), Figure 3b",
        "https://arxiv.org/abs/2410.10813",
    ),
    "beam-paper": (
        "BEAM paper (Tavakoli et al., ICLR 2026), Table 1",
        "https://arxiv.org/abs/2510.27246",
    ),
    "honcho-blog": (
        "Plastic Labs, Benchmarking Honcho (19 Dec 2025)",
        "https://plasticlabs.ai/blog/research/Benchmarking-Honcho",
    ),
    "honcho-evals": ("Honcho evals page", "https://honcho.dev/evals/"),
    "mem0": ("Mem0 memory-benchmarks (Apr 2026)", "https://github.com/mem0ai/memory-benchmarks"),
    "hindsight": (
        "Hindsight benchmarks (Mar 2026)",
        "https://benchmarks.hindsight.vectorize.io",
    ),
    "mastra": (
        "Mastra, Observational Memory (Feb 2026)",
        "https://mastra.ai/research/observational-memory",
    ),
    "zep": ("Zep research (Sep 2026)", "https://www.getzep.com/research"),
    "supermemory": ("Supermemory research", "https://supermemory.ai/research/longmembench"),
    "cognee": ("Cognee BEAM report", "https://github.com/topoteretes/cognee"),
    "memos": ("MemOS README (Jul 2026)", "https://github.com/MemTensor/MemOS"),
    "recall": ("Recall, this page (Oct 2026)", "https://recallmem.dev/evals"),
}

# Recall's models; how each benchmark was graded is in EVALS ("judge") in pages.py.
OURS = f"answer model {ANSWER_MODEL}, memory built by {MEMORY_MODEL}"

# Other systems, as published. Recall's own rows are added from EVALS in pages.py.
LONGMEMEVAL_OTHERS = {
    "memory": [
        ("Mastra (Observational Memory)", 94.87, "answer model gpt-5-mini, judge gpt-4o; 500 questions; the average of the six question-type scores, not of all questions", "mastra"),
        ("Hindsight", 94.6, "answer model gemini-3.1-pro-preview, judge gemini-2.5-flash-lite; 473 of 500 on Vectorize's own harness", "hindsight"),
        ("Mem0 (platform)", 94.4, "answer model and judge gpt-5, top-200 retrieval; as stated in the README (its per-question results file gives 93.4%, 467 of 500)", "mem0"),
        ("Honcho", 90.4, "answer model Claude Haiku 4.5, ingestion gemini-2.5-flash-lite, judge GPT-4o with the paper's prompt; 500 questions", "honcho-blog"),
        ("Zep", 90.2, "answer model and judge gpt-5.4; 451 of 500 (variant not named)", "zep"),
        ("MemOS", 89.2, "models not disclosed; self-reported, 500 questions", "memos"),
        ("Supermemory", 85.2, "answer model gemini-3-pro, judge gpt-4o", "supermemory"),
    ],
    "raw": [
        ("Claude Haiku 4.5, whole history", 62.6, "the model reading every session itself; run by Plastic Labs, judge GPT-4o", "honcho-blog"),
        ("GPT-4o, whole history", 60.6, "the model reading every session itself, no chain-of-note; judge GPT-4o", "lme-paper"),
        ("Llama 3.1 70B, whole history", 33.4, "the model reading every session itself, no chain-of-note; judge GPT-4o", "lme-paper"),
    ],
}

BEAM100K_OTHERS = {
    "memory": [
        ("Cognee", 0.79, "20 questions of one conversation, mean of 4 rounds; answer model and judge gpt-5; marked preliminary", "cognee"),
        ("Hindsight", 0.734, "400 questions; answer model gemini-3.1-pro-preview, judge gemini-2.5-flash-lite (not BEAM's reference judge)", "hindsight"),
        ("Honcho", 0.630, "400 questions; answer model Claude Haiku 4.5; judge per the BEAM paper, model not named", "honcho-evals"),
    ],
    "raw": [
        ("Claude Haiku 4.5, whole history", 0.533, "run by Plastic Labs", "honcho-evals"),
        ("Qwen2.5-32B, whole history", 0.280, "vanilla long context, the paper's own judge", "beam-paper"),
        ("Gemini 2.0 Flash, whole history", 0.242, "vanilla long context, the paper's own judge", "beam-paper"),
        ("Llama-4-Maverick, whole history", 0.240, "vanilla long context, the paper's own judge", "beam-paper"),
        ("GPT-4.1-nano, whole history", 0.239, "vanilla long context, the paper's own judge", "beam-paper"),
    ],
}

BEAM500K_OTHERS = {
    "memory": [
        ("Hindsight", 0.711, "700 questions; answer model gemini-3.1-pro-preview, judge gemini-2.5-flash-lite (not BEAM's reference judge)", "hindsight"),
        ("Honcho", 0.646, "answer model Claude Haiku 4.5; judge per the BEAM paper, model not named (the blog gives 0.649)", "honcho-evals"),
    ],
    "raw": [
        ("Llama-4-Maverick, whole history", 0.283, "vanilla long context, the paper's own judge", "beam-paper"),
        ("Gemini 2.0 Flash, whole history", 0.257, "vanilla long context, the paper's own judge", "beam-paper"),
        ("Qwen2.5-32B, whole history", 0.200, "vanilla long context, the paper's own judge", "beam-paper"),
        ("GPT-4.1-nano, whole history", 0.194, "vanilla long context, the paper's own judge", "beam-paper"),
    ],
}

# Systems whose published figure was graded the way Recall's is, so the numbers compare directly:
# LongMemEval-S with its GPT-4o judge, BEAM with the BEAM paper's scoring. Everyone else is shown
# too, in a separate group, as published.
SAME_JUDGE = {
    "longmemeval": {"Mastra (Observational Memory)", "Honcho", "Supermemory"},
    "beam": {"Honcho"},
}

SAME_LABEL = {
    "longmemeval": "graded by LongMemEval's GPT-4o judge, as Recall is",
    "beam": "graded with BEAM's own scoring, as Recall is",
}


def memory_groups(name, recall, others, bench, scale):
    """A benchmark's memory systems in two groups: those graded like Recall (Recall among them) and
    the rest, as published with other judges and harnesses."""
    same = [r for r in rows_of(others) if r["name"] in SAME_JUDGE[bench]]
    rest = [r for r in rows_of(others) if r["name"] not in SAME_JUDGE[bench]]
    return [
        {"label": f"{name} · {SAME_LABEL[bench]}", "short": f"{name} · same judge", "kind": "mem",
         **scale, "rows": [recall] + same},
        {"label": f"{name} · other judges and harnesses, as published (not directly comparable)",
         "short": f"{name} · other judge", "kind": "mem", **scale, "rows": rest},
    ]


NOTE = (
    "Other systems' scores are as their makers or the papers published them, each with its own answer "
    "model, judge and harness; none is a rerun, so a few points either way is noise. Recall answers with "
    f"{ANSWER_MODEL} and builds memory with {MEMORY_MODEL}."
)

# Under the LongMemEval-S chart: how Recall's figure there was graded.
LONGMEMEVAL_JUDGE = (
    "Recall's figure is graded by LongMemEval's official judge (gpt-4o-2024-08-06 with the benchmark's own "
    "prompts), the GPT-4o judge that Honcho and most figures here also report, so it compares more directly "
    "than a figure from our own rubric would; the other figures are still self-reported."
)


def rows_of(items):
    return [row(n, v, d, src) for n, v, d, src in items]


def row(name, value, detail, source, us=False):
    return {"name": name, "value": value, "detail": detail, "source": source, "us": us}


KIND = {"us": "Recall", "mem": "other memory systems", "raw": "model alone"}


def chart(spec, compact=False):
    """One comparison chart. `spec`: title, unit ("%" or "score"), scale max, a note, an id for
    the table view, and its rows: either `memory` (memory systems, Recall among them) and `raw`
    (models reading the whole history), or `groups`, each {label, kind, rows} with its own unit
    and max if they differ (`short` names the group in the table view, under `group_head`).
    `more` (href, text) adds a link under the sources."""
    groups = spec.get("groups") or [
        {"label": "Memory systems", "short": "memory system", "kind": "mem", "rows": spec["memory"]},
        {
            "label": "The model alone, reading the whole history",
            "short": "model alone, whole history",
            "kind": "raw",
            "rows": spec.get("raw") or [],
        },
    ]
    groups = [{"unit": spec.get("unit"), "max": spec.get("max"), **g} for g in groups if g["rows"]]

    def fmt(v, g):
        return f"{v:.1f}%" if g["unit"] == "%" else f"{v:.2f}"

    numbered = {}

    def ref(src):
        if src not in numbered:
            numbered[src] = len(numbered) + 1
        return numbered[src]

    def kind(r, g):
        return "us" if r["us"] else g["kind"]

    def rows(g):
        out = []
        for r in sorted(g["rows"], key=lambda r: -r["value"]):
            n = ref(r["source"])
            out.append(
                f'<div class="cmp-row {kind(r, g)}">'
                f'<span class="n">{html.escape(r["name"])}</span>'
                f'<span class="track"><span class="fill" data-w="{100 * r["value"] / g["max"]:.1f}"></span></span>'
                f'<span class="v">{fmt(r["value"], g)}<sup>{n}</sup></span>'
                f'<span class="tip" aria-hidden="true">{html.escape(r["detail"])}</span>'
                f"</div>"
            )
        return "\n".join(out)

    body = "\n".join(
        f'<div class="cmp-group {g["kind"]}"><div class="cmp-label">{html.escape(g["label"])}</div>\n{rows(g)}\n</div>'
        for g in groups
    )
    kinds = [k for k in KIND if any(kind(r, g) == k for g in groups for r in g["rows"])]
    key = " ".join(f'<i class="k {k}"></i>{KIND[k]}' for k in kinds)
    sources = "".join(
        f'<li><span class="sn">{n}</span><a href="{SOURCES[k][1]}" rel="noopener">{html.escape(SOURCES[k][0])}</a></li>'
        for k, n in sorted(numbered.items(), key=lambda kv: kv[1])
    )
    more = f'<a class="cmp-more" href="{spec["more"][0]}">{html.escape(spec["more"][1])}</a>' if spec.get("more") else ""
    table_rows = "".join(
        f"<tr><td>{html.escape(r['name'])}</td><td>{html.escape(g.get('short') or g['label'])}</td>"
        f'<td class="n">{fmt(r["value"], g)}</td><td>{html.escape(r["detail"])}</td>'
        f'<td><a href="{SOURCES[r["source"]][1]}" rel="noopener">{numbered[r["source"]]}</a></td></tr>'
        for g in groups
        for r in sorted(g["rows"], key=lambda r: -r["value"])
    )
    return f"""<figure class="cmp window reveal{' compact' if compact else ''}" id="{spec["id"]}">
<div class="window-bar"><span class="t">{html.escape(spec["title"])}</span><span class="cmp-key">{key}</span></div>
<div class="cmp-body">
{body}
</div>
<figcaption class="cmp-foot"><p>{html.escape(spec["note"])}</p><ol class="cmp-src">{sources}</ol>{more}</figcaption>
<details class="cmp-table"><summary>Show as a table</summary><div class="scroll"><table><thead><tr><th>System</th><th>{spec.get("group_head", "Kind")}</th><th>Score</th><th>Answer model, judge, questions</th><th>Source</th></tr></thead><tbody>{table_rows}</tbody></table></div></details>
</figure>"""


def tabbed_chart(spec):
    """Several comparison charts in one window, one tab each (the home page). `spec`: id, label
    (the title bar's bracketed tag), title, note, `more` (href, text) and `tabs`, each {id, label,
    groups}; a group is {label, short, kind, unit, max, rows} as in chart(). Sources are numbered
    once for the whole window and listed in a collapsed list; each bar keeps its number and its
    details in a hover tip, and the table view under the tabs holds every row."""
    fid = spec["id"]
    numbered = {}

    def ref(src):
        if src not in numbered:
            numbered[src] = len(numbered) + 1
        return numbered[src]

    def fmt(v, g):
        return f"{v:.1f}%" if g["unit"] == "%" else f"{v:.2f}"

    def kind(r, g):
        return "us" if r["us"] else g["kind"]

    def rows(g):
        out = []
        for r in sorted(g["rows"], key=lambda r: -r["value"]):
            out.append(
                f'<div class="cmp-row {kind(r, g)}">'
                f'<span class="n">{html.escape(r["name"])}</span>'
                f'<span class="track"><span class="fill" data-w="{100 * r["value"] / g["max"]:.1f}"></span></span>'
                f'<span class="v">{fmt(r["value"], g)}<sup>{ref(r["source"])}</sup></span>'
                f'<span class="tip" aria-hidden="true">{html.escape(r["detail"])}</span>'
                f"</div>"
            )
        return "\n".join(out)

    tabs = [t for t in spec["tabs"] if any(g["rows"] for g in t["groups"])]
    buttons, panels = [], []
    for i, t in enumerate(tabs):
        on = i == 0
        state = 'aria-selected="true"' if on else 'aria-selected="false" tabindex="-1"'
        buttons.append(
            f'<button type="button" class="tab" role="tab" id="{fid}-tab-{t["id"]}" aria-controls="{fid}-{t["id"]}" '
            f'{state} data-tab="{t["id"]}">{html.escape(t["label"])}</button>'
        )
        groups = "\n".join(
            f'<div class="cmp-group {g["kind"]}"><div class="cmp-label">{html.escape(g["label"])}</div>\n{rows(g)}\n</div>'
            for g in t["groups"]
            if g["rows"]
        )
        panels.append(
            f'<div class="cmp-body" role="tabpanel" id="{fid}-{t["id"]}" aria-labelledby="{fid}-tab-{t["id"]}" '
            f'data-panel="{t["id"]}"{"" if on else " hidden"}>\n{groups}\n</div>'
        )
    all_groups = [g for t in tabs for g in t["groups"] if g["rows"]]
    kinds = [k for k in KIND if any(kind(r, g) == k for g in all_groups for r in g["rows"])]
    key = " ".join(f'<i class="k {k}"></i>{KIND[k]}' for k in kinds)
    sources = "".join(
        f'<li><span class="sn">{n}</span><a href="{SOURCES[k][1]}" rel="noopener">{html.escape(SOURCES[k][0])}</a></li>'
        for k, n in sorted(numbered.items(), key=lambda kv: kv[1])
    )
    table_rows = "".join(
        f"<tr><td>{html.escape(r['name'])}</td><td>{html.escape(g['short'])}</td>"
        f'<td class="n">{fmt(r["value"], g)}</td><td>{html.escape(r["detail"])}</td>'
        f'<td><a href="{SOURCES[r["source"]][1]}" rel="noopener">{numbered[r["source"]]}</a></td></tr>'
        for g in all_groups
        for r in sorted(g["rows"], key=lambda r: -r["value"])
    )
    more = f'<a class="cmp-more" href="{spec["more"][0]}">{html.escape(spec["more"][1])}</a>' if spec.get("more") else ""
    return f"""<figure class="cmp window tabbed reveal" id="{fid}" data-tabbox>
<div class="window-bar"><span class="t"><b>[ {html.escape(spec["label"])} ]</b> {html.escape(spec["title"])}</span><span class="cmp-key">{key}</span></div>
<div class="hscroll"><div class="tabs" role="tablist" aria-label="Benchmark">{"".join(buttons)}</div></div>
{chr(10).join(panels)}
<figcaption class="cmp-foot"><p>{html.escape(spec["note"])}</p>{more}<details class="cmp-sources"><summary>Sources ({len(numbered)})</summary><ol class="cmp-src">{sources}</ol></details></figcaption>
<details class="cmp-table"><summary>Show as a table</summary><div class="scroll"><table><thead><tr><th>System</th><th>Benchmark</th><th>Score</th><th>Answer model, judge, questions</th><th>Source</th></tr></thead><tbody>{table_rows}</tbody></table></div></details>
</figure>"""
