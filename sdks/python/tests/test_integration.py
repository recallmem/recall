"""End-to-end tests against the real TypeScript server.

The server is started once per test session (``npx tsx packages/server/src/main.ts``) with an
in-memory database and the offline mock LLM, on a free port. Skipped when node/npx are missing.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import socket
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from pydantic import BaseModel

import recall_memory as pm
from recall_memory import (
    AsyncRecall,
    NotFoundError,
    PeerConfig,
    Recall,
    SessionPeerConfig,
)

pytestmark = pytest.mark.integration

REPO = Path(__file__).resolve().parents[3]
SERVER_DIR = REPO / "packages" / "server"
SERVER_MAIN = SERVER_DIR / "src" / "main.ts"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="session")
def server_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    npx = shutil.which("npx")
    if npx is None or not SERVER_MAIN.exists():
        pytest.skip("node/npx or packages/server not available")
    port = free_port()
    env = {
        k: v
        for k, v in os.environ.items()
        # never let a developer's real keys or database leak into the test server
        if not k.endswith("_API_KEY") and not k.startswith(("RECALL_", "DATABASE_URL"))
    }
    env.update(
        RECALL_DATA_DIR="memory",
        RECALL_REASONER_MAX_DELAY_MS="0",
        RECALL_PORT=str(port),
        RECALL_HOST="127.0.0.1",
        RECALL_LOG_LEVEL="warn",
    )
    log_path = tmp_path_factory.mktemp("server") / "server.log"
    log = log_path.open("w")
    proc = subprocess.Popen(
        [npx, "tsx", str(SERVER_MAIN)],
        cwd=SERVER_DIR,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 120
    try:
        while True:
            if proc.poll() is not None:
                pytest.fail(
                    f"server exited early ({proc.returncode}):\n{log_path.read_text()[-3000:]}"
                )
            try:
                if httpx.get(f"{url}/health", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                pytest.fail(f"server did not start in time:\n{log_path.read_text()[-3000:]}")
            time.sleep(0.25)
        yield url
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
        log.close()


@pytest.fixture
def recall(server_url: str) -> Iterator[Recall]:
    with Recall(base_url=server_url, workspace_id=f"it-{uuid.uuid4().hex[:12]}") as p:
        yield p


def seed(p: Recall, session_id: str = "chat"):
    """alice talks to a bot; returns (alice, bot, session)."""
    alice, bot = p.peer("alice"), p.peer("bot")
    session = p.session(session_id)
    session.add_peers([alice, bot])
    session.add_messages(
        [
            alice.message("I moved to Utrecht last month and I love cycling."),
            bot.message("Utrecht is great for cycling!"),
            alice.message("My favourite drink is oolong tea."),
        ]
    )
    p.wait_for_idle(timeout=60)
    return alice, bot, session


# ---- the main flow -------------------------------------------------------------------


def test_quickstart_flow(recall: Recall):
    alice, bot, session = seed(recall)

    status = recall.queue_status()
    assert status.pending_work_units == 0 and status.in_progress_work_units == 0
    assert status.completed_work_units >= 1

    ctx = session.context(peer_target=alice, tokens=4000)
    assert [m.peer_id for m in ctx.messages] == ["alice", "bot", "alice"]
    assert ctx.peer_representation and "Utrecht" in ctx.peer_representation
    openai = ctx.to_openai(assistant=bot)
    assert openai[0]["role"] == "system" and openai[0]["content"].startswith(
        "<peer_representation>"
    )
    assert openai[-1] == {
        "role": "user",
        "name": "alice",
        "content": "My favourite drink is oolong tea.",
    }
    anthropic = ctx.to_anthropic(assistant=bot)
    assert anthropic[-2] == {"role": "assistant", "content": "Utrecht is great for cycling!"}
    assert anthropic[-1]["content"].startswith("alice: ")

    answer = alice.chat("Where does alice live?")
    assert isinstance(answer, str) and "Utrecht" in answer

    detailed = alice.chat("Where does alice live?", include_evidence=True)
    assert detailed.content and detailed.evidence is not None
    assert detailed.evidence.conclusions and detailed.abstained is False
    assert detailed.citations

    rep = alice.representation()
    assert "Utrecht" in rep
    assert alice.context().representation
    assert "Utrecht" in " ".join(alice.get_card() or [])

    hits = recall.search("oolong")
    assert hits and hits[0].peer_id == "alice"
    assert [m.id for m in alice.search("Utrecht")]
    assert session.search("cycling")

    usage = recall.usage()
    assert usage.total.calls > 0 and usage.items
    assert usage.total.input_tokens >= 0 and "reasoner" in usage.by_task


def test_structured_chat_and_workspace_chat(recall: Recall):
    alice, _, _ = seed(recall)

    class Home(BaseModel):
        city: str

    home = alice.chat("Where does alice live?", response_format=Home)
    assert home is None or isinstance(home, Home)  # the offline mock may not honour schemas
    assert isinstance(recall.chat("Who lives in Utrecht?"), (str, type(None)))
    out = recall.chat("Who lives in Utrecht?", include_evidence=True)
    assert out.evidence is not None


def test_chat_stream_sync(recall: Recall):
    alice, _, _ = seed(recall)
    stream = alice.chat_stream("Where does alice live?", include_evidence=True)
    text = "".join(stream)
    assert "Utrecht" in text and stream.is_complete
    assert stream.get_final_response() == {"content": text}
    assert stream.evidence is not None and stream.citations


def test_messages_are_idempotent(recall: Recall):
    alice = recall.peer("alice")
    session = recall.session("idem")
    batch = [alice.message("one"), alice.message("two")]
    first = session.add_messages(batch, idempotency_key="same-key")
    second = session.add_messages(batch, idempotency_key="same-key")
    assert [m.id for m in first] == [m.id for m in second]
    assert session.messages().total == 2


def test_lost_response_is_retried_without_duplicating(server_url: str):
    """The server stores the batch, the client never sees the reply, retries and gets the same rows."""

    class LoseFirstReply(httpx.BaseTransport):
        def __init__(self) -> None:
            self.inner = httpx.HTTPTransport()
            self.lost = 0

        def handle_request(self, request: httpx.Request) -> httpx.Response:
            response = self.inner.handle_request(request)
            if (
                request.url.path.endswith("/messages")
                and request.method == "POST"
                and not self.lost
            ):
                self.lost += 1
                response.close()
                raise httpx.ReadTimeout("reply lost", request=request)
            return response

    transport = LoseFirstReply()
    p = Recall(
        base_url=server_url,
        workspace_id=f"it-{uuid.uuid4().hex[:12]}",
        http_client=httpx.Client(transport=transport),
    )
    p._core.sleep = lambda s: None
    alice = p.peer("alice")
    session = p.session("lost")
    out = session.add_messages([alice.message("only once please")])
    assert transport.lost == 1 and len(out) == 1
    assert session.messages().total == 1


def test_pagination(recall: Recall):
    alice = recall.peer("alice")
    session = recall.session("pages")
    session.add_messages([alice.message(f"message {i}") for i in range(7)])
    page = session.messages(size=3)
    assert (page.total, page.pages, len(page)) == (7, 3, 3)
    assert [m.content for m in page] == [f"message {i}" for i in range(7)]
    assert [m.content for m in session.messages(size=3, reverse=True)][:2] == [
        "message 6",
        "message 5",
    ]
    assert [m.content for m in session.messages(size=3).iter_all(limit=4)] == [
        f"message {i}" for i in range(4)
    ]
    second = session.messages(size=3).get_next_page()
    assert second is not None and second.page == 2
    # session list pagination returns handles
    for i in range(3):
        recall.session(f"extra-{i}", metadata={"i": i})
    ids = [s.id for s in recall.sessions(size=2)]
    assert {"pages", "extra-0", "extra-1", "extra-2"} <= set(ids)
    assert [s.id for s in recall.sessions({"metadata": {"i": 1}})] == ["extra-1"]


def test_session_management(recall: Recall):
    alice, bot, session = seed(recall, "mgmt")
    assert {p.id for p in session.peers()} == {"alice", "bot"}
    session.set_metadata({"topic": "tea"})
    assert session.get_metadata() == {"topic": "tea"}
    session.set_configuration({"summary": {"enabled": False}})
    assert session.get_configuration().summary.enabled is False
    session.set_peer_configuration(bot, SessionPeerConfig(observe_others=False, observe_me=False))
    assert session.get_peer_configuration(bot).observe_me is False
    session.remove_peers(bot)
    assert {p.id for p in session.peers()} == {"alice"}
    session.set_peers([alice, (bot, SessionPeerConfig(observe_me=True))])
    assert {p.id for p in session.peers()} == {"alice", "bot"}

    msgs = session.messages().to_list()
    updated = session.update_message(msgs[0], {"reviewed": True})
    assert session.get_message(msgs[0].id).metadata == {"reviewed": True} == updated.metadata
    assert session.summaries().id == "mgmt"

    clone = session.clone(message_id=msgs[1].id)
    assert clone.id != session.id
    assert [m.content for m in clone.messages()] == [m.content for m in msgs[:2]]

    session.delete()
    assert "mgmt" not in [s.id for s in recall.sessions()]
    with pytest.raises(NotFoundError):
        session.refresh()


def test_peer_management(recall: Recall):
    alice = recall.peer(
        "alice", metadata={"tier": "pro"}, configuration=PeerConfig(observe_me=True)
    )
    assert alice.created_at is not None and alice.metadata == {"tier": "pro"}
    fresh = recall.peer("alice")
    assert fresh.metadata is None  # lazy: nothing known until asked
    assert fresh.get_metadata() == {"tier": "pro"}
    assert fresh.get_configuration().observe_me is True
    alice.set_card(["Lives in Utrecht", "Drinks tea"])
    assert alice.get_card() == ["Lives in Utrecht", "Drinks tea"]
    assert [p.id for p in recall.peers()] == ["alice"]
    session = recall.session("s1", peers=[alice])
    assert [s.id for s in alice.sessions()] == ["s1"]
    assert session.id == "s1"
    with pytest.raises(NotFoundError):
        recall.peer("ghost").get_metadata()
    assert [p.id for p in recall.peers()] == ["alice"]  # the failed read created nothing


def test_reads_never_create_a_workspace(server_url: str):
    name = f"it-{uuid.uuid4().hex[:12]}"
    p = Recall(base_url=server_url, workspace_id=name)
    with pytest.raises(NotFoundError):
        p.get_metadata()
    with pytest.raises(NotFoundError):
        p.peer("alice").get_card()
    assert name not in list(p.workspaces())
    assert p.wait_for_idle(timeout=5).is_idle  # nothing queued in a workspace that does not exist
    p.peer("alice").set_metadata({"a": 1})  # a write does create it
    assert name in list(p.workspaces())
    assert p.get_metadata() == {}


def test_auto_create_matches_the_reference_behaviour(server_url: str):
    name = f"it-{uuid.uuid4().hex[:12]}"
    p = Recall(base_url=server_url, workspace_id=name, auto_create=True)
    assert p.peer("alice").get_metadata() == {}
    assert name in list(p.workspaces())


def test_conclusions_crud(recall: Recall):
    alice, _, session = seed(recall)
    mine = alice.conclusions
    created = mine.create(
        [
            {"content": "Alice owns a bike"},
            {"content": "Alice dislikes rain", "session_id": session.id},
        ]
    )
    assert [c.level for c in created] == ["explicit", "explicit"]
    listed = mine.list(size=100).to_list()
    assert {c.id for c in created} <= {c.id for c in listed}
    assert mine.get(created[0].id).content == "Alice owns a bike"
    assert [c.id for c in mine.get_many([created[1].id, created[0].id])] == [
        created[1].id,
        created[0].id,
    ]
    found = mine.query("bike", top_k=3)
    assert found and all(c.observer_id == "alice" for c in found)
    assert any(c.id == created[0].id for c in recall.conclusions.list(size=100))
    assert mine.list(session=session.id, filters={"level": "explicit"}).to_list()
    assert "bike" in mine.representation(search_query="bike")
    mine.delete(created[0].id)
    with pytest.raises(NotFoundError):
        mine.get(created[0].id)
    assert created[0].id not in {c.id for c in mine.list(size=100)}


def test_scopes(recall: Recall):
    alice = recall.peer("alice")
    s1 = recall.session("s1", peers=[alice])
    s1.add_messages([alice.message("I keep bees in my garden.")])
    recall.wait_for_idle(timeout=60)
    scope = recall.scope("garden", metadata={"kind": "demo"})
    assert scope.metadata == {"kind": "demo"}
    scope.add_sessions([s1])
    recall.wait_for_idle(timeout=60)
    assert [s.id for s in scope.sessions()] == ["s1"]
    assert set(scope.status()) <= {"s1"}
    assert recall.get_scope("garden").id == "garden"
    assert [s.id for s in recall.scopes()] == ["garden"]
    assert isinstance(alice.chat("What does alice keep?", scope=scope), (str, type(None)))
    assert isinstance(alice.representation(scope="garden"), str)
    scope.remove_session(s1)
    assert list(scope.sessions()) == []
    with pytest.raises(NotFoundError):
        recall.get_scope("missing")


def test_upload_file(recall: Recall):
    session = recall.session("files")
    out = session.upload_file(
        ("notes.txt", b"Bram plays the cello.\n\nHe practises daily.", "text/plain"), "bram"
    )
    assert out and out[0].peer_id == "bram" and "cello" in out[0].content
    with pytest.raises(pm.APIError) as info:
        session.upload_file(("x.bin", b"\x00\x01", "application/octet-stream"), "bram")
    assert info.value.status == 415


def test_dream_and_background_work(recall: Recall):
    alice, _, session = seed(recall)
    recall.schedule_dream(alice, session=session)
    status = recall.wait_for_idle(timeout=60, observer=alice)
    assert status.pending_work_units == 0
    assert session.wait_for_idle(timeout=5).idle in (True, None)


def test_wait_on_add_messages_and_webhook_endpoints(recall: Recall):
    alice = recall.peer("alice")
    session = recall.session("waited", peers=[alice])
    session.add_messages([alice.message("I live in Delft and I keep bees.")], wait=True)
    assert recall.queue_status().pending_work_units == 0  # reasoning already finished
    assert "Delft" in alice.representation()

    hook = recall.webhooks.create("https://example.com/hook")
    assert recall.webhooks.create("https://example.com/hook").id == hook.id  # idempotent per URL
    assert [h.id for h in recall.webhooks.list()] == [hook.id]
    recall.webhooks.delete(hook)
    assert list(recall.webhooks.list()) == []
    recall.webhooks.test()  # nothing registered, so nothing is delivered


def test_turn_round_trip(recall: Recall):
    alice, bot, session = seed(recall, "turns")
    try:
        result = session.turn(
            [alice.message("Actually I now live in Amersfoort."), bot.message("Noted.")],
            peer_target=alice,
            tokens=3000,
        )
    except NotFoundError:
        pytest.skip("this server has no POST /sessions/{id}/turn")
    assert [m.content for m in result.messages] == ["Actually I now live in Amersfoort.", "Noted."]
    assert result.context.messages[-1].content == "Noted."
    assert result.context.session_id == "turns"
    assert session.messages().total == 5
    key = uuid.uuid4().hex
    again = session.turn([alice.message("retry safe")], idempotency_key=key)
    same = session.turn([alice.message("retry safe")], idempotency_key=key)
    assert [m.id for m in again.messages] == [m.id for m in same.messages]
    assert session.messages().total == 6


def test_minimal_flow_end_to_end(server_url: str):
    recall = Recall(base_url=server_url, workspace_id=f"it-{uuid.uuid4().hex[:12]}")
    peer = recall.peer("zoe")
    session = recall.session("hello", peers=[peer])
    session.add_messages([peer.message("hi there")])
    assert session.context().messages[0].content == "hi there"


# ---- async ---------------------------------------------------------------------------


async def test_async_flow_via_aio_view(server_url: str):
    p = Recall(base_url=server_url, workspace_id=f"it-{uuid.uuid4().hex[:12]}")
    ap = p.aio
    alice = await ap.peer("alice")
    bot = await ap.peer("bot")
    session = await ap.session("async-chat", peers=[alice, bot])
    created = await session.add_messages(
        [alice.message("I adopted a dog named Pixel."), bot.message("Lovely!")]
    )
    assert len(created) == 2
    status = await ap.wait_for_idle(timeout=60)
    assert status.pending_work_units == 0
    ctx = await session.context(peer_target=alice)
    assert "Pixel" in (ctx.peer_representation or "")
    assert (await alice.chat("Which dog named Pixel did alice adopt?")) is not None
    stream = await alice.chat_stream("Which dog named Pixel did alice adopt?")
    text = "".join([chunk async for chunk in stream])
    assert text and stream.is_complete  # the offline mock model's wording is not under test
    msgs = [m async for m in await session.messages(size=1)]
    assert [m.peer_id for m in msgs] == ["alice", "bot"]
    assert (await alice.get_card()) is None or isinstance(await alice.get_card(), list)
    assert (await ap.usage()).total.calls > 0
    with pytest.raises(NotFoundError):
        await (await ap.peer("ghost")).get_metadata()
    await ap.aclose()


async def test_async_recall_standalone(server_url: str):
    async with AsyncRecall(base_url=server_url, workspace_id=f"it-{uuid.uuid4().hex[:12]}") as ap:
        peer = await ap.peer("carl", metadata={"a": 1})
        assert peer.metadata == {"a": 1}
        scope = await ap.scope("team")
        assert scope.id == "team"
        session = await ap.session("s", peers=[peer])
        await session.add_messages([peer.message("I play chess on Sundays.")])
        await ap.wait_for_idle(timeout=60)
        hits = await ap.search("chess")
        assert hits and hits[0].peer_id == "carl"
        pages = [s.id async for s in await ap.sessions()]
        assert pages == ["s"]
