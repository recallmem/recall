# Guide: https://recallmem.dev/guides/levels-and-models
# The three ways to read memory, cheapest first: context, search, chat (at a level you choose).
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="my-app")
    # region setup
    user = recall.peer("user-8412")
    assistant = recall.peer("assistant", configuration=PeerConfig(observe_me=False))
    session = recall.session("chat-311", peers=[user, assistant])
    session.add_messages(
        [
            user.message("I moved from Leeds to Utrecht in March. I cycle to work most days."),
            assistant.message("Utrecht is a great city for cycling."),
            user.message("I'm allergic to peanuts, and I've started learning Dutch."),
        ]
    )
    recall.wait_for_idle()  # for this demo only: real apps do not wait for learning
    # endregion

    # region context
    # 1. Context: no model call, a few hundred milliseconds, included in the price.
    #    Use it to build every prompt.
    context = session.context(peer_target=user, tokens=3000, search_query="dinner")
    messages = context.to_openai(assistant=assistant)
    # endregion

    # region search
    # 2. Search: the stored messages that match, no model call. Use it to show sources or to
    #    let your own model read the raw text.
    hits = user.search("allergy", limit=5)
    # endregion

    # region chat
    # 3. Chat: an answer written from memory, one model call. Pick the level per question.
    city = user.chat("Where do I live now?", reasoning_level="minimal")
    plan = user.chat(
        "Suggest a weekend plan I'd enjoy, given what you know about me.",
        reasoning_level="medium",
    )
    # endregion

    # region evidence
    # With evidence: the facts and messages behind the answer, a confidence, and whether it
    # declined to answer. Show sources, or fall back when it abstains.
    answer = user.chat("Which foods must I avoid?", reasoning_level="low", include_evidence=True)
    safe = "Not sure: please check with the user." if answer.abstained else answer.content
    # endregion

    # region structured
    # Structured: a Pydantic model (or a JSON Schema) in, a parsed object out, for code.
    class Profile(BaseModel):
        allergies: list[str]
        languages: list[str]

    profile = user.chat(
        "Summarise this user's diet and languages.",
        reasoning_level="low",
        response_format=Profile,
    )
    # endregion
    return {
        "messages": messages,
        "hits": hits,
        "city": city,
        "plan": plan,
        "safe": safe,
        "profile": profile,
    }
