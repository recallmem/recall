from __future__ import annotations

import json
from dataclasses import dataclass

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, StateGraph
from recall_memory import AsyncRecall, Recall
from typing_extensions import TypedDict

from langchain_recall import (
    RecallAskTool,
    RecallChatMessageHistory,
    RecallRememberTool,
    RecallRetriever,
    RecallSearchTool,
    RecallToolkit,
)
from langchain_recall._memory import NO_ANSWER, safe_id

pytestmark = pytest.mark.integration


def test_toolkit_gives_three_tools_with_small_schemas(recall: Recall) -> None:
    tools = RecallToolkit(user_id="alice", client=recall).get_tools()
    assert [t.name for t in tools] == ["recall_search", "recall_ask", "recall_remember"]
    schemas = {t.name: set(t.tool_call_schema.model_json_schema()["properties"]) for t in tools}
    assert schemas == {
        "recall_search": {"query"},
        "recall_ask": {"question"},
        "recall_remember": {"facts"},
    }


def test_remember_then_search_and_ask(recall: Recall) -> None:
    # A new person in a new workspace: remembering creates both.
    saved = json.loads(
        RecallRememberTool(user_id="alice", client=recall).invoke(
            {"facts": ["Prefers window seats.", "  ", "Is allergic to peanuts."]}
        )
    )
    assert [f["content"] for f in saved["saved"]] == [
        "Prefers window seats.",
        "Is allergic to peanuts.",
    ]

    found = json.loads(RecallSearchTool(user_id="alice", client=recall).invoke({"query": "seats"}))
    assert "Prefers window seats." in [f["content"] for f in found["facts"]]
    assert found["messages"] == []

    answer = RecallAskTool(user_id="alice", client=recall).invoke({"question": "Any allergies?"})
    assert "peanuts" in answer


def test_tools_report_problems_to_the_model(recall: Recall) -> None:
    assert RecallAskTool(user_id="nobody", client=recall).invoke({"question": "Who?"}) == NO_ANSWER
    out = json.loads(RecallRememberTool(user_id="alice", client=recall).invoke({"facts": [" "]}))
    assert out == {"error": "facts must list at least one fact"}
    bad = json.loads(
        RecallRememberTool(user_id="not valid!", client=recall).invoke({"facts": ["x"]})
    )
    assert "error" in bad


async def test_async_tools(arecall: AsyncRecall) -> None:
    tools = {t.name: t for t in RecallToolkit(user_id="bob", client=arecall).get_tools()}
    saved = json.loads(await tools["recall_remember"].ainvoke({"facts": ["Lives in Porto."]}))
    assert saved["saved"][0]["content"] == "Lives in Porto."
    found = json.loads(await tools["recall_search"].ainvoke({"query": "Porto"}))
    assert found["facts"][0]["content"] == "Lives in Porto."
    assert "Porto" in await tools["recall_ask"].ainvoke({"question": "Where does Bob live?"})


def test_retriever(recall: Recall) -> None:
    RecallChatMessageHistory("chat-1", user_id="alice", client=recall).add_messages(
        [HumanMessage("I moved to Utrecht last month and I love cycling."), AIMessage("Welcome!")]
    )
    recall.wait_for_idle()
    docs = RecallRetriever(user_id="alice", client=recall).invoke("Utrecht")
    kinds = [d.metadata["type"] for d in docs]
    assert "fact" in kinds and "message" in kinds
    assert kinds == sorted(kinds)  # facts first
    message = next(d for d in docs if d.metadata["type"] == "message")
    assert message.page_content == "I moved to Utrecht last month and I love cycling."
    assert message.metadata["session_id"] == "chat-1" and message.id == message.metadata["id"]

    facts = RecallRetriever(user_id="alice", source="facts", k=1, client=recall).invoke("Utrecht")
    assert len(facts) == 1 and facts[0].metadata["type"] == "fact"
    in_session = RecallRetriever(
        user_id="alice", source="messages", session_id="chat-1", client=recall
    ).invoke("Welcome")
    assert "Welcome!" in [d.page_content for d in in_session]
    assert RecallRetriever(user_id="nobody", client=recall).invoke("Utrecht") == []


async def test_retriever_async(arecall: AsyncRecall) -> None:
    await RecallRememberTool(user_id="bob", client=arecall).ainvoke({"facts": ["Likes jazz."]})
    docs = await RecallRetriever(user_id="bob", client=arecall).ainvoke("music")
    assert [d.page_content for d in docs] == ["Likes jazz."]


@dataclass
class Context:
    user_id: str


class State(TypedDict, total=False):
    query: str
    result: str
    docs: list


def test_the_user_comes_from_the_graph_context(recall: Recall) -> None:
    """Leave user_id out and the tools and the retriever use the run's context."""
    tools = {t.name: t for t in RecallToolkit(client=recall).get_tools()}
    retriever = RecallRetriever(client=recall, source="facts")

    def node(state: State) -> State:
        tools["recall_remember"].invoke({"facts": [state["query"]]})
        return {
            "result": tools["recall_search"].invoke({"query": state["query"]}),
            "docs": retriever.invoke(state["query"]),
        }

    graph = StateGraph(State, context_schema=Context)
    graph.add_node("node", node)
    graph.add_edge(START, "node")
    graph.add_edge("node", END)
    out = graph.compile().invoke({"query": "Speaks Dutch."}, context=Context(user_id="carol"))
    assert json.loads(out["result"])["facts"][0]["content"] == "Speaks Dutch."
    assert [d.page_content for d in out["docs"]] == ["Speaks Dutch."]
    assert recall.peer("carol").conclusions.list().items[0].content == "Speaks Dutch."

    with pytest.raises(ValueError, match="whose memory"):
        tools["recall_search"].invoke({"query": "outside a graph run"})


def test_safe_id() -> None:
    assert safe_id("thread_1-a") == "thread_1-a"
    a, b = safe_id("user:42"), safe_id("user/42")
    assert a.startswith("user-42-") and b.startswith("user-42-") and a != b
