"""Exception hierarchy.

Each HTTP status maps to a class (``NotFoundError`` for 404, and so on). Every error can carry the
server's ``request_id`` when one is returned, and the timeout/connection errors have unambiguous
``Recall*`` names (the short ``TimeoutError`` / ``ConnectionError`` names are kept as aliases, but
are *not* part of ``__all__`` so ``from recall_memory import *`` never shadows the builtins).
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "APIError",
    "AuthenticationError",
    "BadRequestError",
    "ConflictError",
    "NotFoundError",
    "RecallConnectionError",
    "RecallError",
    "RecallTimeoutError",
    "PermissionDeniedError",
    "RateLimitError",
    "ServerError",
    "UnprocessableEntityError",
    "error_for_status",
    "message_from_body",
]


class RecallError(Exception):
    """Root of every error raised by this SDK."""

    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        code: str | None = None,
        body: Any = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.body = body
        self.request_id = request_id

    @property
    def status_code(self) -> int:
        return self.status

    def __str__(self) -> str:
        parts = [self.message]
        if self.status:
            parts.append(f"(status {self.status})")
        if self.request_id:
            parts.append(f"[request {self.request_id}]")
        return " ".join(parts)


class APIError(RecallError):
    """Any non-2xx response that has no more specific class."""


class BadRequestError(APIError):
    """HTTP 400."""


class AuthenticationError(APIError):
    """HTTP 401. Note that the server also uses 401 for every authorization failure."""


class PermissionDeniedError(APIError):
    """HTTP 403."""


class NotFoundError(APIError):
    """HTTP 404."""


class ConflictError(APIError):
    """HTTP 409."""


class UnprocessableEntityError(APIError):
    """HTTP 422. ``body['detail']`` is either a string or a list of validation problems."""


class RateLimitError(APIError):
    """HTTP 429. ``retry_after`` is the server's ``Retry-After`` in seconds, when sent."""

    def __init__(self, message: str, *, retry_after: float | None = None, **kw: Any) -> None:
        super().__init__(message, **kw)
        self.retry_after = retry_after


class ServerError(APIError):
    """HTTP 5xx."""


class RecallTimeoutError(RecallError):
    """The client-side timeout elapsed (or ``wait_for_idle`` ran out of time)."""


class RecallConnectionError(RecallError):
    """The request never produced a response (DNS, refused connection, reset, ...)."""


# Short names for the two transport errors.
TimeoutError = RecallTimeoutError
ConnectionError = RecallConnectionError

_BY_STATUS: dict[int, type[APIError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitError,
}


def message_from_body(body: Any, status: int) -> str:
    """``detail`` -> ``message`` -> ``error`` -> the stringified body -> ``HTTP <status>``."""
    if isinstance(body, dict):
        for key in ("detail", "message", "error"):
            value = body.get(key)
            if value in (None, "", [], {}):
                continue
            if isinstance(value, str):
                return value
            if key == "detail" and isinstance(value, list):
                # FastAPI-style validation problems: "body.field: message; ..."
                bits = []
                for item in value:
                    if isinstance(item, dict) and "msg" in item:
                        loc = ".".join(str(p) for p in item.get("loc", []))
                        bits.append(f"{loc}: {item['msg']}" if loc else str(item["msg"]))
                    else:
                        bits.append(str(item))
                return "; ".join(bits)
            return str(value)
    elif isinstance(body, str) and body.strip():
        return body.strip()
    if body not in (None, "", [], {}):
        return str(body)
    return f"HTTP {status}"


def error_for_status(
    status: int,
    body: Any,
    *,
    retry_after: float | None = None,
    request_id: str | None = None,
) -> APIError:
    """Build the right ``APIError`` subclass for a non-2xx response."""
    message = message_from_body(body, status)
    code = (
        body.get("code") if isinstance(body, dict) and isinstance(body.get("code"), str) else None
    )
    kwargs: dict[str, Any] = {
        "status": status,
        "code": code,
        "body": body,
        "request_id": request_id,
    }
    if status == 429:
        return RateLimitError(message, retry_after=retry_after, **kwargs)
    cls = _BY_STATUS.get(status)
    if cls is None:
        cls = ServerError if status >= 500 else APIError
    return cls(message, **kwargs)
