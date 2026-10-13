"""The session, the tools and the instructions driven by the Agents SDK's own Runner."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

import pytest
from agents import Agent, Runner
from agents.tool_context import ToolContext
from recall_memory import AsyncRecall, Recall

from conftest import ScriptedModel, call, say
from openai_agents_recall import RecallSession, recall_instructions, recall_tools
from openai_agents_recall._memory import NO_ANSWER

pytestmark = pytest.mark.integration


@dataclass
class User:
    user_id: str


async def test_a_conversation_over_two_runs(recall: Recall) -> None:
    model = ScriptedModel(
        [
            [call("recall_remember", json.dumps({"facts": ["Is vegetarian."]}))],
            [say("Noted. How about a mushroom risotto?")],
            [say("A lentil curry, again without meat.", n=2)],
        ]
    )
    agent = Agent(
        name="Chef",
        instructions=recall_instructions("You plan dinners.", client=recall),
        tools=recall_tools(client=recall),
        model=model,
    )
    session = RecallSession("dinner-1", user_id="alice", client=recall)

    first = await Runner.run(
        agent, "I'm vegetarian. Dinner ideas?", session=session, context=User("alice")
    )
    assert first.final_output == "Noted. How about a mushroom risotto?"
    # The session stores the user's message before the model runs, so Recall may already have
    # learned from it by the time the instructions are built.
    assert model.calls[0]["instructions"].startswith("You plan dinners.")

    second = await Runner.run(agent, "And tomorrow?", session=session, context=User("alice"))
    assert second.final_output == "A lentil curry, again without meat."
    # The second run saw the first one's history, and the instructions carried the new fact.
    history = model.calls[-1]["input"]
    assert history[0] == {"content": "I'm vegetarian. Dinner ideas?", "role": "user"}
    assert [i.get("type") for i in history[1:3]] == ["function_call", "function_call_output"]
    assert "Is vegetarian." in model.calls[-1]["instructions"]
    assert model.calls[-1]["instructions"].startswith("You plan dinners.\n\n<memory>")

    stored = recall.session("dinner-1").messages().to_list()
    assert [(m.peer_id, m.content) for m in stored] == [
        ("alice", "I'm vegetarian. Dinner ideas?"),
        ("assistant", "[tool call: recall_remember]"),
        ("assistant", "[tool result]"),
        ("assistant", "Noted. How about a mushroom risotto?"),
        ("alice", "And tomorrow?"),
        ("assistant", "A lentil curry, again without meat."),
    ]


def tool_context(tool: str, args: dict, context: object = None) -> ToolContext:
    return ToolContext(
        context, tool_name=tool, tool_call_id="call_1", tool_arguments=json.dumps(args)
    )


async def test_tools(arecall: AsyncRecall) -> None:
    tools = {t.name: t for t in recall_tools(user_id="bob", client=arecall)}
    assert set(tools) == {"recall_search", "recall_ask", "recall_remember"}

    async def invoke(name: str, args: dict) -> str:
        return await tools[name].on_invoke_tool(tool_context(name, args), json.dumps(args))

    saved = json.loads(await invoke("recall_remember", {"facts": ["Lives in Porto.", " "]}))
    assert [f["content"] for f in saved["saved"]] == ["Lives in Porto."]
    found = json.loads(await invoke("recall_search", {"query": "Porto"}))
    assert found["facts"][0]["content"] == "Lives in Porto."
    assert "Porto" in await invoke("recall_ask", {"question": "Where does Bob live?"})
    assert json.loads(await invoke("recall_remember", {"facts": []})) == {
        "error": "facts must list at least one fact"
    }

    nobody = {t.name: t for t in recall_tools(user_id="nobody", client=arecall)}
    args = {"question": "Who?"}
    assert (
        await nobody["recall_ask"].on_invoke_tool(
            tool_context("recall_ask", args), json.dumps(args)
        )
        == NO_ANSWER
    )


async def test_the_user_comes_from_the_run_context(arecall: AsyncRecall) -> None:
    tools = {t.name: t for t in recall_tools(client=arecall)}
    args = {"facts": ["Speaks Dutch."]}
    ctx = tool_context("recall_remember", args, context={"user_id": "carol"})
    await tools["recall_remember"].on_invoke_tool(ctx, json.dumps(args))
    carol = await arecall.peer("carol")
    assert [c.content for c in (await carol.conclusions.list()).items] == ["Speaks Dutch."]

    with pytest.raises(Exception, match="whose memory"):
        await tools["recall_remember"].on_invoke_tool(
            tool_context("recall_remember", args), json.dumps(args)
        )


async def test_without_recall_the_agent_goes_on(caplog: pytest.LogCaptureFixture) -> None:
    down = Recall(base_url="http://127.0.0.1:9", workspace_id="w", max_retries=0, timeout=2)
    model = ScriptedModel([[call("recall_search", json.dumps({"query": "x"}))], [say("Fine.")]])
    agent = Agent(
        name="A",
        instructions=recall_instructions("Be brief.", user_id="u", client=down),
        tools=recall_tools(user_id="u", client=down),
        model=model,
    )
    with caplog.at_level(logging.WARNING, logger="openai_agents_recall"):
        result = await Runner.run(agent, "Hi")
    assert result.final_output == "Fine."
    assert model.calls[0]["instructions"] == "Be brief."
    tool_output = model.calls[1]["input"][-1]["output"]
    assert "error" in json.loads(tool_output)
    assert "could not read memory" in caplog.text
