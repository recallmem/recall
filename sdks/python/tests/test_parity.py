"""SDK additions from the parity audit (docs/PARITY.md)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from conftest import Router, make_client
from recall_memory import AsyncRecall, Recall


def test_create_key_mints_a_scoped_key(router: Router, client: Recall):
    router.on("POST", "/v3/keys", {"key": "jwt-or-pk"})
    key = client.create_key(
        workspace_id="ws",
        peer_id=client.peer("alice"),
        expires_at=datetime(2027, 1, 1, tzinfo=timezone.utc),
    )
    assert key == "jwt-or-pk"
    assert router.params() == {
        "workspace_id": ["ws"],
        "peer_id": ["alice"],
        "expires_at": ["2027-01-01T00:00:00+00:00"],
    }
    assert router.last.content == b""


def test_create_key_validates_the_scope_before_any_request(router: Router, client: Recall):
    with pytest.raises(ValueError, match="At least one of"):
        client.create_key()
    with pytest.raises(ValueError, match="workspace_id is required"):
        client.create_key(session_id="s1")
    assert router.requests == []


def test_create_key_never_auto_creates_the_workspace(router: Router):
    router.on("POST", "/v3/keys", {"key": "k"})
    client = make_client(router, auto_create=True)
    assert client.create_key(workspace_id="ws", session_id="s1") == "k"
    assert [r.url.path for r in router.requests] == ["/v3/keys"]


async def test_create_key_async(router: Router, aclient: AsyncRecall):
    router.on("POST", "/v3/keys", {"key": "k2"})
    assert await aclient.create_key(workspace_id="ws") == "k2"
    assert router.params() == {"workspace_id": ["ws"]}


def test_peer_delete_erases_the_peer(router: Router, client: Recall):
    router.on(
        "DELETE",
        "/v3/workspaces/ws/peers/alice",
        {
            "peer_id": "alice",
            "deleted": True,
            "messages_deleted": 3,
            "conclusions_deleted": 7,
            "sessions_affected": 1,
        },
    )
    out = client.peer("alice").delete()
    assert out["messages_deleted"] == 3 and out["conclusions_deleted"] == 7
    assert router.last.method == "DELETE"


async def test_peer_delete_async(router: Router, aclient: AsyncRecall):
    router.on("DELETE", "/v3/workspaces/ws/peers/bob", {"peer_id": "bob", "deleted": True})
    peer = await aclient.peer("bob")
    out = await peer.delete()
    assert out["deleted"] is True
