"""``Scope``: a named bag of sessions that acts as an alternate observer.

Adding a session to a scope lets memory be shared (or kept apart) across sessions: a chat or
representation request scoped to it only draws on the member sessions.
"""

from __future__ import annotations

from collections.abc import Generator, Sequence
from datetime import datetime
from typing import TYPE_CHECKING, Any

from ._core import (
    AsyncMode,
    Dual,
    Request,
    Response,
    SyncMode,
    as_dual,
    dual_operation,
    operation,
    register_pair,
)
from ._resource import Handle
from ._util import HasId, rid, seg, ws_path
from .models import ScopeBackfillJob, ScopeResponse, ScopeStatusResponse, SessionResponse
from .pagination import AsyncPage, SyncPage, fetch_page

if TYPE_CHECKING:
    from .session import Session, SessionAio

__all__ = ["Scope", "ScopeAio", "ScopeBase"]

MAX_SESSIONS_PER_CALL = 100


class _ScopeState:
    __slots__ = ("created_at", "metadata")

    def __init__(self, metadata: dict[str, Any] | None, created_at: datetime | None) -> None:
        self.metadata = metadata
        self.created_at = created_at


class ScopeBase(Handle):
    def __init__(
        self,
        scope_id: str,
        client: Any,
        *,
        metadata: dict[str, Any] | None = None,
        created_at: datetime | None = None,
    ) -> None:
        if not scope_id:
            raise ValueError("scope_id must be a non-empty string")
        self._core = client._core
        self.id = scope_id
        self._state = _ScopeState(metadata, created_at)

    @classmethod
    def _make(cls, core: Any, scope_id: str, data: ScopeResponse | None = None) -> Any:
        self = cls.__new__(cls)
        self._core = core
        self.id = scope_id
        self._state = _ScopeState(None, None)
        if data is not None:
            self._state.metadata = data.metadata
            self._state.created_at = data.created_at
        return self

    @property
    def metadata(self) -> dict[str, Any] | None:
        return self._state.metadata

    @property
    def created_at(self) -> datetime | None:
        return self._state.created_at

    def _path(self, suffix: str = "") -> str:
        return ws_path(self._core.workspace_id, f"/scopes/{seg(self.id)}{suffix}")

    @operation
    def add_sessions(self, sessions: Sequence[str | HasId]) -> Generator[Request, Response, None]:
        """Add sessions (existing conclusions are copied into the scope in the background)."""
        ids = [rid(s) for s in sessions]
        for start in range(0, len(ids), MAX_SESSIONS_PER_CALL):
            yield Request(
                "POST",
                self._path("/sessions"),
                json={"session_ids": ids[start : start + MAX_SESSIONS_PER_CALL]},
            )

    @operation
    def remove_session(self, session: str | HasId) -> Generator[Request, Response, None]:
        yield Request("DELETE", self._path(f"/sessions/{seg(session)}"), missing_ok_on_retry=True)

    @dual_operation
    def sessions(
        self, page: int = 1, size: int = 50, *, reverse: bool = False
    ) -> Generator[
        Request,
        Response,
        Dual[SyncPage[SessionResponse, Session], AsyncPage[SessionResponse, SessionAio]],
    ]:
        """Member sessions, longest-standing first."""
        from . import session as _session  # noqa: F401  (registers the pair)

        session_cls = self._cls("session")
        core = self._core

        def build(n: int) -> Request:
            return Request(
                "POST",
                self._path("/sessions/list"),
                params={"page": n, "size": size, "reverse": reverse or None},
            )

        result = yield from fetch_page(
            core,
            is_async=self._is_async,
            build=build,
            parse=SessionResponse.model_validate,
            wrap=lambda r: session_cls._make(core, r.id, r),
            page=page,
            size=size,
        )
        return as_dual(result)

    @operation
    def status(self) -> Generator[Request, Response, dict[str, ScopeBackfillJob]]:
        """Per-session backfill state: ``pending``, ``completed`` or ``failed``."""
        resp = yield Request("GET", self._path("/status"))
        return ScopeStatusResponse.model_validate(resp.body).backfill_status


class Scope(ScopeBase, SyncMode):
    @property
    def aio(self) -> ScopeAio:
        return ScopeAio._share(self)


class ScopeAio(ScopeBase, AsyncMode):
    """The ``async`` twin of ``Scope``."""


register_pair("scope", Scope, ScopeAio)
