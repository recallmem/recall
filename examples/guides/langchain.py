# Guide: https://recallmem.dev/guides/langchain
# A LangChain agent with Recall memory: the middleware adds memory to the prompt and records each
# exchange, the tools let the model look things up and save facts, the retriever feeds a chain.
# Needs `pip install "langchain-recall[agents]"`. Run with a scripted chat model by
# sdks/python-integrations/langchain-recall/tests/test_guide.py against a real server.
from __future__ import annotations

from typing import Any

from langchain.agents import create_agent
from langchain_recall import RecallMiddleware, RecallRetriever, RecallToolkit
from langgraph.checkpoint.memory import InMemorySaver
from recall_memory import Recall


def main(recall: Recall | None = None, model: Any = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="travel-agent")
    # region setup
    # `model` is your chat model, e.g. init_chat_model(...). One agent serves every user: the
    # middleware and the tools read the user from each run's context.
    agent = create_agent(
        model,
        tools=RecallToolkit(client=recall).get_tools(),
        system_prompt="You are a travel assistant.",
        middleware=[RecallMiddleware(recall)],
        checkpointer=InMemorySaver(),  # the thread's own state; Recall is long-term memory
    )
    # endregion

    # region run
    # The thread id names the Recall session; the user id is the person Recall learns about.
    first = agent.invoke(
        {"messages": [{"role": "user", "content": "I'm vegetarian. Plan a weekend in Lisbon."}]},
        {"configurable": {"thread_id": "trip-lisbon"}},
        context={"user_id": "user-8412"},
    )
    # endregion

    # region later
    # A new thread weeks later: the prompt already holds what Recall knows about the user.
    recall.wait_for_idle()  # only for this demo: learning runs in the background
    later = agent.invoke(
        {"messages": [{"role": "user", "content": "Where should we eat in Porto?"}]},
        {"configurable": {"thread_id": "trip-porto"}},
        context={"user_id": "user-8412"},
    )
    # endregion

    # region retriever
    # Facts about the user as documents, for a chain or a graph node of your own. No model call.
    retriever = RecallRetriever(user_id="user-8412", source="facts", k=5, client=recall)
    docs = retriever.invoke("food preferences")
    # endregion

    # region forget
    # The user deletes their account: erase them, then the threads that hold the agent's replies.
    user = recall.peer("user-8412")
    threads = list(user.sessions())
    user.delete()
    for thread in threads:
        thread.delete()
    # endregion
    return {"first": first, "later": later, "docs": docs}
