"""Request building: paths, methods, query strings and bodies, via ``httpx.MockTransport``."""

from __future__ import annotations

import io
import json

import pytest
from pydantic import BaseModel

from conftest import (
    NOW,
    Router,
    conclusion_json,
    make_client,
    message_json,
    page_json,
    peer_json,
    session_json,
)
from recall_memory import (
    MessageCreateParams,
    NotFoundError,
    Recall,
    PeerConfig,
    SessionConfiguration,
    SessionPeerConfig,
)

# ---- handles -------------------------------------------------------------------------


def test_peer_with_metadata_upserts(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers", peer_json("alice", metadata={"a": 1}))
    peer = client.peer("alice", metadata={"a": 1}, configuration=PeerConfig(observe_me=False))
    assert router.body() == {
        "id": "alice",
        "metadata": {"a": 1},
        "configuration": {"observe_me": False},
    }
    assert peer.metadata == {"a": 1}
    assert peer.created_at is not None


def test_session_with_options_is_one_upsert(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/sessions", session_json("s1"))
    alice = client.peer("alice")
    client.session(
        "s1",
        metadata={"k": "v"},
        configuration=SessionConfiguration(summary={"enabled": False}),
        peers=[alice, ("bot", SessionPeerConfig(observe_others=True)), "carol"],
        scopes=["team"],
    )
    assert len(router.requests) == 1
    assert router.body() == {
        "id": "s1",
        "metadata": {"k": "v"},
        "configuration": {"summary": {"enabled": False}},
        "peers": {"alice": {}, "bot": {"observe_others": True}, "carol": {}},
        "scopes": ["team"],
    }


def test_get_metadata_reads_without_creating(router: Router, client: Recall):
    router.on(
        "POST", "/v3/workspaces/ws/peers/list", page_json([peer_json("alice", metadata={"x": 1})])
    )
    peer = client.peer("alice")
    assert peer.get_metadata() == {"x": 1}
    assert router.last.url.path.endswith("/peers/list")
    assert router.body() == {"filters": {"id": "alice"}}
    assert peer.metadata == {"x": 1}


def test_get_metadata_missing_peer_is_404_not_create(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/list", page_json([]))
    with pytest.raises(NotFoundError):
        client.peer("ghost").get_metadata()
    assert all(r.url.path.endswith("/list") for r in router.requests)


def test_auto_create_restores_get_or_create(router: Router):
    router.on("POST", "/v3/workspaces", {"id": "ws", "metadata": {}, "configuration": {}})
    router.on("POST", "/v3/workspaces/ws/peers", peer_json("alice"))
    c = make_client(router, auto_create=True)
    c.peer("alice").get_metadata()
    c.peer("alice").refresh()
    paths = [(r.method, r.url.path) for r in router.requests]
    # the workspace is ensured exactly once, then reads are get-or-create POSTs
    assert paths == [
        ("POST", "/v3/workspaces"),
        ("POST", "/v3/workspaces/ws/peers"),
        ("POST", "/v3/workspaces/ws/peers"),
    ]


def test_lookup_falls_back_when_token_cannot_list(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/list", {"detail": "nope"}, status=401)
    router.on("POST", "/v3/workspaces/ws/peers", peer_json("alice", metadata={"m": 1}))
    assert client.peer("alice").get_metadata() == {"m": 1}


def test_workspace_metadata_checks_existence_first(router: Router, client: Recall):
    router.on("GET", "/v3/workspaces/ws/queue/status", {"total_work_units": 0})
    router.on("POST", "/v3/workspaces", {"id": "ws", "metadata": {"a": 1}, "configuration": {}})
    assert client.get_metadata() == {"a": 1}
    assert [r.method for r in router.requests] == ["GET", "POST"]
    assert client.metadata == {"a": 1}


def test_set_metadata_and_configuration(router: Router, client: Recall):
    router.on("PUT", "/v3/workspaces/ws/peers/alice", peer_json("alice", metadata={"z": 1}))
    peer = client.peer("alice")
    peer.set_metadata({"z": 1})
    assert router.body() == {"metadata": {"z": 1}}
    peer.set_configuration(PeerConfig(observe_me=False))
    assert router.body() == {"configuration": {"observe_me": False}}
    assert peer.metadata == {"z": 1}


def test_ids_are_url_encoded(router: Router, client: Recall):
    router.on("GET", "/v3/workspaces/ws/peers/a.b c/card", {"peer_card": ["x"]})
    assert client.peer("a.b c").get_card() == ["x"]
    assert router.last.url.raw_path.startswith(b"/v3/workspaces/ws/peers/a.b%20c/card")


# ---- peers ---------------------------------------------------------------------------


def test_peer_chat_body(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/alice/chat", {"content": "tea", "evidence": None})
    alice = client.peer("alice")
    assert alice.chat("what?") == "tea"
    assert router.body() == {"query": "what?", "stream": False}
    alice.chat(
        "q",
        target=client.peer("bob"),
        session="s1",
        reasoning_level="high",
        response_format={"type": "object"},
        include_evidence=True,
    )
    assert router.body() == {
        "query": "q",
        "stream": False,
        "target": "bob",
        "session_id": "s1",
        "reasoning_level": "high",
        "response_format": {"type": "object"},
        "include_evidence": True,
    }


def test_peer_chat_scope_and_sessions_forms(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/alice/chat", {"content": "x"})
    alice = client.peer("alice")
    alice.chat("q", scope="team")
    assert router.body()["scope"] == "team"
    alice.chat("q", scope=["a", "b"])
    assert router.body()["scope"] == ["a", "b"]
    alice.chat("q", sessions=["s1", client.session("s2")])
    assert router.body()["filters"] == {"session_id": ["s1", "s2"]}
    assert "scope" not in router.body()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"scope": "t", "sessions": ["s"]},
        {"scope": "t", "session": "s"},
        {"sessions": ["s"], "session": "s"},
    ],
)
def test_peer_chat_exclusivity_raises_before_any_request(router: Router, client: Recall, kwargs):
    with pytest.raises(ValueError):
        client.peer("alice").chat("q", **kwargs)
    assert router.requests == []


def test_chat_with_pydantic_response_format(router: Router, client: Recall):
    class City(BaseModel):
        name: str
        population: int

    router.on(
        "POST",
        "/v3/workspaces/ws/peers/alice/chat",
        {"content": json.dumps({"name": "Utrecht", "population": 360000}), "evidence": None},
    )
    result = client.peer("alice").chat("where?", response_format=City)
    assert result == City(name="Utrecht", population=360000)
    sent = router.body()["response_format"]
    assert sent["properties"]["name"]["type"] == "string"


def test_chat_with_evidence_returns_chat_response(router: Router, client: Recall):
    router.on(
        "POST",
        "/v3/workspaces/ws/peers/alice/chat",
        {
            "content": "tea",
            "evidence": {
                "conclusions": [
                    {
                        "id": "c1",
                        "level": "explicit",
                        "content": "likes tea",
                        "created_at": NOW,
                        "session_id": None,
                        "observer_id": "alice",
                        "observed_id": "alice",
                        "source_ids": [],
                    }
                ],
                "messages": [],
                "tool_calls": [{"tool_name": "search", "tool_input": {"q": "x"}}],
                "reasoning_trace_id": None,
            },
            "citations": ["c1"],
            "confidence": 0.8,
            "abstained": False,
        },
    )
    out = client.peer("alice").chat("q", include_evidence=True)
    assert out.content == "tea"
    assert out.evidence.conclusions[0].content == "likes tea"
    assert out.evidence.tool_calls[0].tool_name == "search"
    assert (out.citations, out.confidence, out.abstained) == (["c1"], 0.8, False)


def test_chat_none_when_server_has_no_answer(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/alice/chat", {"content": None, "evidence": None})
    assert client.peer("alice").chat("q") is None


def test_chat_per_call_timeout(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/alice/chat", {"content": "x"})
    client.peer("alice").chat("q", timeout=5)
    assert router.last.extensions["timeout"]["read"] == 5


def test_card(router: Router, client: Recall):
    router.on("GET", "/v3/workspaces/ws/peers/alice/card", {"peer_card": None})
    router.on("PUT", "/v3/workspaces/ws/peers/alice/card", {"peer_card": ["a", "b"]})
    alice = client.peer("alice")
    assert alice.get_card() is None
    assert alice.set_card(["a", "b"], target="bob") == ["a", "b"]
    assert router.params()["target"] == ["bob"]
    assert router.body() == {"peer_card": ["a", "b"]}
    with pytest.warns(DeprecationWarning):
        alice.card()


def test_representation_and_context(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/alice/representation", {"representation": "## R"})
    router.on(
        "GET",
        "/v3/workspaces/ws/peers/alice/context",
        {"peer_id": "alice", "target_id": "bob", "representation": "R", "peer_card": ["x"]},
    )
    alice = client.peer("alice")
    assert alice.representation("s1", "bob", "tea", 5, 0.5, True, 20, scope=None) == "## R"
    assert router.body() == {
        "session_id": "s1",
        "target": "bob",
        "search_query": "tea",
        "search_top_k": 5,
        "search_max_distance": 0.5,
        "include_most_frequent": True,
        "max_conclusions": 20,
    }
    alice.representation(sessions=["a", "b"])
    assert router.body() == {"filters": {"session_id": ["a", "b"]}}
    with pytest.raises(ValueError):
        alice.representation("s1", scope="t")
    ctx = alice.context(target="bob", search_query="tea", max_conclusions=10)
    assert (ctx.peer_id, ctx.target_id, ctx.peer_card) == ("alice", "bob", ["x"])
    assert router.params() == {
        "target": ["bob"],
        "search_query": ["tea"],
        "max_conclusions": ["10"],
    }


def test_peer_search_and_message_builder(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/peers/alice/search", [message_json()])
    alice = client.peer("alice")
    found = alice.search("tea", {"metadata": {"k": 1}}, limit=3)
    assert found[0].content == "hi"
    assert router.body() == {"query": "tea", "limit": 3, "filters": {"metadata": {"k": 1}}}
    before = len(router.requests)
    m = alice.message("hello", metadata={"a": 1})
    assert isinstance(m, MessageCreateParams)
    assert (m.peer_id, m["content"], m.get("metadata")) == ("alice", "hello", {"a": 1})
    assert len(router.requests) == before


# ---- sessions ------------------------------------------------------------------------


def test_membership(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/sessions/s1/peers", session_json("s1"))
    router.on("PUT", "/v3/workspaces/ws/sessions/s1/peers", session_json("s1"))
    router.on("DELETE", "/v3/workspaces/ws/sessions/s1/peers", session_json("s1"))
    s = client.session("s1")
    alice = client.peer("alice")
    s.add_peers(alice)
    assert router.body() == {"alice": {}}
    s.add_peers(
        [
            alice,
            (client.peer("bot"), SessionPeerConfig(observe_me=False)),
            ("c", {"observe_others": True}),
        ]
    )
    assert router.body() == {
        "alice": {},
        "bot": {"observe_me": False},
        "c": {"observe_others": True},
    }
    s.set_peers({"x": {"observe_me": True}})
    assert router.last.method == "PUT"
    assert router.body() == {"x": {"observe_me": True}}
    s.remove_peers(["alice", client.peer("bot")])
    assert router.body() == ["alice", "bot"]
    s.remove_peers("alice")
    assert router.body() == ["alice"]


def test_session_peers_walks_pages(router: Router, client: Recall):
    pages = {
        "1": page_json([peer_json("a"), peer_json("b")], page=1, size=2, total=3),
        "2": page_json([peer_json("c")], page=2, size=2, total=3),
    }
    router.on(
        "GET",
        "/v3/workspaces/ws/sessions/s1/peers",
        handler=lambda r: __import__("httpx").Response(200, json=pages[r.url.params["page"]]),
    )
    assert [p.id for p in client.session("s1").peers()] == ["a", "b", "c"]


def test_peer_session_config(router: Router, client: Recall):
    router.on(
        "GET",
        "/v3/workspaces/ws/sessions/s1/peers/alice/config",
        {"observe_me": True, "observe_others": None},
    )
    router.on("PUT", "/v3/workspaces/ws/sessions/s1/peers/alice/config", status=204)
    s = client.session("s1")
    assert s.get_peer_configuration("alice").observe_me is True
    s.set_peer_configuration("alice", SessionPeerConfig(observe_others=True))
    assert router.body() == {"observe_others": True}


def test_add_messages_shapes_and_idempotency_key(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/sessions/s1/messages", [message_json()], status=201)
    s = client.session("s1")
    alice = client.peer("alice")
    out = s.add_messages(alice.message("hi", metadata={"a": 1}))
    assert out[0].id == "m1"
    assert router.body() == {
        "messages": [{"content": "hi", "peer_id": "alice", "metadata": {"a": 1}}]
    }
    key1 = router.last.headers["idempotency-key"]
    s.add_messages([{"content": "yo", "peer_id": "bob", "created_at": "2026-01-01T00:00:00Z"}])
    key2 = router.last.headers["idempotency-key"]
    assert key1 and key2 and key1 != key2
    s.add_messages([alice.message("again")], idempotency_key="mine")
    assert router.last.headers["idempotency-key"] == "mine"


def test_add_messages_chunks_over_100(router: Router, client: Recall):
    def respond(request):
        import httpx

        n = len(json.loads(request.content)["messages"])
        return httpx.Response(201, json=[message_json(f"m{i}") for i in range(n)])

    router.on("POST", "/v3/workspaces/ws/sessions/s1/messages", handler=respond)
    alice = client.peer("alice")
    out = client.session("s1").add_messages(
        [alice.message(str(i)) for i in range(250)], idempotency_key="k"
    )
    assert len(out) == 250
    sizes = [len(router.body(i)["messages"]) for i in range(3)]
    assert sizes == [100, 100, 50]
    keys = [r.headers["idempotency-key"] for r in router.requests]
    assert keys == ["k", "k.1", "k.2"]
    assert client.session("s1").add_messages([]) == []
    assert len(router.requests) == 3


def test_message_listing_update_get(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/sessions/s1/messages/list", page_json([message_json()]))
    router.on("GET", "/v3/workspaces/ws/sessions/s1/messages/m1", message_json())
    router.on("PUT", "/v3/workspaces/ws/sessions/s1/messages/m1", message_json(metadata={"k": 1}))
    s = client.session("s1")
    page = s.messages(filters={"peer_id": "alice"}, size=10, reverse=True)
    assert router.params() == {"page": ["1"], "size": ["10"], "reverse": ["true"]}
    assert router.body() == {"filters": {"peer_id": "alice"}}
    assert page[0].content == "hi"
    msg = s.get_message("m1")
    assert s.update_message(msg, {"k": 1}).metadata == {"k": 1}
    assert router.body() == {"metadata": {"k": 1}}


def test_context_query(router: Router, client: Recall):
    router.on(
        "GET",
        "/v3/workspaces/ws/sessions/s1/context",
        {
            "id": "s1",
            "messages": [message_json()],
            "summary": None,
            "peer_representation": None,
            "peer_card": None,
        },
    )
    s = client.session("s1")
    ctx = s.context()
    assert router.params() == {"summary": ["true"]}
    assert ctx.session_id == "s1" and len(ctx) == 1
    s.context(
        summary=False,
        tokens=500,
        peer_target="alice",
        search_query="tea",
        sessions=["s1", "s2"],
        include_most_frequent=True,
        max_conclusions=5,
    )
    assert router.params() == {
        "summary": ["false"],
        "tokens": ["500"],
        "peer_target": ["alice"],
        "search_query": ["tea"],
        "sessions": ["s1", "s2"],
        "include_most_frequent": ["true"],
        "max_conclusions": ["5"],
    }
    s.context(peer_target="alice", peer_perspective="bob", limit_to_session=True)
    assert router.params()["peer_perspective"] == ["bob"]
    assert router.params()["limit_to_session"] == ["true"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"peer_perspective": "bob"},
        {"search_query": "q"},
        {"scope": "t"},
        {"sessions": ["s1"]},
        {"peer_target": "a", "sessions": ["s1"], "scope": "t"},
        {"peer_target": "a", "sessions": ["s1"], "limit_to_session": True},
        {"peer_target": "a", "scope": "t", "peer_perspective": "b"},
        {"peer_target": "a", "sessions": ["other"]},
    ],
)
def test_context_validation_is_client_side(router: Router, client: Recall, kwargs):
    with pytest.raises(ValueError):
        client.session("s1").context(**kwargs)
    assert router.requests == []


def test_search_summaries_clone_delete(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/sessions/s1/search", [message_json()])
    router.on(
        "GET",
        "/v3/workspaces/ws/sessions/s1/summaries",
        {"id": "s1", "short_summary": None, "long_summary": None},
    )
    router.on("POST", "/v3/workspaces/ws/sessions/s1/clone", session_json("NEW"), status=201)
    router.on("DELETE", "/v3/workspaces/ws/sessions/s1", {"message": "ok"}, status=202)
    s = client.session("s1")
    assert s.search("q", limit=5)[0].id == "m1"
    assert s.summaries().short_summary is None
    clone = s.clone(message_id="m1")
    assert clone.id == "NEW" and router.params() == {"message_id": ["m1"]}
    assert s.delete() is None


def test_upload_file_multipart(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/sessions/s1/messages/upload", [message_json()], status=201)
    s = client.session("s1")
    s.upload_file(
        ("notes.txt", b"hello", "text/plain"),
        "alice",
        metadata={"a": 1},
        created_at="2026-01-01T00:00:00Z",
    )
    body = router.last.content
    assert b'name="peer_id"' in body and b"alice" in body
    assert b'filename="notes.txt"' in body and b"hello" in body
    assert b'name="metadata"' in body
    assert router.last.headers["content-type"].startswith("multipart/form-data")
    assert router.last.headers["idempotency-key"]
    fh = io.BytesIO(b"%PDF")
    fh.name = "/tmp/x/doc.pdf"
    s.upload_file(fh, client.peer("alice"))
    assert b'filename="doc.pdf"' in router.last.content
    assert b"application/pdf" in router.last.content


def test_queue_status_and_dream(router: Router, client: Recall):
    router.on(
        "GET", "/v3/workspaces/ws/queue/status", {"total_work_units": 2, "pending_work_units": 1}
    )
    router.on("POST", "/v3/workspaces/ws/schedule_dream", status=204)
    st = client.queue_status(observer="alice", sender=client.peer("bob"), session="s1")
    assert router.params() == {"observer_id": ["alice"], "sender_id": ["bob"], "session_id": ["s1"]}
    assert st.total_work_units == 2 and not st.is_idle
    assert client.session("s1").queue_status(observer="a").total_work_units == 2
    assert router.params() == {"observer_id": ["a"], "session_id": ["s1"]}
    client.schedule_dream("alice")
    assert router.body() == {"observer": "alice", "observed": "alice", "dream_type": "omni"}
    client.schedule_dream(
        "alice", session="s1", observed="bob", dream_type="card_refresh", rebuild=True
    )
    assert router.body() == {
        "observer": "alice",
        "observed": "bob",
        "dream_type": "card_refresh",
        "session_id": "s1",
        "rebuild": True,
    }


def test_usage(router: Router, client: Recall):
    router.on(
        "GET",
        "/v3/workspaces/ws/usage",
        {
            "workspace_id": "ws",
            "since": None,
            "until": None,
            "total": {"calls": 2, "input_tokens": 10, "output_tokens": 4, "cost_usd": 0.5},
            "by_task": {"chat_low": {"calls": 2, "input_tokens": 10}},
            "items": [{"task": "chat_low", "provider": "p", "model": "m", "calls": 2}],
        },
    )
    u = client.usage(since="2026-01-01T00:00:00Z")
    assert router.params() == {"since": ["2026-01-01T00:00:00Z"]}
    assert u.total.cost_usd == 0.5 and u.by_task["chat_low"].calls == 2 and u.items[0].model == "m"
    assert u.billed is None


def test_usage_on_the_hosted_service_has_charges_and_no_provider_cost(
    router: Router, client: Recall
):
    router.on(
        "GET",
        "/v3/workspaces/ws/usage",
        {
            "workspace_id": "ws",
            "since": None,
            "until": None,
            "total": {"calls": 2, "input_tokens": 480, "output_tokens": 24},
            "by_task": {"chat_low": {"calls": 1}},
            "items": [{"task": "chat_low", "model": "recall-lumen", "calls": 1}],
            "billed": {
                "billed_usd": 0.205,
                "learning": {"message_tokens": 200000, "billed_usd": 0.2},
                "chat": {
                    "questions": 1,
                    "billed_usd": 0.005,
                    "by_level": {
                        "minimal": {"questions": 0, "billed_usd": 0},
                        "low": {"questions": 1, "billed_usd": 0.005},
                    },
                },
            },
        },
    )
    u = client.usage()
    assert u.total.cost_usd is None and u.total.unpriced_calls is None
    assert u.items[0].provider is None and u.items[0].cost_usd is None
    assert u.billed is not None
    assert u.billed.billed_usd == 0.205
    assert u.billed.learning.message_tokens == 200000
    assert u.billed.chat.questions == 1
    assert u.billed.chat.by_level["low"].billed_usd == 0.005


def test_turn(router: Router, client: Recall):
    router.on(
        "POST",
        "/v3/workspaces/ws/sessions/s1/turn",
        {
            "messages": [message_json()],
            "context": {
                "id": "s1",
                "messages": [message_json()],
                "summary": None,
                "peer_representation": "R",
                "peer_card": None,
            },
        },
        status=201,
    )
    alice = client.peer("alice")
    result = client.session("s1").turn([alice.message("hi")], tokens=800, peer_target="alice")
    assert router.body() == {
        "messages": [{"content": "hi", "peer_id": "alice"}],
        "context": {"summary": True, "tokens": 800, "peer_target": "alice"},
    }
    assert router.last.headers["idempotency-key"]
    assert result.messages[0].id == "m1"
    assert result.context.peer_representation == "R" and result.context.session_id == "s1"
    with pytest.raises(ValueError):
        client.session("s1").turn([alice.message("x")], peer_perspective="bob")


# ---- workspace-level -----------------------------------------------------------------


def test_workspace_chat_and_search(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/chat", {"content": "ans"})
    router.on("POST", "/v3/workspaces/ws/search", [message_json()])
    assert client.chat("q", session="s1", reasoning_level="max") == "ans"
    assert router.body() == {
        "query": "q",
        "stream": False,
        "session_id": "s1",
        "reasoning_level": "max",
    }
    with pytest.raises(ValueError):
        client.chat("q", session="s1", scope="t")
    client.search("tea", {"peer_id": "alice"}, 5, scope="t")
    assert router.body() == {
        "query": "tea",
        "limit": 5,
        "filters": {"peer_id": "alice"},
        "scope": "t",
    }


def test_listing_requests(router: Router, client: Recall):
    router.on(
        "POST",
        "/v3/workspaces/list",
        page_json([{"id": "w1", "metadata": {}, "configuration": {}}, {"id": "w2"}]),
    )
    router.on("POST", "/v3/workspaces/ws/peers/list", page_json([peer_json("a")]))
    router.on("POST", "/v3/workspaces/ws/sessions/list", page_json([session_json("s1")]))
    router.on("POST", "/v3/workspaces/ws/peers/alice/sessions", page_json([session_json("s1")]))
    router.on(
        "POST",
        "/v3/workspaces/ws/scopes/list",
        page_json([{"id": "t", "metadata": {}, "created_at": NOW}]),
    )
    assert list(client.workspaces()) == ["w1", "w2"]
    assert router.body() == {}
    list(client.peers({"metadata": {"k": 1}}, size=5))
    assert router.params() == {"page": ["1"], "size": ["5"]}
    assert router.body() == {"filters": {"metadata": {"k": 1}}}
    sessions = client.sessions(reverse=True)
    assert router.params()["reverse"] == ["true"] and sessions[0].id == "s1"
    assert client.peer("alice").sessions()[0].id == "s1"
    assert client.scopes()[0].id == "t"


def test_scopes(router: Router, client: Recall):
    t = {"id": "team", "metadata": {"a": 1}, "created_at": NOW}
    router.on("POST", "/v3/workspaces/ws/scopes", t, status=201)
    router.on("GET", "/v3/workspaces/ws/scopes/team", t)
    router.on("POST", "/v3/workspaces/ws/scopes/team/sessions", status=204)
    router.on("DELETE", "/v3/workspaces/ws/scopes/team/sessions/s1", status=204)
    router.on(
        "POST", "/v3/workspaces/ws/scopes/team/sessions/list", page_json([session_json("s1")])
    )
    router.on(
        "GET",
        "/v3/workspaces/ws/scopes/team/status",
        {"backfill_status": {"s1": {"state": "completed", "updated_at": NOW, "docs_copied": 3}}},
    )
    scope = client.scope("team", metadata={"a": 1})
    assert router.body() == {"id": "team", "metadata": {"a": 1}} and scope.metadata == {"a": 1}
    assert client.get_scope("team").id == "team"
    scope.add_sessions(["s1", client.session("s2")])
    assert router.last.method == "POST" and router.body() == {"session_ids": ["s1", "s2"]}
    scope.add_sessions([f"s{i}" for i in range(230)])
    assert [len(router.body(i)["session_ids"]) for i in (-3, -2, -1)] == [100, 100, 30]
    scope.remove_session("s1")
    assert router.last.method == "DELETE"
    assert scope.sessions()[0].id == "s1"
    assert scope.status()["s1"].docs_copied == 3


def test_conclusions_view(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/conclusions/list", page_json([conclusion_json()]))
    router.on("POST", "/v3/workspaces/ws/conclusions/query", [conclusion_json()])
    router.on("GET", "/v3/workspaces/ws/conclusions/c1", conclusion_json())
    router.on("DELETE", "/v3/workspaces/ws/conclusions/c1", status=204)
    router.on("POST", "/v3/workspaces/ws/conclusions", [conclusion_json()], status=201)
    router.on("POST", "/v3/workspaces/ws/peers/alice/representation", {"representation": "R"})
    view = client.peer("alice").conclusions_of("bob")
    view.list(session="s1", filters={"level": "explicit"}, reverse=True)
    assert router.body() == {
        "filters": {
            "level": "explicit",
            "observer_id": "alice",
            "observed_id": "bob",
            "session_id": "s1",
        }
    }
    assert router.params()["reverse"] == ["true"]
    with pytest.raises(ValueError):
        view.list(filters={"observer_id": "x"})
    view.query("tea", top_k=3, distance=0.4, filters={"level": "explicit"})
    assert router.body() == {
        "query": "tea",
        "top_k": 3,
        "distance": 0.4,
        "filters": {"level": "explicit", "observer_id": "alice", "observed_id": "bob"},
    }
    assert view.get("c1").content == "likes tea"
    view.derived("c1")
    assert router.body()["filters"]["source_ids"] == {"contains": "c1"}
    view.delete("c1")
    created = view.create([{"content": "a"}, {"content": "b", "session_id": "s1"}])
    assert created[0].id == "c1"
    assert router.body() == {
        "conclusions": [
            {"content": "a", "observer_id": "alice", "observed_id": "bob"},
            {"content": "b", "session_id": "s1", "observer_id": "alice", "observed_id": "bob"},
        ]
    }
    assert view.representation("tea", max_conclusions=5) == "R"
    assert router.body() == {"target": "bob", "search_query": "tea", "max_conclusions": 5}


def test_conclusion_validity_and_sources(router: Router, client: Recall):
    old = conclusion_json(
        "c1",
        valid_from="2026-09-01T09:00:00Z",
        valid_to="2026-09-20T09:00:00Z",
        superseded_by="c2",
        message_ids=["m1", "m2"],
    )
    router.on("POST", "/v3/workspaces/ws/conclusions/list", page_json([old, conclusion_json("c3")]))
    view = client.peer("alice").conclusions
    got, plain = view.list(filters={"current": False}).items
    assert router.body()["filters"]["current"] is False
    assert got.valid_from is not None and got.valid_from.day == 1
    assert got.valid_to is not None and got.valid_to.day == 20
    assert got.superseded_by == "c2"
    assert got.message_ids == ["m1", "m2"]
    # a server that does not send them (a Honcho server)
    assert plain.valid_from is None and plain.valid_to is None
    assert plain.superseded_by is None and plain.message_ids == []


def test_get_many_chunks_and_orders(router: Router, client: Recall):
    def respond(request):
        import httpx

        ids = json.loads(request.content)["filters"]["id"]["in"]
        return httpx.Response(
            200, json=page_json([conclusion_json(i) for i in reversed(ids) if i != "gone"])
        )

    router.on("POST", "/v3/workspaces/ws/conclusions/list", handler=respond)
    wanted = [f"c{i}" for i in range(150)] + ["gone"]
    got = client.conclusions.get_many(wanted)
    assert [c.id for c in got] == wanted[:150]
    assert len(router.requests) == 2
    assert len(router.body(0)["filters"]["id"]["in"]) == 100


def test_conclusions_property_forms(client: Recall):
    assert client.peer("alice").conclusions.observer_id == "alice"
    assert client.peer("alice").conclusions.observed_id == "alice"
    assert client.peer("alice").conclusions_of("bob").observed_id == "bob"


def test_delete_workspace(router: Router, client: Recall):
    router.on("DELETE", "/v3/workspaces/other", {"message": "ok"}, status=202)
    client.delete_workspace("other")
    assert router.last.url.path == "/v3/workspaces/other"


def test_add_messages_wait_polls_the_session_queue(router: Router, client: Recall):
    router.on("POST", "/v3/workspaces/ws/sessions/s1/messages", [message_json()], status=201)
    router.on("GET", "/v3/workspaces/ws/queue/status", {"idle": True})
    alice = client.peer("alice")
    client.session("s1").add_messages([alice.message("hi")], wait=True)
    assert router.last.url.path.endswith("/queue/status")
    assert router.params()["session_id"] == ["s1"]
    assert int(router.params()["wait_ms"][0]) == 25000  # one long-poll is capped at 25 s
    client.session("s1").add_messages([alice.message("hi")], wait=5)
    assert 4000 <= int(router.params()["wait_ms"][0]) <= 5000
    router.requests.clear()
    client.session("s1").add_messages([alice.message("hi")])
    assert len(router.requests) == 1  # no waiting unless asked


def test_webhook_endpoints(router: Router, client: Recall):
    endpoint = {
        "id": "wh1",
        "workspace_id": "ws",
        "url": "https://example.com/hook",
        "created_at": NOW,
    }
    router.on("POST", "/v3/workspaces/ws/webhooks", endpoint, status=201)
    router.on("GET", "/v3/workspaces/ws/webhooks", page_json([endpoint]))
    router.on("DELETE", "/v3/workspaces/ws/webhooks/wh1", status=204)
    router.on("GET", "/v3/workspaces/ws/webhooks/test", None)
    created = client.webhooks.create("https://example.com/hook")
    assert router.body() == {"url": "https://example.com/hook"} and created.id == "wh1"
    assert [e.url for e in client.webhooks.list()] == ["https://example.com/hook"]
    client.webhooks.delete(created)
    assert router.last.method == "DELETE"
    client.webhooks.test()
    assert router.last.url.path.endswith("/webhooks/test")
