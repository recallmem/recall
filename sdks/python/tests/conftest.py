"""Shared helpers: a tiny router on top of ``httpx.MockTransport`` and JSON fixtures."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from recall_memory import AsyncRecall, Recall

BASE = "http://recall.test"
WS = "ws"
NOW = "2026-01-01T00:00:00Z"


class Router:
    """Records every request and answers from registered routes (first match wins)."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self._routes: list[tuple[str, str, Callable[[httpx.Request], httpx.Response]]] = []

    def on(
        self,
        method: str,
        path: str,
        json_body: Any = None,
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
        content: bytes | None = None,
        handler: Callable[[httpx.Request], httpx.Response] | None = None,
    ) -> Router:
        def respond(request: httpx.Request) -> httpx.Response:
            if handler is not None:
                return handler(request)
            if content is not None:
                return httpx.Response(status, content=content, headers=headers)
            if json_body is None:
                return httpx.Response(status, headers=headers)
            return httpx.Response(status, json=json_body, headers=headers)

        self._routes.append((method, path, respond))
        return self

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for method, path, respond in self._routes:
            if request.method == method and request.url.path == path:
                return respond(request)
        raise AssertionError(f"unexpected request {request.method} {request.url}")

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def body(self, index: int = -1) -> Any:
        return json.loads(self.requests[index].content)

    def params(self, index: int = -1) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for k, v in self.requests[index].url.params.multi_items():
            out.setdefault(k, []).append(v)
        return out


def make_client(router: Router, **kwargs: Any) -> Recall:
    kwargs.setdefault("base_url", BASE)
    kwargs.setdefault("workspace_id", WS)
    http = httpx.Client(transport=httpx.MockTransport(router))
    client = Recall(http_client=http, **kwargs)
    client._core.sleep = lambda s: None
    return client


def make_async_client(router: Router, **kwargs: Any) -> AsyncRecall:
    kwargs.setdefault("base_url", BASE)
    kwargs.setdefault("workspace_id", WS)
    http = httpx.AsyncClient(transport=httpx.MockTransport(router))
    client = AsyncRecall(http_client=http, **kwargs)

    async def no_sleep(_: float) -> None:
        return None

    client._core.asleep = no_sleep
    return client


@pytest.fixture
def router() -> Router:
    return Router()


@pytest.fixture
def client(router: Router) -> Recall:
    return make_client(router)


@pytest.fixture
def aclient(router: Router) -> AsyncRecall:
    return make_async_client(router)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "RECALL_URL",
        "RECALL_BASE_URL",
        "RECALL_API_KEY",
        "RECALL_WORKSPACE_ID",
        "RECALL_WORKSPACE",
    ):
        monkeypatch.delenv(name, raising=False)


# ---- JSON fixtures --------------------------------------------------------------------


def peer_json(pid: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": pid,
        "workspace_id": WS,
        "created_at": NOW,
        "metadata": {},
        "configuration": {},
        **extra,
    }


def session_json(sid: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": sid,
        "is_active": True,
        "workspace_id": WS,
        "metadata": {},
        "configuration": {},
        "created_at": NOW,
        **extra,
    }


def message_json(
    mid: str = "m1", peer: str = "alice", content: str = "hi", **extra: Any
) -> dict[str, Any]:
    return {
        "id": mid,
        "content": content,
        "peer_id": peer,
        "session_id": "s1",
        "workspace_id": WS,
        "metadata": {},
        "created_at": NOW,
        "token_count": 1,
        **extra,
    }


def conclusion_json(cid: str = "c1", **extra: Any) -> dict[str, Any]:
    return {
        "id": cid,
        "content": "likes tea",
        "observer_id": "alice",
        "observed_id": "alice",
        "session_id": None,
        "level": "explicit",
        "source_ids": [],
        "times_derived": 1,
        "created_at": NOW,
        **extra,
    }


def page_json(
    items: list[Any], *, page: int = 1, size: int = 50, total: int | None = None
) -> dict[str, Any]:
    total = len(items) if total is None else total
    pages = -(-total // size) if total else 0
    return {"items": items, "total": total, "page": page, "size": size, "pages": pages}
