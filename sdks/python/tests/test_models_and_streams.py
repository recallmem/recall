"""Pagination, streaming, prompt converters and sync/async parity."""

from __future__ import annotations

import inspect
import json

import httpx
import pytest

import recall_memory as pm
from conftest import (
    Router,
    make_async_client,
    make_client,
    message_json,
    page_json,
    peer_json,
    session_json,
)
from recall_memory import Recall, SessionContext
from recall_memory._core import dual_operation, operation

# ---- pagination ----------------------------------------------------------------------


def three_pages(request: httpx.Request) -> httpx.Response:
    n = int(request.url.params["page"])
    size = int(request.url.params["size"])
    ids = [f"s{i}" for i in range(5)]
    chunk = ids[(n - 1) * size : n * size]
    return httpx.Response(
        200, json=page_json([session_json(i) for i in chunk], page=n, size=size, total=5)
    )


def test_iterating_a_page_walks_all_pages(router: Router):
    client = make_client(router)
    router.on("POST", "/v3/workspaces/ws/sessions/list", handler=three_pages)
    page = client.sessions(size=2)
    assert (page.total, page.page, page.size, page.pages, len(page)) == (5, 1, 2, 3, 2)
    assert page.has_next_page()
    assert [s.id for s in page] == ["s0", "s1", "s2", "s3", "s4"]
    assert len(router.requests) == 3


def test_get_next_page_and_limits(router: Router):
    client = make_client(router)
    router.on("POST", "/v3/workspaces/ws/sessions/list", handler=three_pages)
    page = client.sessions(size=2)
    second = page.get_next_page()
    assert second.page == 2 and [s.id for s in second.items] == ["s2", "s3"]
    last = second.get_next_page()
    assert not last.has_next_page() and last.get_next_page() is None
    router.requests.clear()
    assert [s.id for s in client.sessions(size=2).iter_all(limit=3)] == ["s0", "s1", "s2"]
    assert len(router.requests) == 2  # did not fetch the third page
    assert len(client.sessions(size=2).to_list()) == 5
    assert client.sessions(size=2)[1].id == "s1"


def test_empty_page(router: Router):
    client = make_client(router)
    router.on("POST", "/v3/workspaces/ws/sessions/list", page_json([]))
    page = client.sessions()
    assert (len(page), page.total, page.pages, page.has_next_page(), list(page)) == (
        0,
        0,
        0,
        False,
        [],
    )


async def test_async_page_iteration(router: Router):
    client = make_async_client(router)
    router.on("POST", "/v3/workspaces/ws/sessions/list", handler=three_pages)
    page = await client.sessions(size=2)
    assert [s.id async for s in page] == ["s0", "s1", "s2", "s3", "s4"]
    page = await client.sessions(size=2)
    nxt = await page.get_next_page()
    assert nxt.page == 2
    assert [s.id for s in await (await client.sessions(size=2)).to_list(limit=4)] == [
        "s0",
        "s1",
        "s2",
        "s3",
    ]
    # handles produced by an async client are async handles
    assert type(page[0]).__name__ == "SessionAio"


# ---- streaming -----------------------------------------------------------------------

SSE = (
    'data: {"delta": {"content": "Hel"}, "done": false}\n\n'
    'data:{"delta":{"content":"lo"},"done":false}\n\n'
    ": comment line\n"
    "event: ping\n"
    "data: not json\n\n"
    'data: {"done": true, "evidence": {"conclusions": [], "messages": [], "tool_calls": [], '
    '"reasoning_trace_id": "t1"}, "citations": ["c1"], "confidence": 0.9, "abstained": false}\n\n'
)


def sse_response(request: httpx.Request) -> httpx.Response:
    assert json.loads(request.content)["stream"] is True
    return httpx.Response(200, content=SSE.encode(), headers={"content-type": "text/event-stream"})


def test_chat_stream_sync(router: Router):
    client = make_client(router)
    router.on("POST", "/v3/workspaces/ws/peers/alice/chat", handler=sse_response)
    stream = client.peer("alice").chat_stream("hi", include_evidence=True)
    assert not stream.is_complete
    assert list(stream) == ["Hel", "lo"]
    assert stream.is_complete
    assert stream.get_final_response() == {"content": "Hello"}
    assert stream.evidence.reasoning_trace_id == "t1"
    assert (stream.citations, stream.confidence, stream.abstained) == (["c1"], 0.9, False)
    assert router.last.headers["accept"] == "text/event-stream"


def test_chat_stream_final_response_drains(router: Router):
    client = make_client(router)
    router.on("POST", "/v3/workspaces/ws/chat", handler=sse_response)
    with client.chat_stream("hi") as stream:
        assert stream.get_final_response() == {"content": "Hello"}
    assert stream.is_complete


def test_stream_errors_surface_at_call_time(router: Router):
    client = make_client(router, max_retries=0)
    router.on(
        "POST", "/v3/workspaces/ws/peers/ghost/chat", {"detail": "Peer not found"}, status=404
    )
    with pytest.raises(pm.NotFoundError):
        client.peer("ghost").chat_stream("hi")


async def test_chat_stream_async(router: Router):
    client = make_async_client(router)
    router.on("POST", "/v3/workspaces/ws/chat", handler=sse_response)
    stream = await client.chat_stream("hi")
    chunks = [c async for c in stream]
    assert chunks == ["Hel", "lo"]
    assert await stream.get_final_response() == {"content": "Hello"}
    assert stream.is_complete and stream.citations == ["c1"]
    peer = await client.peer("alice")
    router.on("POST", "/v3/workspaces/ws/peers/alice/chat", handler=sse_response)
    async with await peer.chat_stream("x") as s2:
        assert await s2.get_final_response() == {"content": "Hello"}


# ---- SessionContext ------------------------------------------------------------------


def make_context(**kw) -> SessionContext:
    base = {
        "id": "s1",
        "messages": [
            message_json("m1", "alice", "I like tea"),
            message_json("m2", "bot", "Noted!"),
            message_json("m3", "alice", "Thanks"),
        ],
        "summary": None,
        "peer_representation": None,
        "peer_card": None,
    }
    return SessionContext.model_validate({**base, **kw})


SUMMARY = {
    "content": "They talked about tea.",
    "message_id": "m0",
    "summary_type": "chat_summary_short",
    "created_at": "2026-01-01T00:00:00Z",
    "token_count": 5,
}


def test_to_openai_full():
    ctx = make_context(peer_representation="## Facts\n- tea", peer_card=["a", "b"], summary=SUMMARY)
    assert ctx.to_openai(assistant="bot") == [
        {"role": "system", "content": "<peer_representation>## Facts\n- tea</peer_representation>"},
        {"role": "system", "content": "<peer_card>- a\n- b</peer_card>"},
        {"role": "system", "content": "<summary>They talked about tea.</summary>"},
        {"role": "user", "name": "alice", "content": "I like tea"},
        {"role": "assistant", "name": "bot", "content": "Noted!"},
        {"role": "user", "name": "alice", "content": "Thanks"},
    ]


def test_card_format_python_gives_the_reference_list_repr():
    ctx = make_context(peer_card=["a", "b"])
    assert ctx.to_openai(assistant="bot", card_format="python")[0] == {
        "role": "system",
        "content": "<peer_card>['a', 'b']</peer_card>",
    }
    assert (
        ctx.to_anthropic(assistant="bot", card_format="python")[0]["content"]
        == "<peer_card>['a', 'b']</peer_card>"
    )
    with pytest.raises(ValueError):
        ctx.to_openai(assistant="bot", card_format="yaml")  # type: ignore[arg-type]


def test_to_anthropic_params_puts_context_in_system_and_alternates():
    ctx = make_context(
        peer_representation="R",
        peer_card=["a"],
        summary=SUMMARY,
        messages=[
            message_json("m1", "alice", "one"),
            message_json("m2", "carol", "two"),
            message_json("m3", "bot", "three"),
            message_json("m4", "alice", "four"),
        ],
    )
    params = ctx.to_anthropic_params(assistant="bot")
    assert params["system"] == (
        "<peer_representation>R</peer_representation>\n"
        "<peer_card>- a</peer_card>\n"
        "<summary>They talked about tea.</summary>"
    )
    assert params["messages"] == [
        {"role": "user", "content": "alice: one\ncarol: two"},
        {"role": "assistant", "content": "three"},
        {"role": "user", "content": "alice: four"},
    ]
    assert "system" not in make_context().to_anthropic_params(assistant="bot")


def test_to_openai_omits_absent_blocks_and_accepts_peer(client: Recall):
    ctx = make_context(peer_representation="", peer_card=[])
    out = ctx.to_openai(assistant=client.peer("bot"))
    assert [m["role"] for m in out] == ["user", "assistant", "user"]


def test_to_anthropic():
    ctx = make_context(peer_representation="R", peer_card=["a"], summary=SUMMARY)
    assert ctx.to_anthropic(assistant="bot") == [
        {"role": "user", "content": "<peer_representation>R</peer_representation>"},
        {"role": "user", "content": "<peer_card>- a</peer_card>"},
        {"role": "user", "content": "<summary>They talked about tea.</summary>"},
        {"role": "user", "content": "alice: I like tea"},
        {"role": "assistant", "content": "Noted!"},
        {"role": "user", "content": "alice: Thanks"},
    ]


def test_context_len_and_truthiness():
    assert len(make_context()) == 3
    assert len(make_context(summary=SUMMARY)) == 4
    empty = make_context(messages=[])
    assert len(empty) == 0 and bool(empty) is True
    assert SessionContext.model_validate({"session_id": "x", "messages": []}).session_id == "x"


def test_converters_are_keyword_only():
    with pytest.raises(TypeError):
        make_context().to_openai("bot")  # type: ignore[misc]


# ---- sync/async parity ---------------------------------------------------------------


def instances():
    p = Recall(base_url="http://x.test")
    peer = p.peer("a")
    session = p.session("s")
    scope = pm.Scope._make(p._core, "t")
    view = peer.conclusions
    ws_view = p.conclusions
    return [
        (p, p.aio),
        (peer, peer.aio),
        (session, session.aio),
        (scope, scope.aio),
        (view, view.aio),
        (ws_view, ws_view.aio),
    ]


@pytest.mark.parametrize("pair", instances(), ids=lambda pair: type(pair[0]).__name__)
def test_aio_twin_has_every_method_as_a_coroutine(pair):
    sync_obj, aio_obj = pair
    names = {
        n
        for n in dir(type(sync_obj))
        if isinstance(inspect.getattr_static(type(sync_obj), n), (operation, dual_operation))
    }
    assert names, "no operations found"
    for name in names:
        sync_attr = getattr(sync_obj, name)
        aio_attr = getattr(aio_obj, name)
        assert not inspect.iscoroutinefunction(sync_attr), name
        assert inspect.iscoroutinefunction(aio_attr), name
        assert str(inspect.signature(sync_attr)) == str(inspect.signature(aio_attr)), name


async def test_every_aio_operation_returns_an_awaitable(router: Router):
    client = make_async_client(router)
    router.on("GET", "/v3/workspaces/ws/queue/status", {})
    result = client.queue_status()
    assert inspect.isawaitable(result)
    await result
    peer = await client.peer("alice")
    assert inspect.iscoroutinefunction(peer.chat)
    assert inspect.iscoroutinefunction(peer.get_card)


def test_sync_aio_twins_share_state(router: Router):
    client = make_client(router)
    router.on("POST", "/v3/workspaces/ws/peers", peer_json("alice", metadata={"a": 1}))
    peer = client.peer("alice", metadata={"a": 1})
    twin = peer.aio
    assert twin.metadata == {"a": 1} and twin == peer and type(twin).__name__ == "PeerAio"
    assert client.aio._core is client._core
    assert client.aio.peer is not None
    assert hash(twin) == hash(peer)


def test_signature_of_operations_is_introspectable(client: Recall):
    sig = inspect.signature(client.peer("alice").chat)
    assert "query" in sig.parameters and "self" not in sig.parameters
    assert sig.parameters["include_evidence"].default is False


def test_context_manager_closes_owned_client(router: Router):
    with Recall(base_url="http://x.test") as p:
        _ = p._core.sync_client
    assert p._core._sync_client is None
