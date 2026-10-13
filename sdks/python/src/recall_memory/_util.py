"""Small helpers shared by the resource classes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any, Protocol
from urllib.parse import quote

from pydantic import BaseModel


class HasId(Protocol):
    @property
    def id(self) -> str: ...


def dump(value: Any) -> Any:
    """Models -> plain JSON-able dicts without unset fields; everything else unchanged."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=True)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def dump_dict(value: Any) -> dict[str, Any] | None:
    out = dump(value)
    return None if out is None else dict(out)


def rid(value: str | HasId) -> str:
    """An id from either a string or any handle/object with ``.id``."""
    return value if isinstance(value, str) else value.id


def seg(value: str | HasId) -> str:
    """A URL path segment for an id (ids may legally contain characters like ``.``)."""
    return quote(rid(value), safe="")


def ws_path(workspace_id: str, suffix: str = "") -> str:
    return f"/v3/workspaces/{quote(workspace_id, safe='')}{suffix}"


def list_body(filters: Mapping[str, Any] | None) -> dict[str, Any]:
    return {"filters": dict(filters)} if filters else {}


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Sequence):
        return [value]
    return list(value)
