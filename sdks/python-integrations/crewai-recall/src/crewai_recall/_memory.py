"""What the tools ask of Recall, for one person (a Recall peer).

Every call exists in a blocking and an ``async`` form. The client is either a ``Recall`` (which
also serves the ``async`` calls through ``recall.aio``) or an ``AsyncRecall`` (``async`` only).
"""

from __future__ import annotations

from typing import Any

from recall_memory import (
    AsyncRecall,
    Conclusion,
    Message,
    NotFoundError,
    Recall,
    RecallAio,
)
from recall_memory.models import ReasoningLevel

NO_ANSWER = "Memory has no answer to that yet."
MAX_SNIPPET = 500

Client = Recall | AsyncRecall | RecallAio


def default_client(client: Client | None) -> Client:
    """The given client, or one configured from ``RECALL_*`` environment variables."""
    return client if client is not None else Recall()


def sync_client(client: Client) -> Recall:
    if isinstance(client, Recall):
        return client
    raise TypeError(
        "this call is blocking but the Recall client is async-only (AsyncRecall); "
        "pass a Recall client, which serves blocking and async calls, or use the async method"
    )


def async_client(client: Client) -> RecallAio:
    return client.aio if isinstance(client, Recall) else client


# ---- results as plain data -------------------------------------------------------------------


def fact_dict(c: Conclusion) -> dict[str, Any]:
    return {"id": c.id, "content": c.content}


def message_dict(m: Message) -> dict[str, Any]:
    return {
        "session": m.session_id,
        "date": m.created_at.date().isoformat() if m.created_at else None,
        "content": m.content[:MAX_SNIPPET],
    }


def clean_facts(facts: list[str]) -> list[str]:
    out = [f.strip() for f in facts if isinstance(f, str) and f.strip()]
    if not out:
        raise ValueError("facts must list at least one fact")
    return out


def memory_text(representation: str | None, card: list[str] | None) -> str:
    """What Recall knows about a person, as text for a prompt ('' when it knows nothing)."""
    parts: list[str] = []
    if card:
        parts.append("Key facts:\n" + "\n".join(f"- {line}" for line in card))
    if representation and representation.strip():
        parts.append(representation.strip())
    return "\n\n".join(parts)


# ---- blocking ---------------------------------------------------------------------------------


def search(client: Recall, peer_id: str, query: str, k: int) -> dict[str, Any]:
    """Facts about the person that match ``query``, and messages they wrote that match it."""
    peer = client.peer(peer_id)
    facts = peer.conclusions.query(query, top_k=k)
    messages = peer.search(query, limit=k)
    return {"facts": [fact_dict(c) for c in facts], "messages": [message_dict(m) for m in messages]}


def ask(client: Recall, peer_id: str, question: str, level: ReasoningLevel) -> str:
    try:
        answer = client.peer(peer_id).chat(question, reasoning_level=level)
    except NotFoundError:  # nobody by that id yet: nothing to answer from
        return NO_ANSWER
    return answer.strip() if isinstance(answer, str) and answer.strip() else NO_ANSWER


def remember(client: Recall, peer_id: str, facts: list[str]) -> list[Conclusion]:
    items = [{"content": f} for f in clean_facts(facts)]
    peer = client.peer(peer_id)
    try:
        return peer.conclusions.create(items)
    except NotFoundError:  # a new person: create them (and the workspace), then save
        client.peer(peer_id, metadata={})
        return peer.conclusions.create(items)


def context(client: Recall, peer_id: str, query: str | None, max_conclusions: int) -> str:
    try:
        ctx = client.peer(peer_id).context(
            search_query=query or None,
            max_conclusions=max_conclusions,
            include_most_frequent=True,
        )
    except NotFoundError:
        return ""
    return memory_text(ctx.representation, ctx.peer_card)


# ---- async ------------------------------------------------------------------------------------


async def asearch(client: RecallAio, peer_id: str, query: str, k: int) -> dict[str, Any]:
    peer = await client.peer(peer_id)
    facts = await peer.conclusions.query(query, top_k=k)
    messages = await peer.search(query, limit=k)
    return {"facts": [fact_dict(c) for c in facts], "messages": [message_dict(m) for m in messages]}


async def aask(client: RecallAio, peer_id: str, question: str, level: ReasoningLevel) -> str:
    peer = await client.peer(peer_id)
    try:
        answer = await peer.chat(question, reasoning_level=level)
    except NotFoundError:
        return NO_ANSWER
    return answer.strip() if isinstance(answer, str) and answer.strip() else NO_ANSWER


async def aremember(client: RecallAio, peer_id: str, facts: list[str]) -> list[Conclusion]:
    items = [{"content": f} for f in clean_facts(facts)]
    peer = await client.peer(peer_id)
    try:
        return await peer.conclusions.create(items)
    except NotFoundError:
        await client.peer(peer_id, metadata={})
        return await peer.conclusions.create(items)
