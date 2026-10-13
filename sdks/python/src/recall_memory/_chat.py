"""Request building and response parsing shared by workspace-level and peer-level chat."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal, Protocol, TypeVar, overload

from pydantic import BaseModel

from ._core import AsyncMode, SyncMode, _OperationBase
from ._util import HasId, rid
from .models import ChatResponse, Evidence, ReasoningLevel

MAX_SCOPES = 100
MAX_SESSION_ALLOWLIST = 1000


def schema_of(response_format: Any) -> dict[str, Any] | None:
    """A Pydantic class is sent as its JSON schema; a dict is sent as given."""
    if response_format is None:
        return None
    if isinstance(response_format, type) and issubclass(response_format, BaseModel):
        return response_format.model_json_schema()
    if isinstance(response_format, dict):
        return response_format
    raise TypeError("response_format must be a Pydantic model class or a JSON-schema dict")


def scope_value(scope: str | HasId | Sequence[str | HasId] | None) -> str | list[str] | None:
    if scope is None:
        return None
    if isinstance(scope, str) or hasattr(scope, "id"):
        return rid(scope)
    ids = [rid(s) for s in scope]
    if not 1 <= len(ids) <= MAX_SCOPES:
        raise ValueError(f"scope must name between 1 and {MAX_SCOPES} scopes")
    return ids


def session_allowlist(sessions: Sequence[str | HasId] | None) -> list[str] | None:
    if sessions is None:
        return None
    ids = [rid(s) for s in sessions]
    if len(ids) > MAX_SESSION_ALLOWLIST:
        raise ValueError(f"sessions may list at most {MAX_SESSION_ALLOWLIST} sessions")
    return ids


def check_recall_scope(*, session: Any, scope: Any, sessions: Any) -> None:
    """The client-side exclusivity rules (raised before any request is made)."""
    if scope is not None and sessions is not None:
        raise ValueError("`scope` and `sessions` are mutually exclusive")
    if scope is not None and session is not None:
        raise ValueError("`scope` and `session` are mutually exclusive")
    if sessions is not None and session is not None:
        raise ValueError("`sessions` and `session` are mutually exclusive")


def chat_body(
    *,
    query: str,
    stream: bool,
    session: str | HasId | None,
    reasoning_level: str | None,
    response_format: Any,
    scope: Any,
    include_evidence: bool,
    target: str | HasId | None = None,
    sessions: Sequence[str | HasId] | None = None,
    peer_level: bool = False,
) -> dict[str, Any]:
    check_recall_scope(session=session, scope=scope, sessions=sessions)
    body: dict[str, Any] = {"query": query, "stream": stream}
    if peer_level and target is not None:
        body["target"] = rid(target)
    if session is not None:
        body["session_id"] = rid(session)
    allow = session_allowlist(sessions)
    if allow is not None:
        body["filters"] = {"session_id": allow}
    sc = scope_value(scope)
    if sc is not None:
        body["scope"] = sc
    if reasoning_level is not None:
        body["reasoning_level"] = reasoning_level
    schema = schema_of(response_format)
    if schema is not None:
        body["response_format"] = schema
    if include_evidence:
        body["include_evidence"] = True
    return body


def parse_chat(body: Any, response_format: Any, include_evidence: bool) -> Any:
    """Turn the server answer into what the caller asked for (see ``Peer.chat``)."""
    data = body if isinstance(body, dict) else {}
    content = data.get("content")
    if (
        content is not None
        and isinstance(response_format, type)
        and issubclass(response_format, BaseModel)
    ):
        content = response_format.model_validate_json(content)
    if not include_evidence:
        return content
    evidence = data.get("evidence")
    return ChatResponse(
        content=content,
        evidence=Evidence.model_validate(evidence) if isinstance(evidence, dict) else None,
        citations=list(data.get("citations") or []),
        confidence=data.get("confidence"),
        abstained=data.get("abstained"),
    )


# --------------------------------------------------------------------------------------
# Typing of chat: the return type depends on `response_format` and `include_evidence`
# --------------------------------------------------------------------------------------

M = TypeVar("M", bound=BaseModel)
_Peer = str | HasId
_ScopeArg = str | HasId | Sequence[str | HasId]


class PeerChatCall(Protocol):
    @overload
    def __call__(
        self, query: str, *, response_format: type[M], include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[M]: ...
    @overload
    def __call__(self, query: str, *, response_format: type[M], **kw: Any) -> M | None: ...
    @overload
    def __call__(
        self, query: str, *, include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[str]: ...
    @overload
    def __call__(
        self,
        query: str,
        *,
        target: _Peer | None = None,
        session: _Peer | None = None,
        scope: _ScopeArg | None = None,
        sessions: Sequence[_Peer] | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: dict[str, Any] | None = None,
        include_evidence: Literal[False] = False,
        timeout: float | None = None,
    ) -> str | None: ...


class PeerChatAioCall(Protocol):
    @overload
    async def __call__(
        self, query: str, *, response_format: type[M], include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[M]: ...
    @overload
    async def __call__(self, query: str, *, response_format: type[M], **kw: Any) -> M | None: ...
    @overload
    async def __call__(
        self, query: str, *, include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[str]: ...
    @overload
    async def __call__(
        self,
        query: str,
        *,
        target: _Peer | None = None,
        session: _Peer | None = None,
        scope: _ScopeArg | None = None,
        sessions: Sequence[_Peer] | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: dict[str, Any] | None = None,
        include_evidence: Literal[False] = False,
        timeout: float | None = None,
    ) -> str | None: ...


class WorkspaceChatCall(Protocol):
    @overload
    def __call__(
        self, query: str, *, response_format: type[M], include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[M]: ...
    @overload
    def __call__(self, query: str, *, response_format: type[M], **kw: Any) -> M | None: ...
    @overload
    def __call__(
        self, query: str, *, include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[str]: ...
    @overload
    def __call__(
        self,
        query: str,
        *,
        session: _Peer | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: dict[str, Any] | None = None,
        scope: _ScopeArg | None = None,
        include_evidence: Literal[False] = False,
    ) -> str | None: ...


class WorkspaceChatAioCall(Protocol):
    @overload
    async def __call__(
        self, query: str, *, response_format: type[M], include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[M]: ...
    @overload
    async def __call__(self, query: str, *, response_format: type[M], **kw: Any) -> M | None: ...
    @overload
    async def __call__(
        self, query: str, *, include_evidence: Literal[True], **kw: Any
    ) -> ChatResponse[str]: ...
    @overload
    async def __call__(
        self,
        query: str,
        *,
        session: _Peer | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: dict[str, Any] | None = None,
        scope: _ScopeArg | None = None,
        include_evidence: Literal[False] = False,
    ) -> str | None: ...


class peer_chat_operation(_OperationBase):
    """``@operation`` for ``Peer.chat``: precise overloads instead of a plain signature."""

    @overload
    def __get__(self, obj: None, owner: type | None = None) -> peer_chat_operation: ...
    @overload
    def __get__(self, obj: SyncMode, owner: type | None = None) -> PeerChatCall: ...
    @overload
    def __get__(self, obj: AsyncMode, owner: type | None = None) -> PeerChatAioCall: ...
    def __get__(self, obj: Any, owner: type | None = None) -> Any:
        return self if obj is None else self._bind(obj)


class workspace_chat_operation(_OperationBase):
    """``@operation`` for ``Recall.chat``."""

    @overload
    def __get__(self, obj: None, owner: type | None = None) -> workspace_chat_operation: ...
    @overload
    def __get__(self, obj: SyncMode, owner: type | None = None) -> WorkspaceChatCall: ...
    @overload
    def __get__(self, obj: AsyncMode, owner: type | None = None) -> WorkspaceChatAioCall: ...
    def __get__(self, obj: Any, owner: type | None = None) -> Any:
        return self if obj is None else self._bind(obj)
