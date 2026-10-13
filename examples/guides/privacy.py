# Guide: https://recallmem.dev/guides/privacy
# A team assistant for one business customer: opting a person out, giving them a copy of their
# data, forgetting one fact, forgetting the person, retention and closing the account.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from recall_memory import PeerConfig, Recall, SessionPeerConfig


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="cust-1042")
    # region setup
    sanne = recall.peer("user-8412")
    colleague = recall.peer("user-5120")
    assistant = recall.peer("assistant", configuration=PeerConfig(observe_me=False))
    standup = recall.session("chat-7731")
    standup.add_messages(
        [
            sanne.message("I prefer short answers, and I work on the billing team."),
            colleague.message("I am covering the billing queue this week while Sanne is away."),
            assistant.message("Got it. Billing questions go to you this week."),
        ]
    )
    # endregion

    # region opt-out
    # Someone who does not want to be modelled: their messages are still stored and shown in
    # context, but nothing is learned from them, by Recall or by any other peer. It applies to
    # new messages; facts already learned stay until you delete them.
    colleague.set_configuration(PeerConfig(observe_me=False))
    # Or for one conversation only, such as a call they did not agree to have analysed.
    call = recall.session(
        "call-2291", peers=[(sanne, SessionPeerConfig(observe_me=False)), assistant]
    )
    call.add_messages([sanne.message("Can you move my one-to-one to Friday?")])
    # endregion

    # region access
    # A person asks for a copy of their data: what they said, and what Recall concluded.
    # (wait_for_idle is for this demo; real apps rarely wait for learning to finish.)
    recall.wait_for_idle()
    said = []
    for session in sanne.sessions().to_list():
        said += session.messages(filters={"peer_id": sanne.id}).to_list()
    copy = {
        "said": said,
        "facts": sanne.conclusions.list().to_list(),
        "card": sanne.get_card(),
    }
    # endregion

    # region forget-fact
    # "Forget that I'm on the billing team." Show people what Recall holds about them (a settings
    # page works well) and delete what they pick.
    picked = next((f for f in copy["facts"] if "billing team" in f.content), None)
    if picked:
        sanne.conclusions.delete(picked.id)
    # The peer card is kept separately: write it back without that line.
    card = copy["card"] or []
    kept = [line for line in card if "billing team" not in line]
    if len(kept) < len(card):
        sanne.set_card(kept)
    # endregion

    # region forget-person
    # Erase the person: their messages and memberships, every fact and card about them or from
    # their point of view, the summaries that quoted them, and cached answers.
    erased = sanne.delete()
    # Other people's messages stay, and so do facts about other people that mention her.
    # Delete the ones that must go.
    for fact in colleague.conclusions.list().to_list():
        if "Sanne" in fact.content:
            colleague.conclusions.delete(fact.id)
    # To remove what others said in that conversation too, delete the whole session.
    standup.delete()
    # endregion

    # region retention
    # Your own retention rule, run daily: delete conversations older than 90 days. Their
    # messages, summaries and the facts learned in them go too.
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    for session in recall.sessions(filters={"created_at": {"lt": cutoff}}).to_list():
        session.delete()
    # endregion

    # region delete-workspace
    # The customer closes their account: delete every session first, then the workspace
    # (deleting a workspace that still has sessions answers 409).
    for session in recall.sessions().to_list():
        session.delete()
    recall.delete_workspace(recall.workspace_id)
    # endregion
    return {"copy": copy, "erased": erased}
