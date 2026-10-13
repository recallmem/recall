"""What the tools and the instructions ask of Recall, for one person (a Recall peer)."""

from __future__ import annotations

from collections.abc import Mapping
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


def async_client(client: Client | None) -> RecallAio:
    """The client's ``async`` side; ``Recall()`` from ``RECALL_*`` variables when none is given."""
    if client is None:
        client = Recall()
    return client.aio if isinstance(client, Recall) else client


def context_value(context: Any, key: str) -> str | None:
    """``key`` of a run context (a mapping or an object), as a string."""
    value = context.get(key) if isinstance(context, Mapping) else getattr(context, key, None)
    return str(value) if value else None


def resolve_user(user_id: str | None, context: Any, key: str) -> str:
    if user_id:
        return user_id
    found = context_value(context, key)
    if found:
        return found
    raise ValueError(
        f"Recall does not know whose memory to use: pass user_id=..., or run the agent with a "
        f"context that has '{key}'"
    )


def fact_dict(c: Conclusion) -> dict[str, Any]:
    return {"id": c.id, "content": c.content}


def message_dict(m: Message) -> dict[str, Any]:
    return {
        "session": m.session_id,
        "date": m.created_at.date().isoformat() if m.created_at else None,
        "content": m.content[:MAX_SNIPPET],
    }


def memory_text(representation: str | None, card: list[str] | None) -> str:
    """What Recall knows about a person, as text for a prompt ('' when it knows nothing)."""
    parts: list[str] = []
    if card:
        parts.append("Key facts:\n" + "\n".join(f"- {line}" for line in card))
    if representation and representation.strip():
        parts.append(representation.strip())
    return "\n\n".join(parts)


async def search(client: RecallAio, peer_id: str, query: str, k: int) -> dict[str, Any]:
    """Facts about the person that match ``query``, and messages they wrote that match it."""
    peer = await client.peer(peer_id)
    facts = await peer.conclusions.query(query, top_k=k)
    messages = await peer.search(query, limit=k)
    return {"facts": [fact_dict(c) for c in facts], "messages": [message_dict(m) for m in messages]}


async def ask(client: RecallAio, peer_id: str, question: str, level: ReasoningLevel) -> str:
    peer = await client.peer(peer_id)
    try:
        answer = await peer.chat(question, reasoning_level=level)
    except NotFoundError:  # nobody by that id yet: nothing to answer from
        return NO_ANSWER
    return answer.strip() if isinstance(answer, str) and answer.strip() else NO_ANSWER


async def remember(client: RecallAio, peer_id: str, facts: list[str]) -> list[Conclusion]:
    items = [{"content": f.strip()} for f in facts if isinstance(f, str) and f.strip()]
    if not items:
        raise ValueError("facts must list at least one fact")
    peer = await client.peer(peer_id)
    try:
        return await peer.conclusions.create(items)
    except NotFoundError:  # a new person: create them (and the workspace), then save
        await client.peer(peer_id, metadata={})
        return await peer.conclusions.create(items)


async def context(client: RecallAio, peer_id: str, max_conclusions: int) -> str:
    peer = await client.peer(peer_id)
    try:
        ctx = await peer.context(max_conclusions=max_conclusions, include_most_frequent=True)
    except NotFoundError:
        return ""
    return memory_text(ctx.representation, ctx.peer_card)
