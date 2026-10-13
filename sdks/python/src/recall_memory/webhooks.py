"""Webhook endpoints (``recall.webhooks``) and verification of the deliveries Recall sends.

Every delivery carries an ``X-Recall-Signature`` header: the lowercase hex HMAC-SHA256 of the exact
request body, keyed with the server's webhook secret. Verify the *raw* body before parsing it.
"""

from __future__ import annotations

import hmac
import json
from collections.abc import Generator
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any

from pydantic import Field

from ._core import (
    AsyncMode,
    Dual,
    Request,
    Response,
    SyncMode,
    as_dual,
    dual_operation,
    operation,
)
from ._util import seg, ws_path
from .errors import RecallError
from .models import WebhookEndpoint, _Base
from .pagination import AsyncPage, SyncPage, fetch_page

__all__ = [
    "SIGNATURE_HEADER",
    "WebhookEvent",
    "Webhooks",
    "WebhooksAio",
    "WebhooksBase",
    "construct_webhook_event",
    "verify_webhook_signature",
]

SIGNATURE_HEADER = "X-Recall-Signature"


class WebhookEvent(_Base):
    """A verified delivery: ``type`` is ``queue.empty`` or ``test.event``; ``data`` varies by type."""

    type: str
    timestamp: str
    data: dict[str, Any] = Field(default_factory=dict)


def verify_webhook_signature(body: str | bytes, signature: str | None, secret: str) -> bool:
    """True when ``signature`` is the right HMAC of ``body`` under ``secret`` (never raises)."""
    if not signature or not secret:
        return False
    raw = body.encode() if isinstance(body, str) else bytes(body)
    expected = hmac.new(secret.encode(), raw, sha256).hexdigest()
    given = signature.strip().lower().removeprefix("sha256=")
    return hmac.compare_digest(expected, given)


def construct_webhook_event(
    body: str | bytes,
    signature: str | None,
    secret: str,
    *,
    tolerance_seconds: float | None = None,
    now: datetime | None = None,
) -> WebhookEvent:
    """Check the signature and return the parsed event, or raise ``RecallError``.

    With ``tolerance_seconds`` events whose timestamp is further from ``now`` are rejected too,
    which limits replay of captured deliveries.
    """
    if not verify_webhook_signature(body, signature, secret):
        raise RecallError("Webhook signature does not match", code="invalid_signature")
    try:
        event = WebhookEvent.model_validate(json.loads(body))
    except ValueError as exc:
        raise RecallError("Webhook body is not a valid event", code="invalid_body") from exc
    if tolerance_seconds is not None:
        sent: datetime | None
        try:
            sent = datetime.fromisoformat(event.timestamp.replace("Z", "+00:00"))
        except ValueError:
            sent = None
        current = now or datetime.now(timezone.utc)
        if sent is None or abs((current - sent).total_seconds()) > tolerance_seconds:
            raise RecallError(
                "Webhook timestamp is outside the tolerance window", code="stale_event"
            )
    return event


class WebhooksBase:
    """The workspace's webhook endpoints (at most 10; every event goes to all of them)."""

    def __init__(self, client: Any) -> None:
        self._core = client._core

    @classmethod
    def _make(cls, core: Any) -> Any:
        self = cls.__new__(cls)
        self._core = core
        return self

    def _path(self, suffix: str = "") -> str:
        return ws_path(self._core.workspace_id, f"/webhooks{suffix}")

    @operation
    def create(self, url: str) -> Generator[Request, Response, WebhookEndpoint]:
        """Register ``url`` (idempotent per URL). The workspace must already exist."""
        resp = yield Request("POST", self._path(), json={"url": url})
        return WebhookEndpoint.model_validate(resp.body)

    @dual_operation
    def list(
        self, *, page: int = 1, size: int = 50
    ) -> Generator[
        Request,
        Response,
        Dual[
            SyncPage[WebhookEndpoint, WebhookEndpoint], AsyncPage[WebhookEndpoint, WebhookEndpoint]
        ],
    ]:
        def build(n: int) -> Request:
            return Request("GET", self._path(), params={"page": n, "size": size})

        result = yield from fetch_page(
            self._core,
            is_async=self._is_async,  # type: ignore[attr-defined]
            build=build,
            parse=WebhookEndpoint.model_validate,
            wrap=lambda e: e,
            page=page,
            size=size,
        )
        return as_dual(result)

    @operation
    def delete(self, endpoint: str | WebhookEndpoint) -> Generator[Request, Response, None]:
        endpoint_id = endpoint if isinstance(endpoint, str) else endpoint.id
        yield Request("DELETE", self._path(f"/{seg(endpoint_id)}"), missing_ok_on_retry=True)

    @operation
    def test(self) -> Generator[Request, Response, None]:
        """Ask the server to send a ``test.event`` to every endpoint."""
        yield Request("GET", self._path("/test"))


class Webhooks(WebhooksBase, SyncMode):
    @property
    def aio(self) -> WebhooksAio:
        twin = WebhooksAio.__new__(WebhooksAio)
        twin.__dict__.update(self.__dict__)
        return twin


class WebhooksAio(WebhooksBase, AsyncMode):
    pass
