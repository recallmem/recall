# Guide: https://recallmem.dev/guides/assistants
# A personal assistant that remembers one user across conversations: settings as facts, the
# peer card, one call per message, questions, and fixing a wrong fact. Run by
# sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="assistant-prod")
    # region setup
    # The user is a peer, keyed by your own stable user id (not their email address).
    user = recall.peer("user-8412", metadata={"locale": "nl-NL"})
    # You write the assistant's persona, so Recall should not learn from its replies.
    assistant = recall.peer("assistant", configuration=PeerConfig(observe_me=False))
    # One session per conversation. Memory of the user is shared across all of them.
    chat = recall.session("chat-20261010-a91f")
    # endregion

    # region settings
    # What the user entered in your app's settings is fact, not inference: store it as such.
    # It is searchable at once, without waiting for background learning.
    user.conclusions.create([{"content": "Is vegetarian."}, {"content": "Prefers short answers."}])
    # endregion

    # region card
    # The peer card: a short list of facts for every prompt. Recall writes and updates it as it
    # learns; you can add lines yourself, e.g. from onboarding. set_card replaces the whole card.
    card = user.get_card() or []
    user.set_card([*card, "Prefers to be called Sam.", "Vegetarian.", "Timezone Europe/Amsterdam."])
    # endregion

    # region turn
    # Every user message: one request stores it and returns the context for the reply: this
    # conversation so far, a summary of older turns, the card and what Recall knows about Sam.
    result = chat.turn(
        [user.message("My parents visit on Saturday. Can you plan a dinner for four?")],
        peer_target=user,
        tokens=3000,
    )
    messages = result.context.to_openai(assistant=assistant)  # or .to_anthropic_params(...)
    # Your model writes the reply from `messages`; store it so the conversation is complete.
    reply = "How about a mushroom risotto with a big salad? Here is a shopping list."
    chat.add_messages([assistant.message(reply)])
    # endregion

    # region ask
    # A question about the user, for a reminder or a suggestion outside the chat. One model call
    # of a few seconds. (wait_for_idle is for this demo; real apps rarely block on learning.)
    recall.wait_for_idle()
    answer = user.chat(
        "What should I keep in mind when suggesting a weekend plan?", reasoning_level="low"
    )
    # endregion

    # region correct
    # A "What I remember" page: list the facts and let the user delete a wrong or outdated one.
    # Deleting a fact does not edit the card, so remove it there too, and store the new value.
    facts = user.conclusions.list(size=50).items
    flagged = next((f for f in facts if "vegetarian" in f.content.lower()), None)
    if flagged:  # the one the user flagged
        user.conclusions.delete(flagged.id)
    current = user.get_card() or []
    user.set_card([line for line in current if "vegetarian" not in line.lower()])
    user.conclusions.create([{"content": "Eats fish, but no meat."}])
    # endregion

    # region forget
    # The user deletes their account: erase them (their messages, every fact and the card), then
    # their conversations, which still hold the assistant's replies to them.
    chats = list(user.sessions())
    user.delete()
    for c in chats:
        c.delete()
    # endregion
    return {"messages": messages, "answer": answer, "facts": facts}
