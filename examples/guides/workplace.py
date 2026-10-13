# Guide: https://recallmem.dev/guides/workplace
# A team assistant: meetings, threads and DMs as sessions, a scope per project, past material
# imported, and what happens when someone leaves.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="acme-corp")
    # region setup
    # People are peers keyed by their directory id, which outlives name and email changes.
    lead = recall.peer("emp-1042")
    designer = recall.peer("emp-2210")
    # The assistant's own replies teach Recall nothing about the team.
    assistant = recall.peer("team-assistant")
    assistant.set_configuration(PeerConfig(observe_me=False))

    # One session per meeting, thread or DM. Work on a project joins the project's scope.
    kickoff = recall.session(
        "meet-20261006-checkout", peers=[lead, designer, assistant], scopes=["proj-checkout"]
    )
    # Your notetaker or chat integration records what each person said.
    kickoff.add_messages(
        [
            lead.message("I own the pricing page. Annual plans get two months free: decided."),
            designer.message("Then I'll have the new checkout mockups ready by 20 October."),
        ]
    )
    # endregion

    # region import
    # Past material: an exported thread, oldest first, with the time each message was written,
    # so Recall dates what it learns. Over 100 messages go in ordered batches of 100.
    exported = [
        {"user": "emp-1042", "at": "2026-03-02T09:14:00Z", "text": "We drop PayPal in Q4."},
        {"user": "emp-2210", "at": "2026-03-02T09:20:00Z", "text": "Fine, it is 2% of orders."},
    ]
    thread = recall.session("slack-c04p2qk-1709370840", scopes=["proj-checkout"])
    thread.add_messages(
        [recall.peer(m["user"]).message(m["text"], created_at=m["at"]) for m in exported]
    )
    # Documents (PDF, JSON or any text format) become messages from the peer you name: here a
    # peer for the wiki, so they outlive the person who wrote them.
    wiki = recall.session("doc-checkout-decisions", scopes=["proj-checkout"])
    doc = "# Checkout decisions\n\n- PayPal goes in Q4.\n- Annual plans: two months free."
    wiki.upload_file(("checkout-decisions.md", doc.encode(), "text/markdown"), "wiki")
    # endregion

    # region ask
    # A question about the project, answered only from the sessions in its scope.
    # (wait_for_idle is for this demo; a real assistant does not block on learning.)
    recall.wait_for_idle()
    answer = recall.chat(
        "Who owns the pricing page, and what is decided on PayPal?",
        scope="proj-checkout",
        reasoning_level="low",
    )
    # Only what one person could have seen: search through their perspective (no answer is
    # generated; your model answers from the messages).
    seen = recall.search("PayPal", filters={"peer_perspective": designer.id}, limit=5)
    # endregion

    # region dm
    # A direct message: one session per person, with what is known about them in the context.
    dm = recall.session("dm-emp-2210", peers=[designer, assistant])
    text = "What did I promise for the checkout project?"
    result = dm.turn([designer.message(text)], peer_target=designer, search_query=text, tokens=2000)
    prompt = result.context.to_openai(assistant=assistant)  # your model replies from `prompt`
    # endregion

    # region leave
    # Someone leaves and is to be forgotten: their messages and every fact about them or from
    # their view go. Other people's messages, the wiki and facts that only mention them stay.
    removed = lead.delete()
    # endregion
    return {"answer": answer, "seen": seen, "prompt": prompt, "removed": removed}
