"""``Peer``: a participant (human or agent) and what the memory knows about it."""

from __future__ import annotations

import warnings
from collections.abc import Generator, Mapping, Sequence
from datetime import datetime
from typing import TYPE_CHECKING, Any

from ._chat import (
    chat_body,
    check_recall_scope,
    parse_chat,
    peer_chat_operation,
    scope_value,
    session_allowlist,
)
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
from ._resource import Handle, lookup
from ._util import HasId, dump, dump_dict, list_body, rid, seg, ws_path
from .models import (
    Message,
    MessageConfiguration,
    MessageCreateParams,
    PeerConfig,
    PeerContextResponse,
    PeerResponse,
    ReasoningLevel,
    SessionResponse,
)
from .pagination import AsyncPage, SyncPage, fetch_page
from .streaming import AsyncDialecticStreamResponse, DialecticStreamResponse

if TYPE_CHECKING:
    from .conclusions import ConclusionsView, ConclusionsViewAio
    from .session import Session, SessionAio

__all__ = ["Peer", "PeerAio", "PeerBase"]


class _PeerState:
    __slots__ = ("configuration", "created_at", "metadata")

    def __init__(
        self,
        metadata: dict[str, Any] | None,
        configuration: dict[str, Any] | None,
        created_at: datetime | None,
    ) -> None:
        self.metadata = metadata
        self.configuration = configuration
        self.created_at = created_at


def _text(search_query: str | Message | None) -> str | None:
    return search_query.content if isinstance(search_query, Message) else search_query


class PeerBase(Handle):
    """Everything a peer can do; ``Peer`` runs it synchronously, ``PeerAio`` as coroutines."""

    def __init__(
        self,
        peer_id: str,
        client: Any,
        *,
        metadata: dict[str, Any] | None = None,
        configuration: PeerConfig | dict[str, Any] | None = None,
        created_at: datetime | None = None,
    ) -> None:
        if not peer_id:
            raise ValueError("peer_id must be a non-empty string")
        self._core = client._core
        self.id = peer_id
        self._state = _PeerState(metadata, dump_dict(configuration), created_at)

    @classmethod
    def _make(cls, core: Any, peer_id: str, data: PeerResponse | None = None) -> Any:
        self = cls.__new__(cls)
        self._core = core
        self.id = peer_id
        self._state = _PeerState(None, None, None)
        if data is not None:
            self._apply(data)
        return self

    def _apply(self, data: PeerResponse) -> None:
        self._state.metadata = data.metadata
        self._state.configuration = data.configuration
        if data.created_at is not None:
            self._state.created_at = data.created_at

    # ---- cached properties ------------------------------------------------------------

    @property
    def metadata(self) -> dict[str, Any] | None:
        """Last known metadata (``None`` until fetched or set)."""
        return self._state.metadata

    @property
    def configuration(self) -> PeerConfig | None:
        cfg = self._state.configuration
        return None if cfg is None else PeerConfig.model_validate(cfg)

    @property
    def created_at(self) -> datetime | None:
        return self._state.created_at

    # ---- metadata / configuration -----------------------------------------------------

    def _path(self, suffix: str = "") -> str:
        return ws_path(self._core.workspace_id, f"/peers/{seg(self.id)}{suffix}")

    def _load(self) -> Generator[Request, Response, PeerResponse]:
        data = yield from lookup(self._core, "Peer", self.id, "peers")
        peer = PeerResponse.model_validate(data)
        self._apply(peer)
        return peer

    def _put(self, **fields: Any) -> Generator[Request, Response, PeerResponse]:
        resp = yield Request("PUT", self._path(), json=fields)
        peer = PeerResponse.model_validate(resp.body)
        self._apply(peer)
        return peer

    @operation
    def get_metadata(self) -> Generator[Request, Response, dict[str, Any]]:
        """This peer's metadata. Raises ``NotFoundError`` if the peer does not exist."""
        peer = yield from self._load()
        return peer.metadata

    @operation
    def set_metadata(self, metadata: dict[str, Any]) -> Generator[Request, Response, None]:
        """Replace this peer's metadata (creates the peer if needed)."""
        yield from self._put(metadata=metadata)

    @operation
    def get_configuration(self) -> Generator[Request, Response, PeerConfig]:
        peer = yield from self._load()
        return PeerConfig.model_validate(peer.configuration)

    @operation
    def set_configuration(
        self, configuration: PeerConfig | dict[str, Any]
    ) -> Generator[Request, Response, None]:
        """Replace this peer's configuration wholesale."""
        yield from self._put(configuration=dump(configuration))

    @operation
    def refresh(self) -> Generator[Request, Response, None]:
        """Re-fetch metadata and configuration."""
        yield from self._load()

    # ---- dialectic chat ---------------------------------------------------------------

    def _chat_request(
        self,
        query: str,
        *,
        stream: bool,
        target: str | PeerBase | None,
        session: Any,
        scope: Any,
        sessions: Sequence[Any] | None,
        reasoning_level: ReasoningLevel | None,
        response_format: Any,
        include_evidence: bool,
        timeout: float | None = None,
    ) -> Request:
        body = chat_body(
            query=query,
            stream=stream,
            target=target,
            session=session,
            scope=scope,
            sessions=sessions,
            reasoning_level=reasoning_level,
            response_format=response_format,
            include_evidence=include_evidence,
            peer_level=True,
        )
        return Request("POST", self._path("/chat"), json=body, stream=stream, timeout=timeout)

    @peer_chat_operation
    def chat(
        self,
        query: str,
        *,
        target: str | PeerBase | None = None,
        session: str | HasId | None = None,
        scope: str | HasId | Sequence[str | HasId] | None = None,
        sessions: Sequence[str | HasId] | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: Any = None,
        include_evidence: bool = False,
        timeout: float | None = None,
    ) -> Generator[Request, Response, Any]:
        """Ask what this peer knows (or, with ``target``, what it knows about another peer).

        Returns ``str | None`` by default; the parsed model (or ``None``) when ``response_format``
        is a Pydantic class; a JSON string when it is a JSON-schema dict; and a ``ChatResponse``
        (answer, evidence, citations, confidence, abstained) when ``include_evidence=True``.

        ``scope`` (id, ``Scope`` or list) and ``sessions`` (allowlist) are mutually exclusive with
        each other and with ``session``; violating that raises ``ValueError`` before any request.
        """
        req = self._chat_request(
            query,
            stream=False,
            target=target,
            session=session,
            scope=scope,
            sessions=sessions,
            reasoning_level=reasoning_level,
            response_format=response_format,
            include_evidence=include_evidence,
            timeout=timeout,
        )
        resp = yield req
        return parse_chat(resp.body, response_format, include_evidence)

    @dual_operation
    def chat_stream(
        self,
        query: str,
        *,
        target: str | PeerBase | None = None,
        session: str | HasId | None = None,
        scope: str | HasId | Sequence[str | HasId] | None = None,
        sessions: Sequence[str | HasId] | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: Any = None,
        include_evidence: bool = False,
    ) -> Generator[Request, Response, Dual[DialecticStreamResponse, AsyncDialecticStreamResponse]]:
        """Like ``chat`` but streamed: iterate the result for text chunks as they arrive."""
        req = self._chat_request(
            query,
            stream=True,
            target=target,
            session=session,
            scope=scope,
            sessions=sessions,
            reasoning_level=reasoning_level,
            response_format=response_format,
            include_evidence=include_evidence,
        )
        resp = yield req
        assert resp.raw is not None
        cls = AsyncDialecticStreamResponse if self._is_async else DialecticStreamResponse
        return as_dual(cls(resp.raw))

    # ---- listing and search -----------------------------------------------------------

    @dual_operation
    def sessions(
        self,
        filters: Mapping[str, Any] | None = None,
        *,
        page: int = 1,
        size: int = 50,
        reverse: bool = False,
    ) -> Generator[
        Request,
        Response,
        Dual[SyncPage[SessionResponse, Session], AsyncPage[SessionResponse, SessionAio]],
    ]:
        """Sessions this peer has belonged to (including ones it has left)."""
        from . import session as _session  # noqa: F401  (registers the pair)

        session_cls = self._cls("session")
        core = self._core

        def build(n: int) -> Request:
            return Request(
                "POST",
                self._path("/sessions"),
                params={"page": n, "size": size, "reverse": reverse or None},
                json=list_body(filters),
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
    def search(
        self, query: str, filters: Mapping[str, Any] | None = None, limit: int = 10
    ) -> Generator[Request, Response, list[Message]]:
        """Hybrid search over the messages this peer wrote."""
        body: dict[str, Any] = {"query": query, "limit": limit}
        if filters:
            body["filters"] = dict(filters)
        resp = yield Request("POST", self._path("/search"), json=body)
        return [Message.model_validate(m) for m in resp.body]

    def message(
        self,
        content: str,
        *,
        metadata: dict[str, Any] | None = None,
        configuration: MessageConfiguration | dict[str, Any] | None = None,
        created_at: datetime | str | None = None,
    ) -> MessageCreateParams:
        """Build (without any I/O) a message authored by this peer, ready for ``add_messages``."""
        return MessageCreateParams(
            content=content,
            peer_id=self.id,
            metadata=metadata,
            configuration=configuration,
            created_at=created_at,
        )

    # ---- peer card --------------------------------------------------------------------

    def _get_card(
        self, target: str | PeerBase | None
    ) -> Generator[Request, Response, list[str] | None]:
        resp = yield Request(
            "GET", self._path("/card"), params={"target": None if target is None else rid(target)}
        )
        card = resp.body.get("peer_card") if isinstance(resp.body, dict) else None
        return None if card is None else list(card)

    @operation
    def get_card(
        self, target: str | PeerBase | None = None
    ) -> Generator[Request, Response, list[str] | None]:
        """The short list of key facts this peer holds about ``target`` (itself by default)."""
        return (yield from self._get_card(target))

    @operation
    def card(
        self, target: str | PeerBase | None = None
    ) -> Generator[Request, Response, list[str] | None]:
        """Deprecated alias of ``get_card``."""
        warnings.warn("`card()` is deprecated; use `get_card()`", DeprecationWarning, stacklevel=3)
        return (yield from self._get_card(target))

    @operation
    def set_card(
        self, peer_card: list[str], target: str | PeerBase | None = None
    ) -> Generator[Request, Response, list[str] | None]:
        """Overwrite the card. Returns what the server stored."""
        resp = yield Request(
            "PUT",
            self._path("/card"),
            params={"target": None if target is None else rid(target)},
            json={"peer_card": list(peer_card)},
        )
        card = resp.body.get("peer_card") if isinstance(resp.body, dict) else None
        return None if card is None else list(card)

    # ---- representation / context -----------------------------------------------------

    @operation
    def representation(
        self,
        session: str | HasId | None = None,
        target: str | PeerBase | None = None,
        search_query: str | Message | None = None,
        search_top_k: int | None = None,
        search_max_distance: float | None = None,
        include_most_frequent: bool | None = None,
        max_conclusions: int | None = None,
        *,
        scope: str | HasId | Sequence[str | HasId] | None = None,
        sessions: Sequence[str | HasId] | None = None,
    ) -> Generator[Request, Response, str]:
        """A Markdown rendering of what this peer believes about ``target``, for use in prompts."""
        check_recall_scope(session=session, scope=scope, sessions=sessions)
        body: dict[str, Any] = {
            "session_id": None if session is None else rid(session),
            "target": None if target is None else rid(target),
            "search_query": _text(search_query),
            "search_top_k": search_top_k,
            "search_max_distance": search_max_distance,
            "include_most_frequent": include_most_frequent,
            "max_conclusions": max_conclusions,
            "scope": scope_value(scope),
        }
        allow = session_allowlist(sessions)
        if allow is not None:
            body["filters"] = {"session_id": allow}
        resp = yield Request(
            "POST",
            self._path("/representation"),
            json={k: v for k, v in body.items() if v is not None},
        )
        return str(resp.body.get("representation") or "")

    @operation
    def context(
        self,
        target: str | PeerBase | None = None,
        search_query: str | Message | None = None,
        search_top_k: int | None = None,
        search_max_distance: float | None = None,
        include_most_frequent: bool | None = None,
        max_conclusions: int | None = None,
    ) -> Generator[Request, Response, PeerContextResponse]:
        """Representation and peer card in one call."""
        resp = yield Request(
            "GET",
            self._path("/context"),
            params={
                "target": None if target is None else rid(target),
                "search_query": _text(search_query),
                "search_top_k": search_top_k,
                "search_max_distance": search_max_distance,
                "include_most_frequent": include_most_frequent,
                "max_conclusions": max_conclusions,
            },
        )
        return PeerContextResponse.model_validate(resp.body)

    @operation
    def delete(self) -> Generator[Request, Response, dict[str, Any]]:
        """Erase this peer (a Recall extension to the v3 API).

        Removes the messages it wrote, its memberships and everything memory holds from or about it
        (conclusions, peer cards, scopes' memory of it). Needs a workspace-level key. Returns what
        was removed: ``messages_deleted``, ``conclusions_deleted``, ``sessions_affected``.
        """
        resp = yield Request("DELETE", self._path())
        return dict(resp.body) if isinstance(resp.body, dict) else {}


class Peer(PeerBase, SyncMode):
    """A participant, with blocking methods. Use ``peer.aio`` for the coroutine twin."""

    @property
    def aio(self) -> PeerAio:
        return PeerAio._share(self)

    @property
    def conclusions(self) -> ConclusionsView:
        """Conclusions this peer holds about itself."""
        return self.conclusions_of(self.id)

    def conclusions_of(self, target: str | PeerBase) -> ConclusionsView:
        """Conclusions this peer holds about ``target``."""
        from .conclusions import ConclusionsView

        return ConclusionsView._make(self._core, self.id, rid(target))  # type: ignore[no-any-return]


class PeerAio(PeerBase, AsyncMode):
    """The ``async`` twin of ``Peer``; same methods, awaited."""

    @property
    def conclusions(self) -> ConclusionsViewAio:
        """Conclusions this peer holds about itself."""
        return self.conclusions_of(self.id)

    def conclusions_of(self, target: str | PeerBase) -> ConclusionsViewAio:
        """Conclusions this peer holds about ``target``."""
        from .conclusions import ConclusionsViewAio

        return ConclusionsViewAio._make(self._core, self.id, rid(target))  # type: ignore[no-any-return]


register_pair("peer", Peer, PeerAio)
