"""Base class and lookup helpers for the Peer / Session / Scope handles."""

from __future__ import annotations

from collections.abc import Generator
from typing import Any, TypeVar

from ._core import AsyncMode, ClientCore, Request, Response, SyncMode, pair_class
from ._util import ws_path
from .errors import AuthenticationError, NotFoundError

H = TypeVar("H", bound="Handle")


class Handle:
    """A lightweight, lazily-evaluated reference to a server-side resource."""

    _core: ClientCore
    _is_async: bool
    id: str

    def _cls(self, name: str) -> Any:
        """The class registered as ``name`` in this handle's own mode (sync or aio)."""
        return pair_class(self, name)

    @property
    def workspace_id(self) -> str:
        return self._core.workspace_id

    @classmethod
    def _share(cls: type[H], other: Handle) -> H:
        """A twin of ``other`` in this class's mode, sharing its client and cached state."""
        twin = cls.__new__(cls)
        twin.__dict__.update(other.__dict__)
        return twin

    def __repr__(self) -> str:
        return f"{type(self).__name__}(id={self.id!r})"

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Handle)
            and other._core.workspace_id == self._core.workspace_id
            and other.id == self.id
            and other._kind() == self._kind()
        )

    def __hash__(self) -> int:
        return hash((self._kind(), self._core.workspace_id, self.id))

    def _kind(self) -> str:
        return type(self).__name__.removesuffix("Aio")


def lookup(
    core: ClientCore, kind: str, resource_id: str, collection: str
) -> Generator[Request, Response, dict[str, Any]]:
    """Fetch a peer/session without creating it.

    The API only has get-or-create for single resources, so a read is a one-row filtered list.
    Tokens that may not list (peer- or session-scoped) fall back to their own get-or-create.
    With ``auto_create=True`` it is always a get-or-create.
    """
    base = ws_path(core.workspace_id, f"/{collection}")
    if not core.auto_create:
        try:
            resp = yield Request(
                "POST", f"{base}/list", params={"size": 1}, json={"filters": {"id": resource_id}}
            )
        except AuthenticationError:
            pass
        else:
            items = resp.body.get("items") if isinstance(resp.body, dict) else None
            if not items:
                raise NotFoundError(
                    f"{kind} '{resource_id}' not found in workspace '{core.workspace_id}'",
                    status=404,
                    body={"detail": f"{kind} not found"},
                )
            return dict(items[0])
    resp = yield Request("POST", base, json={"id": resource_id})
    return dict(resp.body)


__all__ = ["AsyncMode", "Handle", "SyncMode", "lookup"]
