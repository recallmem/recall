# Guide: https://recallmem.dev/guides/switch-from-honcho
# Code written for the v3 memory API runs on Recall as it is. This file makes the usual calls with
# Recall's own SDK, then the calls Recall adds. Run by sdks/python/tests/test_guides.py against a
# real server.
from __future__ import annotations

from typing import Any

from recall_memory import Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="my-app")
    # region same
    # The same objects and calls as before: peers, sessions, messages, context and chat.
    alice = recall.peer("alice")
    assistant = recall.peer("assistant")
    session = recall.session("support-42")
    session.add_peers([alice, assistant])
    session.add_messages(
        [
            alice.message("We moved from London to New York last week."),
            assistant.message("Congratulations on the move!"),
        ]
    )
    context = session.context(tokens=2000, peer_target=alice)
    messages = context.to_openai(assistant=assistant)
    recall.wait_for_idle()  # for this demo only: real apps do not wait for learning
    city = alice.chat("Where does alice live now?", reasoning_level="low")
    hits = alice.search("New York")
    # endregion

    # region extras
    # What Recall adds. An answer with its sources, a confidence and an honest "I don't know".
    answer = alice.chat("Where does alice live now?", include_evidence=True)
    reply = "I'm not sure yet." if answer.abstained else answer.content
    sources = answer.citations
    # One request that stores a message and returns the context for the reply.
    result = session.turn(
        [alice.message("Any good cafés near me?")], peer_target=alice, tokens=2000
    )
    # Forget a person: her messages, the facts about her and her peer cards.
    erased = alice.delete()
    # endregion
    return {
        "messages": messages,
        "city": city,
        "hits": hits,
        "reply": reply,
        "sources": sources,
        "next": result.context.to_openai(assistant=assistant),
        "erased": erased,
    }
