"""``RecallSession``: an OpenAI Agents SDK session kept in a Recall session."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from recall_memory import Message, SessionAio, SessionPeerConfig

from . import _store
from ._memory import Client, async_client

if TYPE_CHECKING:
    from agents.items import TResponseInputItem

KEY = "openai_agents_item"
_PLACEHOLDERS = {"input_image": "[image]", "input_file": "[file]", "input_audio": "[audio]"}


def _text(content: Any) -> str:
    """The readable text of a message's content (a string or a list of content parts)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if not isinstance(part, Mapping):
            continue
        if isinstance(part.get("text"), str):
            parts.append(part["text"])
        elif isinstance(part.get("refusal"), str):
            parts.append(part["refusal"])
        elif part.get("type") in _PLACEHOLDERS:
            parts.append(_PLACEHOLDERS[str(part["type"])])
    return "\n".join(p for p in parts if p)


def _plain(item: Any) -> dict[str, Any]:
    if hasattr(item, "model_dump"):
        return dict(item.model_dump(exclude_unset=True, mode="json"))
    return dict(item)


class RecallSession:
    """Conversation history for the OpenAI Agents SDK, kept in a Recall session.

    Implements the SDK's ``Session`` protocol, so ``Runner.run(agent, input, session=...)``
    loads the history before a run and stores the new items after it. Recall also learns from
    the conversation: the user's messages are stored as written by ``user_id``, the agent's
    messages as written by ``assistant_id`` (a member Recall does not learn about). Tool calls,
    tool results and reasoning items are kept for the history only. Every item comes back
    exactly as it was added.

    Args:
        session_id: The Recall session (letters, digits, ``_`` and ``-``), e.g. one per chat.
        user_id: The Recall peer of the person the agent talks to.
        assistant_id: The Recall peer that writes the agent's messages.
        client: A ``Recall`` or ``AsyncRecall`` client. Defaults to ``Recall()``, configured
            from ``RECALL_*`` variables.
        session_settings: The SDK's ``SessionSettings`` (or a dict); ``limit`` caps how many of
            the newest items ``get_items()`` returns by default.

    ``pop_item()`` and ``clear_session()`` hide items from the history; Recall keeps the
    messages and what it learned from them. To erase, delete the Recall session.
    """

    def __init__(
        self,
        session_id: str,
        *,
        user_id: str,
        assistant_id: str = "assistant",
        client: Client | None = None,
        session_settings: Any = None,
    ) -> None:
        if not session_id or not user_id or not assistant_id:
            raise ValueError("session_id, user_id and assistant_id must be non-empty")
        self.session_id = session_id
        self.user_id = user_id
        self.assistant_id = assistant_id
        self.client = async_client(client)
        self.session_settings = session_settings
        self._members_set = False

    def __repr__(self) -> str:
        return f"RecallSession(session_id={self.session_id!r}, user_id={self.user_id!r})"

    # ---- mapping ----------------------------------------------------------------------------

    def _describe(self, item: Mapping[str, Any]) -> tuple[str, str, bool]:
        """(author, text Recall reads, whether Recall learns from it) for one item."""
        role = item.get("role")
        kind = item.get("type") or ("message" if role else "item")
        if kind == "message" and isinstance(role, str):
            text = _text(item.get("content"))
            if role == "user":
                return self.user_id, text or "[non-text message]", True
            if role == "assistant":
                return self.assistant_id, text or "[empty reply]", bool(text)
            return self.assistant_id, f"[{role} message]", False
        if kind == "function_call_output":
            return self.assistant_id, "[tool result]", False
        what = "tool call" if kind == "function_call" else str(kind)
        name = item.get("name")
        return self.assistant_id, f"[{what}: {name}]" if name else f"[{what}]", False

    def _encode(self, items: list[TResponseInputItem]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for raw in items:
            item = _plain(raw)
            payload = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
            peer, content, learn = self._describe(item)
            out.extend(
                _store.to_messages(payload, key=KEY, peer_id=peer, content=content, learn=learn)
            )
        return out

    def _decode(self, entry: _store.Entry) -> TResponseInputItem:
        if entry.payload is not None:
            try:
                item = json.loads(entry.payload)
                if isinstance(item, dict):
                    return item  # type: ignore[return-value]
            except ValueError:
                pass  # not ours after all: read it like any other message
        return self._foreign(entry.messages[0])

    def _foreign(self, m: Message) -> TResponseInputItem:
        if m.peer_id == self.assistant_id:
            return {"role": "assistant", "content": m.content}
        if m.peer_id == self.user_id:
            return {"role": "user", "content": m.content}
        return {"role": "user", "content": f"{m.peer_id}: {m.content}"}

    def _limit(self, limit: int | None) -> int | None:
        if limit is not None:
            return limit
        settings = self.session_settings
        value = (
            settings.get("limit")
            if isinstance(settings, Mapping)
            else getattr(settings, "limit", None)
        )
        return value if isinstance(value, int) else None

    async def _session(self) -> SessionAio:
        return await self.client.session(self.session_id)

    # ---- the Session protocol ---------------------------------------------------------------

    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        """The history, oldest first; with ``limit``, only the newest ``limit`` items."""
        entries = await _store.aread(await self._session(), KEY, self._limit(limit))
        return [self._decode(e) for e in entries]

    async def add_items(self, items: list[TResponseInputItem]) -> None:
        """Store new items; Recall learns from the user's messages among them."""
        if not items:
            return
        if self._members_set:
            session = await self._session()
        else:  # first write: the assistant is a member Recall does not learn about
            session = await self.client.session(
                self.session_id,
                peers={self.user_id: {}, self.assistant_id: SessionPeerConfig(observe_me=False)},
            )
            self._members_set = True
        await session.add_messages(self._encode(items))

    async def pop_item(self) -> TResponseInputItem | None:
        """Remove the newest item from the history and return it (``None`` when empty)."""
        session = await self._session()
        entries = await _store.aread(session, KEY, 1)
        if not entries:
            return None
        await _store.ahide(session, entries[-1].messages, KEY)
        return self._decode(entries[-1])

    async def clear_session(self) -> None:
        """Start the history over. Recall keeps the messages and what it learned from them."""
        session = await self._session()
        entries = await _store.aread(session, KEY)
        await _store.ahide(session, [m for e in entries for m in e.messages], KEY)
