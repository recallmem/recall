"""Queue status and ``wait_for_idle``, shared by the client and ``Session``."""

from __future__ import annotations

import time
from collections.abc import Generator
from typing import Any

from ._core import ClientCore, Request, Response, Sleep
from ._util import rid, ws_path
from .errors import NotFoundError, RecallTimeoutError
from .models import QueueStatusResponse

#: Longest single long-poll. Kept well under common 60 s proxy idle timeouts.
LONG_POLL_SECONDS = 25.0


def status_request(
    core: ClientCore,
    *,
    observer: Any = None,
    sender: Any = None,
    session: Any = None,
    wait_ms: int | None = None,
    timeout: float | None = None,
) -> Request:
    return Request(
        "GET",
        ws_path(core.workspace_id, "/queue/status"),
        params={
            "observer_id": None if observer is None else rid(observer),
            "sender_id": None if sender is None else rid(sender),
            "session_id": None if session is None else rid(session),
            "wait_ms": wait_ms or None,
        },
        timeout=timeout,
    )


def queue_status_gen(
    core: ClientCore, *, observer: Any = None, sender: Any = None, session: Any = None
) -> Generator[Request, Response, QueueStatusResponse]:
    resp = yield status_request(core, observer=observer, sender=sender, session=session)
    return QueueStatusResponse.model_validate(resp.body)


def wait_for_idle_gen(
    core: ClientCore,
    *,
    timeout: float,
    observer: Any = None,
    sender: Any = None,
    session: Any = None,
) -> Generator[Request, Response, QueueStatusResponse]:
    """Block (server-side long-poll) until background work for the scope has finished.

    The server holds each ``queue/status?wait_ms=`` request until the scope is idle or the wait
    elapses, flushes batched work so it starts immediately, and says which of the two happened in
    the ``idle`` field (a dream scheduled for later is "pending" in the counts but does not keep
    the scope busy). Raises ``RecallTimeoutError`` if work is still running at ``timeout``.
    """
    deadline = time.monotonic() + timeout
    while True:
        remaining = max(0.0, deadline - time.monotonic())
        window = min(remaining, LONG_POLL_SECONDS)
        wait_ms = int(window * 1000)
        started = time.monotonic()
        try:
            resp = yield status_request(
                core,
                observer=observer,
                sender=sender,
                session=session,
                wait_ms=wait_ms,
                timeout=window + 10.0,
            )
        except NotFoundError:
            return QueueStatusResponse()  # no such workspace yet, so nothing can be queued
        status = QueueStatusResponse.model_validate(resp.body)
        if status.idle is True or (status.idle is None and status.is_idle):
            return status
        instant = (time.monotonic() - started) < 0.2
        # Servers that predate the `idle` flag: a request that came back before its wait elapsed
        # means the scope went idle, even if a dream scheduled for later still counts as pending.
        returned_early = wait_ms >= 50 and (time.monotonic() - started) < window * 0.8
        if status.idle is None and returned_early and status.in_progress_work_units == 0:
            return status
        if remaining <= window:
            raise RecallTimeoutError(
                f"Background work still running after {timeout:g}s "
                f"({status.pending_work_units} pending, {status.in_progress_work_units} in progress)"
            )
        if instant:
            # A server that ignores `wait_ms` answers at once; do not spin on it.
            yield Sleep(0.25)  # type: ignore[misc]
