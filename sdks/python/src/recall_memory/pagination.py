"""Page objects for list endpoints.

Iterating a page walks *every* remaining page. For bounded reads use
``iter_all(limit=...)`` / ``to_list(limit=...)``; for page-at-a-time control use
``get_next_page()``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Generator, Iterator
from typing import Any, Generic, TypeVar, cast

from ._core import ClientCore, Request, Response

T = TypeVar("T")  # the wire model
U = TypeVar("U")  # what the SDK hands out (often a handle object)

__all__ = ["AsyncPage", "Page", "SyncPage", "fetch_page"]

PageFetcher = Callable[[int], Generator[Request, Response, Any]]


class Page(Generic[T, U]):
    """Shared page state. Use the ``SyncPage`` / ``AsyncPage`` flavour you were given."""

    def __init__(
        self,
        *,
        core: ClientCore,
        raw_items: list[T],
        items: list[U],
        total: int | None,
        page: int,
        size: int,
        pages: int | None,
        fetch: PageFetcher,
    ) -> None:
        self._core = core
        self._fetch = fetch
        self.raw_items = raw_items
        self.items = items
        self.total = total
        self.page = page
        self.size = size
        self.pages = pages

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> U:
        return self.items[index]

    def has_next_page(self) -> bool:
        if self.pages is None:
            return len(self.items) >= self.size
        return self.page < self.pages

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(page={self.page}, size={self.size}, "
            f"items={len(self.items)}, total={self.total})"
        )


class SyncPage(Page[T, U]):
    def get_next_page(self) -> SyncPage[T, U] | None:
        if not self.has_next_page():
            return None
        return cast("SyncPage[T, U]", self._core.run_sync(self._fetch(self.page + 1)))

    def iter_pages(self) -> Iterator[SyncPage[T, U]]:
        page: SyncPage[T, U] | None = self
        while page is not None:
            yield page
            page = page.get_next_page()

    def iter_all(self, limit: int | None = None) -> Iterator[U]:
        """Yield items across all pages, stopping after ``limit`` items when given."""
        n = 0
        for page in self.iter_pages():
            for item in page.items:
                if limit is not None and n >= limit:
                    return
                yield item
                n += 1

    def __iter__(self) -> Iterator[U]:
        return self.iter_all()

    def to_list(self, limit: int | None = None) -> list[U]:
        return list(self.iter_all(limit))


class AsyncPage(Page[T, U]):
    async def get_next_page(self) -> AsyncPage[T, U] | None:
        if not self.has_next_page():
            return None
        return cast("AsyncPage[T, U]", await self._core.run_async(self._fetch(self.page + 1)))

    async def iter_pages(self) -> AsyncIterator[AsyncPage[T, U]]:
        page: AsyncPage[T, U] | None = self
        while page is not None:
            yield page
            page = await page.get_next_page()

    async def iter_all(self, limit: int | None = None) -> AsyncIterator[U]:
        n = 0
        async for page in self.iter_pages():
            for item in page.items:
                if limit is not None and n >= limit:
                    return
                yield item
                n += 1

    def __aiter__(self) -> AsyncIterator[U]:
        return self.iter_all()

    async def to_list(self, limit: int | None = None) -> list[U]:
        return [item async for item in self.iter_all(limit)]


def fetch_page(
    core: ClientCore,
    *,
    is_async: bool,
    build: Callable[[int], Request],
    parse: Callable[[Any], T],
    wrap: Callable[[T], U],
    page: int,
    size: int,
) -> Generator[Request, Response, Page[T, U]]:
    """Request page ``page`` and return it as a ``SyncPage`` or ``AsyncPage``.

    ``build(n)`` makes the request for page ``n``; ``parse`` validates one raw item into the wire
    model and ``wrap`` turns that into the object callers see.
    """
    resp = yield build(page)
    body: dict[str, Any] = resp.body if isinstance(resp.body, dict) else {"items": resp.body or []}
    raw = [parse(item) for item in body.get("items", [])]

    def fetch(n: int) -> Generator[Request, Response, Page[T, U]]:
        return fetch_page(
            core, is_async=is_async, build=build, parse=parse, wrap=wrap, page=n, size=size
        )

    cls: type[Page[T, U]] = AsyncPage if is_async else SyncPage
    return cls(
        core=core,
        raw_items=raw,
        items=[wrap(r) for r in raw],
        total=body.get("total"),
        page=int(body.get("page") or page),
        size=int(body.get("size") or size),
        pages=body.get("pages"),
        fetch=fetch,
    )
