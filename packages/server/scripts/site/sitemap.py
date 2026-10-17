"""Writes public/sitemap.xml: every page of the site that names a canonical URL, home first.

Run it after adding or removing a page (from packages/server): python3 scripts/site/sitemap.py
test/site.test.ts fails while the sitemap and the pages disagree.
"""

import pathlib
import re

PUBLIC = pathlib.Path(__file__).resolve().parents[2] / "public"
CANONICAL = re.compile(r'<link rel="canonical" href="(https://recallmem\.dev/[^"]*)"\s*/?>')


def urls():
    found = set()
    for f in PUBLIC.rglob("*.html"):
        m = CANONICAL.search(f.read_text())
        if m:
            found.add(m.group(1))
    return sorted(found, key=lambda u: (u != "https://recallmem.dev/", u.count("/"), u))


def main():
    body = "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls())
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}</urlset>\n"
    )
    (PUBLIC / "sitemap.xml").write_text(xml)
    print("public/sitemap.xml:", body.count("<url>"), "pages")


if __name__ == "__main__":
    main()
