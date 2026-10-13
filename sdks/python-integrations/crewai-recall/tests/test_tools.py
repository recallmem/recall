from __future__ import annotations

import json

import pytest
from crewai import Agent, Crew, Task
from recall_memory import AsyncRecall, Recall

from conftest import ScriptedLLM, final, use_tool
from crewai_recall import (
    RecallAskTool,
    RecallRememberTool,
    RecallSearchTool,
    recall_context,
    recall_tools,
)
from crewai_recall._memory import NO_ANSWER

pytestmark = pytest.mark.integration


def test_tools_look_like_crewai_tools(recall: Recall) -> None:
    tools = recall_tools("alice", client=recall)
    assert [t.name for t in tools] == ["recall_search", "recall_ask", "recall_remember"]
    assert [sorted(t.args_schema.model_json_schema()["properties"]) for t in tools] == [
        ["query"],
        ["question"],
        ["facts"],
    ]
    assert {e.name for e in tools[0].env_vars} == {
        "RECALL_API_KEY",
        "RECALL_WORKSPACE_ID",
        "RECALL_URL",
    }
    dumped = tools[0].model_dump(mode="json")
    assert "client" not in dumped and dumped["user_id"] == "alice"
    assert tools[0].client is tools[2].client  # one shared client


def test_remember_search_ask(recall: Recall) -> None:
    saved = json.loads(
        RecallRememberTool(user_id="alice", client=recall).run(facts=["Prefers aisle seats."])
    )
    assert saved["saved"][0]["content"] == "Prefers aisle seats."
    found = json.loads(RecallSearchTool(user_id="alice", client=recall).run(query="seats"))
    assert found["facts"][0]["content"] == "Prefers aisle seats."
    assert "aisle" in RecallAskTool(user_id="alice", client=recall).run(question="Seat preference?")
    assert RecallAskTool(user_id="nobody", client=recall).run(question="Who?") == NO_ANSWER
    error = json.loads(RecallRememberTool(user_id="alice", client=recall).run(facts=[""]))
    assert error == {"error": "facts must list at least one fact"}


async def test_async_tools(arecall: AsyncRecall) -> None:
    tools = recall_tools("bob", client=arecall)
    search, ask, remember = tools
    saved = json.loads(await remember.arun(facts=["Lives in Porto."]))
    assert saved["saved"][0]["content"] == "Lives in Porto."
    assert json.loads(await search.arun(query="Porto"))["facts"][0]["content"] == "Lives in Porto."
    assert "Porto" in await ask.arun(question="Where does Bob live?")
    with pytest.raises(TypeError, match="async-only"):
        search.run(query="blocking call on an async client")


def test_when_recall_is_down_the_tool_says_so() -> None:
    down = Recall(base_url="http://127.0.0.1:9", workspace_id="w", max_retries=0, timeout=2)
    out = json.loads(RecallSearchTool(user_id="alice", client=down).run(query="x"))
    assert "error" in out


def test_recall_context(recall: Recall) -> None:
    assert recall_context("nobody", client=recall) == ""
    RecallRememberTool(user_id="alice", client=recall).run(facts=["Is vegetarian."])
    text = recall_context("alice", query="dinner", client=recall)
    assert "Is vegetarian." in text


def test_a_crew_uses_the_tools(recall: Recall) -> None:
    llm = ScriptedLLM(
        model="scripted",
        responses=[
            use_tool("recall_remember", json.dumps({"facts": ["Hates early flights."]})),
            final("A weekend in Lisbon with an afternoon flight."),
        ],
    )
    concierge = Agent(
        role="Travel concierge",
        goal="Plan trips the traveller will love",
        backstory="You remember what each traveller likes.",
        tools=recall_tools("alice", client=recall),
        llm=llm,
    )
    plan = Task(
        description="{request}\n\nWhat you know about the traveller:\n{memory}",
        expected_output="A plan",
        agent=concierge,
    )
    RecallRememberTool(user_id="alice", client=recall).run(facts=["Is vegetarian."])
    request = "I hate early flights. Plan a weekend in Lisbon."
    result = Crew(agents=[concierge], tasks=[plan]).kickoff(
        inputs={"request": request, "memory": recall_context("alice", query=request, client=recall)}
    )
    assert str(result) == "A weekend in Lisbon with an afternoon flight."
    first_prompt = json.dumps(llm.prompts[0])
    assert "Is vegetarian." in first_prompt and "recall_remember" in first_prompt
    facts = [c.content for c in recall.peer("alice").conclusions.list().items]
    assert "Hates early flights." in facts
