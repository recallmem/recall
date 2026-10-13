from __future__ import annotations

from typing import Any

import pytest
from agents.memory import Session
from recall_memory import AsyncRecall, Recall

from openai_agents_recall import RecallSession
from openai_agents_recall._store import CHUNK, HIDDEN

pytestmark = pytest.mark.integration


def turn() -> list[dict[str, Any]]:
    """A user message, a tool call and its result, a reasoning item and the answer."""
    return [
        {"role": "user", "content": "I moved to Utrecht last month and I love cycling."},
        {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [{"type": "summary_text", "text": "Check the weather."}],
        },
        {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "weather",
            "arguments": '{"city": "Utrecht"}',
        },
        {"type": "function_call_output", "call_id": "call_1", "output": "Sunny, 21 degrees"},
        {
            "type": "message",
            "id": "msg_1",
            "role": "assistant",
            "status": "completed",
            "content": [
                {"type": "output_text", "text": "A good day for a ride.", "annotations": []}
            ],
        },
    ]


def test_is_an_agents_sdk_session(arecall: AsyncRecall) -> None:
    assert isinstance(RecallSession("s", user_id="alice", client=arecall), Session)


async def test_items_come_back_exactly(arecall: AsyncRecall) -> None:
    session = RecallSession("chat-1", user_id="alice", client=arecall)
    assert await session.get_items() == []
    await session.add_items(turn())
    assert await session.get_items() == turn()
    assert await session.get_items(limit=2) == turn()[-2:]
    assert await session.get_items(limit=0) == []
    assert await session.get_items(limit=50) == turn()


def settings_limit_1() -> list[Any]:
    out: list[Any] = [{"limit": 1}]
    try:  # the SDK's SessionSettings (newer SDK versions)
        from agents.memory import SessionSettings

        out.append(SessionSettings(limit=1))
    except ImportError:
        pass
    return out


@pytest.mark.parametrize("settings", settings_limit_1())
async def test_session_settings_limit(arecall: AsyncRecall, settings: Any) -> None:
    session = RecallSession("chat-1", user_id="alice", client=arecall, session_settings=settings)
    await session.add_items(turn())
    assert await session.get_items() == turn()[-1:]
    assert await session.get_items(limit=3) == turn()[-3:]


async def test_recall_learns_from_the_user_only(recall: Recall) -> None:
    session = RecallSession("chat-1", user_id="alice", assistant_id="bot", client=recall)
    await session.add_items(turn())
    stored = recall.session("chat-1").messages().to_list()
    assert [(m.peer_id, m.content) for m in stored] == [
        ("alice", "I moved to Utrecht last month and I love cycling."),
        ("bot", "[reasoning]"),
        ("bot", "[tool call: weather]"),
        ("bot", "[tool result]"),
        ("bot", "A good day for a ride."),
    ]
    assert recall.session("chat-1").get_peer_configuration("bot").observe_me is False
    recall.wait_for_idle()
    assert any("Utrecht" in c.content for c in recall.peer("alice").conclusions.list().items)
    assert recall.peer("bot").conclusions.list().items == []


async def test_pop_item_and_clear_session(recall: Recall) -> None:
    session = RecallSession("chat-1", user_id="alice", client=recall)
    await session.add_items(turn())
    assert await session.pop_item() == turn()[-1]
    assert await session.pop_item() == turn()[-2]
    assert await session.get_items() == turn()[:-2]
    await session.clear_session()
    assert await session.get_items() == []
    assert await session.pop_item() is None
    stored = recall.session("chat-1").messages().to_list()
    assert len(stored) == 5 and all(m.metadata[HIDDEN] is True for m in stored)
    await session.add_items([{"role": "user", "content": "Starting over."}])
    assert await session.get_items() == [{"role": "user", "content": "Starting over."}]


async def test_an_item_larger_than_one_recall_message(arecall: AsyncRecall) -> None:
    session = RecallSession("chat-big", user_id="alice", client=arecall)
    big = {"type": "function_call_output", "call_id": "call_9", "output": "x" * (CHUNK * 2)}
    items = [
        {"role": "user", "content": "Fetch it"},
        big,
        {"role": "assistant", "content": "Done."},
    ]
    await session.add_items(items)
    assert await session.get_items() == items
    assert await session.get_items(limit=2) == items[1:]
    assert await session.pop_item() == items[2]
    assert await session.pop_item() == big
    assert await session.get_items() == items[:1]


async def test_messages_written_by_other_clients(recall: Recall) -> None:
    alice, bot = recall.peer("alice"), recall.peer("assistant")
    recall.session("chat-2").add_messages(
        [alice.message("Hi"), bot.message("Hello!"), recall.peer("carol").message("Me too")]
    )
    session = RecallSession("chat-2", user_id="alice", client=recall)
    assert await session.get_items() == [
        {"role": "user", "content": "Hi"},
        {"role": "assistant", "content": "Hello!"},
        {"role": "user", "content": "carol: Me too"},
    ]
    assert await session.pop_item() == {"role": "user", "content": "carol: Me too"}
    assert len(await session.get_items()) == 2


def test_needs_ids() -> None:
    with pytest.raises(ValueError):
        RecallSession("", user_id="alice", client=Recall(base_url="http://127.0.0.1:9"))
