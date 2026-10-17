"""Renders public/home.html (served at "/") from index.tpl.html, inlining the pixel sprites, and
src/http/dashboard/night.ts: the same night sky and elephant scene behind the sign-in pages.
Also writes public/llms.txt from llms.tpl.txt, and puts the analytics tag (analytics.py) on the
hand-written pages (docs, privacy, terms, support).

Every benchmark figure on the home page comes from EVALS in pages.py (the evals page's source) and
every price from the defaults in src/config.ts (prices.py), so neither can go stale here.

Usage (from packages/server): python3 scripts/site/build.py
"""

import html
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
PUBLIC = HERE.parent.parent / "public"
sys.path.insert(0, str(HERE))
from brands import PATHS, brand  # noqa: E402
from art import art_ask, art_learn, art_send, coin, hero_layers, night_room, night_stars, pixel_divider  # noqa: E402
from scene import hero_sky, scene  # noqa: E402
from compare import ANSWER_MODEL, MEMORY_MODEL  # noqa: E402
from pages import EVALS, REPO_URL, landing_comparison  # noqa: E402
from prices import LEVELS, PRICES, usd, usd2  # noqa: E402
from sprites import S, svg  # noqa: E402
from analytics import stamp  # noqa: E402

LME, B100, B500 = EVALS["longmemeval"], EVALS["beam100k"], EVALS["beam500k"]


def first_clause(scope):
    """"all 400 questions, 20 conversations of about 125,000 tokens" -> "all 400 questions"."""
    return scope.split(",")[0].split(";")[0].strip()


def graded(r):
    """How a run was graded, in a few words, from its "judge" note in EVALS ("" if unsure)."""
    judge = r["judge"].lower()
    if "official" in judge:
        return "official judge"
    if "beam's" in judge:
        return "BEAM's own scoring"
    return ""


def caption(r):
    return " · ".join(x for x in (first_clause(r["scope"]), graded(r)) if x)


NUMBERS = {
    "lme": f"{LME['score']:.1f}%",
    "beam100k": f"{B100['score']:.2f}",
    "beam500k": f"{B500['score']:.2f}" if B500 else "",
}

# ------------------------------------------------------------------ prices and a worked example

PRICE = {f"price_{k}": usd(PRICES[k]) for k in LEVELS}
PRICE["price_ingest"] = usd(PRICES["ingest_per_mtok"])
PRICE["price_min_tokens"] = f"{PRICES['ingest_min_tokens']:.0f}"
PRICE["price_store"] = usd(PRICES["store_per_mtok"])
PRICE["signup_credit"] = usd(PRICES["signup_credit"])

# One month of a support assistant, computed from the prices above so it cannot drift. At today's
# defaults ($1.75 per 1M message tokens, a 50-token minimum per message, $0.005 a question at low):
#   500 conversations x 20 messages = 10,000 messages
#   per conversation: 10 short user messages of ~30 tokens, billed at the 50-token minimum (10 x 50 = 500),
#                     plus 10 agent replies of 150 tokens (10 x 150 = 1,500)  -> 2,000 billed tokens
#   learning: 500 x 2,000 = 1,000,000 tokens x $1.75 / 1M = $1.75
#   chat:     500 questions (one per conversation) x $0.005 = $2.50
#   context on every turn: included, $0.00
#   total:    $1.75 + $2.50 = $4.25 a month
EX_CONVERSATIONS, EX_USER_MSGS, EX_USER_TOKENS, EX_AGENT_MSGS, EX_AGENT_TOKENS = 500, 10, 30, 10, 150
_min = int(PRICES["ingest_min_tokens"])
EX_TOKENS_PER_CONV = EX_USER_MSGS * max(EX_USER_TOKENS, _min) + EX_AGENT_MSGS * max(EX_AGENT_TOKENS, _min)
EX_TOKENS = EX_CONVERSATIONS * EX_TOKENS_PER_CONV
EX_LEARN = EX_TOKENS * PRICES["ingest_per_mtok"] / 1_000_000
EX_CHAT = EX_CONVERSATIONS * PRICES["low"]
EX_TOTAL = EX_LEARN + EX_CHAT


def example():
    rows = [
        (
            f"Learning from {EX_CONVERSATIONS * (EX_USER_MSGS + EX_AGENT_MSGS):,} messages",
            f"{EX_CONVERSATIONS} conversations: {EX_USER_MSGS} short user messages each, billed at the "
            f"{_min}-token minimum, and {EX_AGENT_MSGS} replies of {EX_AGENT_TOKENS} tokens. "
            f"{EX_TOKENS:,} tokens × {usd(PRICES['ingest_per_mtok'])} per 1M",
            usd2(EX_LEARN),
        ),
        (
            f"{EX_CONVERSATIONS} questions at low",
            f"one per conversation × {usd(PRICES['low'])}",
            usd2(EX_CHAT),
        ),
        ("Context on every turn", "recent messages, summary and what is known, in each prompt", "included"),
    ]
    body = "".join(
        f'<tr><td>{html.escape(a)}<small>{html.escape(b)}</small></td><td class="n">{c}</td></tr>' for a, b, c in rows
    )
    return (
        f'<table class="ex-table"><tbody>{body}</tbody>'
        f'<tfoot><tr><td>Total for the month</td><td class="n">{usd2(EX_TOTAL)}</td></tr></tfoot></table>'
    )


# ------------------------------------------------------------------------------ benchmark panels


def stats():
    """The benchmark panel under the hero: three full runs and the price of an answer."""
    cells = [
        (NUMBERS["lme"], "LongMemEval-S", "accuracy", caption(LME), "/evals#longmemeval"),
        (NUMBERS["beam100k"], "BEAM 100K", "score, 0 to 1", caption(B100), "/evals#beam"),
    ]
    if B500:
        cells.append((NUMBERS["beam500k"], "BEAM 500K", "score, 0 to 1", caption(B500), "/evals#beam500k"))
    cells.append((PRICE["price_low"], "per answer", "at the default level", "one model call", "#pricing"))
    return "\n".join(
        f'<a class="stat" href="{href}"><div class="n">{n}</div>'
        f'<div class="l"><b>{html.escape(name)}</b> {html.escape(what)}</div>'
        f'<div class="c">{html.escape(caption)}</div></a>'
        for n, name, what, caption, href in cells
    )


def proof_line():
    """The one-line proof under the hero's buttons."""
    items = [(NUMBERS["lme"], "LongMemEval-S")]
    items.append((NUMBERS["beam500k"], "BEAM 500K") if B500 else (NUMBERS["beam100k"], "BEAM 100K"))
    items.append((PRICE["price_low"], "per answer"))
    spans = "".join(f"<span><b>{n}</b> {html.escape(label)}</span>" for n, label in items)
    return f'<a class="proof-line" href="#numbers">{spans}<i aria-hidden="true">→</i></a>'


SCENES = {
    "scene": scene,
    "hero_sky": hero_sky,
    # The animated pixel art (art.py): the hero's horizon, the three steps, the night shift.
    **{f"hero_layer_{k}": (lambda k=k: hero_layers()[k]) for k in ("sky", "far", "near", "front")},
    "night_stars": night_stars,
    "art_send": art_send,
    "art_learn": art_learn,
    "art_ask": art_ask,
    "night_room": night_room,
    "coin": coin,
    **{f"divider_{n}": (lambda n=n: pixel_divider(n)) for n in range(4)},
    "compare": landing_comparison,
    "stats": stats,
    "proof_line": proof_line,
    "example": example,
    # The hosted models' public names (CODENAMES in src/llm/codenames.ts).
    "answer_model": lambda: ANSWER_MODEL,
    "memory_model": lambda: MEMORY_MODEL,
    # The public source repository (REPO_URL in pages.py).
    "repo_url": lambda: REPO_URL,
    **{k: (lambda v=v: v) for k, v in {**NUMBERS, **PRICE}.items()},
}


def fill(name):
    """{{scene}}, {{compare}}, {{stats}}, {{repo_url}}, a number ({{lme}}) or price ({{price_low}}), a model's
    public name, {{brand_<name>}} for a product mark, else a pixel sprite."""
    if name in SCENES:
        return SCENES[name]()
    if name.startswith("brand_") and name[6:] in PATHS:
        return brand(name[6:])
    return svg(name)


def render(tpl):
    out = re.sub(r"\{\{(\w+)\}\}", lambda m: fill(m.group(1)), tpl)
    if "{{" in out:
        raise SystemExit("unknown placeholder")
    return out


(PUBLIC / "home.html").write_text(stamp(render((HERE / "index.tpl.html").read_text())))
print(f"public/home.html written ({len(S)} sprites available)")
# The hand-written pages carry the same analytics tag (analytics.py); pages.py and guides.mjs stamp theirs.
for name in ("docs.html", "privacy.html", "terms.html", "support.html"):
    (PUBLIC / name).write_text(stamp((PUBLIC / name).read_text()))
print("analytics tag stamped on docs, privacy, terms and support")
(PUBLIC / "llms.txt").write_text(render((HERE / "llms.tpl.txt").read_text()))
print("public/llms.txt written")

sky_svg, scene_svg = hero_sky(), scene()
if any("`" in x or "${" in x for x in (sky_svg, scene_svg)):
    raise SystemExit("the scene SVG would break a TypeScript template literal")
night = (
    "// Generated by scripts/site/build.py from scripts/site/scene.py; do not edit.\n"
    'import { html } from "hono/html";\n\n'
    "/** The landing page's night sky: sparse pixel stars over a dithered amber glow. */\n"
    f"export const NIGHT_SKY = html`{sky_svg}`;\n\n"
    "/** The landing page's closing scene: the elephant walking past the data towers. */\n"
    f"export const NIGHT_SCENE = html`{scene_svg}`;\n"
)
(HERE.parent.parent / "src" / "http" / "dashboard" / "night.ts").write_text(night)
print("src/http/dashboard/night.ts written")
