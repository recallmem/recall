#!/usr/bin/env python3
"""Summarise a meter-proxy log: calls, tokens and USD per endpoint and model.

Usage: summarize-tokens.py <log.jsonl> [since ISO time] [until ISO time]
Prices come from openai-prices.json next to this file (USD per 1M tokens); lines written by the
current meter-proxy carry their own cost_usd, which wins. Run with `python3 -I`.
"""
import collections
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
prices = {k: v for k, v in json.load(open(os.path.join(here, "openai-prices.json"))).items() if not k.startswith("_")}


def price_for(model):
    best = None
    for key in prices:
        if model == key or (model or "").startswith(key + "-"):
            if best is None or len(key) > len(best):
                best = key
    return prices.get(best)


def cost_of(r):
    if "cost_usd" in r:
        return r["cost_usd"] or 0.0
    p = price_for(r.get("model"))
    if not p:
        return 0.0
    cached = min(r.get("cached_tokens", 0), r.get("prompt_tokens", 0))
    written = min(r.get("cache_write_tokens", 0), r.get("prompt_tokens", 0) - cached)
    return ((r["prompt_tokens"] - cached - written) * p["input"] + cached * p["cached"]
            + written * p.get("cacheWrite", p["input"]) + r["completion_tokens"] * p["output"]) / 1e6


rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
since = sys.argv[2] if len(sys.argv) > 2 else ""
until = sys.argv[3] if len(sys.argv) > 3 else "9999"
rows = [r for r in rows if since <= r["at"] < until]
agg = collections.defaultdict(lambda: [0, 0, 0, 0, 0, 0, 0, 0.0, 0])
for r in rows:
    k = (r["path"].split("?")[0].replace("/v1/", ""), r["model"])
    a = agg[k]
    a[0] += 1
    a[1] += r.get("prompt_tokens", 0)
    a[2] += r.get("cached_tokens", 0)
    a[3] += r.get("completion_tokens", 0)
    a[4] += r.get("reasoning_tokens", 0)
    a[5] += 1 if r.get("usage_missing") else 0
    a[6] += 1 if r.get("status", 200) >= 400 else 0
    a[7] += cost_of(r)
    a[8] += r.get("cache_write_tokens", 0)
total = 0.0
for k, a in sorted(agg.items(), key=lambda kv: -kv[1][7]):
    total += a[7]
    print(f"{k[0]:18} {str(k[1]):24} calls {a[0]:6}  in {a[1]:12,}  cached {a[2]:11,}  written {a[8]:11,}  out {a[3]:10,} (reasoning {a[4]:9,})  no-usage {a[5]}  errors {a[6]}  ${a[7]:.4f}")
print(f"total ${total:.4f}")
