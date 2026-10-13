from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from recall_memory import AsyncRecall, Recall

from langchain_recall import RecallChatMessageHistory
from langchain_recall._store import CHUNK, HIDDEN

pytestmark = pytest.mark.integration


def conversation() -> list:
    return [
        SystemMessage("You are a travel assistant."),
        HumanMessage("I moved to Utrecht last month and I love cycling.", id="h1"),
        AIMessage(
            "",
            id="a1",
            tool_calls=[{"name": "weather", "args": {"city": "Utrecht"}, "id": "call-1"}],
        ),
        ToolMessage("Sunny, 21 degrees", tool_call_id="call-1", name="weather", id="t1"),
        AIMessage("Sunny today: a good day for a ride.", id="a2"),
    ]


def test_messages_come_back_exactly(recall: Recall) -> None:
    history = RecallChatMessageHistory("chat-1", user_id="alice", client=recall)
    assert history.messages == []
    history.add_messages(conversation())
    assert history.messages == conversation()


def test_recall_learns_from_the_user_only(recall: Recall) -> None:
    history = RecallChatMessageHistory("chat-1", user_id="alice", assistant_id="bot", client=recall)
    history.add_messages(conversation())
    session = recall.session("chat-1")
    stored = session.messages().to_list()
    assert [(m.peer_id, m.content) for m in stored] == [
        ("bot", "[system message]"),
        ("alice", "I moved to Utrecht last month and I love cycling."),
        ("bot", "[tool call: weather]"),
        ("bot", "[tool result: weather]"),
        ("bot", "Sunny today: a good day for a ride."),
    ]
    assert session.get_peer_configuration("bot").observe_me is False
    recall.wait_for_idle()
    facts = [c.content for c in recall.peer("alice").conclusions.list().items]
    assert any("Utrecht" in f for f in facts)
    assert recall.peer("bot").conclusions.list().items == []


def test_a_message_larger_than_one_recall_message(recall: Recall) -> None:
    history = RecallChatMessageHistory("chat-big", user_id="alice", client=recall)
    big = ToolMessage("x" * (CHUNK * 2 + 10), tool_call_id="call-9", name="fetch")
    history.add_messages([HumanMessage("Fetch the page"), big, AIMessage("Done.")])
    stored = recall.session("chat-big").messages().to_list()
    assert len(stored) == 5  # the tool result takes three Recall messages
    assert [m.content for m in stored[1:4]] == ["[tool result: fetch]", "", ""]
    assert [m.metadata["recall_part"] for m in stored[1:4]] == [[0, 3], [1, 3], [2, 3]]
    assert history.messages == [HumanMessage("Fetch the page"), big, AIMessage("Done.")]


def test_messages_written_by_other_clients(recall: Recall) -> None:
    session = recall.session("chat-2")
    alice, bot = recall.peer("alice"), recall.peer("assistant")
    session.add_messages([alice.message("Hi there"), bot.message("Hello!")])
    session.add_messages([recall.peer("carol").message("Me too")])
    history = RecallChatMessageHistory("chat-2", user_id="alice", client=recall)
    got = history.messages
    assert [(type(m).__name__, m.content, m.name) for m in got] == [
        ("HumanMessage", "Hi there", None),
        ("AIMessage", "Hello!", None),
        ("HumanMessage", "Me too", "carol"),
    ]


def test_clear_hides_the_history_but_recall_keeps_it(recall: Recall) -> None:
    history = RecallChatMessageHistory("chat-3", user_id="alice", client=recall)
    history.add_messages(conversation())
    history.clear()
    assert history.messages == []
    stored = recall.session("chat-3").messages().to_list()
    assert len(stored) == 5 and all(m.metadata.get(HIDDEN) is True for m in stored)
    assert all("langchain_message" not in m.metadata for m in stored)
    history.add_messages([HumanMessage("Starting over.")])
    assert history.messages == [HumanMessage("Starting over.")]


async def test_async(arecall: AsyncRecall) -> None:
    history = RecallChatMessageHistory("chat-4", user_id="alice", client=arecall)
    await history.aadd_messages(conversation())
    assert await history.aget_messages() == conversation()
    await history.aclear()
    assert await history.aget_messages() == []
    with pytest.raises(TypeError, match="async-only"):
        history.add_messages([HumanMessage("blocking call on an async client")])


async def test_a_sync_client_also_serves_async_calls(recall: Recall) -> None:
    history = RecallChatMessageHistory("chat-5", user_id="alice", client=recall)
    await history.aadd_messages([HumanMessage("One"), AIMessage("Two")])
    assert history.messages == [HumanMessage("One"), AIMessage("Two")]
