# Guide: https://recallmem.dev/guides/sales
# A sales copilot: contacts and reps as peers, a call transcript and an email thread with a
# file, account and deal scopes, and a structured meeting brief. Run by
# sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="crm-org-5531")
    # region setup
    # Contacts at the prospect are peers, keyed by your CRM contact ids.
    cfo = recall.peer("contact-2210", metadata={"title": "CFO"})
    it_lead = recall.peer("contact-2211", metadata={"title": "Head of IT"})
    # Recall learns about prospects, not about your reps.
    rep = recall.peer("rep-104", configuration=PeerConfig(observe_me=False))
    # One scope per account and one per deal: every call and thread about them.
    account = recall.scope("acct-381")
    deal = recall.scope("deal-7781", metadata={"stage": "evaluation"})
    # endregion

    # region call
    # A discovery call from your recorder's transcript: one message per turn, each dated with when
    # it was said, so "next quarter" is reckoned from the call, not from the upload.
    call = recall.session("call-90211", scopes=[account])
    start = datetime(2026, 10, 2, 14, 0, tzinfo=timezone.utc)

    def at(seconds: int) -> datetime:
        return start + timedelta(seconds=seconds)

    call.add_messages(
        [
            rep.message("Thanks for making time. What made you start looking?", created_at=at(0)),
            cfo.message(
                "Month-end close takes eight days. I want it under five by next quarter.",
                created_at=at(9),
            ),
            it_lead.message(
                "Whatever we pick must use our SSO. The last vendor failed our review.",
                created_at=at(31),
            ),
            cfo.message(
                "Budget is approved up to 40k a year. Above that it goes to the board.",
                created_at=at(88),
            ),
        ]
    )
    deal.add_sessions([call])
    # endregion

    # region email
    # An email thread is a session too. The requirements the Head of IT attached go in with
    # upload_file, as their words (PDF, text or JSON; long files become several messages).
    thread = recall.session("email-4410", scopes=[account, deal])
    sent = "2026-10-05T08:30:00Z"
    thread.add_messages(
        [
            it_lead.message(
                "Attached are our requirements. SSO and EU hosting are must-haves.",
                created_at=sent,
            )
        ]
    )
    requirements = b"Must: SAML single sign-on.\nMust: data stored in the EU.\nNice: ERP export."
    thread.upload_file(("requirements.txt", requirements, "text/plain"), it_lead, created_at=sent)
    # endregion

    # region brief
    # Before the next meeting: one question across the whole deal, answered as JSON your UI lays
    # out. Pass a Pydantic model (or a JSON Schema dict, which returns the JSON as a string).
    class Stakeholder(BaseModel):
        contact: str
        role: str
        cares_about: str

    class MeetingBrief(BaseModel):
        stakeholders: list[Stakeholder]
        objections: list[str]
        next_steps: list[str]
        open_questions: list[str]

    recall.wait_for_idle()  # for this demo; briefs are made later, when learning is done
    brief = recall.chat(
        "Prepare me for the next meeting on this deal: who is involved and what each cares about, "
        "their objections, the next steps we agreed and the questions still open.",
        scope=deal,
        reasoning_level="medium",
        response_format=MeetingBrief,
    )
    # endregion

    # region contact
    # A quick question about one person, from everything they said in any call or thread.
    cfo_needs = cfo.chat(
        "What does this contact need to see before signing?", reasoning_level="low"
    )
    # endregion

    # region forget
    # A contact asks you to delete their data: erase their words and everything learned about
    # them, in every call, thread and scope. Keep the result for your deletion log.
    removed = it_lead.delete()
    # endregion
    return {"brief": brief, "cfo_needs": cfo_needs, "removed": removed}
