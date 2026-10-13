"""Pixel-art sprites for the Recall site, rendered as crisp inline SVG."""
import json
import sys

PAL = {
    "a": "#ffb000",  # amber
    "d": "#7a5300",  # amber dark
    "m": "#c98b00",  # amber mid
    "l": "#ffcb4d",  # amber light
    "c": "#5fd7ff",  # cyan
    "g": "#4dff9a",  # green
    "r": "#ff5f56",  # red
    "w": "#efe9dc",  # white
    "k": "#120d02",  # ink
}

S = {}

S["heart"] = """
................
................
..aaa.....aaa...
.alllaa..alaaa..
.allaaaaaaaaaad.
.alaaaaaaaaaaad.
.aaaaaaaaaaaaad.
..aaaaaaaaaaad..
...aaaaaaaaad...
....aaaaaaad....
.....aaaaad.....
......aaad......
.......ad.......
................
""".strip().split()

S["terminal"] = """
aaaaaaaaaaaaaaaa
akkkkkkkkkkkkkka
akwkkkkkkkkkkkka
akkwkkkkkkkkkkka
akkkwkkkkkkkkkka
akkwkkkkkkkkkkka
akwkkkkllllkkkka
akkkkkkkkkkkkkka
aaaaaaaaaaaaaaaa
......dddd......
....dddddddd....
""".strip().split()

S["chat"] = """
.aaaaaaaaaaaaaa.
aallllllllllllda
alkkkkkkkkkkkkda
alkcckcckcckkkda
alkkkkkkkkkkkkda
alkkkkkkkkkkkkda
adddddddddddddda
.dddaad.........
...aad..........
..ad............
""".strip().split()

S["cap"] = """
.......aa.......
.....aallaa.....
...aallllllaa...
.aallllllllllaa.
...aaaaaaaaaaa.c
....dddddddddd.c
....ad......da.c
....ad......da.c
....aaaaaaaaaa.cc
...............cc
""".strip().split()

S["chart"] = """
.............gg.
.............gg.
.........aa..gg.
.........aa..gg.
.....aa..aa..gg.
.....aa..aa..gg.
.aa..aa..aa..gg.
.aa..aa..aa..gg.
.aa..aa..aa..gg.
dddddddddddddddd
""".strip().split()

S["pad"] = """
................
..aaaaaaaaaaaa..
.aallllllllllaa.
aalkkalkkkkkcala
alkaaakkkkcklcda
alkkakkkkkkcklda
alkkkkkkkkkkkkda
adddaaaaaaaaddda
.dda........add.
""".strip().split()

S["shield"] = """
......aaaa......
...aaallllaaa...
.aallllllllllaa.
.alllllllllllda.
.allllgllllllda.
.allllggllllgda.
.alllllgllgglda.
..allllggggldd..
...alllllllda...
....aaalldaa....
......aada......
""".strip().split()

S["retry"] = """
.....aaaaaa.....
...aa......aa...
..a..........a..
.a...........aaa
.a............aa
a.............a.
a...............
a..............a
.a............a.
aa............a.
aaa...........a.
..a..........a..
...aa......aa...
.....aaaaaa.....
""".strip().split()

S["meter"] = """
................
..............g.
.............gg.
............g...
....a......g....
...aa.....g.....
..a..a...g......
.a....a.g.......
a......g........
dddddddddddddddd
""".strip().split()

S["clock"] = """
.....aaaaaa.....
...aallllllaa...
..allllallllla..
.alllllallllllad
.alllllallllllad
alllllaallllllad
allllllaaaallllad
alllllllllllllad
.allllllllllllad
.alllllllllllld.
..alllllllllld..
...aaddddddaa...
.....dddddd.....
""".strip().split()

S["bell"] = """
.......aa.......
.....aallaa.....
....alllllla....
...allllllllad..
...allllllllad..
...allllllllad..
..alllllllllldd.
..alllllllllldd.
.aaaaaaaaaaaaaad
.......aa.......
......c..c......
.....c....c.....
""".strip().split()

S["nodes"] = """
............aaa.
...........alla.
..........aaaa..
.........a......
..aaa...a.......
.allaaaa........
.aaaa...a.......
.........a......
..........cccc..
...........clc..
............ccc.
""".strip().split()

S["plug"] = """
....aa....aa....
....aa....aa....
....aa....aa....
..aaaaaaaaaaaa..
..alllllllllld..
..alllllllllld..
..alllllllllld..
...alllllllld...
....alllllld....
.....alllld.....
......aadd......
.......cc.......
.......cc.......
.......cc.......
""".strip().split()

S["braces"] = """
...aaa....aaa...
..alla....alla..
..alla....alla..
..alla....alla..
.alla......alla.
alla...cc...alla
.alla..cc..alla.
..alla....alla..
..alla....alla..
..alla....alla..
...aaa....aaa...
""".strip().split()

S["claw"] = """
.rr..........rr.
rrrr........rrrr
rr.rr......rr.rr
rr..rrrrrrrr..rr
.rr.rrrrrrrr.rr.
..rrrrkrrkrrrr..
....rrrrrrrr....
...rrrrrrrrrr...
....rrrrrrrr....
...rr.rrrr.rr...
..rr..r..r..rr..
""".strip().split()

S["wing"] = """
..............aa
...........aaall
........aaalllla
.....aaalllllaad
...aalllllllaad.
..alllllllaad...
.alllllllad.....
.allllllad......
..aalllad.......
...aaad.........
....dd..........
""".strip().split()

S["scroll"] = """
..aaaaaaaaaaaa..
..alccccccclld..
..alllllllllld..
..alccccclllld..
..alllllllllld..
..alccccccclld..
..alllllllllld..
..alccccclllld..
..alllllllllld..
..alccccccclld..
..alllllllllld..
..alccccclllld..
..dddddddddddd..
""".strip().split()

S["port"] = """
..aaaaaaaaaaaa..
..alllllllllld..
..alkkkkkkkkld..
..alkakakakkld..
..alkkkkkkkkld..
..alllllllllld..
..dddddddddddd..
....cc....cc....
....cc....cc....
....cc....cc....
""".strip().split()


def elephant_logo():
    """The logo: the night scene's elephant (first walk frame) carrying its memory, 43 x 27."""
    from scene import elephant, orb  # scene does not import this module

    grid = dict(elephant(0))
    grid.update({(x + 36, y + 14): c for (x, y), c in orb().items() if c != "ch"})
    x0, y0 = min(x for x, _ in grid), min(y for _, y in grid)
    x1, y1 = max(x for x, _ in grid), max(y for _, y in grid)
    return ["".join(grid.get((x, y), ".") for x in range(x0, x1 + 1)) for y in range(y0, y1 + 1)]


S["logo"] = elephant_logo()

# The favicon: the elephant redrawn for 16 x 16, where every pixel has to count.
S["mark"] = """
................
................
................
..........llll..
...lllllllaaaal.
..laaaaaamaaaka.
.laaaaaammmaaaa.
.aaaaaaammmaaaa.
.aaaaaaaammaaaw.
daaaaaaaaaaaaaa.
.aaaaaaaaaaaa.a.
.aa.aa..aa.aa.a.
.aa.aa..aa.aa.a.
.aa.aa..aa.aa.aa
.ll.ll..ll.ll...
................
""".strip().split()


def svg(name, cls="sprite", label=None):
    rows = S[name]
    w = max(len(r) for r in rows)
    h = len(rows)
    rects = []
    for y, row in enumerate(rows):
        x = 0
        while x < len(row):
            ch = row[x]
            if ch == ".":
                x += 1
                continue
            run = 1
            while x + run < len(row) and row[x + run] == ch:
                run += 1
            rects.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{PAL[ch]}"/>')
            x += run
    aria = f'role="img" aria-label="{label}"' if label else 'aria-hidden="true"'
    return (
        f'<svg class="{cls}" {aria} viewBox="0 0 {w} {h}" shape-rendering="crispEdges">'
        + "".join(rects)
        + "</svg>"
    )


if __name__ == "__main__":
    print(json.dumps({k: svg(k) for k in S}))
