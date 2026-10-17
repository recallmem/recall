"""Animated pixel art for the landing page, drawn the same way as scene.py: pixel grids emitted as
crisp inline SVG, with all motion as CSS classes in site.css (the CSP allows no inline style), so
prefers-reduced-motion freezes it. Every piece reads as a still picture when frozen.

- hero_world: the hero's horizon. People talk, their words rise as memories, an elephant walks
  past carrying one, and the stars above form an elephant.
- art_send, art_learn, art_ask: the three "how it works" steps as small dioramas.
- night_room: the night shift, as an elephant asleep in a nightcap, dreaming of facts merging.
- coin: a spinning coin for the pricing header.
- pixel_divider: a strip of dithered ground with sparkles between sections.
"""

import math
import random

from scene import COL as SCENE_COL
from scene import elephant, orb

PAL = {
    "a": "#ffb000",  # amber
    "l": "#ffcb4d",  # amber light
    "m": "#c98b00",  # amber mid
    "d": "#7a5300",  # amber dark
    "c": "#5fd7ff",  # cyan
    "C": "#1d4552",  # cyan halo
    "g": "#4dff9a",  # green
    "G": "#1e5c3a",  # green dark
    "r": "#ff5f56",  # red
    "R": "#5c2420",  # red dark
    "w": "#efe9dc",  # white
    "W": "#8f8778",  # grey
    "k": "#120d02",  # ink
    "K": "#1e1a14",  # panel
    "P": "#2b261d",  # panel edge
    "t": "#272014",  # tower
    "T": "#3a2f1c",  # tower edge
    "u": "#1a150d",  # far tower
    "n": "#15110b",  # mountains
    "o": "#0e0c08",  # ground
    "s": "#e8b98a",  # skin
    "S": "#a06a43",  # skin, darker
    "h": "#3b2a1a",  # hair, dark
    "H": "#d9893a",  # hair, ginger
    "j": "#3a3f52",  # trousers
    "v": "#9b7bff",  # violet
    "q": "#ff8fb1",  # pink
    "y": "#0b1424",  # night sky through a window
    "x": "#3a2d16",  # wood
}


def draw(grid, ox=0, oy=0):
    """A {(x, y): palette key} grid as one <path> per colour, each pixel row merged into runs."""
    by_row = {}
    for (x, y), c in grid.items():
        by_row.setdefault(y, {})[x] = c
    paths = {}
    for y in sorted(by_row):
        row = by_row[y]
        xs = sorted(row)
        i = 0
        while i < len(xs):
            x, c = xs[i], row[xs[i]]
            j = i
            while j + 1 < len(xs) and xs[j + 1] == xs[j] + 1 and row[xs[j + 1]] == c:
                j += 1
            n = j - i + 1
            paths.setdefault(c, []).append(f"M{x + ox} {y + oy}h{n}v1h-{n}z")
            i = j + 1
    return "".join(f'<path fill="{PAL[c]}" d="{"".join(d)}"/>' for c, d in paths.items())


def grid(rows, swap=None):
    """ASCII rows (one palette key per pixel, "." for none) as a grid; `swap` recolours keys."""
    swap = swap or {}
    return {(x, y): swap.get(c, c) for y, row in enumerate(rows) for x, c in enumerate(row) if c != "."}


def g(cls, body):
    return f'<g class="{cls}">{body}</g>'


def svg(cls, w, h, body, fit="xMidYMid meet"):
    return (
        f'<svg class="{cls}" viewBox="0 0 {w} {h}" preserveAspectRatio="{fit}" '
        f'shape-rendering="crispEdges" aria-hidden="true">{body}</svg>'
    )


def big_elephant(frame):
    """scene.py's elephant (42 x 27) in this palette."""
    return {p: _scene_key(c) for p, c in elephant(frame).items()}


def _scene_key(c):
    return {v: k for k, v in PAL.items()}.get(SCENE_COL[c], "a")


def carried_orb():
    return {p: _scene_key(c) for p, c in orb().items()}


# ------------------------------------------------------------------------------- sprites

PERSON = [
    "..hhh..",
    ".hhhhh.",
    ".hsssh.",
    ".sksks.",
    ".sssss.",
    "..sss..",
    ".ttttt.",
    "ttttttt",
    "t.ttt.t",
    "s.ttt.s",
    "..jjj..",
    "..j.j..",
    ".kk.kk.",
]
PERSON_LONG = [
    "..hhh..",
    ".hhhhh.",
    "hhsssh.",
    "hsksksh",
    "hsssssh",
    "h.sss.h",
    ".ttttt.",
    "ttttttt",
    "t.ttt.t",
    "s.ttt.s",
    "..jjj..",
    "..j.j..",
    ".kk.kk.",
]
PEOPLE = [
    (PERSON, {"t": "c"}),
    (PERSON_LONG, {"t": "v", "h": "H"}),
    (PERSON, {"t": "g", "s": "S"}),
    (PERSON_LONG, {"t": "r"}),
    (PERSON, {"t": "q", "h": "H"}),
    (PERSON_LONG, {"t": "a", "s": "S", "h": "h"}),
]

BUBBLE = [
    ".wwwwwwwww.",
    "wwwwwwwwwww",
    "wwwwwwwwwww",
    "wwwwwwwwwww",
    ".wwwwwwwww.",
    "..ww.......",
    "..w........",
]

ENVELOPE = [
    "wwwwwwwww",
    "wlwwwwwlw",
    "wwlwwwlww",
    "wwwlalwww",
    "wwwwawwww",
    "wwwwwwwww",
]

CARD = [
    "wwwwwwwww",
    "wkkkkkwww",
    "wwwwwwwww",
    "wkkkwkkkw",
    "wwwwwwwww",
]

CARD_GLOW = [
    ".ccccccccc.",
    "cwwwwwwwwwc",
    "cwkkkkkwwwc",
    "cwwwwwwwwwc",
    "cwkkkwkkkwc",
    "cwwwwwwwwwc",
    ".ccccccccc.",
]

CABINET = [
    "dddddddddddddddddd",
    "dmmmmmmmmmmmmmmmmd",
    "dmaaaaaaaaaaaaaamd",
    "dmaaaaalllaaaaaamd",
    "dmaaaaaaaaaaaaaamd",
    "dmmmmmmmmmmmmmmmmd",
    "dmaaaaaaaaaaaaaamd",
    "dmaaaaalllaaaaaamd",
    "dmaaaaaaaaaaaaaamd",
    "dmmmmmmmmmmmmmmmmd",
    "dmaaaaaaaaaaaaaamd",
    "dmaaaaalllaaaaaamd",
    "dmaaaaaaaaaaaaaamd",
    "dmmmmmmmmmmmmmmmmd",
    "dddddddddddddddddd",
    ".d..............d.",
]
DRAWER = [
    "dddddddddddddddddd",
    "dllllllllllllllld.",
    "dlaaaaaaaaaaaaaad.",
    "dlaaaaawwwaaaaaad.",
    "dlaaaaaaaaaaaaaad.",
    "dddddddddddddddd..",
]

CRATE = [
    "xxxxxxxxxxxx",
    "xddddddddddx",
    "xdxxxxxxxxdx",
    "xddddddddddx",
    "xdxxxxxxxxdx",
    "xddddddddddx",
    "xxxxxxxxxxxx",
]

PHONE = [
    ".PPPPPPPPPPPPPP.",
    "PKKKKKKKKKKKKKKP",
    "PKkkkkkkkkkkkkKP",
    *["PKkkkkkkkkkkkkKP"] * 20,
    "PKKKKKKKKKKKKKKP",
    "PKKKKKKWWKKKKKKP",
    ".PPPPPPPPPPPPPP.",
]

CHEST = [
    "...dddddddddddddd...",
    "..dllllllllllllllld.",
    ".dlaaaaaaaaaaaaaaaad",
    "dlaaaaaaaaaaaaaaaaad",
    "dddddddddddddddddddd",
    "dmaaaaaaalllaaaaaamd",
    "dmaaaaaaalcclaaaaamd",
    "dmaaaaaaalcclaaaaamd",
    "dmaaaaaaaallaaaaaamd",
    "dmaaaaaaaaaaaaaaaamd",
    "dmaaaaaaaaaaaaaaaamd",
    "dmmmmmmmmmmmmmmmmmmd",
    "dddddddddddddddddddd",
]

BUBBLE_Q = [
    ".wwwwwww.",
    "wwwkkkwww",
    "wwkwwwkww",
    "wwwwwwkww",
    "wwwwwkwww",
    "wwwwkwwww",
    "wwwwwwwww",
    "wwwwkwwww",
    ".wwwwwww.",
    "..ww.....",
    "..w......",
]

ZED = [
    "wwww",
    "..w.",
    ".w..",
    "wwww",
]

def nightcap():
    """A striped night cap in the elephant's own coordinates: the band on its head, the cone
    leaning back over it, a bobble hanging at the end."""
    cap = {}
    rows = {1: (22, 31), 0: (21, 30), -1: (20, 28), -2: (19, 26), -3: (18, 24), -4: (17, 22), -5: (16, 19)}
    for y, (x0, x1) in rows.items():
        for x in range(x0, x1 + 1):
            cap[(x, y)] = "c" if ((x + y) // 3) % 2 == 0 else "w"
    for x in range(22, 33):
        cap[(x, 2)] = "w"
        cap[(x, 3)] = "W" if x % 2 else "w"
    cap.update({(15, -5): "c", (14, -4): "c", (13, -3): "c"})
    cap.update({(x, y): "w" for x in range(11, 15) for y in range(-2, 2)})
    cap.update({(11, -2): None, (14, -2): None, (11, 1): None, (14, 1): None})
    cap.update({(14, 0): "W", (13, 1): "W", (12, 1): "W"})
    return {p: c for p, c in cap.items() if c}


def ellipse(cx, cy, rx, ry, key):
    return {
        (x, y): key
        for x in range(int(cx - rx - 1), int(cx + rx + 2))
        for y in range(int(cy - ry - 1), int(cy + ry + 2))
        if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1
    }


def box(x0, y0, w, h, key):
    return {(x, y): key for x in range(x0, x0 + w) for y in range(y0, y0 + h)}


def line(x0, y0, x1, y1, key, every=1):
    """A pixel line (Bresenham); `every` 2 leaves a gap between dots, for faint lines."""
    pts = {}
    dx, dy = abs(x1 - x0), -abs(y1 - y0)
    sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
    err, i = dx + dy, 0
    x, y = x0, y0
    while True:
        if i % every == 0:
            pts[(x, y)] = key
        i += 1
        if x == x1 and y == y1:
            break
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x += sx
        if e2 <= dx:
            err += dx
            y += sy
    return pts


def dither(grid_, key, pid):
    """A soft glow in pixel art: the grid's area filled with a checkerboard of `key`. `pid` names
    the pattern and must be unique on the page."""
    shape = draw({p: "k" for p in grid_}).replace(f'fill="{PAL["k"]}"', f'fill="url(#{pid})"')
    pattern = (
        f'<defs><pattern id="{pid}" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'<path fill="{PAL[key]}" d="M0 0h1v1h-1zM1 1h1v1h-1z"/></pattern></defs>'
    )
    return pattern + shape


def shift(grid_, dx, dy):
    return {(x + dx, y + dy): c for (x, y), c in grid_.items()}


def cross(x, y, centre="w", arm="l"):
    return {(x, y): centre, (x - 1, y): arm, (x + 1, y): arm, (x, y - 1): arm, (x, y + 1): arm}


def dots_bubble(ox, oy, n):
    """A speech bubble with three typing dots that light up in turn."""
    body = draw(grid(BUBBLE), ox, oy)
    dots = "".join(g(f"dot dot{i}", draw({(ox + 3 + 2 * i, oy + 2): "k"})) for i in range(3))
    return g(f"bub bub{n}", body + dots)


# ---------------------------------------------------------------------------------- hero


def hero_world():
    """The hero's horizon (480 x 60): people talk, their words rise into the sky as memories,
    the elephant walks past carrying one, and some of the stars form an elephant."""
    W, H, GROUND = 480, 60, 50
    rng = random.Random(23)
    parts = []

    # The elephant constellation: stars at its outline, faint dotted lines between them.
    cx, cy = 372, 3
    stars = [
        (0, 12), (4, 6), (12, 2), (21, 1), (28, 0), (34, 4), (36, 9), (35, 14), (38, 16),
        (30, 10), (27, 11), (27, 18), (9, 11), (9, 18), (18, 12), (22, 8),
    ]
    links = [
        (0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 7), (7, 8), (6, 9), (9, 10),
        (10, 11), (10, 14), (14, 12), (12, 13), (1, 12), (3, 15), (15, 4),
    ]
    faint = {}
    for a, b in links:
        (x0, y0), (x1, y1) = stars[a], stars[b]
        faint.update(line(cx + x0, cy + y0, cx + x1, cy + y1, "C", every=2))
    parts.append(g("cons", draw(faint)))
    for i, (x, y) in enumerate(stars):
        bright = i in (2, 4, 8, 11, 13)
        parts.append(g(f"tw tw{i % 3}", draw(cross(cx + x, cy + y, "w", "C") if bright else {(cx + x, cy + y): "c"})))
    # Its eye is a warm star: the memory it keeps.
    parts.append(g("orb", draw(cross(cx + 31, cy + 4, "l", "d"))))
    # A few loose stars elsewhere.
    for gi in range(3):
        loose = {(rng.randrange(W), rng.randrange(1, 22)): rng.choice(["W", "d", "C"]) for _ in range(14)}
        loose = {p: c for p, c in loose.items() if not (cx - 4 <= p[0] <= cx + 42)}
        parts.append(g(f"tw tw{gi}", draw(loose)))

    # A crescent moon in a soft halo.
    mx, my = 64, 10
    parts.append(dither(ellipse(mx, my, 9, 9, "d"), "d", "glow-moon"))
    moon = {
        (x, y): "l"
        for x in range(mx - 5, mx + 6)
        for y in range(my - 5, my + 6)
        if math.hypot(x + 0.5 - mx, y + 0.5 - my) <= 4.8 and math.hypot(x + 0.5 - mx - 2.2, y + 0.5 - my + 1.4) > 4.0
    }
    parts.append(draw(moon))

    # Mountains and two rows of data towers.
    mts = {}
    peaks = [(0, 40), (40, 30), (78, 38), (120, 28), (165, 37), (210, 29), (250, 38), (300, 27), (345, 36), (390, 30), (440, 38), (480, 31)]
    for (x0, y0), (x1, y1) in zip(peaks, peaks[1:]):
        for x in range(x0, x1):
            top = round(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
            for y in range(top, GROUND):
                mts[(x, y)] = "n"
    parts.append(draw(mts))
    for row, (tk, ek, lo, hi) in enumerate([("u", "u", 8, 16), ("t", "T", 6, 20)]):
        towers, lit, blink, beacons = {}, {}, {}, {}
        x = rng.randrange(-4, 2)
        while x < W:
            w = rng.randrange(6, 12)
            h = rng.randrange(lo, hi)
            top = GROUND - h - (4 if row == 0 else 0)
            # Leave room in front of the people.
            if row == 1 and any(abs(x + w / 2 - p) < 12 for p in (36, 104, 170, 262, 330, 440)):
                x += w + 2
                continue
            for tx in range(x, x + w):
                for ty in range(top, GROUND):
                    towers[(tx, ty)] = ek if row and tx == x + w - 1 else tk
            if row:
                for wy in range(top + 2, GROUND - 2, 3):
                    for wx in range(x + 2, x + w - 2, 2):
                        roll = rng.random()
                        if roll < 0.28:
                            lit[(wx, wy)] = "d"
                        elif roll < 0.36:
                            lit[(wx, wy)] = "m"
                        elif roll < 0.43:
                            blink[(wx, wy)] = rng.choice(["a", "a", "c", "l"])
                if h >= 15:
                    mast = x + w // 2
                    towers.update({(mast, top - 1): ek, (mast, top - 2): ek})
                    beacons[(mast, top - 3)] = "r"
            x += w + rng.randrange(2, 7)
        parts.append(draw(towers))
        if row:
            parts.append(draw(lit))
            parts.append(g("blink", draw(blink)))
            parts.append(g("beacon", draw(beacons)))

    # Ground: dark band, a dashed amber seam, scattered pixels.
    ground = {}
    for x in range(W):
        for y in range(GROUND, H):
            ground[(x, y)] = "o"
        if x % 3 != 2:
            ground[(x, GROUND)] = "d"
    for _ in range(70):
        ground[(rng.randrange(W), rng.randrange(GROUND + 2, H))] = rng.choice(["d", "t", "T"])
    parts.append(draw(ground))

    # People, each saying something; what they say rises as a memory.
    for i, px in enumerate((36, 104, 170, 262, 330, 440)):
        rows, swap = PEOPLE[i]
        parts.append(draw(grid(rows, swap), px, GROUND - len(rows)))
        bx, by = px - 2, GROUND - len(rows) - 9
        parts.append(dots_bubble(bx, by, i))
        mem = {(1, 0): "c", (0, 1): "c", (1, 1): "w", (2, 1): "c", (1, 2): "c"}
        parts.append(g(f"lift lift{i}", draw(mem, bx + 4, by - 3)))

    # Now and then a shooting star.
    streak = {(i, i // 2): k for i, k in enumerate("ddmaallw")}
    parts.append(g("shoot", draw(streak, 60, 4)))

    # The elephant walks past in front of them, carrying a memory.
    ex, ey = 0, H - 3 - 26
    frames = "".join(g(f"ef ef{i}", draw(big_elephant(i))) for i in range(2))
    carried = g("orb", draw(carried_orb(), 36, 14))
    parts.append(f'<g class="hw-walker"><g transform="translate({ex} {ey})">{frames}{carried}</g></g>')

    return svg("hero-world-svg", W, H, "".join(parts), fit="xMidYMax slice")


def hero_layers():
    """The hero's city as four layers of one 400 x 96 panorama, so each can move at its own speed
    (site.js shifts them with the scroll and the pointer): the sky, the far skyline, the near
    towers, and the street, where people talk, their words rise as memories, and the elephant
    walks past carrying one. Returns {"sky": svg, "far": svg, "near": svg, "front": svg}."""
    W, H, GROUND = 400, 96, 82
    rng = random.Random(41)
    people_x = (30, 86, 146, 250, 306, 362)

    def layer(name, body):
        return svg(f"layer-svg l-{name}", W, H, body, fit="xMidYMax slice")

    # ---- sky: stars, a moon in a soft halo, a shooting star, and an elephant constellation.
    sky = []
    for gi in range(3):
        loose = {(rng.randrange(W), rng.randrange(1, 58)): rng.choice(["W", "d", "C", "W"]) for _ in range(22)}
        loose = {p: c for p, c in loose.items() if not (296 <= p[0] <= 350 and p[1] < 34) and not (40 <= p[0] <= 72 and p[1] < 30)}
        sky.append(g(f"tw tw{gi}", draw(loose)))
    for i, x in enumerate((120, 205, 382, 18)):
        sky.append(g(f"tw tw{i % 3}", draw(cross(x, 8 + (i * 13) % 30, "w", "C"))))
    mx, my = 56, 16
    sky.append(dither(ellipse(mx, my, 11, 11, "d"), "d", "glow-moon"))
    sky.append(draw({
        (x, y): "l"
        for x in range(mx - 7, mx + 8)
        for y in range(my - 7, my + 8)
        if math.hypot(x + 0.5 - mx, y + 0.5 - my) <= 6 and math.hypot(x + 0.5 - mx - 2.8, y + 0.5 - my + 1.8) > 5
    }))
    cx, cy = 300, 4
    stars = [
        (0, 15), (5, 8), (15, 3), (26, 1), (35, 0), (42, 5), (45, 11), (44, 18), (48, 20),
        (37, 12), (34, 14), (34, 23), (11, 14), (11, 23), (22, 15), (27, 10),
    ]
    links = [
        (0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 7), (7, 8), (6, 9), (9, 10),
        (10, 11), (10, 14), (14, 12), (12, 13), (1, 12), (3, 15), (15, 4),
    ]
    faint = {}
    for a, b in links:
        (x0, y0), (x1, y1) = stars[a], stars[b]
        faint.update(line(cx + x0, cy + y0, cx + x1, cy + y1, "C", every=2))
    sky.append(g("cons", draw(faint)))
    for i, (x, y) in enumerate(stars):
        bright = i in (2, 4, 8, 11, 13)
        sky.append(g(f"tw tw{i % 3}", draw(cross(cx + x, cy + y, "w", "C") if bright else {(cx + x, cy + y): "c"})))
    sky.append(g("orb", draw(cross(cx + 39, cy + 5, "l", "d"))))
    streak = {(i, i // 2): k for i, k in enumerate("ddmaallw")}
    sky.append(g("shoot", draw(streak, 150, 6)))

    # ---- the far skyline: hills and a row of dim towers.
    far = {}
    peaks = [(0, 58), (34, 50), (70, 57), (110, 47), (150, 56), (196, 48), (236, 57), (280, 46), (322, 55), (360, 49), (400, 56)]
    for (x0, y0), (x1, y1) in zip(peaks, peaks[1:]):
        for x in range(x0, x1):
            top = round(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
            for y in range(top, GROUND):
                far[(x, y)] = "n"
    x = -3
    lit_far = {}
    while x < W:
        w, h = rng.randrange(5, 11), rng.randrange(12, 28)
        top = GROUND - h
        for tx in range(x, x + w):
            for ty in range(top, GROUND):
                far[(tx, ty)] = "u"
        for wy in range(top + 2, GROUND - 2, 4):
            for wx in range(x + 1, x + w - 1, 3):
                if rng.random() < 0.18:
                    lit_far[(wx, wy)] = "d"
        x += w + rng.randrange(1, 5)
    far_body = draw(far) + draw(lit_far)

    # ---- the near towers, with lit windows, blinking ones and red beacons; a gap at each person.
    towers, lit, blink, beacons = {}, {}, {}, {}
    x = rng.randrange(-4, 2)
    while x < W:
        w, h = rng.randrange(7, 14), rng.randrange(10, 34)
        if any(abs(x + w / 2 - px - 3) < 13 for px in people_x):
            x += 3
            continue
        top = GROUND - h
        for tx in range(x, x + w):
            for ty in range(top, GROUND):
                towers[(tx, ty)] = "T" if tx == x + w - 1 else "t"
        for wy in range(top + 2, GROUND - 2, 3):
            for wx in range(x + 2, x + w - 2, 2):
                roll = rng.random()
                if roll < 0.24:
                    lit[(wx, wy)] = "d"
                elif roll < 0.32:
                    lit[(wx, wy)] = "m"
                elif roll < 0.38:
                    blink[(wx, wy)] = rng.choice(["a", "a", "c", "l"])
        if h >= 24:
            mast = x + w // 2
            towers.update({(mast, top - 1): "T", (mast, top - 2): "T", (mast, top - 3): "T"})
            beacons[(mast, top - 4)] = "r"
        x += w + rng.randrange(2, 6)
    near_body = draw(towers) + draw(lit) + g("blink", draw(blink)) + g("beacon", draw(beacons))

    # ---- the street: ground, people talking, memories rising, the elephant walking past.
    front = []
    ground = {(x, y): "o" for x in range(W) for y in range(GROUND, H)}
    for x in range(W):
        if x % 3 != 2:
            ground[(x, GROUND)] = "d"
    for _ in range(90):
        ground[(rng.randrange(W), rng.randrange(GROUND + 2, H))] = rng.choice(["d", "t", "T", "m"])
    front.append(draw(ground))
    for i, px in enumerate(people_x):
        rows, swap = PEOPLE[i]
        front.append(draw(grid(rows, swap), px, GROUND - len(rows)))
        bx, by = px - 2, GROUND - len(rows) - 9
        front.append(dots_bubble(bx, by, i))
        mem = {(1, 0): "c", (0, 1): "c", (1, 1): "w", (2, 1): "c", (1, 2): "c"}
        front.append(g(f"lift lift{i}", draw(mem, bx + 4, by - 3)))
    frames = "".join(g(f"ef ef{i}", draw(big_elephant(i))) for i in range(2))
    carried = g("orb", draw(carried_orb(), 36, 14))
    front.append(f'<g class="hw-walker"><g transform="translate(0 {H - 4 - 26})">{frames}{carried}</g></g>')

    return {
        "sky": layer("sky", "".join(sky)),
        "far": layer("far", far_body),
        "near": layer("near", near_body),
        "front": layer("front", "".join(front)),
    }


def night_stars():
    """A wide strip of stars (400 x 120) for the night shift's sky, which fades in on scroll."""
    rng = random.Random(9)
    body = []
    for gi in range(3):
        pts = {(rng.randrange(400), rng.randrange(120)): rng.choice(["W", "C", "w", "d"]) for _ in range(40)}
        body.append(g(f"tw tw{gi}", draw(pts)))
    for i in range(6):
        body.append(g(f"tw tw{i % 3}", draw(cross(rng.randrange(10, 390), rng.randrange(6, 110), "w", "C"))))
    return svg("night-stars-svg", 400, 120, "".join(body), fit="xMidYMid slice")


# ------------------------------------------------------------------------- how it works


def art_send():
    """Step 1: a conversation on a phone; each message flies off as a letter into Recall's chest."""
    W, H = 120, 44
    parts = [draw(grid(PHONE), 6, 6)]
    # Messages stacking up on the screen, in two alternating colours.
    msgs = {}
    for i, (side, w, key) in enumerate([(0, 9, "W"), (1, 8, "a"), (0, 10, "W"), (1, 6, "a"), (0, 8, "W"), (1, 9, "a")]):
        y = 9 + i * 3
        x = 9 if side == 0 else 20 - w
        msgs.update(box(x, y, w, 2, key))
    parts.append(g("chat", draw(msgs)))
    # Letters on their way, one after another.
    for i in range(3):
        parts.append(g(f"fly fly{i}", draw(grid(ENVELOPE), 26, 18)))
    # The dotted path they take.
    parts.append(draw(line(26, 26, 88, 26, "P", every=3)))
    # Recall's chest, which glows when a letter lands.
    parts.append(g("pulse", dither(ellipse(101, 28, 17, 12, "C"), "C", "glow-send")))
    parts.append(draw(grid(CHEST), 91, 22))
    parts.append(draw(box(0, 41, W, 3, "o")))
    return svg("art art-send", W, H, "".join(parts))


def art_learn():
    """Step 2: the elephant files what it learned; an outdated card is stamped and archived."""
    W, H = 128, 44
    parts = [draw(box(0, 41, W, 3, "o"))]
    # The elephant (frame 0), facing the cabinet.
    parts.append(draw(big_elephant(0), 4, 15))
    # The cabinet, and the archive crate beside it.
    parts.append(draw(grid(CABINET), 76, 25))
    parts.append(draw(grid(CRATE), 104, 34))
    parts.append(draw({(108, 33): "W", (109, 32): "W", (110, 33): "W"}))
    # New cards travel from the trunk into the top drawer.
    for i in range(2):
        parts.append(g(f"file file{i}", draw(grid(CARD), 42, 30)))
    # An old card comes out, gets a red cross and drops into the crate.
    old = grid(CARD, {"k": "W"})
    stamp = {**line(0, 0, 4, 4, "r"), **line(4, 0, 0, 4, "r")}
    parts.append(g("retire", draw(old, 84, 18) + g("stamp", draw(stamp, 86, 18))))
    return svg("art art-learn", W, H, "".join(parts))


def art_ask():
    """Step 3: a question goes in, the right card comes out of the drawer and becomes the answer."""
    W, H = 120, 44
    parts = [draw(box(0, 41, W, 3, "o"))]
    parts.append(draw(grid(PERSON, {"t": "c"}), 8, 28))
    parts.append(g("ask-q", draw(grid(BUBBLE_Q), 6, 16)))
    parts.append(draw(grid(CABINET), 44, 25))
    # The top drawer's opening, which shows when the drawer slides out.
    parts.append(draw(box(45, 26, 16, 4, "k")))
    parts.append(g("drawer", draw(grid(DRAWER), 44, 25)))
    parts.append(g("found", draw(grid(CARD_GLOW), 48, 14)))
    # The answer: a bubble with lines and an amber source tag.
    answer = {**box(76, 12, 38, 16, "w"), **box(77, 11, 36, 1, "w"), **box(77, 28, 36, 1, "w")}
    answer.update({(78, 29): "w", (79, 29): "w", (78, 30): "w"})
    answer.update(box(79, 15, 24, 2, "k"))
    answer.update(box(79, 19, 30, 2, "k"))
    answer.update(box(79, 23, 14, 2, "k"))
    answer.update(box(96, 22, 10, 4, "a"))
    answer.update(box(98, 23, 6, 2, "l"))
    parts.append(g("answer", draw(answer)))
    return svg("art art-ask", W, H, "".join(parts))


# ---------------------------------------------------------------------------- night shift


def sleeping_elephant():
    """The elephant lying down (legs tucked away), eyes shut, in a nightcap."""
    e = {p: c for p, c in big_elephant(0).items() if p[1] <= 21}
    # Close the eye.
    for p in [(31, 7), (31, 8)]:
        e[p] = "a"
    for p in [(30, 8), (31, 8), (32, 8)]:
        e[p] = "d"
    # A flat belly line on the floor.
    for x in range(6, 27):
        e[(x, 21)] = "d"
    return {**e, **nightcap()}


def night_room():
    """The night shift (160 x 64): the elephant asleep under the window, dreaming facts into order."""
    W, H, FLOOR = 160, 64, 54
    rng = random.Random(5)
    parts = []
    # Window with a frame, stars and a moon.
    win = box(10, 8, 34, 26, "y")
    for x in range(9, 45):
        win[(x, 7)] = "x"
        win[(x, 34)] = "x"
    for y in range(7, 35):
        win[(9, y)] = "x"
        win[(44, y)] = "x"
        win[(27, y)] = "x"
    for x in range(9, 45):
        win[(x, 21)] = "x"
    parts.append(draw(win))
    parts.append(g("tw tw1", draw({(14, 11): "w", (22, 15): "W", (31, 25): "w", (40, 12): "W", (16, 28): "W"})))
    moon = {}
    for x in range(30, 42):
        for y in range(9, 21):
            if math.hypot(x + 0.5 - 36, y + 0.5 - 15) <= 4.6:
                moon[(x, y)] = "l" if math.hypot(x + 0.5 - 37.6, y + 0.5 - 13.6) > 4.2 else None
    parts.append(draw({p: c for p, c in moon.items() if c}))
    # Floor, rug, and a small lamp.
    floor = box(0, FLOOR, W, H - FLOOR, "o")
    for x in range(0, W, 8):
        floor[(x, FLOOR)] = "x"
    parts.append(draw(floor))
    rug = ellipse(70, FLOOR + 1, 34, 4, "R")
    rug.update({p: "d" for p in ellipse(70, FLOOR + 1, 30, 2.6, "d")})
    parts.append(draw(rug))
    lamp = {**box(140, 40, 9, 5, "a"), **box(141, 39, 7, 1, "l"), **box(144, 45, 1, 9, "d"), **box(141, 53, 7, 1, "d")}
    parts.append(g("pulse", dither(ellipse(144, 43, 14, 11, "d"), "d", "glow-lamp")))
    parts.append(draw(lamp))
    # The elephant, asleep on the rug, and its Zs.
    parts.append(g("snore", draw(sleeping_elephant(), 46, FLOOR - 21)))
    for i in range(3):
        parts.append(g(f"zz zz{i}", draw(grid(ZED), 82, 28)))
    # The dream: a cloud with two facts sliding into one, which then gets a green tick.
    cloud = {}
    for cx, cy, rx, ry in [(118, 16, 22, 10), (104, 20, 10, 7), (132, 21, 10, 7), (110, 10, 9, 6), (127, 10, 9, 6)]:
        cloud.update(ellipse(cx, cy, rx, ry, "K"))
    edge = {(x, y): "W" for (x, y) in cloud if any((x + dx, y + dy) not in cloud for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))}
    parts.append(draw({**cloud, **edge}))
    parts.append(draw({**ellipse(96, 33, 2.2, 2.2, "W"), **ellipse(90, 38, 1.4, 1.4, "W")}))
    parts.append(g("dream-a", draw(grid(CARD), 102, 14)))
    parts.append(g("dream-b", draw(grid(CARD), 126, 14)))
    merged = {**grid(CARD_GLOW, {"c": "g"})}
    tick = {(4, 9): "g", (5, 10): "g", (6, 9): "g", (7, 8): "g", (8, 7): "g"}
    parts.append(g("dream-c", draw(merged, 113, 12) + draw(tick, 113, 12)))
    return svg("art art-night", W, H, "".join(parts))


# --------------------------------------------------------------------------- small pieces


def coin_frame(sx):
    """The coin (12 x 12) turned so that it is `sx` of its width wide."""
    out = {}
    for y in range(12):
        for x in range(12):
            u, v = (x + 0.5 - 6) / sx, y + 0.5 - 6
            r = math.hypot(u, v)
            if r > 5.9:
                continue
            if r > 4.7:
                key = "d" if u + v > -2 else "m"
            elif abs(u) + abs(v) < 1.2:
                key = "w"
            elif abs(u) + abs(v) < 2.6:
                key = "l" if u + v <= 0 else "m"
            elif u + v < -3.2:
                key = "l"
            else:
                key = "a"
            out[(x, y)] = key
    return out


def coin():
    frames = [coin_frame(1), coin_frame(0.55), coin_frame(0.14), coin_frame(0.55)]
    body = "".join(g(f"cf cf{i}", draw(f)) for i, f in enumerate(frames))
    return svg("coin", 12, 12, body)


def pixel_divider(n=0):
    """A strip of ground (480 x 10) with sparkles, to sit between sections; `n` keeps its pattern
    ids apart from the other dividers on the page."""
    W, H = 480, 10
    rng = random.Random(3 + n)
    seam = (
        f'<defs><pattern id="seam{n}" width="3" height="1" patternUnits="userSpaceOnUse">'
        f'<path fill="{PAL["d"]}" d="M0 0h2v1h-2z"/><path fill="{PAL["T"]}" d="M2 0h1v1h-1z"/></pattern>'
        f'<pattern id="soil{n}" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'<path fill="{PAL["T"]}" d="M0 0h1v1h-1zM1 1h1v1h-1z"/></pattern></defs>'
        f'<path fill="url(#seam{n})" d="M0 6h{W}v1h-{W}z"/><path fill="url(#soil{n})" d="M0 7h{W}v{H - 7}h-{W}z"/>'
    )
    xs = [int(W * (i + 0.5) / 9) + rng.randrange(-16, 16) for i in range(9)]
    sparkles = [g(f"tw tw{i % 3}", draw(cross(x, 3, "l", "d"))) for i, x in enumerate(xs)]
    return svg("pixel-divider-svg", W, H, seam + "".join(sparkles), fit="xMidYMid slice")


if __name__ == "__main__":
    for f in (hero_world, art_send, art_learn, art_ask, night_room, coin, pixel_divider):
        print(f.__name__, len(f()))
