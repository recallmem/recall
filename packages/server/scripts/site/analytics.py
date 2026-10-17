"""The Umami tracker tag on the site's pages: cookieless analytics, self-hosted at stats.recallmem.dev
and loaded from the site's own origin (/u/script.js and /u/api/send are rewritten to it in vercel.json),
so the pages' CSP stays script-src 'self' and connect-src 'self'. The website id is in analytics.json;
without one the pages carry no tag. guides.mjs reads the same file and stamps its pages the same way.
"""

import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
WEBSITE_ID = json.loads((HERE / "analytics.json").read_text())["umamiWebsiteId"].strip()
if WEBSITE_ID and not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", WEBSITE_ID):
    raise SystemExit("analytics.json: umamiWebsiteId must be the website's UUID in Umami")

TAG = f'<script defer src="/u/script.js" data-website-id="{WEBSITE_ID}" data-host-url="/u"></script>' if WEBSITE_ID else ""
_OLD = re.compile(r'<script defer src="/u/script\.js"[^>]*></script>\n')


def stamp(page):
    """The page with exactly the current tag (or none) just before </body>."""
    page = _OLD.sub("", page)
    return page.replace("</body>", f"{TAG}\n</body>", 1) if TAG else page
