"""``Session``: a conversation thread holding messages from several peers."""

from __future__ import annotations

import json
import mimetypes
import os
import uuid
from collections.abc import Generator, Mapping, Sequence
from datetime import datetime
from typing import IO, TYPE_CHECKING, Any

from pydantic import BaseModel

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
from ._queue import queue_status_gen, wait_for_idle_gen
from ._resource import Handle, lookup
from ._util import HasId, dump, dump_dict, list_body, rid, seg, ws_path
from .context import SessionContext, TurnResult
from .models import (
    Message,
    MessageCreateParams,
    MessageResponse,
    PeerResponse,
    QueueStatusResponse,
    SessionConfiguration,
    SessionPeerConfig,
    SessionResponse,
    SessionSummaries,
)
from .pagination import AsyncPage, SyncPage, fetch_page

if TYPE_CHECKING:
    from .peer import Peer, PeerAio

__all__ = ["Session", "SessionAio", "SessionBase"]

MAX_BATCH = 100
MAX_ALLOWLIST = 1000

PeerLike = str | HasId
PeersArg = (
    PeerLike
    | tuple[PeerLike, SessionPeerConfig | Mapping[str, Any]]
    | Mapping[Any, Any]
    | Sequence[Any]
)
MessageInput = MessageCreateParams | Mapping[str, Any]
FileArg = (
    tuple[str, bytes | IO[bytes], str]
    | tuple[str, bytes | IO[bytes]]
    | IO[bytes]
    | os.PathLike[str]
)


def normalize_peers(peers: Any) -> dict[str, dict[str, Any]]:
    """Every accepted way of naming peers -> ``{peer_id: SessionPeerConfig-as-dict}``."""

    def config(value: Any) -> dict[str, Any]:
        return dump_dict(value) or {}

    out: dict[str, dict[str, Any]] = {}

    def add(item: Any) -> None:
        if isinstance(item, str) or hasattr(item, "id"):
            out.setdefault(rid(item), {})
        elif isinstance(item, tuple) and len(item) == 2:
            out[rid(item[0])] = config(item[1])
        elif isinstance(item, Mapping):
            for key, value in item.items():
                out[rid(key)] = config(value)
        elif isinstance(item, (list, tuple)):
            for sub in item:
                add(sub)
        else:
            raise TypeError(f"cannot interpret {item!r} as a peer")

    add(peers)
    return out


def message_payload(message: MessageInput) -> dict[str, Any]:
    data = dump(message) if isinstance(message, BaseModel) else dict(message)
    for key in ("configuration", "created_at"):
        if key in data:
            data[key] = dump(data[key])
    return {k: v for k, v in data.items() if v is not None}


class _SessionState:
    __slots__ = ("configuration", "created_at", "is_active", "metadata")

    def __init__(
        self,
        metadata: dict[str, Any] | None,
        configuration: dict[str, Any] | None,
        created_at: datetime | None,
        is_active: bool | None,
    ) -> None:
        self.metadata = metadata
        self.configuration = configuration
        self.created_at = created_at
        self.is_active = is_active


class SessionBase(Handle):
    """Everything a session can do; ``Session`` runs it synchronously, ``SessionAio`` awaited."""

    def __init__(
        self,
        session_id: str,
        client: Any,
        *,
        metadata: dict[str, Any] | None = None,
        configuration: SessionConfiguration | dict[str, Any] | None = None,
        created_at: datetime | None = None,
        is_active: bool | None = None,
    ) -> None:
        if not session_id:
            raise ValueError("session_id must be a non-empty string")
        self._core = client._core
        self.id = session_id
        self._state = _SessionState(metadata, dump_dict(configuration), created_at, is_active)

    @classmethod
    def _make(cls, core: Any, session_id: str, data: SessionResponse | None = None) -> Any:
        self = cls.__new__(cls)
        self._core = core
        self.id = session_id
        self._state = _SessionState(None, None, None, None)
        if data is not None:
            self._apply(data)
        return self

    def _apply(self, data: SessionResponse) -> None:
        self._state.metadata = data.metadata
        self._state.configuration = data.configuration
        self._state.is_active = data.is_active
        if data.created_at is not None:
            self._state.created_at = data.created_at

    @property
    def metadata(self) -> dict[str, Any] | None:
        return self._state.metadata

    @property
    def configuration(self) -> SessionConfiguration | None:
        cfg = self._state.configuration
        return None if cfg is None else SessionConfiguration.model_validate(cfg)

    @property
    def created_at(self) -> datetime | None:
        return self._state.created_at

    @property
    def is_active(self) -> bool | None:
        return self._state.is_active

    def _path(self, suffix: str = "") -> str:
        return ws_path(self._core.workspace_id, f"/sessions/{seg(self.id)}{suffix}")

    # ---- metadata / configuration -----------------------------------------------------

    def _load(self) -> Generator[Request, Response, SessionResponse]:
        data = yield from lookup(self._core, "Session", self.id, "sessions")
        session = SessionResponse.model_validate(data)
        self._apply(session)
        return session

    def _put(self, **fields: Any) -> Generator[Request, Response, SessionResponse]:
        resp = yield Request("PUT", self._path(), json=fields)
        session = SessionResponse.model_validate(resp.body)
        self._apply(session)
        return session

    @operation
    def get_metadata(self) -> Generator[Request, Response, dict[str, Any]]:
        """This session's metadata. Raises ``NotFoundError`` if the session does not exist."""
        return (yield from self._load()).metadata

    @operation
    def set_metadata(self, metadata: dict[str, Any]) -> Generator[Request, Response, None]:
        """Replace the metadata (creates the session if needed)."""
        yield from self._put(metadata=metadata)

    @operation
    def get_configuration(self) -> Generator[Request, Response, SessionConfiguration]:
        return SessionConfiguration.model_validate((yield from self._load()).configuration)

    @operation
    def set_configuration(
        self, configuration: SessionConfiguration | dict[str, Any]
    ) -> Generator[Request, Response, None]:
        """Merge ``configuration`` into the stored one (one level deep)."""
        yield from self._put(configuration=dump(configuration))

    @operation
    def refresh(self) -> Generator[Request, Response, None]:
        yield from self._load()

    @operation
    def delete(self) -> Generator[Request, Response, None]:
        """Delete the session; its messages and derived data are removed in the background."""
        yield Request("DELETE", self._path(), missing_ok_on_retry=True)

    @dual_operation
    def clone(
        self, *, message_id: str | None = None
    ) -> Generator[Request, Response, Dual[Session, SessionAio]]:
        """Copy the whole session, or everything up to and including ``message_id``."""
        resp = yield Request(
            "POST", self._path("/clone"), params={"message_id": message_id}, retry="unsafe"
        )
        data = SessionResponse.model_validate(resp.body)
        return as_dual(self._cls("session")._make(self._core, data.id, data))

    # ---- membership -------------------------------------------------------------------

    @operation
    def add_peers(self, peers: PeersArg) -> Generator[Request, Response, None]:
        """Add peers. Accepts ids, ``Peer`` objects, ``(peer, SessionPeerConfig)`` pairs or lists."""
        yield Request("POST", self._path("/peers"), json=normalize_peers(peers))

    @operation
    def set_peers(self, peers: PeersArg) -> Generator[Request, Response, None]:
        """Replace the membership with exactly these peers."""
        yield Request("PUT", self._path("/peers"), json=normalize_peers(peers))

    @operation
    def remove_peers(
        self, peers: PeerLike | Sequence[PeerLike]
    ) -> Generator[Request, Response, None]:
        ids = [peers] if isinstance(peers, str) or hasattr(peers, "id") else list(peers)
        yield Request("DELETE", self._path("/peers"), json=[rid(p) for p in ids])

    @dual_operation
    def peers(self) -> Generator[Request, Response, Dual[list[Peer], list[PeerAio]]]:
        """The active members, as ``Peer`` objects (all pages fetched)."""
        peer_cls = self._cls("peer")
        out: list[Any] = []
        page = 1
        while True:
            resp = yield Request("GET", self._path("/peers"), params={"page": page, "size": 100})
            body: dict[str, Any] = (
                resp.body if isinstance(resp.body, dict) else {"items": resp.body or []}
            )
            for item in body.get("items", []):
                data = PeerResponse.model_validate(item)
                out.append(peer_cls._make(self._core, data.id, data))
            if page >= int(body.get("pages") or 0):
                return as_dual(out)
            page += 1

    @operation
    def get_peer_configuration(
        self, peer: PeerLike
    ) -> Generator[Request, Response, SessionPeerConfig]:
        resp = yield Request("GET", self._path(f"/peers/{seg(peer)}/config"))
        return SessionPeerConfig.model_validate(resp.body)

    @operation
    def set_peer_configuration(
        self, peer: PeerLike, configuration: SessionPeerConfig | dict[str, Any]
    ) -> Generator[Request, Response, None]:
        yield Request("PUT", self._path(f"/peers/{seg(peer)}/config"), json=dump(configuration))

    # ---- messages ---------------------------------------------------------------------

    @operation
    def add_messages(
        self,
        messages: MessageInput | Sequence[MessageInput],
        *,
        idempotency_key: str | None = None,
        wait: bool | float = False,
    ) -> Generator[Request, Response, list[Message]]:
        """Store messages (one or many). More than 100 are sent in ordered batches.

        Every request carries an ``Idempotency-Key`` (yours, or a random one generated per call),
        so a retry after a timeout can never store the batch twice. With ``wait=True`` (or a number
        of seconds; ``True`` means 30) the call returns once reasoning and summaries for this
        session have finished, so the next ``context()`` / ``chat()`` already reflects the messages.
        """
        items = [messages] if isinstance(messages, (BaseModel, Mapping)) else list(messages)
        key = idempotency_key or uuid.uuid4().hex
        created: list[Message] = []
        for n, start in enumerate(range(0, len(items), MAX_BATCH)):
            chunk = [message_payload(m) for m in items[start : start + MAX_BATCH]]
            resp = yield Request(
                "POST",
                self._path("/messages"),
                json={"messages": chunk},
                headers={"Idempotency-Key": key if n == 0 else f"{key}.{n}"},
            )
            created.extend(Message.model_validate(m) for m in resp.body)
        if wait and created:
            yield from wait_for_idle_gen(
                self._core, timeout=30.0 if wait is True else float(wait), session=self.id
            )
        return created

    @dual_operation
    def messages(
        self,
        *,
        filters: Mapping[str, Any] | None = None,
        page: int = 1,
        size: int = 50,
        reverse: bool = False,
    ) -> Generator[
        Request,
        Response,
        Dual[SyncPage[MessageResponse, Message], AsyncPage[MessageResponse, Message]],
    ]:
        def build(n: int) -> Request:
            return Request(
                "POST",
                self._path("/messages/list"),
                params={"page": n, "size": size, "reverse": reverse or None},
                json=list_body(filters),
            )

        result = yield from fetch_page(
            self._core,
            is_async=self._is_async,
            build=build,
            parse=MessageResponse.model_validate,
            wrap=lambda r: Message.model_validate(r.model_dump()),
            page=page,
            size=size,
        )
        return as_dual(result)

    @operation
    def get_message(self, message_id: str) -> Generator[Request, Response, Message]:
        resp = yield Request("GET", self._path(f"/messages/{seg(message_id)}"))
        return Message.model_validate(resp.body)

    @operation
    def update_message(
        self, message: Message | str, metadata: dict[str, Any]
    ) -> Generator[Request, Response, Message]:
        """Replace a message's metadata (content is immutable)."""
        message_id = message if isinstance(message, str) else message.id
        resp = yield Request(
            "PUT", self._path(f"/messages/{seg(message_id)}"), json={"metadata": metadata}
        )
        return Message.model_validate(resp.body)

    @operation
    def upload_file(
        self,
        file: FileArg,
        peer: PeerLike,
        metadata: dict[str, Any] | None = None,
        configuration: dict[str, Any] | Any = None,
        created_at: datetime | str | None = None,
    ) -> Generator[Request, Response, list[Message]]:
        """Turn a PDF, text or JSON file into one or more messages written by ``peer``."""
        filename, content, content_type = _read_file(file)
        data: dict[str, str] = {"peer_id": rid(peer)}
        if metadata is not None:
            data["metadata"] = json.dumps(metadata)
        if configuration is not None:
            data["configuration"] = json.dumps(dump(configuration))
        if created_at is not None:
            data["created_at"] = (
                created_at.isoformat() if isinstance(created_at, datetime) else created_at
            )
        resp = yield Request(
            "POST",
            self._path("/messages/upload"),
            data=data,
            files={"file": (filename, content, content_type)},
            headers={"Idempotency-Key": uuid.uuid4().hex},
        )
        return [Message.model_validate(m) for m in resp.body]

    # ---- context, summaries, search ---------------------------------------------------

    @operation
    def context(
        self,
        *,
        summary: bool = True,
        tokens: int | None = None,
        peer_target: PeerLike | None = None,
        search_query: str | Message | None = None,
        peer_perspective: PeerLike | None = None,
        scope: str | HasId | None = None,
        sessions: Sequence[PeerLike] | None = None,
        limit_to_session: bool = False,
        search_top_k: int | None = None,
        search_max_distance: float | None = None,
        include_most_frequent: bool | None = None,
        max_conclusions: int | None = None,
    ) -> Generator[Request, Response, SessionContext]:
        """The most recent messages that fit ``tokens``, plus summary and peer knowledge.

        ``peer_target`` adds that peer's representation and card to the result;
        ``peer_perspective`` / ``scope`` / ``sessions`` / ``limit_to_session`` choose whose view of
        them (see the API docs). Combinations the server would reject raise ``ValueError`` first.
        """
        if peer_target is None:
            if peer_perspective is not None:
                raise ValueError("peer_target must be provided if peer_perspective is provided")
            if search_query is not None:
                raise ValueError("peer_target must be provided if search_query is provided")
            if scope is not None:
                raise ValueError("peer_target must be provided if scope is provided")
            if sessions is not None:
                raise ValueError("peer_target must be provided if sessions is provided")
        if sessions is not None and scope is not None:
            raise ValueError("`sessions` and `scope` are mutually exclusive")
        if sessions is not None and limit_to_session:
            raise ValueError("`sessions` and `limit_to_session` are mutually exclusive")
        if scope is not None and peer_perspective is not None:
            raise ValueError("`scope` and `peer_perspective` are mutually exclusive")
        allow = None if sessions is None else [rid(s) for s in sessions]
        if allow is not None and len(allow) > MAX_ALLOWLIST:
            raise ValueError(f"sessions may list at most {MAX_ALLOWLIST} sessions")
        if allow is not None and self.id not in allow:
            raise ValueError("`sessions` must include this session")
        resp = yield Request(
            "GET",
            self._path("/context"),
            params={
                "summary": summary,
                "tokens": tokens,
                "peer_target": None if peer_target is None else rid(peer_target),
                "search_query": search_query.content
                if isinstance(search_query, Message)
                else search_query,
                "peer_perspective": None if peer_perspective is None else rid(peer_perspective),
                "scope": None if scope is None else rid(scope),
                "sessions": allow,
                "limit_to_session": True if limit_to_session else None,
                "search_top_k": search_top_k,
                "search_max_distance": search_max_distance,
                "include_most_frequent": include_most_frequent,
                "max_conclusions": max_conclusions,
            },
        )
        return SessionContext.model_validate(resp.body)

    @operation
    def turn(
        self,
        messages: MessageInput | Sequence[MessageInput],
        *,
        tokens: int | None = None,
        summary: bool = True,
        peer_target: PeerLike | None = None,
        peer_perspective: PeerLike | None = None,
        limit_to_session: bool = False,
        search_query: str | Message | None = None,
        max_conclusions: int | None = None,
        idempotency_key: str | None = None,
    ) -> Generator[Request, Response, TurnResult]:
        """Store ``messages`` and get the next prompt's context in a single round trip.

        Equivalent to ``add_messages`` followed by ``context`` but one request; the stored
        messages are included in the returned context. Needs a server that implements
        ``POST .../sessions/{id}/turn`` (Recall does).
        """
        items = [messages] if isinstance(messages, (BaseModel, Mapping)) else list(messages)
        context: dict[str, Any] = {"summary": summary}
        if tokens is not None:
            context["tokens"] = tokens
        if peer_target is not None:
            context["peer_target"] = rid(peer_target)
        if peer_perspective is not None:
            if peer_target is None:
                raise ValueError("peer_target must be provided if peer_perspective is provided")
            context["peer_perspective"] = rid(peer_perspective)
        if limit_to_session:
            context["limit_to_session"] = True
        if search_query is not None:
            context["search_query"] = (
                search_query.content if isinstance(search_query, Message) else search_query
            )
        if max_conclusions is not None:
            context["max_conclusions"] = max_conclusions
        resp = yield Request(
            "POST",
            self._path("/turn"),
            json={"messages": [message_payload(m) for m in items], "context": context},
            headers={"Idempotency-Key": idempotency_key or uuid.uuid4().hex},
        )
        body = resp.body if isinstance(resp.body, dict) else {}
        ctx = body.get("context")
        if not isinstance(ctx, dict):
            ctx = {k: v for k, v in body.items() if k != "messages"}
        ctx.setdefault("id", self.id)
        return TurnResult(
            messages=[Message.model_validate(m) for m in body.get("messages", [])],
            context=SessionContext.model_validate(ctx),
        )

    @operation
    def summaries(self) -> Generator[Request, Response, SessionSummaries]:
        resp = yield Request("GET", self._path("/summaries"))
        return SessionSummaries.model_validate(resp.body)

    @operation
    def search(
        self, query: str, filters: Mapping[str, Any] | None = None, limit: int = 10
    ) -> Generator[Request, Response, list[Message]]:
        body: dict[str, Any] = {"query": query, "limit": limit}
        if filters:
            body["filters"] = dict(filters)
        resp = yield Request("POST", self._path("/search"), json=body)
        return [Message.model_validate(m) for m in resp.body]

    @operation
    def representation(
        self,
        peer: PeerLike,
        *,
        target: PeerLike | None = None,
        search_query: str | Message | None = None,
        search_top_k: int | None = None,
        search_max_distance: float | None = None,
        include_most_frequent: bool | None = None,
        max_conclusions: int | None = None,
    ) -> Generator[Request, Response, str]:
        """``peer``'s representation of ``target`` restricted to this session."""
        body: dict[str, Any] = {
            "session_id": self.id,
            "target": None if target is None else rid(target),
            "search_query": search_query.content
            if isinstance(search_query, Message)
            else search_query,
            "search_top_k": search_top_k,
            "search_max_distance": search_max_distance,
            "include_most_frequent": include_most_frequent,
            "max_conclusions": max_conclusions,
        }
        resp = yield Request(
            "POST",
            ws_path(self._core.workspace_id, f"/peers/{seg(peer)}/representation"),
            json={k: v for k, v in body.items() if v is not None},
        )
        return str(resp.body.get("representation") or "")

    # ---- background work --------------------------------------------------------------

    @operation
    def queue_status(
        self, observer: PeerLike | None = None, sender: PeerLike | None = None
    ) -> Generator[Request, Response, QueueStatusResponse]:
        return (
            yield from queue_status_gen(
                self._core, observer=observer, sender=sender, session=self.id
            )
        )

    @operation
    def wait_for_idle(
        self,
        timeout: float = 60.0,
        *,
        observer: PeerLike | None = None,
        sender: PeerLike | None = None,
    ) -> Generator[Request, Response, QueueStatusResponse]:
        """Wait until reasoning and summaries for this session have finished (see client docs)."""
        return (
            yield from wait_for_idle_gen(
                self._core, timeout=timeout, observer=observer, sender=sender, session=self.id
            )
        )


def _read_file(file: Any) -> tuple[str, bytes, str]:
    """Normalise the accepted ``upload_file`` inputs to ``(filename, bytes, content_type)``."""
    content_type: str | None = None
    if isinstance(file, tuple):
        if len(file) == 3:
            filename, content, content_type = file
        elif len(file) == 2:
            filename, content = file
        else:
            raise TypeError("file tuples are (filename, content[, content_type])")
    elif isinstance(file, (str, os.PathLike)):
        filename = os.path.basename(os.fspath(file))
        with open(file, "rb") as fh:
            content = fh.read()
    elif hasattr(file, "read"):
        filename = os.path.basename(getattr(file, "name", None) or "upload")
        content = file
    else:
        raise TypeError("file must be a path, a file object or a (filename, content, type) tuple")
    if hasattr(content, "read"):
        content = content.read()
    if isinstance(content, str):
        content = content.encode()
    if not content_type:
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return str(filename), bytes(content), content_type


class Session(SessionBase, SyncMode):
    """A conversation, with blocking methods. Use ``session.aio`` for the coroutine twin."""

    @property
    def aio(self) -> SessionAio:
        return SessionAio._share(self)


class SessionAio(SessionBase, AsyncMode):
    """The ``async`` twin of ``Session``; same methods, awaited."""


register_pair("session", Session, SessionAio)
