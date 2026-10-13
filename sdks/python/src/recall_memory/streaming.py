"""Server-sent-event streams for dialectic chat."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx

from .errors import RecallConnectionError, RecallError, RecallTimeoutError
from .models import Evidence

__all__ = ["AsyncDialecticStreamResponse", "DialecticStreamResponse"]


def _parse_line(line: str) -> dict[str, Any] | None:
    """One SSE line -> its JSON payload, or ``None`` for anything that is not a data event."""
    if not line.startswith("data:"):
        return None
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        event = json.loads(payload)
    except ValueError:
        return None
    return event if isinstance(event, dict) else None


def _wrap(exc: httpx.HTTPError) -> RecallError:
    if isinstance(exc, httpx.TimeoutException):
        return RecallTimeoutError(f"Stream timed out: {exc!r}")
    return RecallConnectionError(f"Stream interrupted: {exc!r}")


class _StreamState:
    def __init__(self) -> None:
        self.parts: list[str] = []
        self.done = False
        self.evidence: Evidence | None = None
        self.citations: list[str] = []
        self.confidence: float | None = None
        self.abstained: bool | None = None

    def feed(self, event: dict[str, Any]) -> str | None:
        """Absorb one event; returns the text delta it carried, if any."""
        delta = event.get("delta")
        text: str | None = None
        if isinstance(delta, dict) and isinstance(delta.get("content"), str):
            text = delta["content"]
            self.parts.append(text)
        if event.get("done"):
            self.done = True
            if isinstance(event.get("evidence"), dict):
                self.evidence = Evidence.model_validate(event["evidence"])
            self.citations = list(event.get("citations") or [])
            self.confidence = event.get("confidence")
            self.abstained = event.get("abstained")
        return text or None


class _StreamBase:
    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self._state = _StreamState()
        self._exhausted = False

    @property
    def is_complete(self) -> bool:
        """True once the server's terminal event has been seen."""
        return self._state.done

    @property
    def evidence(self) -> Evidence | None:
        return self._state.evidence

    @property
    def citations(self) -> list[str]:
        return self._state.citations

    @property
    def confidence(self) -> float | None:
        return self._state.confidence

    @property
    def abstained(self) -> bool | None:
        return self._state.abstained

    @property
    def text(self) -> str:
        """Everything received so far."""
        return "".join(self._state.parts)


class DialecticStreamResponse(_StreamBase):
    """Iterator over the text chunks of a streamed answer.

    The HTTP request has already been made (so errors such as 404 or 503 raised at the call, not
    on first iteration). Use it as a context manager, or consume it fully, to release the connection.
    """

    def __iter__(self) -> Iterator[str]:
        if self._exhausted:
            return
        try:
            for line in self._response.iter_lines():
                event = _parse_line(line)
                if event is None:
                    continue
                text = self._state.feed(event)
                if text:
                    yield text
                if self._state.done:
                    break
        except httpx.HTTPError as exc:
            raise _wrap(exc) from exc
        finally:
            self._exhausted = True
            self.close()

    def get_final_response(self) -> dict[str, str]:
        """Drain the stream (if needed) and return ``{"content": <whole answer>}``."""
        if not self._state.done and not self._exhausted:
            for _ in self:
                pass
        return {"content": self.text}

    def close(self) -> None:
        self._response.close()

    def __enter__(self) -> DialecticStreamResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class AsyncDialecticStreamResponse(_StreamBase):
    """Async iterator over the text chunks of a streamed answer."""

    async def __aiter__(self) -> AsyncIterator[str]:
        if self._exhausted:
            return
        try:
            async for line in self._response.aiter_lines():
                event = _parse_line(line)
                if event is None:
                    continue
                text = self._state.feed(event)
                if text:
                    yield text
                if self._state.done:
                    break
        except httpx.HTTPError as exc:
            raise _wrap(exc) from exc
        finally:
            self._exhausted = True
            await self.aclose()

    async def get_final_response(self) -> dict[str, str]:
        if not self._state.done and not self._exhausted:
            async for _ in self:
                pass
        return {"content": self.text}

    async def aclose(self) -> None:
        await self._response.aclose()

    async def __aenter__(self) -> AsyncDialecticStreamResponse:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()
