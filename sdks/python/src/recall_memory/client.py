"""The entry points: ``Recall`` (sync, with ``.aio``) and ``AsyncRecall``."""

from __future__ import annotations

from collections.abc import Generator, Mapping, Sequence
from datetime import datetime
from types import TracebackType
from typing import TYPE_CHECKING, Any, Literal

import httpx

from . import conclusions as _conclusions  # noqa: F401  (registers the class pairs)
from ._chat import chat_body, parse_chat, scope_value, workspace_chat_operation
from ._config import (
    resolve_api_key,
    resolve_base_url,
    resolve_max_retries,
    resolve_timeout,
    resolve_workspace,
)
from ._core import (
    AsyncMode,
    ClientCore,
    Dual,
    Request,
    Response,
    SyncMode,
    as_dual,
    dual_operation,
    operation,
    pair_class,
)
from ._queue import queue_status_gen, status_request, wait_for_idle_gen
from ._util import HasId, dump, dump_dict, list_body, rid, seg, ws_path
from .conclusions import WorkspaceConclusions, WorkspaceConclusionsAio
from .models import (
    Message,
    PeerConfig,
    PeerResponse,
    QueueStatusResponse,
    ReasoningLevel,
    ScopeResponse,
    SessionConfiguration,
    SessionResponse,
    Usage,
    WorkspaceConfiguration,
    WorkspaceResponse,
)
from .pagination import AsyncPage, SyncPage, fetch_page
from .session import PeersArg, normalize_peers
from .streaming import AsyncDialecticStreamResponse, DialecticStreamResponse
from .webhooks import Webhooks, WebhooksAio

__all__ = ["AsyncRecall", "Recall", "RecallAio", "RecallBase"]

if TYPE_CHECKING:
    from .peer import Peer, PeerAio
    from .scope import Scope, ScopeAio
    from .session import Session, SessionAio


def _iso(value: datetime | str | None) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else value


class RecallBase:
    """Workspace-level operations; the ``Recall`` / ``RecallAio`` classes add the mode."""

    _core: ClientCore
    _is_async: bool

    def _cls(self, name: str) -> Any:
        return pair_class(self, name)

    # ---- properties -------------------------------------------------------------------

    @property
    def workspace_id(self) -> str:
        return self._core.workspace_id

    @property
    def base_url(self) -> str:
        return self._core.base_url

    @property
    def metadata(self) -> dict[str, Any] | None:
        """Workspace metadata as last fetched or set (``None`` until then)."""
        return self._core.metadata

    @property
    def configuration(self) -> WorkspaceConfiguration | None:
        cfg = self._core.configuration
        return None if cfg is None else WorkspaceConfiguration.model_validate(cfg)

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(base_url={self.base_url!r}, workspace_id={self.workspace_id!r})"
        )

    # ---- workspace metadata / configuration -------------------------------------------

    def _ws(self, suffix: str = "") -> str:
        return ws_path(self._core.workspace_id, suffix)

    def _apply(self, data: WorkspaceResponse) -> WorkspaceResponse:
        self._core.metadata = data.metadata
        self._core.configuration = data.configuration
        return data

    def _load(self) -> Generator[Request, Response, WorkspaceResponse]:
        core = self._core
        if not core.auto_create:
            # There is no read-only workspace route; check existence first so reads never create.
            yield status_request(core)
        resp = yield Request(
            "POST", "/v3/workspaces", json={"id": core.workspace_id}, workspace_scoped=False
        )
        return self._apply(WorkspaceResponse.model_validate(resp.body))

    def _put(self, **fields: Any) -> Generator[Request, Response, WorkspaceResponse]:
        resp = yield Request("PUT", self._ws(), json=fields)
        return self._apply(WorkspaceResponse.model_validate(resp.body))

    @operation
    def get_metadata(self) -> Generator[Request, Response, dict[str, Any]]:
        return (yield from self._load()).metadata

    @operation
    def set_metadata(self, metadata: dict[str, Any]) -> Generator[Request, Response, None]:
        yield from self._put(metadata=metadata)

    @operation
    def get_configuration(self) -> Generator[Request, Response, WorkspaceConfiguration]:
        return WorkspaceConfiguration.model_validate((yield from self._load()).configuration)

    @operation
    def set_configuration(
        self, configuration: WorkspaceConfiguration | dict[str, Any]
    ) -> Generator[Request, Response, None]:
        yield from self._put(configuration=dump(configuration))

    @operation
    def refresh(self) -> Generator[Request, Response, None]:
        """Re-fetch workspace metadata and configuration."""
        yield from self._load()

    # ---- handles ----------------------------------------------------------------------

    @dual_operation
    def peer(
        self,
        id: str,
        *,
        metadata: dict[str, Any] | None = None,
        configuration: PeerConfig | dict[str, Any] | None = None,
    ) -> Generator[Request, Response, Dual[Peer, PeerAio]]:
        """A handle for peer ``id``. No request is made unless metadata/configuration are given,
        in which case the peer is created (or updated) with them."""
        cls = self._cls("peer")
        if metadata is None and configuration is None:
            return as_dual(cls._make(self._core, id))
        body: dict[str, Any] = {"id": id}
        if metadata is not None:
            body["metadata"] = metadata
        if configuration is not None:
            body["configuration"] = dump(configuration)
        resp = yield Request("POST", self._ws("/peers"), json=body)
        data = PeerResponse.model_validate(resp.body)
        return as_dual(cls._make(self._core, data.id, data))

    @dual_operation
    def peers(
        self,
        filters: Mapping[str, Any] | None = None,
        *,
        page: int = 1,
        size: int = 50,
        reverse: bool = False,
    ) -> Generator[
        Request,
        Response,
        Dual[SyncPage[PeerResponse, Peer], AsyncPage[PeerResponse, PeerAio]],
    ]:
        peer_cls = self._cls("peer")
        core = self._core

        def build(n: int) -> Request:
            return Request(
                "POST",
                self._ws("/peers/list"),
                params={"page": n, "size": size, "reverse": reverse or None},
                json=list_body(filters),
            )

        result = yield from fetch_page(
            core,
            is_async=self._is_async,
            build=build,
            parse=PeerResponse.model_validate,
            wrap=lambda r: peer_cls._make(core, r.id, r),
            page=page,
            size=size,
        )
        return as_dual(result)

    @dual_operation
    def session(
        self,
        id: str,
        *,
        metadata: dict[str, Any] | None = None,
        configuration: SessionConfiguration | dict[str, Any] | None = None,
        peers: PeersArg | None = None,
        scopes: Sequence[str | HasId] | None = None,
    ) -> Generator[Request, Response, Dual[Session, SessionAio]]:
        """A handle for session ``id``. No request is made unless any option is given, in which
        case the session is created (or updated) with them in a single call."""
        cls = self._cls("session")
        if metadata is None and configuration is None and peers is None and scopes is None:
            return as_dual(cls._make(self._core, id))
        body: dict[str, Any] = {"id": id}
        if metadata is not None:
            body["metadata"] = metadata
        if configuration is not None:
            body["configuration"] = dump(configuration)
        if peers is not None:
            body["peers"] = normalize_peers(peers)
        if scopes is not None:
            body["scopes"] = [rid(s) for s in scopes]
        resp = yield Request("POST", self._ws("/sessions"), json=body)
        data = SessionResponse.model_validate(resp.body)
        return as_dual(cls._make(self._core, data.id, data))

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
        session_cls = self._cls("session")
        core = self._core

        def build(n: int) -> Request:
            return Request(
                "POST",
                self._ws("/sessions/list"),
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

    @dual_operation
    def scope(
        self, id: str, *, metadata: dict[str, Any] | None = None
    ) -> Generator[Request, Response, Dual[Scope, ScopeAio]]:
        """Get or create scope ``id``."""
        body: dict[str, Any] = {"id": id}
        if metadata is not None:
            body["metadata"] = metadata
        resp = yield Request("POST", self._ws("/scopes"), json=body)
        data = ScopeResponse.model_validate(resp.body)
        return as_dual(self._cls("scope")._make(self._core, data.id, data))

    @dual_operation
    def get_scope(self, id: str) -> Generator[Request, Response, Dual[Scope, ScopeAio]]:
        """Fetch an existing scope (``NotFoundError`` if missing)."""
        resp = yield Request("GET", self._ws(f"/scopes/{seg(id)}"))
        data = ScopeResponse.model_validate(resp.body)
        return as_dual(self._cls("scope")._make(self._core, data.id, data))

    @dual_operation
    def scopes(
        self, *, page: int = 1, size: int = 50, reverse: bool = False
    ) -> Generator[
        Request,
        Response,
        Dual[SyncPage[ScopeResponse, Scope], AsyncPage[ScopeResponse, ScopeAio]],
    ]:
        scope_cls = self._cls("scope")
        core = self._core

        def build(n: int) -> Request:
            return Request(
                "POST",
                self._ws("/scopes/list"),
                params={"page": n, "size": size, "reverse": reverse or None},
            )

        result = yield from fetch_page(
            core,
            is_async=self._is_async,
            build=build,
            parse=ScopeResponse.model_validate,
            wrap=lambda r: scope_cls._make(core, r.id, r),
            page=page,
            size=size,
        )
        return as_dual(result)

    @dual_operation
    def workspaces(
        self,
        filters: Mapping[str, Any] | None = None,
        *,
        page: int = 1,
        size: int = 50,
        reverse: bool = False,
    ) -> Generator[
        Request,
        Response,
        Dual[SyncPage[WorkspaceResponse, str], AsyncPage[WorkspaceResponse, str]],
    ]:
        """Ids of every workspace (needs an admin key)."""

        def build(n: int) -> Request:
            return Request(
                "POST",
                "/v3/workspaces/list",
                params={"page": n, "size": size, "reverse": reverse or None},
                json=list_body(filters),
                workspace_scoped=False,
            )

        result = yield from fetch_page(
            self._core,
            is_async=self._is_async,
            build=build,
            parse=WorkspaceResponse.model_validate,
            wrap=lambda r: r.id,
            page=page,
            size=size,
        )
        return as_dual(result)

    @operation
    def delete_workspace(self, workspace_id: str) -> Generator[Request, Response, None]:
        """Delete a workspace (all its sessions must already be deleted)."""
        yield Request(
            "DELETE", ws_path(workspace_id), workspace_scoped=False, missing_ok_on_retry=True
        )

    # ---- workspace-wide chat and search -----------------------------------------------

    def _chat_request(
        self,
        query: str,
        *,
        stream: bool,
        session: Any,
        reasoning_level: ReasoningLevel | None,
        response_format: Any,
        scope: Any,
        include_evidence: bool,
    ) -> Request:
        body = chat_body(
            query=query,
            stream=stream,
            session=session,
            reasoning_level=reasoning_level,
            response_format=response_format,
            scope=scope,
            include_evidence=include_evidence,
            sessions=None,
        )
        return Request("POST", self._ws("/chat"), json=body, stream=stream)

    @workspace_chat_operation
    def chat(
        self,
        query: str,
        *,
        session: str | HasId | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: Any = None,
        scope: str | HasId | Sequence[str | HasId] | None = None,
        include_evidence: bool = False,
    ) -> Generator[Request, Response, Any]:
        """Ask a question over the whole workspace (no single observer).

        Return value follows ``response_format`` / ``include_evidence`` exactly like ``Peer.chat``.
        """
        resp = yield self._chat_request(
            query,
            stream=False,
            session=session,
            reasoning_level=reasoning_level,
            response_format=response_format,
            scope=scope,
            include_evidence=include_evidence,
        )
        return parse_chat(resp.body, response_format, include_evidence)

    @dual_operation
    def chat_stream(
        self,
        query: str,
        *,
        session: str | HasId | None = None,
        reasoning_level: ReasoningLevel | None = None,
        response_format: Any = None,
        scope: str | HasId | Sequence[str | HasId] | None = None,
        include_evidence: bool = False,
    ) -> Generator[Request, Response, Dual[DialecticStreamResponse, AsyncDialecticStreamResponse]]:
        resp = yield self._chat_request(
            query,
            stream=True,
            session=session,
            reasoning_level=reasoning_level,
            response_format=response_format,
            scope=scope,
            include_evidence=include_evidence,
        )
        assert resp.raw is not None
        cls = AsyncDialecticStreamResponse if self._is_async else DialecticStreamResponse
        return as_dual(cls(resp.raw))

    @operation
    def search(
        self,
        query: str,
        filters: Mapping[str, Any] | None = None,
        limit: int = 10,
        *,
        scope: str | HasId | None = None,
    ) -> Generator[Request, Response, list[Message]]:
        """Hybrid (semantic + keyword) search over every message in the workspace."""
        body: dict[str, Any] = {"query": query, "limit": limit}
        if filters:
            body["filters"] = dict(filters)
        if scope is not None:
            body["scope"] = scope_value(scope)
        resp = yield Request("POST", self._ws("/search"), json=body)
        return [Message.model_validate(m) for m in resp.body]

    # ---- background work, dreams, usage -----------------------------------------------

    @operation
    def queue_status(
        self,
        observer: str | HasId | None = None,
        sender: str | HasId | None = None,
        session: str | HasId | None = None,
    ) -> Generator[Request, Response, QueueStatusResponse]:
        return (
            yield from queue_status_gen(
                self._core, observer=observer, sender=sender, session=session
            )
        )

    @operation
    def wait_for_idle(
        self,
        timeout: float = 60.0,
        *,
        observer: str | HasId | None = None,
        sender: str | HasId | None = None,
        session: str | HasId | None = None,
    ) -> Generator[Request, Response, QueueStatusResponse]:
        """Block until background reasoning and summaries have finished.

        Uses the server's ``queue/status?wait_ms=`` long-poll, so there is no sleep-and-poll
        loop. Returns the final ``QueueStatusResponse``; raises ``RecallTimeoutError`` if work is
        still running after ``timeout`` seconds. If the workspace does not exist yet it counts as
        idle. Requires a Recall server (other servers ignore ``wait_ms``).
        """
        return (
            yield from wait_for_idle_gen(
                self._core, timeout=timeout, observer=observer, sender=sender, session=session
            )
        )

    @operation
    def schedule_dream(
        self,
        observer: str | HasId,
        session: str | HasId | None = None,
        observed: str | HasId | None = None,
        *,
        dream_type: Literal["omni", "card_refresh"] = "omni",
        rebuild: bool = False,
    ) -> Generator[Request, Response, None]:
        """Queue a consolidation ("dream") for ``observer``'s view of ``observed`` right now."""
        body: dict[str, Any] = {
            "observer": rid(observer),
            "observed": rid(observed if observed is not None else observer),
            "dream_type": dream_type,
        }
        if session is not None:
            body["session_id"] = rid(session)
        if rebuild:
            body["rebuild"] = True
        yield Request("POST", self._ws("/schedule_dream"), json=body)

    @operation
    def usage(
        self, *, since: datetime | str | None = None, until: datetime | str | None = None
    ) -> Generator[Request, Response, Usage]:
        """Model calls and tokens of the workspace, in total and by task and model.

        On a server of your own ``cost_usd`` is the provider cost; on the hosted service it is
        ``None`` and ``billed`` is what the workspace was charged.
        """
        resp = yield Request(
            "GET", self._ws("/usage"), params={"since": _iso(since), "until": _iso(until)}
        )
        return Usage.model_validate(resp.body)

    @operation
    def create_key(
        self,
        *,
        workspace_id: str | None = None,
        peer_id: str | HasId | None = None,
        session_id: str | HasId | None = None,
        expires_at: datetime | str | None = None,
    ) -> Generator[Request, Response, str]:
        """Mint a scoped API key (``POST /v3/keys``; needs an admin key and auth enabled).

        Give at least a workspace; add a peer or session to narrow the key further. The key is
        returned as a string.
        """
        if workspace_id is None and peer_id is None and session_id is None:
            raise ValueError(
                "At least one of workspace_id, peer_id, or session_id must be provided"
            )
        if workspace_id is None:
            raise ValueError("workspace_id is required when scoping a key to a peer or session")
        resp = yield Request(
            "POST",
            "/v3/keys",
            params={
                "workspace_id": workspace_id,
                "peer_id": None if peer_id is None else rid(peer_id),
                "session_id": None if session_id is None else rid(session_id),
                "expires_at": _iso(expires_at),
            },
            workspace_scoped=False,
        )
        return str(resp.body["key"])

    # ---- lifecycle --------------------------------------------------------------------

    def close(self) -> None:
        """Release the sync HTTP connection pool (clients you passed in are left open)."""
        self._core.close()


def _build_core(
    *,
    api_key: str | None,
    base_url: str | None,
    workspace_id: str | None,
    timeout: float | None,
    max_retries: int | None,
    default_headers: Mapping[str, str] | None,
    default_query: Mapping[str, object] | None,
    http_client: httpx.Client | None,
    async_http_client: httpx.AsyncClient | None,
    auto_create: bool,
) -> ClientCore:
    return ClientCore(
        api_key=resolve_api_key(api_key),
        base_url=resolve_base_url(base_url),
        workspace_id=resolve_workspace(workspace_id),
        timeout=resolve_timeout(timeout),
        max_retries=resolve_max_retries(max_retries),
        default_headers=default_headers,
        default_query=default_query,
        http_client=http_client,
        async_http_client=async_http_client,
        auto_create=auto_create,
    )


class Recall(RecallBase, SyncMode):
    """Client for a Recall server (hosted or self-hosted). Blocking; see ``.aio`` for async.

    Configuration resolves argument -> environment -> default:

    * ``api_key``: ``RECALL_API_KEY``; none means no auth header.
    * server URL: ``base_url``, else ``RECALL_URL`` (or ``RECALL_BASE_URL``), else the hosted
      API, ``https://api.recallmem.dev``. For a server you run yourself pass
      ``base_url="http://localhost:8000"`` or set ``RECALL_URL``.
    * ``workspace_id``: ``RECALL_WORKSPACE_ID``, else ``"default"``.
    * ``timeout`` seconds (default 60), ``max_retries`` (default 2).

    Creating the client, a peer handle or a session handle never touches the network. Reads never
    create anything; pass ``auto_create=True`` for get-or-create behaviour
    (the workspace is ensured on first use, and ``get_*`` / ``refresh`` create missing peers and
    sessions).
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        workspace_id: str | None = None,
        timeout: float | None = None,
        max_retries: int | None = None,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        http_client: httpx.Client | None = None,
        *,
        auto_create: bool = False,
    ) -> None:
        self._core = _build_core(
            api_key=api_key,
            base_url=base_url,
            workspace_id=workspace_id,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            default_query=default_query,
            http_client=http_client,
            async_http_client=None,
            auto_create=auto_create,
        )

    @property
    def conclusions(self) -> WorkspaceConclusions:
        """Read access to every conclusion in the workspace."""
        return WorkspaceConclusions._make(self._core)  # type: ignore[no-any-return]

    @property
    def webhooks(self) -> Webhooks:
        """Manage webhook endpoints; see ``construct_webhook_event`` to verify deliveries."""
        return Webhooks._make(self._core)  # type: ignore[no-any-return]

    @property
    def aio(self) -> RecallAio:
        """The async twin: same methods as coroutines, sharing this client's configuration."""
        twin = RecallAio.__new__(RecallAio)
        twin._core = self._core
        return twin

    def __enter__(self) -> Recall:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class RecallAio(RecallBase, AsyncMode):
    """The ``async`` twin of ``Recall`` (``recall.aio``)."""

    @property
    def webhooks(self) -> WebhooksAio:
        """Manage webhook endpoints; see ``construct_webhook_event`` to verify deliveries."""
        return WebhooksAio._make(self._core)  # type: ignore[no-any-return]

    @property
    def conclusions(self) -> WorkspaceConclusionsAio:
        """Read access to every conclusion in the workspace."""
        return WorkspaceConclusionsAio._make(self._core)  # type: ignore[no-any-return]

    async def aclose(self) -> None:
        await self._core.aclose()

    async def __aenter__(self) -> RecallAio:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()


class AsyncRecall(RecallAio):
    """A standalone async client: ``async with AsyncRecall() as p: await p.peer("alice")``.

    Same arguments as ``Recall``; ``http_client`` is an ``httpx.AsyncClient``.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        workspace_id: str | None = None,
        timeout: float | None = None,
        max_retries: int | None = None,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        http_client: httpx.AsyncClient | None = None,
        *,
        auto_create: bool = False,
    ) -> None:
        self._core = _build_core(
            api_key=api_key,
            base_url=base_url,
            workspace_id=workspace_id,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            default_query=default_query,
            http_client=None,
            async_http_client=http_client,
            auto_create=auto_create,
        )

    async def __aenter__(self) -> AsyncRecall:
        return self


# Unused-import guard for names re-exported for type checkers.
_ = (dump_dict,)
