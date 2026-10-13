# Guide: https://recallmem.dev/guides/modeling
# One user, two agents, two conversations. Each agent's view of the user holds only what it
# witnessed; Recall's own view holds everything. Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import PeerConfig, Recall, SessionPeerConfig


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="trips-prod")
    # region setup
    # One peer per real person or agent, with the id your own database already uses.
    user = recall.peer("user-8412", metadata={"plan": "pro"})
    # Your code defines the agents, so Recall need not learn about them from their own lines.
    agent = PeerConfig(observe_me=False)
    planner = recall.peer("agent-planner", configuration=agent)
    billing = recall.peer("agent-billing", configuration=agent)
    # endregion

    # region sessions
    # One session per conversation. Each agent joins with observe_others, so it builds its own
    # view of the people it talks to, from this conversation only.
    trip = recall.session(
        "chat-5531",
        metadata={"channel": "web"},
        peers=[user, (planner, SessionPeerConfig(observe_others=True))],
    )
    trip.add_messages(
        [
            user.message("I live in Utrecht and I am vegetarian."),
            planner.message("Noted. I'll only suggest restaurants with good vegetarian menus."),
        ]
    )

    invoice = recall.session(
        "chat-5532",
        metadata={"channel": "email"},
        peers=[user, (billing, SessionPeerConfig(observe_others=True))],
    )
    invoice.add_messages(
        [
            user.message("I moved to Amersfoort last week, please update my billing address."),
            billing.message("Done. Your next invoice goes to your new address in Amersfoort."),
        ]
    )
    # endregion

    # region views
    # (wait_for_idle is for this demo; real apps rarely wait for learning to finish.)
    recall.wait_for_idle()
    # Recall's view of the user, built from everything they said in any session: Amersfoort.
    recall_view = user.chat("Where do I live?", reasoning_level="minimal")
    # The planner's view holds only what it witnessed. It never heard about the move: Utrecht.
    planner_view = planner.chat("Where does the user live?", target=user, reasoning_level="minimal")
    # In a prompt, read the user through the eyes of the agent that is talking.
    context = trip.context(peer_target=user, peer_perspective=planner, tokens=2000)
    # endregion

    # region filters
    # Metadata is yours to filter on.
    email_chats = recall.sessions(filters={"metadata": {"channel": "email"}}).to_list()
    # Search only what the billing agent saw: the trip chat is not in the results.
    billing_saw = recall.search("restaurants", filters={"peer_perspective": "agent-billing"})
    # endregion
    return {
        "recall_view": recall_view,
        "planner_view": planner_view,
        "context": context,
        "email_chats": email_chats,
        "billing_saw": billing_saw,
    }
