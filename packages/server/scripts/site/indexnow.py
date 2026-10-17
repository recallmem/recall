"""Tells Bing (and the other IndexNow search engines: Yandex, Seznam, Naver, Yep) about every page in
public/sitemap.xml, so new and changed pages are crawled within days instead of weeks. Bing's index
also serves ChatGPT search, Copilot and DuckDuckGo.

The key is the 32-hex-character .txt file in public/ whose content is its own name; IndexNow fetches
https://recallmem.dev/<key>.txt to check the request comes from the site's owner. Run it after a
deploy that adds or changes pages (from packages/server): python3 scripts/site/indexnow.py
"""

import json
import pathlib
import re
import sys
import urllib.request

PUBLIC = pathlib.Path(__file__).resolve().parents[2] / "public"
HOST = "recallmem.dev"


def key():
    for f in PUBLIC.glob("*.txt"):
        if re.fullmatch(r"[0-9a-f]{32}", f.stem) and f.read_text().strip() == f.stem:
            return f.stem
    raise SystemExit("no IndexNow key file in public/")


def main():
    k = key()
    urls = re.findall(r"<loc>([^<]+)</loc>", (PUBLIC / "sitemap.xml").read_text())
    body = {"host": HOST, "key": k, "keyLocation": f"https://{HOST}/{k}.txt", "urlList": urls}
    req = urllib.request.Request(
        "https://api.indexnow.org/indexnow",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            print(f"IndexNow: {res.status} for {len(urls)} pages")
    except urllib.error.HTTPError as e:
        # 202: accepted, key not yet checked. 403: key file not found or wrong. 422: URLs not on the host.
        print(f"IndexNow: {e.code} {e.read().decode()[:300]}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
