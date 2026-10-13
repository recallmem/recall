#!/usr/bin/env python3
"""Draws the README's pixel art in .github/assets/ from the website's own material, so the
repository looks like recallmem.dev:

- the elephant and the memory it carries come from packages/server/scripts/site/scene.py (the
  landing page's night scene), the icons from sprites.py, the palette from both;
- text is rasterised from the site's pixel fonts (Silkscreen, Departure Mono, in
  packages/server/public/fonts) into squares, so the SVGs need no font and no script and GitHub
  can show them as images;
- the benchmark figures come from EVALS in packages/server/scripts/site/pages.py, the source of the
  evals page, so the README cannot show a number the site does not. The same figures are written
  into the table in README.md between the "evals" markers.

Each image that has a background comes in a dark and a light version; README.md picks one with
<picture> and prefers-color-scheme. Motion (twinkling stars, the walking elephant) is CSS inside
the SVG and stops under prefers-reduced-motion.

When the checkout has integrations/public-repo/ (the files only the plugin repository,
recallmem/recall-plugin, has), the same art is also drawn for that repository's README into
integrations/public-repo/.github/assets/: the hero with the plugins' title, a card of what a
plugin does in your agent, and the divider.

Needs Python 3.10+ and Pillow. From the repository root:

    python3 scripts/readme-assets.py           # rewrite the images and the README table
    python3 scripts/readme-assets.py --check   # exit 1 if any of them is out of date
"""

from __future__ import annotations

import math
import pathlib
import random
import re
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "packages" / "server" / "scripts" / "site"
FONTS = ROOT / "packages" / "server" / "public" / "fonts"
OUT = ROOT / ".github" / "assets"
README = ROOT / "README.md"
PLUGIN_REPO = ROOT / "integrations" / "public-repo"
PLUGIN_OUT = PLUGIN_REPO / ".github" / "assets"

sys.path.insert(0, str(SITE))
from pages import EVALS  # noqa: E402
from scene import COL as SCENE_COL  # noqa: E402
from scene import elephant, orb  # noqa: E402
from sprites import PAL, S  # noqa: E402

# --------------------------------------------------------------------------------------- palette

# The site's tokens (public/site.css :root) for the dark images, and a paper version of them for
# GitHub's light theme. Amber stays the brand colour in both; text that must be read on paper uses
# the darker ambers.
DARK = {
    "bg": "#0c0b0a",
    "panel": "#171410",
    "panel2": "#1e1a14",
    "line": "#2b261d",
    "line2": "#3d3528",
    "fg": "#f4efe4",
    "muted": "#bdb5a5",
    "faint": "#9a917f",
    "amber": "#ffb000",
    "amber2": "#ffcb4d",
    "mid": "#c98b00",
    "dim": "#7a5300",
    "atext": "#ffb000",
    "cyan": "#5fd7ff",
    "shadow": "#000000",
    "drop": "#000000",
}
LIGHT = {
    "bg": "#fbf7ee",
    "panel": "#fffcf5",
    "panel2": "#f3ead6",
    "line": "#e0d3b6",
    "line2": "#c9b993",
    "fg": "#1d1810",
    "muted": "#4f4637",
    "faint": "#6b604d",
    "amber": "#ffb000",
    "amber2": "#ffcb4d",
    "mid": "#c98b00",
    "dim": "#7a5300",
    "atext": "#8a5a00",
    "cyan": "#0b7fa3",
    "shadow": "#d9cba9",
    "drop": "#3a2a05",
}

# ------------------------------------------------------------------------------------- drawing


def paths(grid, ox=0, oy=0, s=1):
    """A {(x, y): "#rrggbb"} pixel grid as one <path> per colour, rows merged into runs, each
    pixel s x s user units, offset by (ox, oy) user units."""
    rows = {}
    for (x, y), c in grid.items():
        rows.setdefault(y, {})[x] = c
    by_colour = {}
    for y in sorted(rows):
        row = rows[y]
        xs = sorted(row)
        i = 0
        while i < len(xs):
            j = i
            while j + 1 < len(xs) and xs[j + 1] == xs[j] + 1 and row[xs[j + 1]] == row[xs[i]]:
                j += 1
            n = j - i + 1
            by_colour.setdefault(row[xs[i]], []).append(
                f"M{fmt(ox + xs[i] * s)} {fmt(oy + y * s)}h{fmt(n * s)}v{fmt(s)}h-{fmt(n * s)}z"
            )
            i = j + 1
    return "".join(f'<path fill="{c}" d="{"".join(d)}"/>' for c, d in by_colour.items())


def fmt(v):
    return str(int(v)) if float(v).is_integer() else f"{v:.2f}".rstrip("0")


def rect(x, y, w, h, fill, extra=""):
    return f'<rect x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" fill="{fill}"{extra}/>'


def svg(w, h, body, label, style="", static=""):
    """An SVG document; `style` (the motion) applies only when the viewer has not asked for
    reduced motion, `static` always."""
    head = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w * 2}" '
        f'height="{h * 2}" shape-rendering="crispEdges" role="img" aria-label="{label}">'
        f"<title>{label}</title>"
    )
    css = f"<style>{static}@media (prefers-reduced-motion:no-preference){{{style}}}</style>" if style or static else ""
    return head + css + body + "</svg>\n"


# ---------------------------------------------------------------------------------------- text

FACES = {
    "silk": ("silkscreen-400.woff2", 8),  # captions; capitals only, 5 pixels tall
    "silkb": ("silkscreen-700.woff2", 8),  # headings and the wordmark
    "mono": ("departure-mono.woff2", 11),  # figures
}
_cache = {}


def glyphs(text, face):
    """The pixels of `text` in one of the site's pixel fonts at its native size: a set of
    (x, y) with y relative to the baseline (negative is above), and the advance width."""
    key = (text, face)
    if key not in _cache:
        file, size = FACES[face]
        font = ImageFont.truetype(str(FONTS / file), size)
        ascent, descent = font.getmetrics()
        width = int(math.ceil(font.getlength(text))) + 2
        im = Image.new("1", (width, ascent + descent + 2), 0)
        draw = ImageDraw.Draw(im)
        draw.fontmode = "1"
        draw.text((0, ascent), text, font=font, fill=1, anchor="ls")
        px = {(x, y - ascent) for x in range(width) for y in range(im.height) if im.getpixel((x, y))}
        _cache[key] = (px, int(round(font.getlength(text))))
    return _cache[key]


def text(t, x, baseline, colour, face="silk", s=1, anchor="start"):
    """Pixel text with its baseline at `baseline`; anchor "middle" or "end" aligns on x."""
    px, adv = glyphs(t, face)
    if anchor == "middle":
        x -= adv * s / 2
    elif anchor == "end":
        x -= adv * s
    x = round(x)
    return paths({p: colour for p in px}, x, baseline, s)


def width(t, face="silk", s=1):
    return glyphs(t, face)[1] * s


def chunky(t, x, baseline, theme, face="silkb", s=4, anchor="start", shadows=None):
    """Display text the way the site sets its amber headings and figures: flat amber with hard
    shadows, given as (offset in user units, colour) pairs, nearest first. The default is the
    landing page headline's: amber-dim half a pixel out, then the drop shadow a pixel out."""
    px, adv = glyphs(t, face)
    if anchor == "middle":
        x -= adv * s / 2
    x = round(x)
    if shadows is None:
        shadows = [(s // 2, theme["dim"]), (s, theme["drop"])]
    out = []
    for off, colour in reversed(shadows):
        out.append(paths({p: colour for p in px}, x + off, baseline + off, s))
    out.append(paths({p: theme["amber"] for p in px}, x, baseline, s))
    return "".join(out)


def kicker(t, cx, baseline, theme, blink_cls="cur"):
    """The site's kicker: a blinking amber square and amber mono text in a faint amber box."""
    tw = width(t, "mono")
    w = tw + 23
    x = round(cx - w / 2)
    top = baseline - 13
    return (
        f'<rect x="{x}" y="{top}" width="{w}" height="18" fill="{theme["amber"]}" fill-opacity=".07"/>'
        f'<rect x="{x}.5" y="{top}.5" width="{w - 1}" height="17" fill="none" stroke="{theme["amber"]}" stroke-opacity=".5"/>'
        f'<g class="{blink_cls}">{rect(x + 7, top + 6, 5, 5, theme["amber"])}</g>'
        + text(t, x + 17, baseline, theme["atext"], "mono")
    )


# ------------------------------------------------------------------------------------- sprites


def sprite(name, colours=None):
    """A sprite from sprites.py as a pixel grid of colours."""
    pal = dict(PAL, **(colours or {}))
    return {(x, y): pal[c] for y, row in enumerate(S[name]) for x, c in enumerate(row) if c != "."}


def elephant_grid(frame, outline=None):
    """The night scene's elephant (one walk frame) carrying its memory, as colours; with
    `outline`, a one-pixel border so it reads on a light background."""
    g = {p: SCENE_COL[c] for p, c in elephant(frame).items()}
    g.update({(x + 36, y + 14): SCENE_COL[c] for (x, y), c in orb().items() if c != "ch"})
    if outline:
        edge = {
            (x + dx, y + dy)
            for x, y in g
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            if (x + dx, y + dy) not in g
        }
        # The orb floats free of the trunk: keep its outline off the gap between them.
        g.update({p: outline for p in edge})
    return g


def outlined(grid, colour):
    edge = {
        (x + dx, y + dy)
        for x, y in grid
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
        if (x + dx, y + dy) not in grid
    }
    return {**{p: colour for p in edge}, **grid}


# ---------------------------------------------------------------------------------------- hero

HERO_W, HERO_H, GROUND = 320, 124, 104
# The wordmark and tagline sit in this box: no stars, clouds or rising memories in it.
TEXT_BOX = (54, 8, 266, 66)

HERO_CSS = (
    ".tw{animation:tw 3.6s steps(1) infinite}.tw1{animation-delay:-1.2s;animation-duration:4.4s}"
    ".tw2{animation-delay:-2.5s;animation-duration:2.8s}@keyframes tw{0%,100%{opacity:1}50%{opacity:.25}}"
    ".blink{animation:tw 2.2s steps(1) infinite}.beacon{animation:bc 1.6s steps(1) infinite}"
    "@keyframes bc{0%,100%{opacity:1}30%{opacity:0}}"
    ".walker{animation:walk 42s linear -15s infinite}"
    "@keyframes walk{from{transform:translateX(-190px)}to{transform:translateX(190px)}}"
    ".ef0{animation:f0 .7s steps(1) infinite}.ef1{animation:f1 .7s steps(1) infinite}"
    "@keyframes f0{0%{opacity:1}50%{opacity:0}}@keyframes f1{0%{opacity:0}50%{opacity:1}}"
    ".cur{animation:tw 1.1s steps(1) infinite}"
    ".mem{animation:rise 9s steps(30) infinite}.mem1{animation-duration:11s;animation-delay:-3s}"
    ".mem2{animation-duration:8s;animation-delay:-6s}.mem3{animation-duration:12s;animation-delay:-1s}"
    ".mem4{animation-duration:10s;animation-delay:-8s}.mem5{animation-duration:7s;animation-delay:-4s}"
    "@keyframes rise{0%{transform:translateY(0);opacity:0}12%{opacity:1}80%{opacity:.7}"
    "100%{transform:translateY(-46px);opacity:0}}"
)

NIGHT = {
    "sky": "#0c0b0a",
    "h1": "#1a140a",
    "h2": "#241a09",
    "mt": "#120f0a",
    "t0": "#16120b",
    "t1": "#1f1910",
    "t2": "#2b2316",
    "win": "#7a5300",
    "lit": "#ffb000",
    "blink": ("#ffb000", "#5fd7ff"),
    "beacon": "#ff5f56",
    "gr": "#0e0c08",
    "seam": "#7a5300",
    "speck": ("#7a5300", "#1f1910", "#2b2316"),
    "mem": ("#5fd7ff", "#ffb000", "#ffcb4d", "#5fd7ff"),
}
DAY = {
    "sky": "#fbf7ee",
    "h1": "#f2e6cb",
    "h2": "#ecdcb6",
    "mt": "#ece0c6",
    "t0": "#e4d8bd",
    "t1": "#d9caa9",
    "t2": "#c9b792",
    "win": "#a88a52",
    "lit": "#ffb000",
    "blink": ("#ffb000", "#0b7fa3"),
    "beacon": "#d2402f",
    "gr": "#e6d9bb",
    "seam": "#7a5300",
    "speck": ("#c9b792", "#d9caa9", "#a88a52"),
    "mem": ("#0b7fa3", "#ffb000", "#c98b00", "#0b7fa3"),
}


def in_text_box(x, y=None):
    x0, y0, x1, y1 = TEXT_BOX
    return x0 <= x <= x1 and (y is None or y0 <= y <= y1)


def recall_words(theme):
    """The main README's hero text: the wordmark, and the tagline as the site's kicker."""
    return chunky("RECALL", HERO_W / 2, 38, theme, s=4, anchor="middle") + kicker(
        "Memory for AI agents", HERO_W / 2, 60, theme
    )


PLUGIN_AGENTS = ["CLAUDE CODE", "CODEX", "OPENCLAW", "HERMES"]


def plugin_words(theme):
    """The plugin repository's hero text: the wordmark a little higher, "plugins" in the kicker,
    and the agents they are for in a line of capitals with amber dots between them."""
    cx = HERO_W / 2
    out = chunky("RECALL", cx, 30, theme, s=4, anchor="middle")
    out += kicker("Memory plugins for agents", cx, 51, theme)
    sep, baseline = " · ", 65
    x = round(cx - (sum(width(n) for n in PLUGIN_AGENTS) + width(sep) * (len(PLUGIN_AGENTS) - 1)) / 2)
    for i, name in enumerate(PLUGIN_AGENTS):
        if i:
            out += text(sep, x, baseline, theme["atext"])
            x += width(sep)
        out += text(name, x, baseline, theme["fg"])
        x += width(name)
    return out


def hero(theme, night, words=recall_words, label="Recall: memory for AI agents"):
    """The landing page's scene: data towers under a night (or day) sky, and the elephant walking
    past with its memory. `words(theme)` draws the text, which must stay inside TEXT_BOX."""
    w, h = HERO_W, HERO_H
    rng = random.Random(7)
    sc = NIGHT if night else DAY
    parts = [rect(0, 0, w, h, sc["sky"])]

    # Horizon glow: dithered bands above the skyline.
    parts.append(
        "<defs>"
        '<pattern id="d1" width="4" height="4" patternUnits="userSpaceOnUse">'
        f'{rect(0, 0, 1, 1, sc["h1"])}{rect(2, 2, 1, 1, sc["h1"])}</pattern>'
        '<pattern id="d2" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'{rect(0, 0, 1, 1, sc["h1"])}{rect(1, 1, 1, 1, sc["h1"])}</pattern>'
        '<pattern id="d3" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'{rect(0, 0, 1, 1, sc["h2"])}{rect(1, 1, 1, 1, sc["h2"])}</pattern>'
        "</defs>"
        f'<rect y="{GROUND - 30}" width="{w}" height="8" fill="url(#d1)"/>'
        f'<rect y="{GROUND - 22}" width="{w}" height="8" fill="url(#d2)"/>'
        f'<rect y="{GROUND - 14}" width="{w}" height="14" fill="url(#d3)"/>'
    )

    if night:
        # Stars in three groups that twinkle out of step, and a few bright crosses.
        for gi in range(3):
            stars = {}
            for _ in range(30):
                x, y = rng.randrange(w), rng.randrange(2, GROUND - 40)
                colour = rng.choice(["#efe9dc", "#efe9dc", "#ffcb4d", "#5fd7ff"])
                if not in_text_box(x, y):
                    stars[(x, y)] = colour
            parts.append(f'<g class="tw tw{gi}">{paths(stars)}</g>')
        for x, y in [(18, 12), (40, 40), (276, 52), (300, 44), (30, 26), (248, 6)]:
            cross = {(x, y): "#efe9dc", (x - 1, y): "#ffcb4d", (x + 1, y): "#ffcb4d", (x, y - 1): "#ffcb4d", (x, y + 1): "#ffcb4d"}
            parts.append(f'<g class="tw tw{(x // 7) % 3}">{paths(cross)}</g>')
        # Moon with craters.
        moon = {}
        cx, cy, r = 292, 22, 10
        for x in range(cx - r - 1, cx + r + 2):
            for y in range(cy - r - 1, cy + r + 2):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                if d <= r:
                    moon[(x, y)] = "#ffcb4d" if (x - cx) + (y - cy) < -6 else "#ffb000"
                    if d > r - 1.2 and (x - cx) + (y - cy) > 4:
                        moon[(x, y)] = "#c98b00"
        for mx, my, mr in [(288, 18, 2), (296, 26, 2.6), (294, 16, 1.2), (286, 26, 1.3)]:
            for x in range(int(mx - mr - 1), int(mx + mr + 2)):
                for y in range(int(my - mr - 1), int(my + mr + 2)):
                    if math.hypot(x + 0.5 - mx, y + 0.5 - my) <= mr and (x, y) in moon:
                        moon[(x, y)] = "#c98b00"
        parts.append(paths(moon))
    else:
        # Sun with pixel rays, and a few clouds.
        sun = {}
        cx, cy, r = 292, 22, 8
        for x in range(cx - 14, cx + 15):
            for y in range(cy - 14, cy + 15):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                if d <= r:
                    sun[(x, y)] = "#ffcb4d" if (x - cx) + (y - cy) < -5 else "#ffb000"
                    if d > r - 1.2 and (x - cx) + (y - cy) > 3:
                        sun[(x, y)] = "#c98b00"
        for a in range(8):
            ang = a * math.pi / 4
            for k in (11, 12, 13):
                sun[(round(cx - 0.5 + k * math.cos(ang)), round(cy - 0.5 + k * math.sin(ang)))] = "#ffb000"
        parts.append(f'<g class="tw">{paths({p: c for p, c in sun.items() if math.hypot(p[0] + .5 - cx, p[1] + .5 - cy) > r + 1})}</g>')
        parts.append(paths({p: c for p, c in sun.items() if math.hypot(p[0] + .5 - cx, p[1] + .5 - cy) <= r + 1}))
        for x0, y0, n in [(16, 14, 22), (34, 40, 16), (262, 52, 18), (230, 6, 12)]:
            cloud = {}
            for x in range(n):
                cloud[(x0 + x, y0 + 3)] = "#e7d9bb"
                cloud[(x0 + x, y0 + 2)] = "#ffffff"
            for x in range(2, n - 3):
                cloud[(x0 + x, y0 + 1)] = "#ffffff"
            for x in range(5, n - 8):
                cloud[(x0 + x, y0)] = "#ffffff"
            parts.append(paths(cloud))

    # Distant mountains.
    mts = {}
    peaks = [(0, 84), (30, 72), (55, 80), (88, 68), (120, 78), (150, 71), (185, 81), (220, 69), (250, 77), (285, 70), (320, 80)]
    for i in range(len(peaks) - 1):
        (x0, y0), (x1, y1) = peaks[i], peaks[i + 1]
        for x in range(x0, x1):
            top = round(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
            for y in range(top, GROUND):
                mts[(x, y)] = sc["mt"]
    parts.append(paths(mts))

    # Skyline of data towers, far row then near row, with windows (some blink) and beacons.
    for row, (tcol, edge, lo, hi, wmin, wmax) in enumerate(
        [(sc["t0"], sc["t0"], 12, 24, 8, 14), (sc["t1"], sc["t2"], 8, 32, 7, 13)]
    ):
        x = rng.randrange(-6, 0)
        towers, windows, blink, beacons = {}, {}, {}, {}
        while x < w:
            tw = rng.randrange(wmin, wmax)
            gap = rng.randrange(1, 5) if row else rng.randrange(0, 3)
            th = rng.randrange(lo, hi)
            if any(in_text_box(tx) for tx in (x, x + tw)):
                th = min(th, 30)
            top = GROUND - th - (6 if row == 0 else 0)
            for tx in range(x, x + tw):
                for ty in range(top, GROUND):
                    towers[(tx, ty)] = edge if tx == x + tw - 1 and row else tcol
            if row:
                for wy in range(top + 2, GROUND - 2, 3):
                    for wx in range(x + 2, x + tw - 2, 2):
                        roll = rng.random()
                        if roll < 0.32:
                            windows[(wx, wy)] = sc["win"]
                        elif roll < 0.4:
                            windows[(wx, wy)] = sc["lit"]
                        elif roll < 0.44:
                            blink[(wx, wy)] = rng.choice(sc["blink"])
                if th > 24 and not in_text_box(x + tw // 2):
                    for ay in range(top - 4, top):
                        towers[(x + tw // 2, ay)] = edge
                    beacons[(x + tw // 2, top - 5)] = sc["beacon"]
            x += tw + gap
        parts.append(paths(towers))
        if row:
            parts.append(paths(windows))
            parts.append(f'<g class="blink">{paths(blink)}</g>')
            parts.append(f'<g class="beacon">{paths(beacons)}</g>')

    # Memories rising out of the towers, beside the text.
    for i in range(14):
        x = rng.randrange(6, w - 6)
        if in_text_box(x):
            x = x - 150 if x < w // 2 else x + 150
            x = min(max(x, 4), w - 4)
        y = rng.randrange(GROUND - 30, GROUND - 10)
        size = rng.choice([1, 1, 2])
        parts.append(rect(x, y, size, size, rng.choice(sc["mem"]), f' class="mem mem{i % 6}"'))

    # Ground: a band with a seam and scattered pixels.
    ground = {}
    for x in range(w):
        for y in range(GROUND, h):
            ground[(x, y)] = sc["gr"]
        if x % 3 != 2:
            ground[(x, GROUND)] = sc["seam"]
    for _ in range(50):
        ground[(rng.randrange(w), rng.randrange(GROUND + 3, h))] = rng.choice(sc["speck"])
    parts.append(paths(ground))

    parts.append(words(theme))

    # The elephant (two walk frames) carrying a memory, walking left to right.
    outline = None if night else "#3a2a05"
    frames = "".join(f'<g class="ef{i}">{paths(elephant_grid(i, outline))}</g>' for i in range(2))
    parts.append(f'<g class="walker"><g transform="translate(140 {GROUND - 26})">{frames}</g></g>')

    return svg(w, h, "".join(parts), label, HERO_CSS, ".ef1{opacity:0}")


# -------------------------------------------------------------------------------- how it works

FLOW_CSS = (
    ".ef0{animation:f0 .7s steps(1) infinite}.ef1{animation:f1 .7s steps(1) infinite}"
    "@keyframes f0{0%{opacity:1}50%{opacity:0}}@keyframes f1{0%{opacity:0}50%{opacity:1}}"
    ".pk{animation:pk 1.8s steps(6) infinite}.pk1{animation-delay:-.9s}"
    "@keyframes pk{from{transform:translateX(0)}to{transform:translateX(12px)}}"
    ".tw{animation:tw 1.4s steps(1) infinite}@keyframes tw{0%,100%{opacity:1}50%{opacity:.3}}"
)


def window(x, y, w, h, title_no, title, theme):
    """The site's window: hard shadow, border, a title bar with "[ 01 ] title"."""
    parts = [
        rect(x + 4, y + 4, w, h, theme["shadow"]),
        rect(x, y, w, h, theme["line2"]),
        rect(x + 1, y + 1, w - 2, h - 2, theme["panel"]),
        rect(x + 1, y + 1, w - 2, 13, theme["panel2"]),
        rect(x + 1, y + 14, w - 2, 1, theme["line2"]),
    ]
    label = f"[ {title_no} ]"
    parts.append(text(label, x + 6, y + 11, theme["atext"], "silkb"))
    parts.append(text(title, x + 6 + width(label, "silkb") + 5, y + 11, theme["muted"]))
    return "".join(parts)


def flow(theme, dark, panels, label):
    """Three of the site's windows in a row, joined by arrows with a memory travelling along each.
    A panel is (number, title, icon, heading lines, lines); the icon is a sprite from sprites.py,
    drawn three times its size, or "elephant" for the walking elephant with its memory."""
    w, h = 420, 148
    pw, ph, top = 124, 136, 4
    xs = [4, 148, 292]
    parts = []  # transparent: the page shows through around the windows
    icon_mid = top + 20 + 30  # vertical middle of the icon area
    for x, (no, title, icon, head, lines) in zip(xs, panels):
        parts.append(window(x, top, pw, ph, no, title, theme))
        cx = x + pw / 2
        if icon == "elephant":
            outline = None if dark else "#3a2a05"
            frames = "".join(
                f'<g class="ef{i}">{paths(elephant_grid(i, outline), round(cx - 43), icon_mid - 27, 2)}</g>' for i in range(2)
            )
            parts.append(frames)
        else:
            rows = S[icon]
            iw = max(len(r) for r in rows)
            parts.append(paths(sprite(icon), round(cx - iw * 3 / 2), icon_mid - math.ceil(len(rows) * 3 / 2), 3))
        y = top + 96
        for hl in head:
            parts.append(text(hl, cx, y, theme["fg"], "silkb", anchor="middle"))
            y += 12
        for ln in lines:
            parts.append(text(ln, cx, y, theme["muted"], anchor="middle"))
            y += 9
    # Arrows between the windows, with a memory travelling along each.
    for i, x in enumerate(xs[:2]):
        ax, ay = x + pw + 3, icon_mid
        arrow = {}
        for k in range(0, 13, 2):
            arrow[(k, 0)] = theme["mid"]
        for k in range(4):
            for j in range(-k, k + 1):
                arrow[(16 - k, j)] = theme["amber"]
        parts.append(paths(arrow, ax, ay))
        parts.append(f'<g class="pk pk{i}">{rect(ax, ay - 1, 3, 3, theme["cyan"])}</g>')
    return svg(w, h, "".join(parts), label, FLOW_CSS, ".ef1{opacity:0}")


def how_it_works(theme, dark):
    return flow(
        theme,
        dark,
        [
            ("01", "SEND", "chat", ["MESSAGES"], ["EACH TURN, FROM", "YOUR APP, AN SDK", "OR A PLUGIN"]),
            ("02", "LEARN", "elephant", ["MEMORY"], ["BUILT IN THE", "BACKGROUND: FACTS,", "DATES, SOURCES"]),
            ("03", "ASK", "terminal", ["ANSWERS"], ["ASK A QUESTION OR", "PUT CONTEXT IN", "YOUR NEXT PROMPT"]),
        ],
        "How Recall works: send messages, memory is built in the background, ask or get context",
    )


def plugin_flow(theme, dark):
    """What a plugin does in your agent. Claude Code and Codex recall at session start, OpenClaw
    and Hermes before each turn; all of them record your message and the final reply, never tool
    calls (see each integration's README)."""
    return flow(
        theme,
        dark,
        [
            ("01", "RECALL", "scroll", ["WHAT IT KNOWS"], ["YOUR PEER CARD AND", "FACTS, AT SESSION", "START OR EACH TURN"]),
            ("02", "RECORD", "chat", ["EVERY TURN"], ["YOUR MESSAGE AND", "THE FINAL REPLY,", "NOT TOOL CALLS"]),
            ("03", "LEARN", "elephant", ["IN THE BACKGROUND"], ["WHAT IS TRUE ABOUT", "YOU, WITH DATES", "AND SOURCES"]),
        ],
        "How a Recall plugin works in your agent: it recalls what it knows about you at session start "
        "or before each turn, records each turn, and Recall learns in the background",
    )


# ---------------------------------------------------------------------------------- benchmarks


def first_clause(scope):
    """"all 400 questions, 20 conversations of about 125,000 tokens" -> "all 400 questions"."""
    return scope.split(",")[0].split(";")[0].strip()


def graded(r):
    judge = r["judge"].lower()
    if "official" in judge:
        return "official judge"
    if "beam's" in judge:
        return "BEAM's own scoring"
    return ""


def results():
    """The full runs the site publishes, from EVALS: (key, name, what, figure, interval, scope, graded)."""
    out = []
    lme = EVALS["longmemeval"]
    out.append(
        (
            "longmemeval",
            "LongMemEval-S",
            "accuracy",
            f"{lme['score']:.1f}%",
            f"{lme['ci'][0]:.1f}-{lme['ci'][1]:.1f}%",
            first_clause(lme["scope"]),
            graded(lme),
        )
    )
    for key, name, anchor in (("beam100k", "BEAM 100K", "beam"), ("beam500k", "BEAM 500K", "beam500k")):
        r = EVALS.get(key)
        if not r:
            continue
        out.append(
            (anchor, name, "score, 0 to 1", f"{r['score']:.3f}", f"{r['ci'][0]:.3f}-{r['ci'][1]:.3f}", first_clause(r["scope"]), graded(r))
        )
    return out


def benchmarks(theme, dark):
    rows = results()
    w, h = 420, 120
    parts = []  # transparent: the page shows through around the windows
    x, y, pw, ph = 4, 4, 412, 112
    parts += [
        rect(x + 4, y + 4, pw, ph, theme["shadow"]),
        rect(x, y, pw, ph, theme["line2"]),
        rect(x + 1, y + 1, pw - 2, ph - 2, theme["panel"]),
        rect(x + 1, y + 1, pw - 2, 13, theme["panel2"]),
        rect(x + 1, y + 14, pw - 2, 1, theme["line2"]),
    ]
    label = "[ BENCHMARKS ]"
    parts.append(text(label, x + 6, y + 11, theme["atext"], "silkb"))
    parts.append(
        text("FULL RUNS · HOSTED SERVICE · DEFAULT LEVEL", x + 12 + width(label, "silkb"), y + 11, theme["muted"])
    )
    cw = (pw - 2) / len(rows)
    for i, (_, name, what, fig, ci, scope, how) in enumerate(rows):
        cx = x + 1 + i * cw
        if i:
            parts.append(rect(cx, y + 15, 1, ph - 16, theme["line"]))
        left = cx + 10
        parts.append(chunky(fig, left, y + 50, theme, "mono", s=3, shadows=[(1, theme["amber"]), (3, theme["drop"])]))
        parts.append(text(name.upper(), left, y + 66, theme["fg"], "silkb"))
        parts.append(text(what.upper(), left, y + 76, theme["muted"]))
        parts.append(text(scope.upper(), left, y + 89, theme["faint"]))
        parts.append(text(how.upper(), left, y + 98, theme["faint"]))
        parts.append(text(f"95% CI {ci}", left, y + 107, theme["faint"]))
    label = "Benchmarks: " + ", ".join(f"{name} {fig}" for _, name, _, fig, _, _, _ in rows)
    return svg(w, h, "".join(parts), label)


def readme_table():
    """The README's table of the same figures, between the evals markers."""
    lines = ["| Benchmark | Result | 95% interval | Questions | Graded by |", "|---|---|---|---|---|"]
    for anchor, name, what, fig, ci, scope, how in results():
        lines.append(
            f"| [{name}](https://recallmem.dev/evals#{anchor}) | **{fig}** {what} | {ci} | {scope} | {how} |"
        )
    return "\n".join(lines)


# ------------------------------------------------------------------------------------ dividers


def divider():
    """A section divider for either theme: the memory orb between dotted amber lines."""
    w, h = 420, 9
    g = {}
    c = w // 2
    for x in range(c - 200, c + 201):
        d = abs(x - c)
        if d < 10:
            continue
        step = 2 if d < 70 else 3 if d < 130 else 4
        if (d - 10) % step == 0:
            g[(x, 4)] = "#ffb000" if d < 70 else "#c98b00" if d < 130 else "#7a5300"
    for sx in (c - 40, c + 40):
        g.update({(sx, 4): "#ffcb4d", (sx - 1, 4): "#ffb000", (sx + 1, 4): "#ffb000", (sx, 3): "#ffb000", (sx, 5): "#ffb000"})
    o = {(x + c - 3, y + 1): SCENE_COL[k] for (x, y), k in orb().items() if k != "ch"}
    return svg(w, h, paths(g) + f'<g class="tw">{paths(o)}</g>', "", ".tw{animation:tw 1.4s steps(1) infinite}@keyframes tw{0%,100%{opacity:1}50%{opacity:.35}}").replace(
        'role="img" aria-label=""><title></title>', 'aria-hidden="true">'
    )


# ---------------------------------------------------------------------------------------- main


def files():
    """Every image, by the path it is written to."""
    out = {
        OUT / name: content
        for name, content in {
            "hero-dark.svg": hero(DARK, True),
            "hero-light.svg": hero(LIGHT, False),
            "how-it-works-dark.svg": how_it_works(DARK, True),
            "how-it-works-light.svg": how_it_works(LIGHT, False),
            "benchmarks-dark.svg": benchmarks(DARK, True),
            "benchmarks-light.svg": benchmarks(LIGHT, False),
            "divider.svg": divider(),
        }.items()
    }
    if PLUGIN_REPO.is_dir():
        label = "Recall plugins: memory for Claude Code, Codex, OpenClaw and Hermes"
        out.update(
            {
                PLUGIN_OUT / name: content
                for name, content in {
                    "hero-dark.svg": hero(DARK, True, plugin_words, label),
                    "hero-light.svg": hero(LIGHT, False, plugin_words, label),
                    "how-it-works-dark.svg": plugin_flow(DARK, True),
                    "how-it-works-light.svg": plugin_flow(LIGHT, False),
                    "divider.svg": divider(),
                }.items()
            }
        )
    return out


MARK = re.compile(r"(<!-- evals:start[^>]*-->\n)(.*?)(\n<!-- evals:end -->)", re.S)


def readme_with_table(readme):
    if not MARK.search(readme):
        raise SystemExit("README.md: the <!-- evals:start --> ... <!-- evals:end --> markers are missing")
    return MARK.sub(lambda m: m.group(1) + readme_table() + m.group(3), readme)


def main(argv):
    check = "--check" in argv
    stale = []
    images = files()
    for path, content in images.items():
        if check:
            if not path.exists() or path.read_text() != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    readme = README.read_text()
    fresh = readme_with_table(readme)
    if check:
        if fresh != readme:
            stale.append("README.md (benchmark table)")
        if stale:
            print("out of date (run python3 scripts/readme-assets.py): " + ", ".join(stale))
            return 1
        print("README assets are up to date")
        return 0
    if fresh != readme:
        README.write_text(fresh)
    folders = ", ".join(sorted({str(p.parent.relative_to(ROOT)) for p in images}))
    print(f"wrote {len(images)} files to {folders} and the README table")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
