# Guide: https://recallmem.dev/guides/coaching
# A running coach that remembers a client's goals, setbacks and what worked: intake answers from a
# form, a check-in, a weekly review as JSON, a "what my coach remembers" page and deletion.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="coach-app")
    # region setup
    client = recall.peer("client-3087")
    # The coach is your app, so Recall learns about the client, not from the coach's own lines.
    coach = recall.peer("coach", configuration=PeerConfig(observe_me=False))
    # One session per check-in.
    checkin = recall.session("checkin-71204", peers=[client, coach])
    # endregion

    # region intake
    # What the client typed into your intake form is already a fact: write it directly. It is
    # searchable at once, with no model in between. Store only what coaching needs, with consent.
    client.conclusions.create(
        [
            {"content": "Goal: run a 10 km race in March."},
            {"content": "Trains on weekday mornings, before work."},
            {"content": "Knee injury last year; cleared to run by their physiotherapist."},
        ]
    )
    # endregion

    # region checkin
    # Each client message: store it and get back what the coach should know, in one request.
    result = checkin.turn(
        [client.message("Missed two runs this week, work was brutal. Did my Sunday 5 km though.")],
        peer_target=client,
        tokens=2000,
    )
    prompt = result.context.to_openai(assistant=coach)  # intake facts and past check-ins first
    # Your model writes the coach's reply from `prompt`; store it with the check-in.
    checkin.add_messages(
        [coach.message("Sunday counts. Shall we move Thursday's run to the morning too?")]
    )
    # endregion

    # region weekly-review
    # Once a week: a review as JSON that your app turns into next week's plan.
    # (wait_for_idle is for this demo; a weekly job runs long after learning has finished.)
    recall.wait_for_idle()

    class WeeklyReview(BaseModel):
        progress: list[str]
        setbacks: list[str]
        worked: list[str]
        focus: str

    review = client.chat(
        "Review this client's last week against their goals: progress, setbacks, what worked, "
        "and the one thing to focus on next week.",
        reasoning_level="low",
        response_format=WeeklyReview,
    )
    # endregion

    # region remembers
    # A "what my coach remembers" page for the client, served by your backend: these routes need a
    # workspace key. The list includes facts that have since changed, not only current ones.
    page = client.conclusions.list(size=50)
    remembered = [{"id": c.id, "fact": c.content, "learned": c.created_at} for c in page.items]
    # The client taps "forget" next to a fact:
    tapped = remembered[0]["id"]
    client.conclusions.delete(tapped)
    # endregion

    # region forget
    # The client deletes their account: their check-ins first (the coach's replies quote them),
    # then the client and everything learned about them.
    for s in list(client.sessions()):
        s.delete()
    removed = client.delete()
    # endregion
    return {"prompt": prompt, "review": review, "remembered": remembered, "removed": removed}
