# Guide: https://recallmem.dev/guides/shopping
# A shopping assistant: account data as facts, preferences learned in chat, a return that
# updates what is known, preferences as catalogue filters, and opting out. Run by
# sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="shop-eu")
    # region setup
    # The shopper is a peer keyed by your customer id; the assistant is a peer Recall does not
    # learn about.
    shopper = recall.peer("cust-1042", metadata={"country": "NL"})
    assistant = recall.peer("shop-assistant", configuration=PeerConfig(observe_me=False))
    # Once, for the whole shop: what Recall should learn here, and what it must not.
    recall.set_configuration(
        {
            "reasoning": {
                "custom_instructions": (
                    "Record sizes and fit per brand, budgets, colours, styles, brands, diets the "
                    "shopper states, and returns with their reasons. Never record or guess health, "
                    "pregnancy, religion, ethnicity, sexuality or money trouble from purchases or "
                    "messages."
                )
            }
        }
    )
    # endregion

    # region account
    # What the shopper entered in their account is fact, not inference: store it as facts.
    shopper.conclusions.create([{"content": "Shoe size EU 42."}, {"content": "Eats vegan."}])
    # endregion

    # region return
    # A return from an earlier order, in the shopper's words from the returns form, dated when
    # it was filed. Recall learns from it like any message, and can close facts it contradicts.
    order = recall.session("order-77120")
    order.add_messages(
        [
            shopper.message(
                "Returning the Trailblaze GTX in 42: too small. I need a 43 in this brand.",
                created_at="2026-10-08T17:20:00Z",
                metadata={"order": "77120", "sku": "TB-GTX-42", "reason": "too_small"},
            )
        ]
    )
    # endregion

    # region chat
    # In the shop's chat: one request stores the message and returns what Recall knows about
    # the shopper for the reply. Preferences stated here are learned in the background.
    visit = recall.session("chat-5e21c")
    result = visit.turn(
        [shopper.message("Trail shoes for muddy autumn runs, please. Nothing neon, max €150.")],
        peer_target=shopper,
        tokens=2000,
    )
    prompt = result.context.to_openai(assistant=assistant)
    # Your model writes the reply from `prompt` and your catalogue; store it too.
    reply = "The Trailblaze GTX in black grips well in mud, €139. In 43 this time?"
    visit.add_messages([assistant.message(reply)])
    # endregion

    # region filters
    # Turn memory into filters for your catalogue: ask for JSON once per visit and keep it in your
    # session. (wait_for_idle is for this demo; real apps rarely block on learning.)
    recall.wait_for_idle()

    class Filters(BaseModel):
        shoe_size_eu: float | None
        max_price_eur: float | None
        avoid_colours: list[str]
        diet: list[str]

    prefs = shopper.chat(
        "Which filters should a product search use for this shopper?",
        reasoning_level="low",
        response_format=Filters,
    )
    catalogue = [
        {"sku": "TB-GTX-43", "size": 43, "price": 139, "colour": "black"},
        {"sku": "VX-9-43", "size": 43, "price": 165, "colour": "neon green"},
    ]
    picks = [
        p
        for p in catalogue
        if prefs is None
        or (
            (not prefs.max_price_eur or p["price"] <= prefs.max_price_eur)
            and not any(c in p["colour"] for c in prefs.avoid_colours)
        )
    ]
    # endregion

    # region opt-out
    # The shopper turns personalisation off: stop learning from their messages and drop every
    # fact memory holds about them. Their chats stay stored.
    # (To erase the shopper completely instead: shopper.delete())
    shopper.set_configuration(PeerConfig(observe_me=False))
    learned = list(shopper.conclusions.list())
    for fact in learned:
        shopper.conclusions.delete(fact.id)
    shopper.set_card([])
    # endregion
    return {"prompt": prompt, "prefs": prefs, "picks": picks, "forgotten": len(learned)}
