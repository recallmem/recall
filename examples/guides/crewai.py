# Guide: https://recallmem.dev/guides/crewai
# A CrewAI crew with Recall memory: what Recall knows goes into the task, the tools let agents
# look things up and save facts, and the request and answer are recorded so Recall keeps
# learning. Needs `pip install crewai-recall`. Run with a scripted LLM by
# sdks/python-integrations/crewai-recall/tests/test_guide.py against a real server.
from __future__ import annotations

from typing import Any

from crewai import Agent, Crew, Task
from crewai_recall import recall_context, recall_tools
from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None, llm: Any = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="travel-crew")
    # region setup
    # The crew works for one traveller per run: their id is the Recall peer. `llm` is your
    # CrewAI LLM; None uses CrewAI's default.
    traveller = "user-8412"
    concierge = Agent(
        role="Travel concierge",
        goal="Plan trips the traveller will love",
        backstory="You remember what each traveller likes and never ask twice.",
        tools=recall_tools(traveller, client=recall),
        llm=llm,
    )
    plan = Task(
        description="{request}\n\nWhat you know about the traveller:\n{memory}",
        expected_output="A day-by-day plan",
        agent=concierge,
    )
    crew = Crew(agents=[concierge], tasks=[plan])
    # endregion

    # region run
    # Memory goes in with the inputs: the card and the facts that relate to this request.
    request = "I'm vegetarian and I hate early flights. Plan a weekend in Lisbon."
    memory = recall_context(traveller, query=request, client=recall)
    result = crew.kickoff(inputs={"request": request, "memory": memory})
    # endregion

    # region record
    # Recall learns from conversations: store the request and the crew's answer. The crew is a
    # peer Recall does not learn about.
    person = recall.peer(traveller)
    crew_peer = recall.peer("travel-crew", configuration=PeerConfig(observe_me=False))
    recall.session("trip-lisbon").add_messages(
        [person.message(request), crew_peer.message(str(result))]
    )
    # endregion

    # region forget
    # The traveller deletes their account: erase them, then the trips that hold the answers.
    trips = list(person.sessions())
    person.delete()
    for trip in trips:
        trip.delete()
    # endregion
    return {"result": result, "memory": memory}
