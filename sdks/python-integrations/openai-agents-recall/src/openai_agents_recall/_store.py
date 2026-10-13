"""A conversation history kept as messages in a Recall session.

Each entry (here a session item) is one Recall message: the text Recall learns from as its
content, and the exact entry as JSON in its metadata, so it comes back unchanged. An entry larger
than one message's metadata allows is continued in further messages with empty content.
Messages another client wrote to the session (they carry no JSON) are read back by their author.

Removing an entry hides its messages (a flag in their metadata) rather than deleting them: Recall
has no per-message delete, and what it learned from them stays. Delete the Recall session, or the
person, to erase.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from recall_memory import Message, Session, SessionAio

PART = "recall_part"
HIDDEN = "recall_hidden"
VISIBLE: dict[str, Any] = {"NOT": [{"metadata": {HIDDEN: True}}]}
#: Characters of JSON per message (the server allows 64 KB of metadata per message).
CHUNK = 60_000
#: The server's limit on a message's content.
MAX_CONTENT = 25_000
NO_LEARNING: dict[str, Any] = {"reasoning": {"enabled": False}}
PAGE = 100


@dataclass
class Entry:
    """One stored entry and the Recall messages that hold it (oldest first)."""

    messages: list[Message]
    payload: str | None  # the entry's JSON; None for a message another client wrote


def to_messages(
    payload: str, *, key: str, peer_id: str, content: str, learn: bool
) -> list[dict[str, Any]]:
    """The Recall messages that store one entry."""
    chunks = [payload[i : i + CHUNK] for i in range(0, len(payload), CHUNK)] or [""]
    out: list[dict[str, Any]] = []
    for i, chunk in enumerate(chunks):
        metadata: dict[str, Any] = {key: chunk}
        if len(chunks) > 1:
            metadata[PART] = [i, len(chunks)]
        message: dict[str, Any] = {
            "peer_id": peer_id,
            "content": content[:MAX_CONTENT] if i == 0 else "",
            "metadata": metadata,
        }
        if not learn or i > 0:
            message["configuration"] = NO_LEARNING
        out.append(message)
    return out


def _part(m: Message) -> tuple[int, int] | None:
    part = (m.metadata or {}).get(PART)
    if isinstance(part, list) and len(part) == 2 and all(isinstance(x, int) for x in part):
        return part[0], part[1]
    return None


def starts_entry(m: Message, key: str) -> bool:
    part = _part(m) if isinstance((m.metadata or {}).get(key), str) else None
    return part is None or part[0] == 0


def group(messages: Sequence[Message], key: str) -> list[Entry]:
    """Messages (oldest first) -> entries. Incomplete multi-part entries are skipped."""
    entries: list[Entry] = []
    parts: list[Message] = []
    for m in messages:
        chunk = (m.metadata or {}).get(key)
        if not isinstance(chunk, str):
            parts = []
            entries.append(Entry([m], None))
            continue
        part = _part(m)
        if part is None or part[1] <= 1:
            parts = []
            entries.append(Entry([m], chunk))
            continue
        index, count = part
        if index == 0:
            parts = [m]
        elif parts and len(parts) == index:
            parts.append(m)
        else:
            parts = []
            continue
        if len(parts) == count:
            entries.append(Entry(parts, "".join(str((p.metadata or {})[key]) for p in parts)))
            parts = []
    return entries


def hidden_metadata(m: Message, key: str) -> dict[str, Any]:
    """The metadata that hides ``m``: its own keys, without the stored JSON, plus the flag."""
    kept = {k: v for k, v in (m.metadata or {}).items() if k not in (key, PART)}
    return {**kept, HIDDEN: True}


# ---- reading and hiding -----------------------------------------------------------------------


def read(session: Session, key: str, limit: int | None = None) -> list[Entry]:
    """All visible entries, or the newest ``limit`` of them, oldest first."""
    if limit is None:
        return group(session.messages(filters=VISIBLE, size=PAGE).to_list(), key)
    if limit <= 0:
        return []
    newest: list[Message] = []
    starts = 0
    for m in session.messages(filters=VISIBLE, reverse=True, size=min(PAGE, limit)):
        newest.append(m)
        starts += starts_entry(m, key)
        if starts >= limit:
            break
    return group(newest[::-1], key)[-limit:]


async def aread(session: SessionAio, key: str, limit: int | None = None) -> list[Entry]:
    if limit is None:
        page = await session.messages(filters=VISIBLE, size=PAGE)
        return group(await page.to_list(), key)
    if limit <= 0:
        return []
    newest: list[Message] = []
    starts = 0
    page = await session.messages(filters=VISIBLE, reverse=True, size=min(PAGE, limit))
    async for m in page:
        newest.append(m)
        starts += starts_entry(m, key)
        if starts >= limit:
            break
    return group(newest[::-1], key)[-limit:]


def hide(session: Session, messages: Sequence[Message], key: str) -> None:
    for m in messages:
        session.update_message(m, hidden_metadata(m, key))


async def ahide(session: SessionAio, messages: Sequence[Message], key: str) -> None:
    for m in messages:
        await session.update_message(m, hidden_metadata(m, key))
