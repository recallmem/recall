"""The pixel night scene on the landing page: an amber elephant walking past a skyline of data
towers while memories rise into the sky ("an elephant never forgets").

Everything is drawn from shapes onto pixel grids and emitted as one crisp inline SVG; the motion
(walk cycle, twinkling stars, blinking windows, rising memories) is CSS in site.css, so
prefers-reduced-motion freezes it like the rest of the site.
"""

import math
import random

W, H = 320, 100
GROUND = 86
# The closing scene's headline, subhead and buttons sit over the middle of the sky (the SVG is
# cropped to its centre on narrow screens): no stars or rising memories there, so nothing
# twinkles through the text.
TEXT_X0, TEXT_X1 = 112, 208


def clear_of_text(x):
    return not TEXT_X0 <= x <= TEXT_X1

COL = {
    "a": "#ffb000",  # amber
    "l": "#ffcb4d",  # amber light
    "m": "#c98b00",  # amber mid
    "d": "#7a5300",  # amber dark
    "c": "#5fd7ff",  # cyan
    "g": "#4dff9a",  # green
    "r": "#ff5f56",  # red
    "w": "#efe9dc",  # white
    "k": "#120d02",  # ink
    "t1": "#1f1910",  # tower
    "t2": "#2b2316",  # tower edge
    "t0": "#16120b",  # far tower
    "h1": "#1a140a",  # horizon glow, dither
    "h2": "#241a09",
    "mt": "#120f0a",  # mountains
    "gr": "#0e0c08",  # ground
    "ch": "#1d4552",  # cyan halo
    "s1": "#5d564a",  # dim star (hero sky)
    "s2": "#7a5d1c",  # dim amber star
    "s3": "#285e6c",  # dim cyan star
    "s4": "#8f8778",  # brighter star
}


def runs(grid, ox=0, oy=0):
    """A {(x, y): colour} grid as one <path> per colour, each pixel row merged into runs."""
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
    return "".join(f'<path fill="{COL[c]}" d="{"".join(d)}"/>' for c, d in paths.items())


# ---------------------------------------------------------------------------- elephant


def _in_ellipse(x, y, cx, cy, rx, ry):
    return ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1


def _blob(points, r0, r1):
    """Pixels within a thick polyline whose radius tapers from r0 to r1."""
    px = set()
    n = len(points) - 1
    for i in range(n):
        (x0, y0), (x1, y1) = points[i], points[i + 1]
        steps = 12
        for s in range(steps + 1):
            t = (i + s / steps) / n
            x = x0 + (x1 - x0) * s / steps
            y = y0 + (y1 - y0) * s / steps
            r = r0 + (r1 - r0) * t
            for gx in range(int(x - r - 1), int(x + r + 2)):
                for gy in range(int(y - r - 1), int(y + r + 2)):
                    if (gx + 0.5 - x) ** 2 + (gy + 0.5 - y) ** 2 <= r * r:
                        px.add((gx, gy))
    return px


def elephant(frame):
    """One walk-cycle frame (0 or 1) of the elephant, 42 x 27, facing right; feet on row 26."""
    body = set()
    for x in range(42):
        for y in range(27):
            if (
                _in_ellipse(x, y, 15.5, 13.5, 11.5, 7.8)  # body
                or _in_ellipse(x, y, 28.5, 10, 6.8, 6.8)  # head
                or _in_ellipse(x, y, 27.5, 5.8, 4.2, 3.4)  # crown
            ):
                body.add((x, y))
    trunk = _blob([(33, 11), (34.6, 14), (35.2, 17), (35.2, 20), (35.8, 22.6), (37.6, 23.6), (39.2, 22.4)], 2.3, 1.1)
    tail = _blob([(4.6, 11), (3.2, 14), (2.6, 17)], 0.8, 0.6)
    ear = {(x, y) for x in range(42) for y in range(27) if _in_ellipse(x, y, 24.6, 11.2, 4.6, 6.2)}

    # Legs: near pair in amber, far pair one shade darker; the stepping pair lifts and swings.
    near, far = [(7, 18), (20, 18)], [(11, 18), (24, 18)]
    swing = [(1, -1), (-1, 0)] if frame == 0 else [(-1, 0), (1, -1)]
    legs_near, legs_far = set(), set()
    for i, (lx, ly) in enumerate(near):
        dx, lift = swing[i % 2]
        for x in range(lx + dx, lx + dx + 4):
            for y in range(ly, 26 + lift + 1):
                legs_near.add((x, y))
    for i, (lx, ly) in enumerate(far):
        dx, lift = swing[(i + 1) % 2]
        for x in range(lx + dx, lx + dx + 4):
            for y in range(ly, 26 + lift + 1):
                legs_far.add((x, y))

    g = {}
    for p in legs_far:
        g[p] = "m"
    for p in body | trunk | tail:
        g[p] = "a"
    for p in legs_near:
        g[p] = "a"
    # Shading: light on top edges, dark underneath.
    solid = set(g)
    for (x, y), c in list(g.items()):
        if c != "a":
            continue
        if (x, y - 1) not in solid:
            g[(x, y)] = "l"
        elif (x, y + 1) not in solid and y < 25:
            g[(x, y)] = "d"
    # Ear: a darker flap with a light rim on its front edge.
    for p in ear:
        g[p] = "m"
    for x, y in ear:
        if (x + 1, y) not in ear:
            g[(x, y)] = "l"
        elif (x, y + 1) not in ear:
            g[(x, y)] = "d"
    # The shadow side of the near legs keeps them apart from each other.
    for x, y in legs_near:
        if (x + 1, y) not in legs_near and y > 19:
            g[(x, y)] = "m"
    # Toenails, tail tuft, tusk, eye.
    for lx, _ in near:
        dx = swing[near.index((lx, _)) % 2][0]
        lift = swing[near.index((lx, _)) % 2][1]
        for x in (lx + dx + 1, lx + dx + 3):
            g[(x, 26 + lift)] = "l"
    for p in [(1, 17), (2, 18), (3, 18), (2, 17)]:
        g[p] = "d"
    for p in [(31, 15), (32, 15), (33, 16), (34, 16)]:
        g[p] = "w"
    g[(31, 8)] = "k"
    g[(31, 7)] = "k"
    return g


def orb():
    """The memory the elephant carries: a cyan crystal in a soft halo (7 x 7, centre 3,3)."""
    g = {}
    for x in range(7):
        for y in range(7):
            d = abs(x - 3) + abs(y - 3)
            if d <= 1:
                g[(x, y)] = "w" if d == 0 else "c"
            elif d == 2:
                g[(x, y)] = "c" if x == 3 or y == 3 else "ch"
            elif d == 3 and (x + y) % 2 == 0:
                g[(x, y)] = "ch"
    return g


# ---------------------------------------------------------------------------- scene


def scene():
    rng = random.Random(7)
    parts = []

    # Horizon glow: dithered bands above the skyline, as checkerboard patterns.
    parts.append(
        "<defs>"
        '<pattern id="dz1" width="4" height="4" patternUnits="userSpaceOnUse">'
        f'<rect width="1" height="1" fill="{COL["h1"]}"/><rect x="2" y="2" width="1" height="1" fill="{COL["h1"]}"/></pattern>'
        '<pattern id="dz2" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'<rect width="1" height="1" fill="{COL["h1"]}"/><rect x="1" y="1" width="1" height="1" fill="{COL["h1"]}"/></pattern>'
        '<pattern id="dz3" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'<rect width="1" height="1" fill="{COL["h2"]}"/><rect x="1" y="1" width="1" height="1" fill="{COL["h2"]}"/></pattern>'
        "</defs>"
        f'<rect y="58" width="{W}" height="8" fill="url(#dz1)"/>'
        f'<rect y="66" width="{W}" height="8" fill="url(#dz2)"/>'
        f'<rect y="74" width="{W}" height="{GROUND - 74}" fill="url(#dz3)"/>'
    )

    # Stars, in three groups that twinkle out of step.
    for gi in range(3):
        stars = {}
        for _ in range(26):
            x, y = rng.randrange(W), rng.randrange(2, 54)
            colour = rng.choice(["w", "w", "l", "c"])
            if clear_of_text(x):
                stars[(x, y)] = colour
        parts.append(f'<g class="tw tw{gi}">{runs(stars)}</g>')
    # A few bright cross-shaped stars, either side of the text.
    for x, y in [(38, 12), (74, 8), (98, 34), (226, 12), (244, 44), (297, 40)]:
        parts.append(f'<g class="tw tw{(x // 7) % 3}">' + runs({(x, y): "w", (x - 1, y): "l", (x + 1, y): "l", (x, y - 1): "l", (x, y + 1): "l"}) + "</g>")

    # Moon with craters.
    moon = {}
    cx, cy, r = 262, 20, 10
    for x in range(cx - r - 1, cx + r + 2):
        for y in range(cy - r - 1, cy + r + 2):
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if d <= r:
                moon[(x, y)] = "l" if (x - cx) + (y - cy) < -6 else "a"
                if d > r - 1.2 and (x - cx) + (y - cy) > 4:
                    moon[(x, y)] = "m"
    for (mx, my, mr) in [(258, 16, 2), (266, 24, 2.6), (264, 14, 1.2), (256, 24, 1.3)]:
        for x in range(int(mx - mr - 1), int(mx + mr + 2)):
            for y in range(int(my - mr - 1), int(my + mr + 2)):
                if math.hypot(x + 0.5 - mx, y + 0.5 - my) <= mr and (x, y) in moon:
                    moon[(x, y)] = "m"
    parts.append(f'<g class="moon">{runs(moon)}</g>')

    # Distant mountains.
    mts = {}
    peaks = [(0, 70), (30, 58), (55, 66), (88, 54), (120, 64), (150, 57), (185, 67), (220, 55), (250, 63), (285, 56), (320, 66)]
    for i in range(len(peaks) - 1):
        (x0, y0), (x1, y1) = peaks[i], peaks[i + 1]
        for x in range(x0, x1):
            top = round(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
            for y in range(top, GROUND):
                mts[(x, y)] = "mt"
    parts.append(runs(mts))

    # Skyline of data towers, far row then near row, with lit windows (some blink) and beacons.
    for row, (tcol, edge, lo, hi, wmin, wmax) in enumerate([("t0", "t0", 14, 26, 8, 14), ("t1", "t2", 10, 36, 7, 13)]):
        x = rng.randrange(-6, 0)
        towers, windows, blink, beacons = {}, {}, {}, {}
        while x < W:
            w = rng.randrange(wmin, wmax)
            gap = rng.randrange(1, 5) if row else rng.randrange(0, 3)
            h = rng.randrange(lo, hi)
            top = GROUND - h - (6 if row == 0 else 0)
            for tx in range(x, x + w):
                for ty in range(top, GROUND):
                    towers[(tx, ty)] = edge if tx == x + w - 1 and row else tcol
            if row:
                for wy in range(top + 2, GROUND - 2, 3):
                    for wx in range(x + 2, x + w - 2, 2):
                        roll = rng.random()
                        if roll < 0.32:
                            windows[(wx, wy)] = "d"
                        elif roll < 0.4:
                            windows[(wx, wy)] = "a"
                        elif roll < 0.44:
                            blink[(wx, wy)] = rng.choice(["a", "c"])
                if h > 26:
                    for ay in range(top - 4, top):
                        towers[(x + w // 2, ay)] = edge
                    beacons[(x + w // 2, top - 5)] = "r"
            x += w + gap
        parts.append(runs(towers))
        if row:
            parts.append(runs(windows))
            parts.append(f'<g class="blink">{runs(blink)}</g>')
            parts.append(f'<g class="beacon">{runs(beacons)}</g>')

    # Memories rising out of the towers.
    for i in range(16):
        x = rng.randrange(8, W - 8)
        if not clear_of_text(x):  # they rise 46 pixels: keep them beside the text
            x = x - 104 if x < W // 2 else x + 104
        y = rng.randrange(56, 78)
        c = COL[rng.choice(["c", "a", "l", "c"])]
        size = rng.choice([1, 1, 2])
        # Timing comes from six classes in site.css: the CSP allows no inline style.
        parts.append(
            f'<rect class="mem mem{i % 6}" x="{x}" y="{y}" width="{size}" height="{size}" fill="{c}"/>'
        )

    # Ground: a dark band with an amber-dark seam and scattered pixels.
    ground = {}
    for x in range(W):
        for y in range(GROUND, H):
            ground[(x, y)] = "gr"
        if x % 3 != 2:
            ground[(x, GROUND)] = "d"
    for _ in range(40):
        ground[(rng.randrange(W), rng.randrange(GROUND + 3, H))] = rng.choice(["d", "t1", "t2"])
    parts.append(runs(ground))

    # The elephant (two walk frames) carrying a memory, walking left to right.
    ex, ey = 140, GROUND - 26
    frames = "".join(f'<g class="ef ef{i}">{runs(elephant(i))}</g>' for i in range(2))
    carried = f'<g class="orb">{runs(orb(), 36, 14)}</g>'
    parts.append(
        f'<g class="walker"><g transform="translate({ex} {ey})">{frames}{carried}</g></g>'
    )

    return (
        f'<svg class="scene-svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMax slice" '
        f'shape-rendering="crispEdges" aria-hidden="true">' + "".join(parts) + "</svg>"
    )


def hero_sky():
    """The hero's backdrop: a sparse pixel night sky over a dithered amber glow, the same night
    as the scene further down. Dim on purpose; only the stars move (opacity)."""
    w, h = 240, 120
    rng = random.Random(11)
    parts = [
        "<defs>"
        '<pattern id="hz1" width="4" height="4" patternUnits="userSpaceOnUse">'
        f'<rect width="1" height="1" fill="{COL["h1"]}"/><rect x="2" y="2" width="1" height="1" fill="{COL["h1"]}"/></pattern>'
        '<pattern id="hz2" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'<rect width="1" height="1" fill="{COL["h1"]}"/><rect x="1" y="1" width="1" height="1" fill="{COL["h1"]}"/></pattern>'
        '<pattern id="hz3" width="2" height="2" patternUnits="userSpaceOnUse">'
        f'<rect width="1" height="1" fill="{COL["h2"]}"/><rect x="1" y="1" width="1" height="1" fill="{COL["h2"]}"/></pattern>'
        "</defs>"
        f'<rect class="hz" y="74" width="{w}" height="14" fill="url(#hz1)"/>'
        f'<rect class="hz" y="88" width="{w}" height="14" fill="url(#hz2)"/>'
        f'<rect class="hz" y="102" width="{w}" height="{h - 102}" fill="url(#hz3)"/>'
    ]
    # Sparse stars in three groups that twinkle out of step, thinning towards the glow.
    for gi in range(3):
        stars = {}
        for _ in range(16):
            x, y = rng.randrange(w), int(2 + (rng.random() ** 1.6) * 80)
            stars[(x, y)] = rng.choice(["s1", "s1", "s2", "s3"])
        parts.append(f'<g class="tw tw{gi}">{runs(stars)}</g>')
    # Three brighter cross-shaped stars.
    for x, y in [(31, 9), (118, 22), (203, 6)]:
        cross = {(x, y): "s4", (x - 1, y): "s1", (x + 1, y): "s1", (x, y - 1): "s1", (x, y + 1): "s1"}
        parts.append(f'<g class="tw tw{(x // 7) % 3}">{runs(cross)}</g>')
    return (
        f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="xMidYMid slice" '
        f'shape-rendering="crispEdges" aria-hidden="true">' + "".join(parts) + "</svg>"
    )


if __name__ == "__main__":
    print(scene())
