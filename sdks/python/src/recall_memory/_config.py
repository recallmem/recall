"""Constructor argument and environment resolution (shared by sync and async clients)."""

from __future__ import annotations

import os

# Recall's hosted API. Self-hosters set RECALL_URL (or base_url=...) to their own server instead.
DEFAULT_BASE_URL = "https://api.recallmem.dev"
DEFAULT_WORKSPACE = "default"
DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 2

# Only RECALL_* variables are read. Variables that belong to other products are never consulted,
# so a key meant for another service is never sent to Recall.
URL_ENV = ("RECALL_URL", "RECALL_BASE_URL")
API_KEY_ENV = ("RECALL_API_KEY",)
WORKSPACE_ENV = ("RECALL_WORKSPACE_ID", "RECALL_WORKSPACE")


def env_first(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value is not None and value.strip():
            return value.strip()
    return None


def resolve_base_url(base_url: str | None) -> str:
    """``base_url`` > ``RECALL_URL`` / ``RECALL_BASE_URL`` > the hosted API."""
    if base_url:
        return base_url.rstrip("/")
    return (env_first(*URL_ENV) or DEFAULT_BASE_URL).rstrip("/")


def resolve_workspace(workspace_id: str | None) -> str:
    value = workspace_id if workspace_id is not None else env_first(*WORKSPACE_ENV)
    value = value if value is not None else DEFAULT_WORKSPACE
    if not value:
        raise ValueError("workspace_id must be a non-empty string")
    return value


def resolve_api_key(api_key: str | None) -> str | None:
    return api_key if api_key else env_first(*API_KEY_ENV)


def resolve_timeout(timeout: float | None) -> float:
    value = DEFAULT_TIMEOUT if timeout is None else float(timeout)
    if value <= 0:
        raise ValueError("timeout must be greater than 0 (seconds)")
    return value


def resolve_max_retries(max_retries: int | None) -> int:
    value = DEFAULT_MAX_RETRIES if max_retries is None else int(max_retries)
    if value < 0:
        raise ValueError("max_retries must be >= 0")
    return value
