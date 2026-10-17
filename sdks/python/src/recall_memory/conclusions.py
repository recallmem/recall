"""Conclusions: facts an observer believes about an observed peer."""

from __future__ import annotations

from collections.abc import Generator, Mapping, Sequence
from typing import Any

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
from ._util import HasId, dump, list_body, rid, seg, ws_path
from .models import Conclusion, ConclusionCreateParams, ConclusionResponse, Message
from .pagination import AsyncPage, SyncPage, fetch_page

_List = list

__all__ = [
    "ConclusionScope",
    "ConclusionScopeAio",
    "ConclusionsView",
    "ConclusionsViewAio",
    "ConclusionsViewBase",
    "WorkspaceConclusions",
    "WorkspaceConclusionsAio",
]

MAX_BATCH = 100
_RESERVED = ("observer", "observed", "observer_id", "observed_id")

ConclusionInput = ConclusionCreateParams | Mapping[str, Any]
ConclusionPage = Dual[
    SyncPage[ConclusionResponse, Conclusion], AsyncPage[ConclusionResponse, Conclusion]
]


def _to_conclusion(r: ConclusionResponse) -> Conclusion:
    return Conclusion.model_validate(r.model_dump())


def _list_pages(
    core: Any,
    *,
    is_async: bool,
    body: dict[str, Any],
    page: int,
    size: int,
    reverse: bool,
) -> Generator[Request, Response, Any]:
    def build(n: int) -> Request:
        return Request(
            "POST",
            ws_path(core.workspace_id, "/conclusions/list"),
            params={"page": n, "size": size, "reverse": reverse or None},
            json=body,
        )

    return fetch_page(
        core,
        is_async=is_async,
        build=build,
        parse=ConclusionResponse.model_validate,
        wrap=_to_conclusion,
        page=page,
        size=size,
    )


class _ConclusionsCommon:
    _core: Any
    _is_async: bool

    def _scope_filters(self) -> dict[str, Any]:
        return {}

    def _filters(self, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if extra:
            clash = [k for k in _RESERVED if k in extra]
            if clash and self._scope_filters():
                raise ValueError(
                    f"{', '.join(clash)} cannot be passed in filters: they are fixed by this view"
                )
        return {**(dict(extra) if extra else {}), **self._scope_filters()}

    def _path(self, suffix: str = "") -> str:
        return ws_path(self._core.workspace_id, f"/conclusions{suffix}")

    def _get(self, conclusion_id: str) -> Generator[Request, Response, Conclusion]:
        resp = yield Request("GET", self._path(f"/{seg(conclusion_id)}"))
        return Conclusion.model_validate(resp.body)

    def _get_many(self, ids: Sequence[str]) -> Generator[Request, Response, _List[Conclusion]]:
        found: dict[str, Conclusion] = {}
        wanted = list(dict.fromkeys(ids))
        for start in range(0, len(wanted), MAX_BATCH):
            chunk = wanted[start : start + MAX_BATCH]
            resp = yield Request(
                "POST",
                self._path("/list"),
                params={"size": MAX_BATCH},
                json={"filters": self._filters({"id": {"in": chunk}})},
            )
            for item in resp.body.get("items", []):
                c = Conclusion.model_validate(item)
                found[c.id] = c
        return [found[i] for i in ids if i in found]


class ConclusionsViewBase(_ConclusionsCommon):
    """Conclusions ``observer`` holds about ``observed`` (create, search, list, delete)."""

    def __init__(
        self, client: Any, workspace_id: str, observer: str | HasId, observed: str | HasId
    ) -> None:
        self._core = client._core
        self.workspace_id = workspace_id
        self.observer_id = rid(observer)
        self.observed_id = rid(observed)

    @classmethod
    def _make(cls, core: Any, observer_id: str, observed_id: str) -> Any:
        self = cls.__new__(cls)
        self._core = core
        self.workspace_id = core.workspace_id
        self.observer_id = observer_id
        self.observed_id = observed_id
        return self

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(observer={self.observer_id!r}, observed={self.observed_id!r})"
        )

    def _scope_filters(self) -> dict[str, Any]:
        return {"observer_id": self.observer_id, "observed_id": self.observed_id}

    @dual_operation
    def list(
        self,
        page: int = 1,
        size: int = 50,
        session: str | HasId | None = None,
        *,
        filters: Mapping[str, Any] | None = None,
        reverse: bool = False,
    ) -> Generator[Request, Response, ConclusionPage]:
        """Newest first. ``filters`` are ANDed with the fixed observer/observed pair."""
        merged = self._filters(filters)
        if session is not None:
            merged["session_id"] = rid(session)
        result = yield from _list_pages(
            self._core,
            is_async=self._is_async,
            body={"filters": merged},
            page=page,
            size=size,
            reverse=reverse,
        )
        return as_dual(result)

    @operation
    def query(
        self,
        query: str,
        top_k: int = 10,
        distance: float | None = None,
        *,
        filters: Mapping[str, Any] | None = None,
    ) -> Generator[Request, Response, _List[Conclusion]]:
        """Semantic search, nearest first. ``top_k`` 1 to 100, ``distance`` 0 to 1."""
        body: dict[str, Any] = {"query": query, "top_k": top_k, "filters": self._filters(filters)}
        if distance is not None:
            body["distance"] = distance
        resp = yield Request("POST", self._path("/query"), json=body)
        return [Conclusion.model_validate(c) for c in resp.body]

    @operation
    def get(self, conclusion_id: str) -> Generator[Request, Response, Conclusion]:
        return (yield from self._get(conclusion_id))

    @operation
    def get_many(
        self, conclusion_ids: Sequence[str]
    ) -> Generator[Request, Response, _List[Conclusion]]:
        """Fetch several by id (in the order given; unknown ids are skipped)."""
        return (yield from self._get_many(conclusion_ids))

    @dual_operation
    def derived(
        self, conclusion_id: str, page: int = 1, size: int = 50, *, reverse: bool = False
    ) -> Generator[Request, Response, ConclusionPage]:
        """Conclusions that were derived from ``conclusion_id``."""
        result = yield from _list_pages(
            self._core,
            is_async=self._is_async,
            body={"filters": self._filters({"source_ids": {"contains": conclusion_id}})},
            page=page,
            size=size,
            reverse=reverse,
        )
        return as_dual(result)

    @operation
    def delete(self, conclusion_id: str) -> Generator[Request, Response, None]:
        yield Request("DELETE", self._path(f"/{seg(conclusion_id)}"), missing_ok_on_retry=True)

    @operation
    def create(
        self, conclusions: ConclusionInput | Sequence[ConclusionInput]
    ) -> Generator[Request, Response, _List[Conclusion]]:
        """Write conclusions directly (1 to 100 per request; longer lists are batched in order)."""
        items = (
            [conclusions] if isinstance(conclusions, (BaseModel, Mapping)) else list(conclusions)
        )
        created: _List[Conclusion] = []
        for start in range(0, len(items), MAX_BATCH):
            payload = []
            for item in items[start : start + MAX_BATCH]:
                data = dump(item) if isinstance(item, BaseModel) else dict(item)
                payload.append(
                    {
                        **{k: v for k, v in data.items() if v is not None},
                        "observer_id": self.observer_id,
                        "observed_id": self.observed_id,
                    }
                )
            # The server cannot de-duplicate these, so a lost response is never retried blindly.
            resp = yield Request(
                "POST", self._path(), json={"conclusions": payload}, retry="unsafe"
            )
            created.extend(Conclusion.model_validate(c) for c in resp.body)
        return created

    @operation
    def representation(
        self,
        search_query: str | Message | None = None,
        search_top_k: int | None = None,
        search_max_distance: float | None = None,
        include_most_frequent: bool | None = None,
        max_conclusions: int | None = None,
    ) -> Generator[Request, Response, str]:
        """Markdown rendering of these conclusions, for prompts."""
        body: dict[str, Any] = {
            "target": self.observed_id,
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
            ws_path(self._core.workspace_id, f"/peers/{seg(self.observer_id)}/representation"),
            json={k: v for k, v in body.items() if v is not None},
        )
        return str(resp.body.get("representation") or "")


class WorkspaceConclusionsBase(_ConclusionsCommon):
    """Conclusions across the whole workspace (read-only)."""

    def __init__(self, client: Any) -> None:
        self._core = client._core

    @classmethod
    def _make(cls, core: Any) -> Any:
        self = cls.__new__(cls)
        self._core = core
        return self

    @dual_operation
    def list(
        self,
        page: int = 1,
        size: int = 50,
        *,
        filters: Mapping[str, Any] | None = None,
        reverse: bool = False,
    ) -> Generator[Request, Response, ConclusionPage]:
        result = yield from _list_pages(
            self._core,
            is_async=self._is_async,
            body=list_body(filters),
            page=page,
            size=size,
            reverse=reverse,
        )
        return as_dual(result)

    @operation
    def get(self, conclusion_id: str) -> Generator[Request, Response, Conclusion]:
        return (yield from self._get(conclusion_id))

    @operation
    def get_many(
        self, conclusion_ids: Sequence[str]
    ) -> Generator[Request, Response, _List[Conclusion]]:
        return (yield from self._get_many(conclusion_ids))

    @operation
    def history(self, conclusion_id: str) -> Generator[Request, Response, dict[str, Any]]:
        """What happened to a fact: ``conclusion``, ``events`` (who changed it, why, from what),
        ``replaced`` (the facts it replaced) and ``replaced_by``."""
        resp = yield Request("GET", self._path(f"/{seg(conclusion_id)}/history"))
        return dict(resp.body)

    @operation
    def pin(
        self, conclusion_id: str, pinned: bool = True
    ) -> Generator[Request, Response, Conclusion]:
        """Pin a fact (or unpin it with ``pinned=False``): Recall never replaces a pinned fact;
        a statement that disagrees is kept next to it and flagged."""
        resp = yield Request("PATCH", self._path(f"/{seg(conclusion_id)}"), json={"pinned": pinned})
        return Conclusion.model_validate(resp.body)


class ConclusionsView(ConclusionsViewBase, SyncMode):
    @property
    def aio(self) -> ConclusionsViewAio:
        twin = ConclusionsViewAio.__new__(ConclusionsViewAio)
        twin.__dict__.update(self.__dict__)
        return twin


class ConclusionsViewAio(ConclusionsViewBase, AsyncMode):
    pass


class WorkspaceConclusions(WorkspaceConclusionsBase, SyncMode):
    @property
    def aio(self) -> WorkspaceConclusionsAio:
        twin = WorkspaceConclusionsAio.__new__(WorkspaceConclusionsAio)
        twin.__dict__.update(self.__dict__)
        return twin


class WorkspaceConclusionsAio(WorkspaceConclusionsBase, AsyncMode):
    pass


# Back-compat aliases kept by the reference SDK.
ConclusionScope = ConclusionsView
ConclusionScopeAio = ConclusionsViewAio

register_pair("conclusions_view", ConclusionsView, ConclusionsViewAio)
register_pair("workspace_conclusions", WorkspaceConclusions, WorkspaceConclusionsAio)
