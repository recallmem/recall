# Guide: https://recallmem.dev/guides/openai-agents
# An OpenAI Agents SDK agent with Recall memory: a RecallSession keeps each conversation, the
# instructions carry what Recall knows about the user, the tools look things up and save facts.
# Needs `pip install openai-agents-recall`. Run with a scripted model by
# sdks/python-integrations/openai-agents-recall/tests/test_guide.py against a real server.
from __future__ import annotations

from typing import Any

from agents import Agent, Runner
from openai_agents_recall import RecallSession, recall_instructions, recall_tools
from recall_memory import Recall


def main(recall: Recall | None = None, model: Any = None) -> dict[str, Any]:
    import asyncio  # the guide's code below runs in an async function

    recall = recall or Recall(workspace_id="assistant-prod")
    return asyncio.run(chat(recall, model))


async def chat(recall: Recall, model: Any) -> dict[str, Any]:
    # region setup
    # One agent for every user. `model` is any Agents SDK model; None uses the SDK's default.
    agent = Agent(
        name="Assistant",
        instructions=recall_instructions("You are a helpful assistant.", client=recall),
        tools=recall_tools(client=recall),
        model=model,
    )
    # endregion

    # region run
    # A RecallSession per conversation keeps its history; the run's context names the user.
    me = {"user_id": "user-8412"}
    session = RecallSession("chat-20261013-a1", user_id="user-8412", client=recall)
    first = await Runner.run(
        agent, "I'm vegetarian. Plan dinner for four on Saturday.", session=session, context=me
    )
    # The next message in the same conversation: the session supplies what was said so far.
    second = await Runner.run(agent, "Make it gluten-free too.", session=session, context=me)
    # endregion

    # region later
    # A new conversation: no history, but the instructions already carry what Recall learned.
    await recall.aio.wait_for_idle()  # only for this demo: learning runs in the background
    later = await Runner.run(
        agent,
        "Any ideas for lunch tomorrow?",
        session=RecallSession("chat-20261014-b2", user_id="user-8412", client=recall),
        context=me,
    )
    # endregion

    # region forget
    # The user deletes their account: erase them, then the conversations that hold the replies.
    user = await recall.aio.peer("user-8412")
    conversations = [c async for c in await user.sessions()]
    await user.delete()
    for conversation in conversations:
        await conversation.delete()
    # endregion
    return {"first": first, "second": second, "later": later}
