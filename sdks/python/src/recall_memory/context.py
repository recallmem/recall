"""``SessionContext`` and its prompt converters, plus the ``Session.turn`` result."""

from __future__ import annotations

from typing import Any, Literal, Protocol

from pydantic import AliasChoices, Field

from .models import Message, Summary, _Base

__all__ = ["CardFormat", "SessionContext", "TurnResult"]

CardFormat = Literal["bullets", "python"]


class _HasId(Protocol):
    @property
    def id(self) -> str: ...


def _assistant_id(assistant: str | _HasId) -> str:
    return assistant if isinstance(assistant, str) else assistant.id


class SessionContext(_Base):
    """What to put in the next prompt: recent messages, a summary and what is known about a peer."""

    session_id: str = Field(validation_alias=AliasChoices("session_id", "id"))
    messages: list[Message] = Field(default_factory=list)
    summary: Summary | None = None
    peer_representation: str | None = None
    peer_card: list[str] | None = None

    def __len__(self) -> int:
        return len(self.messages) + (1 if self.summary is not None else 0)

    def __bool__(self) -> bool:
        # A context is a value, not a container: an empty one is still "a context".
        return True

    def _blocks(self, card_format: CardFormat) -> list[tuple[str, str]]:
        """(tag, text) for each context block present, in prompt order."""
        blocks: list[tuple[str, str]] = []
        if self.peer_representation:
            blocks.append(("peer_representation", self.peer_representation))
        if self.peer_card:
            if card_format == "python":
                card = str(self.peer_card)
            elif card_format == "bullets":
                card = "\n".join(f"- {fact}" for fact in self.peer_card)
            else:
                raise ValueError("card_format must be 'bullets' or 'python'")
            blocks.append(("peer_card", card))
        if self.summary is not None and self.summary.content:
            blocks.append(("summary", self.summary.content))
        return blocks

    def to_openai(
        self, *, assistant: str | _HasId, card_format: CardFormat = "bullets"
    ) -> list[dict[str, Any]]:
        """Chat-completions messages: context as leading ``system`` messages, then the history.

        Messages written by ``assistant`` get role ``assistant``; everyone else is ``user`` and
        carries their peer id in ``name``. The peer card is rendered as ``- fact`` lines (the same
        text the TypeScript SDK produces); ``card_format="python"`` gives the reference Python
        SDK's list repr (``['a', 'b']``) instead.
        """
        me = _assistant_id(assistant)
        out: list[dict[str, Any]] = [
            {"role": "system", "content": f"<{tag}>{text}</{tag}>"}
            for tag, text in self._blocks(card_format)
        ]
        for m in self.messages:
            out.append(
                {
                    "role": "assistant" if m.peer_id == me else "user",
                    "name": m.peer_id,
                    "content": m.content,
                }
            )
        return out

    def to_anthropic(
        self, *, assistant: str | _HasId, card_format: CardFormat = "bullets"
    ) -> list[dict[str, Any]]:
        """Messages API ``messages``: context blocks as ``user`` turns, then the history.

        Anthropic has no system role inside ``messages``. Messages from ``assistant`` become
        ``assistant`` turns; every other peer's message is a ``user`` turn prefixed ``"<peer>: "``.
        Consecutive same-role turns are left as they are; see ``to_anthropic_params``.
        """
        me = _assistant_id(assistant)
        out: list[dict[str, Any]] = [
            {"role": "user", "content": f"<{tag}>{text}</{tag}>"}
            for tag, text in self._blocks(card_format)
        ]
        for m in self.messages:
            if m.peer_id == me:
                out.append({"role": "assistant", "content": m.content})
            else:
                out.append({"role": "user", "content": f"{m.peer_id}: {m.content}"})
        return out

    def to_anthropic_params(
        self, *, assistant: str | _HasId, card_format: CardFormat = "bullets"
    ) -> dict[str, Any]:
        """``{"system": ..., "messages": [...]}`` ready for ``client.messages.create(**params)``.

        The context blocks go in ``system`` (omitted when there are none) and consecutive turns of
        the same role are merged so the history alternates, as the API expects.
        """
        me = _assistant_id(assistant)
        merged: list[dict[str, Any]] = []
        for m in self.messages:
            role = "assistant" if m.peer_id == me else "user"
            content = m.content if role == "assistant" else f"{m.peer_id}: {m.content}"
            if merged and merged[-1]["role"] == role:
                merged[-1]["content"] += f"\n{content}"
            else:
                merged.append({"role": role, "content": content})
        system = "\n".join(f"<{tag}>{text}</{tag}>" for tag, text in self._blocks(card_format))
        params: dict[str, Any] = {"messages": merged}
        if system:
            params = {"system": system, **params}
        return params


class TurnResult(_Base):
    """Result of ``Session.turn``: the stored messages and the context for the next prompt."""

    messages: list[Message] = Field(default_factory=list)
    context: SessionContext
