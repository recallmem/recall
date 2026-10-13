"""The customer price list, read from the defaults in src/config.ts (RECALL_PRICE_* and
RECALL_SIGNUP_CREDIT_USD), the one place they are set, so the site never shows a stale price."""

import pathlib
import re

CONFIG = pathlib.Path(__file__).resolve().parents[2] / "src" / "config.ts"
KEYS = {
    "ingest_per_mtok": "RECALL_PRICE_INGEST_PER_MTOK_USD",
    "ingest_min_tokens": "RECALL_PRICE_INGEST_MIN_TOKENS",
    "minimal": "RECALL_PRICE_CHAT_MINIMAL_USD",
    "low": "RECALL_PRICE_CHAT_LOW_USD",
    "medium": "RECALL_PRICE_CHAT_MEDIUM_USD",
    "high": "RECALL_PRICE_CHAT_HIGH_USD",
    "max": "RECALL_PRICE_CHAT_MAX_USD",
    "signup_credit": "RECALL_SIGNUP_CREDIT_USD",
}


def _read():
    src = CONFIG.read_text()
    found = dict(re.findall(r"(RECALL_[A-Z_]+): z\.coerce\.number\(\)[^\n]*?\.default\(([\d.]+)\)", src))
    missing = [env for env in KEYS.values() if env not in found]
    if missing:
        raise SystemExit(f"src/config.ts: no default found for {', '.join(missing)}")
    return {k: float(found[env]) for k, env in KEYS.items()}


PRICES = _read()
LEVELS = ["minimal", "low", "medium", "high", "max"]


def usd(x):
    """A price as the site shows it: $5, $1.75, $0.03, $0.0005 (no trailing zeros)."""
    s = f"{x:.4f}".rstrip("0").rstrip(".")
    cents = s.partition(".")[2]
    if len(cents) == 1:
        s += "0"
    return f"${s}"


def usd2(x):
    """A total in dollars and cents: $3.25."""
    return f"${x:,.2f}"
