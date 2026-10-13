"""``RecallChatMessageHistory``: a LangChain chat history kept in a Recall session."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    ToolMessage,
    message_to_dict,
    messages_from_dict,
)
from recall_memory import Message, Session, SessionAio, SessionPeerConfig

from . import _store
from ._memory import Client, async_client, default_client, sync_client

KEY = "langchain_message"


class RecallChatMessageHistory(BaseChatMessageHistory):
    """Chat history stored in a Recall session, so Recall also learns from the conversation.

    Human messages are stored as written by ``user_id`` and are what Recall learns about that
    person from. AI messages are written by ``assistant_id``, a member Recall does not learn
    about. Tool and system messages are kept for the history only: Recall does not learn from
    them. Every message comes back exactly as it was added, with its type, ids and tool calls.

    Args:
        session_id: The Recall session (letters, digits, ``_`` and ``-``), e.g. one per chat.
        user_id: The Recall peer of the person the conversation is with.
        assistant_id: The Recall peer that writes the AI messages.
        client: A ``Recall`` client (serves blocking and ``async`` calls) or an ``AsyncRecall``
            (``async`` only). Defaults to ``Recall()``, configured from ``RECALL_*`` variables.

    ``clear()`` hides the messages from this history; Recall keeps them and what it learned
    from them. To erase, delete the Recall session (``recall.session(id).delete()``).
    """

    def __init__(
        self,
        session_id: str,
        *,
        user_id: str,
        assistant_id: str = "assistant",
        client: Client | None = None,
    ) -> None:
        if not session_id or not user_id or not assistant_id:
            raise ValueError("session_id, user_id and assistant_id must be non-empty")
        self.session_id = session_id
        self.user_id = user_id
        self.assistant_id = assistant_id
        self.client = default_client(client)
        self._members_set = False

    # ---- mapping ----------------------------------------------------------------------------

    def _payload(self, messages: Sequence[BaseMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for message in messages:
            payload = json.dumps(message_to_dict(message), ensure_ascii=False, default=str)
            peer, content, learn = self._describe(message)
            out.extend(
                _store.to_messages(payload, key=KEY, peer_id=peer, content=content, learn=learn)
            )
        return out

    def _describe(self, message: BaseMessage) -> tuple[str, str, bool]:
        """(author, text Recall reads, whether Recall learns from it) for one message."""
        text = message.text
        if isinstance(message, HumanMessage) or message.type == "human":
            return self.user_id, text or "[non-text message]", True
        if isinstance(message, AIMessage):
            if text:
                return self.assistant_id, text, True
            names = ", ".join(c["name"] for c in message.tool_calls)
            return self.assistant_id, f"[tool call: {names}]" if names else "[empty reply]", False
        if isinstance(message, ToolMessage):
            label = f"[tool result: {message.name}]" if message.name else "[tool result]"
            return self.assistant_id, label, False
        return self.assistant_id, f"[{message.type} message]", False

    def _decode(self, entries: list[_store.Entry]) -> list[BaseMessage]:
        out: list[BaseMessage] = []
        for entry in entries:
            if entry.payload is not None:
                try:
                    out.extend(messages_from_dict([json.loads(entry.payload)]))
                    continue
                except (ValueError, KeyError, TypeError):
                    pass  # not ours after all: read it like any other message
            m = entry.messages[0]
            out.append(self._foreign(m))
        return out

    def _foreign(self, m: Message) -> BaseMessage:
        if m.peer_id == self.assistant_id:
            return AIMessage(content=m.content, id=m.id)
        if m.peer_id == self.user_id:
            return HumanMessage(content=m.content, id=m.id)
        return HumanMessage(content=m.content, id=m.id, name=m.peer_id)

    def _members(self) -> dict[str, Any]:
        return {self.user_id: {}, self.assistant_id: SessionPeerConfig(observe_me=False)}

    # ---- blocking ---------------------------------------------------------------------------

    def _session(self) -> Session:
        return sync_client(self.client).session(self.session_id)

    @property
    def messages(self) -> list[BaseMessage]:  # type: ignore[override]
        """The visible messages, oldest first."""
        return self._decode(_store.read(self._session(), KEY))

    def add_messages(self, messages: Sequence[BaseMessage]) -> None:
        if not messages:
            return
        client = sync_client(self.client)
        if self._members_set:
            session = client.session(self.session_id)
        else:  # first write: the assistant is a member Recall does not learn about
            session = client.session(self.session_id, peers=self._members())
            self._members_set = True
        session.add_messages(self._payload(messages))

    def clear(self) -> None:
        session = self._session()
        entries = _store.read(session, KEY)
        _store.hide(session, [m for e in entries for m in e.messages], KEY)

    # ---- async ------------------------------------------------------------------------------

    async def _asession(self) -> SessionAio:
        return await async_client(self.client).session(self.session_id)

    async def aget_messages(self) -> list[BaseMessage]:
        return self._decode(await _store.aread(await self._asession(), KEY))

    async def aadd_messages(self, messages: Sequence[BaseMessage]) -> None:
        if not messages:
            return
        client = async_client(self.client)
        if self._members_set:
            session = await client.session(self.session_id)
        else:
            session = await client.session(self.session_id, peers=self._members())
            self._members_set = True
        await session.add_messages(self._payload(messages))

    async def aclear(self) -> None:
        session = await self._asession()
        entries = await _store.aread(session, KEY)
        await _store.ahide(session, [m for e in entries for m in e.messages], KEY)
