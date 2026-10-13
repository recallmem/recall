"""Transport, retries and the sync/async operation machinery.

Every public method of the SDK is written once, as a generator that *yields* ``Request`` objects
and is *sent* ``Response`` objects (a sans-IO coroutine). The ``@operation`` descriptor then
exposes it as a plain method on the sync classes and as an ``async def`` on their ``.aio`` twins,
with the same signature and a precise return type. Retries, auth headers and error mapping live
here and nowhere else.
"""

from __future__ import annotations

import asyncio
import email.utils
import functools
import inspect
import json as jsonlib
import platform
import random
import time
from collections.abc import Awaitable, Callable, Generator, Mapping
from dataclasses import dataclass, field
from typing import (
    Any,
    Concatenate,
    Generic,
    Literal,
    ParamSpec,
    TypeVar,
    cast,
    overload,
)

import httpx

from ._version import __version__
from .errors import (
    RecallConnectionError,
    RecallError,
    RecallTimeoutError,
    error_for_status,
)

P = ParamSpec("P")
R = TypeVar("R")
S = TypeVar("S")
A = TypeVar("A")

UNSET: Any = object()

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
# For writes the server cannot de-duplicate: only retry when the request cannot have been applied.
UNSAFE_RETRY_STATUSES = frozenset({429, 503})
BACKOFF_BASE = 0.5
BACKOFF_CAP = 8.0
RETRY_AFTER_CAP = 60.0


@dataclass(slots=True)
class Request:
    """One HTTP request, described independently of sync/async execution."""

    method: str
    path: str
    params: Mapping[str, Any] | None = None
    json: Any = UNSET
    data: Mapping[str, str] | None = None
    files: Mapping[str, tuple[str, bytes, str]] | None = None
    headers: Mapping[str, str] | None = None
    #: "safe": retry on timeouts, network errors and 429/5xx (reads, upserts, writes carrying an
    #: Idempotency-Key). "unsafe": a retry could apply the write twice, so only retry when the
    #: request provably never reached the application (connect failures, 429, 503).
    retry: Literal["safe", "unsafe"] = "safe"
    stream: bool = False
    timeout: float | None = None
    workspace_scoped: bool = True
    #: A DELETE retried after a lost response finds the resource gone; treat that 404 as success.
    missing_ok_on_retry: bool = False


@dataclass(slots=True)
class Sleep:
    """Yielded by an operation to pause (so polling loops work in both sync and async mode)."""

    seconds: float


@dataclass(slots=True)
class Response:
    status: int
    headers: httpx.Headers
    body: Any = None
    request_id: str | None = None
    #: The open streaming response (stream requests only).
    raw: httpx.Response | None = field(default=None, repr=False)


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, float(when.timestamp() - time.time()))


def _request_id(headers: httpx.Headers) -> str | None:
    return headers.get("x-request-id") or headers.get("request-id") or None


def _clean_params(params: Mapping[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in (params or {}).items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            items = [v for v in value if v is not None]
            if items:
                out[key] = items
        else:
            out[key] = value
    return out


class ClientCore:
    """Shared by a sync client, its ``.aio`` twin and every handle they create."""

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        workspace_id: str,
        timeout: float,
        max_retries: int,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, Any] | None = None,
        http_client: httpx.Client | None = None,
        async_http_client: httpx.AsyncClient | None = None,
        auto_create: bool = False,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.workspace_id = workspace_id
        self.timeout = timeout
        self.max_retries = max_retries
        self.default_headers = dict(default_headers or {})
        self.default_query = dict(default_query or {})
        self.auto_create = auto_create
        self._ensured = False
        self._sync_client = http_client
        self._async_client = async_http_client
        self._owns_sync = http_client is None
        self._owns_async = async_http_client is None
        # Overridable in tests so retry behaviour can be exercised without waiting.
        self.sleep: Callable[[float], None] = time.sleep
        self.asleep: Callable[[float], Awaitable[None]] = asyncio.sleep
        self.random: Callable[[], float] = random.random
        # Workspace-level cached state (shared between the sync client and its async view).
        self.metadata: dict[str, Any] | None = None
        self.configuration: dict[str, Any] | None = None

    # ---- clients ---------------------------------------------------------------------

    @property
    def sync_client(self) -> httpx.Client:
        if self._sync_client is None:
            self._sync_client = httpx.Client(timeout=self.timeout)
            self._owns_sync = True
        return self._sync_client

    @property
    def async_client(self) -> httpx.AsyncClient:
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(timeout=self.timeout)
            self._owns_async = True
        return self._async_client

    def close(self) -> None:
        if self._sync_client is not None and self._owns_sync:
            self._sync_client.close()
            self._sync_client = None

    async def aclose(self) -> None:
        if self._async_client is not None and self._owns_async:
            await self._async_client.aclose()
            self._async_client = None
        self.close()

    # ---- request building ------------------------------------------------------------

    def headers_for(self, req: Request) -> dict[str, str]:
        headers = {
            "Accept": "text/event-stream" if req.stream else "application/json",
            "User-Agent": f"recall-memory-python/{__version__} ({platform.system().lower()})",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self.default_headers)
        headers.update(req.headers or {})
        return headers

    def build(self, client: httpx.Client | httpx.AsyncClient, req: Request) -> httpx.Request:
        params = {**self.default_query, **_clean_params(req.params)}
        kwargs: dict[str, Any] = {
            "params": params or None,
            "headers": self.headers_for(req),
            "timeout": req.timeout if req.timeout is not None else self.timeout,
        }
        if req.json is not UNSET:
            kwargs["content"] = jsonlib.dumps(req.json, separators=(",", ":"), default=str).encode()
            kwargs["headers"]["Content-Type"] = "application/json"
        if req.files is not None:
            kwargs["files"] = req.files
        if req.data is not None:
            kwargs["data"] = dict(req.data)
        return client.build_request(req.method, f"{self.base_url}{req.path}", **kwargs)

    # ---- retry policy ----------------------------------------------------------------

    def backoff(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(retry_after, RETRY_AFTER_CAP)
        ceiling = min(BACKOFF_CAP, BACKOFF_BASE * float(2**attempt))
        return self.random() * ceiling  # full jitter

    def _error_to_raise(self, exc: Exception) -> RecallError:
        if isinstance(exc, httpx.TimeoutException):
            return RecallTimeoutError(f"Request timed out: {exc!r}")
        return RecallConnectionError(f"Connection error: {exc!r}")

    def _exc_retryable(self, req: Request, exc: Exception) -> bool:
        if isinstance(exc, (httpx.UnsupportedProtocol, httpx.ProxyError)):
            return False
        if req.retry == "unsafe":
            return isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))
        return isinstance(exc, httpx.TransportError)

    def _status_retryable(self, req: Request, status: int) -> bool:
        return status in (RETRY_STATUSES if req.retry == "safe" else UNSAFE_RETRY_STATUSES)

    def _finish(self, req: Request, raw: httpx.Response, attempt: int, body: Any) -> Response:
        headers = raw.headers
        rid = _request_id(headers)
        if 200 <= raw.status_code < 300:
            return Response(raw.status_code, headers, body, rid, raw if req.stream else None)
        if req.missing_ok_on_retry and attempt > 0 and raw.status_code == 404:
            return Response(200, headers, None, rid)
        raise error_for_status(
            raw.status_code,
            body,
            retry_after=parse_retry_after(headers.get("retry-after")),
            request_id=rid,
        )

    @staticmethod
    def _decode(raw: httpx.Response) -> Any:
        if not raw.content:
            return None
        try:
            return raw.json()
        except ValueError:
            return raw.text

    # ---- execution -------------------------------------------------------------------

    def send_sync(self, req: Request) -> Response:
        client = self.sync_client
        attempt = 0
        while True:
            raw: httpx.Response | None = None
            try:
                raw = client.send(self.build(client, req), stream=req.stream)
            except httpx.HTTPError as exc:
                if attempt < self.max_retries and self._exc_retryable(req, exc):
                    self.sleep(self.backoff(attempt, None))
                    attempt += 1
                    continue
                raise self._error_to_raise(exc) from exc
            ok = 200 <= raw.status_code < 300
            if req.stream and ok:
                return self._finish(req, raw, attempt, None)
            try:
                raw.read()
            except httpx.HTTPError as exc:
                raw.close()
                if attempt < self.max_retries and self._exc_retryable(req, exc):
                    self.sleep(self.backoff(attempt, None))
                    attempt += 1
                    continue
                raise self._error_to_raise(exc) from exc
            finally:
                if req.stream:
                    raw.close()
            if (
                not ok
                and attempt < self.max_retries
                and self._status_retryable(req, raw.status_code)
            ):
                self.sleep(self.backoff(attempt, parse_retry_after(raw.headers.get("retry-after"))))
                attempt += 1
                continue
            return self._finish(req, raw, attempt, self._decode(raw))

    async def send_async(self, req: Request) -> Response:
        client = self.async_client
        attempt = 0
        while True:
            raw: httpx.Response | None = None
            try:
                raw = await client.send(self.build(client, req), stream=req.stream)
            except httpx.HTTPError as exc:
                if attempt < self.max_retries and self._exc_retryable(req, exc):
                    await self.asleep(self.backoff(attempt, None))
                    attempt += 1
                    continue
                raise self._error_to_raise(exc) from exc
            ok = 200 <= raw.status_code < 300
            if req.stream and ok:
                return self._finish(req, raw, attempt, None)
            try:
                await raw.aread()
            except httpx.HTTPError as exc:
                await raw.aclose()
                if attempt < self.max_retries and self._exc_retryable(req, exc):
                    await self.asleep(self.backoff(attempt, None))
                    attempt += 1
                    continue
                raise self._error_to_raise(exc) from exc
            finally:
                if req.stream:
                    await raw.aclose()
            if (
                not ok
                and attempt < self.max_retries
                and self._status_retryable(req, raw.status_code)
            ):
                await self.asleep(
                    self.backoff(attempt, parse_retry_after(raw.headers.get("retry-after")))
                )
                attempt += 1
                continue
            return self._finish(req, raw, attempt, self._decode(raw))

    # ---- drivers ---------------------------------------------------------------------

    def _ensure_request(self, req: Request) -> Request | None:
        """The one-time get-or-create of the workspace, when ``auto_create`` is on."""
        if self.auto_create and not self._ensured and req.workspace_scoped:
            self._ensured = True
            return Request(
                "POST", "/v3/workspaces", json={"id": self.workspace_id}, workspace_scoped=False
            )
        return None

    def run_sync(self, gen: Generator[Request, Response, R]) -> R:
        try:
            req = next(gen)
            while True:
                if isinstance(req, Sleep):
                    self.sleep(req.seconds)
                    req = gen.send(None)
                    continue
                try:
                    pre = self._ensure_request(req)
                    if pre is not None:
                        self.send_sync(pre)
                    resp = self.send_sync(req)
                except RecallError as exc:
                    req = gen.throw(exc)
                    continue
                req = gen.send(resp)
        except StopIteration as stop:
            return cast("R", stop.value)

    async def run_async(self, gen: Generator[Request, Response, R]) -> R:
        try:
            req = next(gen)
            while True:
                if isinstance(req, Sleep):
                    await self.asleep(req.seconds)
                    req = gen.send(None)
                    continue
                try:
                    pre = self._ensure_request(req)
                    if pre is not None:
                        await self.send_async(pre)
                    resp = await self.send_async(req)
                except RecallError as exc:
                    req = gen.throw(exc)
                    continue
                req = gen.send(resp)
        except StopIteration as stop:
            return cast("R", stop.value)


# --------------------------------------------------------------------------------------
# Sync/async dual exposure
# --------------------------------------------------------------------------------------


class SyncMode:
    """Marker base for objects whose operations run synchronously."""

    _is_async = False
    _core: ClientCore


class AsyncMode:
    """Marker base for ``.aio`` views whose operations are coroutines."""

    _is_async = True
    _core: ClientCore


class Dual(Generic[S, A]):
    """Typing-only: a result that is ``S`` for sync callers and ``A`` for async callers."""


def _public_signature(fn: Callable[..., Any]) -> inspect.Signature:
    sig = inspect.signature(fn)
    return sig.replace(parameters=list(sig.parameters.values())[1:])


class _OperationBase:
    fn: Callable[..., Any]
    name: str

    def __init__(self, fn: Callable[..., Any]) -> None:
        self.fn = fn
        self.name = fn.__name__
        self.__doc__ = fn.__doc__
        self.__wrapped__ = fn
        self.__signature__ = _public_signature(fn)

    def __set_name__(self, owner: type, name: str) -> None:
        self.name = name

    def _bind(self, obj: Any) -> Callable[..., Any]:
        fn = self.fn
        core: ClientCore = obj._core
        if obj._is_async:

            @functools.wraps(fn)
            async def acall(*args: Any, **kwargs: Any) -> Any:
                return await core.run_async(fn(obj, *args, **kwargs))

            acall.__signature__ = self.__signature__  # type: ignore[attr-defined]
            return acall

        @functools.wraps(fn)
        def call(*args: Any, **kwargs: Any) -> Any:
            return core.run_sync(fn(obj, *args, **kwargs))

        call.__signature__ = self.__signature__  # type: ignore[attr-defined]
        return call


class operation(_OperationBase, Generic[P, R]):
    """Expose a request-generator as ``f(...) -> R`` (sync) or ``await f(...) -> R`` (aio)."""

    def __init__(self, fn: Callable[Concatenate[Any, P], Generator[Any, Any, R]]) -> None:
        super().__init__(fn)

    @overload
    def __get__(self, obj: None, owner: type | None = None) -> operation[P, R]: ...
    @overload
    def __get__(self, obj: SyncMode, owner: type | None = None) -> Callable[P, R]: ...
    @overload
    def __get__(self, obj: AsyncMode, owner: type | None = None) -> Callable[P, Awaitable[R]]: ...
    def __get__(self, obj: Any, owner: type | None = None) -> Any:
        if obj is None:
            return self
        return self._bind(obj)


class dual_operation(_OperationBase, Generic[P, S, A]):
    """Like ``operation`` for results whose type differs per mode (pages, streams)."""

    def __init__(self, fn: Callable[Concatenate[Any, P], Generator[Any, Any, Dual[S, A]]]) -> None:
        super().__init__(fn)

    @overload
    def __get__(self, obj: None, owner: type | None = None) -> dual_operation[P, S, A]: ...
    @overload
    def __get__(self, obj: SyncMode, owner: type | None = None) -> Callable[P, S]: ...
    @overload
    def __get__(self, obj: AsyncMode, owner: type | None = None) -> Callable[P, Awaitable[A]]: ...
    def __get__(self, obj: Any, owner: type | None = None) -> Any:
        if obj is None:
            return self
        return self._bind(obj)


def as_dual(value: Any) -> Dual[Any, Any]:
    """Tell the type checker that ``value`` is the mode-appropriate half of a ``Dual``."""
    return cast("Dual[Any, Any]", value)


# --------------------------------------------------------------------------------------
# Sync/async class pairs
# --------------------------------------------------------------------------------------

_PAIRS: dict[str, tuple[type, type]] = {}


def register_pair(name: str, sync_cls: type, async_cls: type) -> None:
    _PAIRS[name] = (sync_cls, async_cls)


def pair_class(obj: Any, name: str) -> Any:
    """The class named ``name`` in the same mode (sync/aio) as ``obj``."""
    return _PAIRS[name][1 if obj._is_async else 0]
