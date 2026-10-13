# Guide: https://recallmem.dev/guides/tutoring
# A maths tutor that follows one learner across lessons: a structured learner model, a
# misconception that gets corrected, a teacher's search and the end-of-year deletion.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="school-2207-y2026")
    # region setup
    # A pseudonymous id from your own system: no name, email or class in Recall.
    learner = recall.peer("learner-5531")
    # The tutor is your app, so Recall learns about the learner, not from the tutor's own lines.
    tutor = recall.peer("tutor", configuration=PeerConfig(observe_me=False))

    # One session per lesson or homework session, filed under the course it belongs to.
    course = "course-math-7"
    lesson = recall.session("lesson-40817", peers=[learner, tutor], scopes=[course])
    # endregion

    # region lesson
    # Each learner message: store it and get back what the tutor should know, in one request.
    result = lesson.turn(
        [learner.message("1/8 is bigger than 1/4, right? Because 8 is bigger than 4.")],
        peer_target=learner,
        tokens=2000,
    )
    prompt = result.context.to_openai(assistant=tutor)  # the learner's memory, then the lesson
    # Your model writes the tutor's reply from `prompt`; store it so the lesson stays complete.
    lesson.add_messages(
        [tutor.message("One pizza cut into 8 slices, one cut into 4. Which slice is bigger?")]
    )
    # endregion

    # region learner-model
    # Before the next lesson: the learner model as JSON your app can show and act on.
    # (wait_for_idle is for this demo; by the next lesson, learning has long finished.)
    recall.wait_for_idle()

    class LearnerModel(BaseModel):
        mastered: list[str] = Field(description="Skills the learner has shown they can do")
        misconceptions: list[str] = Field(description="Mistakes the learner still makes")
        next_goal: str = Field(description="The one thing to practise next")

    model = learner.chat(
        "What has this learner mastered, what do they still get wrong, and what should come next?",
        scope=course,
        reasoning_level="low",
        response_format=LearnerModel,
    )
    # endregion

    # region corrected
    # Two weeks later, in homework, the learner has it right. Recall closes the old fact instead
    # of deleting it: context and the learner model show what holds now; chat can say what changed.
    homework = recall.session("homework-40822", peers=[learner, tutor], scopes=[course])
    homework.add_messages(
        [learner.message("Wait, 1/8 is smaller than 1/4. More slices means smaller slices.")]
    )
    recall.wait_for_idle()  # demo only, as above
    progress = learner.chat(
        "Which misconceptions has this learner corrected, and when?",
        scope=course,
        reasoning_level="low",
    )
    # endregion

    # region teacher
    # The teacher's view: the learner's own words about a topic, across every lesson, with the
    # session each came from. Search takes about a second and is included in the price.
    found = learner.search("fractions pizza slices", limit=20)
    excerpts = [{"lesson": m.session_id, "at": m.created_at, "said": m.content} for m in found]
    # endregion

    # region forget
    # A learner leaves: delete their sessions (the tutor's replies quote them), then the learner.
    for s in list(learner.sessions()):
        s.delete()
    learner.delete()
    # End of the school year: every session, then the workspace (refused while sessions remain).
    for s in list(recall.sessions()):
        s.delete()
    recall.delete_workspace(recall.workspace_id)
    # endregion
    return {"prompt": prompt, "model": model, "progress": progress, "excerpts": excerpts}
