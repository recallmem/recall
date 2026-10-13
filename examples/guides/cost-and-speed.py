# Guide: https://recallmem.dev/guides/cost-and-speed
# The settings and calls that keep Recall cheap and fast: an assistant Recall does not learn
# about, chats it only stores, context on every turn, and one question at the cheapest level.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="assistant-prod")
    # region settings
    user = recall.peer("user-8412")
    # Your prompt defines the assistant: Recall reads its replies but does not learn from them.
    assistant = recall.peer("assistant", configuration=PeerConfig(observe_me=False))
    chat = recall.session("chat-6120")

    # A visitor who is not signed in: keep the chat as context, learn nothing from it.
    visitor = recall.peer("visitor-3b9e")
    no_learning = {"reasoning": {"enabled": False}}
    guest = recall.session("guest-3b9e", configuration=no_learning)
    guest.add_messages([visitor.message("Do you ship to Belgium?")])

    # The same setting on one message: stored for context, not learned from, like a pasted log.
    chat.add_messages(
        [user.message("Error log: payment timed out (504)", configuration=no_learning)]
    )
    # endregion

    # region calls
    # Every reply: one request stores the user's line and returns the prompt context.
    # It makes no model call and is included in the price.
    result = chat.turn(
        [user.message("Book the hotel by Ghent station again, like last time.")],
        peer_target=user,
        tokens=3000,
    )
    prompt = result.context.to_openai(assistant=assistant)
    # Your model writes the reply from `prompt`; store it so the next context includes it.
    chat.add_messages([assistant.message("Happy to. Which dates?")])

    # Ask only when your code needs an answer, at the cheapest level that gives a good one, and
    # keep it for the conversation instead of asking again on every turn.
    recall.wait_for_idle()  # for this demo; real apps rarely wait for learning
    hotel = user.chat("Which hotel did I stay at last time?", reasoning_level="minimal")
    # endregion
    return {"prompt": prompt, "hotel": hotel}
