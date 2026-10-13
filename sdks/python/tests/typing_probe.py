"""Static-typing contract, checked by mypy (see test_typing.py); never imported at runtime."""

from __future__ import annotations

from pydantic import BaseModel
from typing_extensions import assert_type

from recall_memory import (
    AsyncPage,
    AsyncRecall,
    ChatResponse,
    DialecticStreamResponse,
    Message,
    Recall,
    Peer,
    PeerAio,
    Session,
    SessionAio,
    SessionContext,
    SessionResponse,
    SyncPage,
)


class Home(BaseModel):
    city: str


def sync(p: Recall) -> None:
    peer = p.peer("alice")
    assert_type(peer, Peer)
    assert_type(peer.chat("q"), str | None)
    assert_type(peer.chat("q", response_format={"type": "object"}), str | None)
    assert_type(peer.chat("q", response_format=Home), Home | None)
    assert_type(peer.chat("q", include_evidence=True), ChatResponse[str])
    assert_type(peer.chat("q", response_format=Home, include_evidence=True), ChatResponse[Home])
    assert_type(peer.chat_stream("q"), DialecticStreamResponse)
    assert_type(p.chat("q"), str | None)
    assert_type(p.chat("q", response_format=Home), Home | None)
    session = p.session("s")
    assert_type(session, Session)
    assert_type(session.context(), SessionContext)
    assert_type(session.add_messages([]), list[Message])
    assert_type(session.peers(), list[Peer])
    assert_type(p.sessions(), SyncPage[SessionResponse, Session])
    assert_type(peer.get_card(), list[str] | None)


async def asynchronous(p: AsyncRecall) -> None:
    peer = await p.peer("alice")
    assert_type(peer, PeerAio)
    assert_type(await peer.chat("q"), str | None)
    assert_type(await peer.chat("q", response_format=Home), Home | None)
    assert_type(await peer.chat("q", include_evidence=True), ChatResponse[str])
    session = await p.session("s")
    assert_type(session, SessionAio)
    assert_type(await session.peers(), list[PeerAio])
    assert_type(await p.sessions(), AsyncPage[SessionResponse, SessionAio])
    assert_type(await session.context(), SessionContext)
