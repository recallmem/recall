from __future__ import annotations

import logging

import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver
from recall_memory import AsyncRecall, Recall

from conftest import ScriptedChatModel
from langchain_recall import RecallToolkit
from langchain_recall.middleware import RecallMiddleware

pytestmark = pytest.mark.integration


def ask(text: str) -> dict:
    return {"messages": [HumanMessage(text)]}


def remember_call(fact: str) -> AIMessage:
    return AIMessage(
        "",
        tool_calls=[{"name": "recall_remember", "args": {"facts": [fact]}, "id": "call-1"}],
    )


def system_text(prompt: list) -> str:
    return next((m.text for m in prompt if isinstance(m, SystemMessage)), "")


def test_recalls_before_and_records_after(recall: Recall) -> None:
    model = ScriptedChatModel(
        responses=[
            remember_call("Is vegetarian."),
            AIMessage("Noted: vegetarian. How about a mushroom risotto?"),
            AIMessage("A lentil curry, since you are vegetarian."),
        ]
    )
    agent = create_agent(
        model,
        tools=RecallToolkit(client=recall).get_tools(),
        system_prompt="You plan dinners.",
        middleware=[RecallMiddleware(recall)],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "dinner:1"}}
    context = {"user_id": "alice"}

    agent.invoke(ask("I'm vegetarian. What should I cook tonight?"), config, context=context)
    # The first prompt had no memory yet: alice was unknown.
    assert system_text(model.prompts[0]) == "You plan dinners."

    session = recall.session(next(s.id for s in recall.sessions()))
    assert session.id.startswith("dinner-1-")  # the thread id, made a valid Recall id
    stored = session.messages().to_list()
    assert [(m.peer_id, m.content) for m in stored] == [
        ("alice", "I'm vegetarian. What should I cook tonight?"),
        ("assistant", "Noted: vegetarian. How about a mushroom risotto?"),
    ]  # the tool call and its result are not recorded
    assert session.get_peer_configuration("assistant").observe_me is False

    agent.invoke(ask("And tomorrow?"), config, context=context)
    memory = system_text(model.prompts[-1])
    assert memory.startswith("You plan dinners.\n\n<memory>")
    assert "vegetarian" in memory.lower()
    assert len(session.messages().to_list()) == 4


async def test_async_agent_with_fixed_ids(arecall: AsyncRecall) -> None:
    model = ScriptedChatModel(responses=[AIMessage("Hello Bob.")])
    bob = await arecall.peer("bob", metadata={})  # creates the workspace and the peer
    await bob.conclusions.create([{"content": "Is called Bob."}])
    agent = create_agent(
        model,
        middleware=[RecallMiddleware(arecall, user_id="bob", session_id="chat-bob")],
    )
    await agent.ainvoke(ask("Hi!"))
    assert "Is called Bob." in system_text(model.prompts[0])
    session = await arecall.session("chat-bob")
    page = await session.messages()
    assert [m.content for m in page.items] == ["Hi!", "Hello Bob."]


def test_recording_twice_stores_the_exchange_once(recall: Recall) -> None:
    middleware = RecallMiddleware(recall, user_id="alice", session_id="chat-1", recall=False)
    state = {"messages": [HumanMessage("Hi", id="h1"), AIMessage("Hello", id="a1")]}
    middleware.after_agent(state, None)  # type: ignore[arg-type]
    middleware.after_agent(state, None)  # type: ignore[arg-type]
    assert len(recall.session("chat-1").messages().to_list()) == 2


def test_needs_a_user_and_a_session(recall: Recall) -> None:
    model = ScriptedChatModel(responses=[AIMessage("ok"), AIMessage("ok")])
    agent = create_agent(model, middleware=[RecallMiddleware(recall)])
    with pytest.raises(ValueError, match="does not know the user"):
        agent.invoke(ask("Hi"))
    with pytest.raises(ValueError, match="needs a session"):
        agent.invoke(ask("Hi"), context={"user_id": "alice"})
    only_record = create_agent(model, middleware=[RecallMiddleware(recall, recall=False)])
    with pytest.raises(ValueError, match="needs a session"):  # before the model runs
        only_record.invoke(ask("Hi"), context={"user_id": "alice"})
    assert model.prompts == []
    no_record = create_agent(model, middleware=[RecallMiddleware(recall, record=False)])
    out = no_record.invoke(ask("Hi"), context={"user_id": "alice"})
    assert out["messages"][-1].text == "ok"
    assert "recall_memory" not in out


def test_goes_on_without_recall_when_it_is_down(caplog: pytest.LogCaptureFixture) -> None:
    down = Recall(base_url="http://127.0.0.1:9", workspace_id="w", max_retries=0, timeout=2)
    model = ScriptedChatModel(responses=[AIMessage("Still here.")])
    agent = create_agent(model, middleware=[RecallMiddleware(down, user_id="u", session_id="s")])
    with caplog.at_level(logging.WARNING, logger="langchain_recall"):
        out = agent.invoke(ask("Hi"))
    assert out["messages"][-1].text == "Still here."
    assert [r.message.split(":")[1].strip() for r in caplog.records] == [
        "could not read memory, going on without it",
        "could not record the exchange",
    ]
