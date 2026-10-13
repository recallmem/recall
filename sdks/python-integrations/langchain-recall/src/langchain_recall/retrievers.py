"""``RecallRetriever``: what Recall knows about a person, as LangChain documents."""

from __future__ import annotations

from typing import Any, Literal

from langchain_core.callbacks import (
    AsyncCallbackManagerForRetrieverRun,
    CallbackManagerForRetrieverRun,
)
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import Field
from recall_memory import Conclusion, Message

from ._memory import async_client, default_client, resolve_user, sync_client

Source = Literal["facts", "messages", "both"]


def _iso(m: Conclusion | Message) -> str | None:
    return m.created_at.isoformat() if m.created_at else None


def _fact(c: Conclusion) -> Document:
    return Document(
        id=c.id,
        page_content=c.content,
        metadata={
            "source": "recall",
            "type": "fact",
            "id": c.id,
            "session_id": c.session_id,
            "created_at": _iso(c),
        },
    )


def _message(m: Message) -> Document:
    return Document(
        id=m.id,
        page_content=m.content,
        metadata={
            "source": "recall",
            "type": "message",
            "id": m.id,
            "peer_id": m.peer_id,
            "session_id": m.session_id,
            "created_at": _iso(m),
        },
    )


class RecallRetriever(BaseRetriever):
    """Retrieves facts Recall learned about a person, and messages they wrote, for a query.

    Facts are found by meaning, messages by meaning and keywords. Neither calls a model, so a
    retrieval is fast and cheap. Documents carry ``metadata["type"]`` (``"fact"`` or
    ``"message"``) and the Recall ids.

    Example:
        .. code-block:: python

            from langchain_recall import RecallRetriever

            retriever = RecallRetriever(user_id="user-42", k=5)
            docs = retriever.invoke("travel plans")
    """

    user_id: str | None = None
    """The Recall peer whose memory to search. If unset, ``user_id_key`` of the LangGraph run's
    context (``context={"user_id": ...}``)."""
    user_id_key: str = "user_id"
    k: int = 8
    """How many facts and how many messages to return (each)."""
    source: Source = "both"
    """``"facts"``, ``"messages"`` or ``"both"`` (facts first)."""
    session_id: str | None = None
    """Search the messages of this Recall session (any author) instead of the person's own."""
    client: Any = Field(default=None, exclude=True)
    """A ``Recall`` or ``AsyncRecall`` client; ``Recall()`` from ``RECALL_*`` variables if unset."""

    def model_post_init(self, context: Any, /) -> None:
        self.client = default_client(self.client)

    def _get_relevant_documents(
        self, query: str, *, run_manager: CallbackManagerForRetrieverRun
    ) -> list[Document]:
        client = sync_client(self.client)
        user = resolve_user(self.user_id, self.user_id_key)
        docs: list[Document] = []
        if self.source in ("facts", "both"):
            docs += [_fact(c) for c in client.peer(user).conclusions.query(query, top_k=self.k)]
        if self.source in ("messages", "both"):
            if self.session_id is not None:
                found = client.session(self.session_id).search(query, limit=self.k)
            else:
                found = client.peer(user).search(query, limit=self.k)
            docs += [_message(m) for m in found]
        return docs

    async def _aget_relevant_documents(
        self, query: str, *, run_manager: AsyncCallbackManagerForRetrieverRun
    ) -> list[Document]:
        client = async_client(self.client)
        user = resolve_user(self.user_id, self.user_id_key)
        peer = await client.peer(user)
        docs: list[Document] = []
        if self.source in ("facts", "both"):
            docs += [_fact(c) for c in await peer.conclusions.query(query, top_k=self.k)]
        if self.source in ("messages", "both"):
            if self.session_id is not None:
                session = await client.session(self.session_id)
                found = await session.search(query, limit=self.k)
            else:
                found = await peer.search(query, limit=self.k)
            docs += [_message(m) for m in found]
        return docs
