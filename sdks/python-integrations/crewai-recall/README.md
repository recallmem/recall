# crewai-recall

[Recall](https://recallmem.dev) memory for [CrewAI](https://www.crewai.com) agents. Recall learns about the people
your crew works for from their conversations, and gives that back as context, search results and answers.

## Install

```bash
pip install crewai-recall
```

Create an API key at <https://app.recallmem.dev/keys> and export it as `RECALL_API_KEY` (and `RECALL_WORKSPACE_ID`
to pick a workspace). Running your own server? Set `RECALL_URL=http://localhost:8000`.

## Quickstart

```python
from crewai import Agent, Crew, Task
from crewai_recall import recall_context, recall_tools

concierge = Agent(
    role="Travel concierge",
    goal="Plan trips the traveller will love",
    backstory="You remember what each traveller likes.",
    tools=recall_tools("user-42"),  # recall_search, recall_ask, recall_remember
)
plan = Task(
    description="{request}\n\nWhat you know about the traveller:\n{memory}",
    expected_output="A day-by-day plan",
    agent=concierge,
)
request = "Plan a weekend in Lisbon."
Crew(agents=[concierge], tasks=[plan]).kickoff(
    inputs={"request": request, "memory": recall_context("user-42", query=request)}
)
```

`recall_context()` reads the person's peer card and the facts that relate to the request (no model call, well
under a second), so the crew starts with what Recall knows. The tools let an agent look up more, ask a question
of memory and save facts the person states.

## What is in the package

| Import | CrewAI interface | What it does |
|---|---|---|
| `RecallSearchTool` | `BaseTool` (`recall_search`) | Facts about the person and messages they wrote that match a query. No model call. |
| `RecallAskTool` | `BaseTool` (`recall_ask`) | A question answered from memory (one Recall model call, a few seconds). |
| `RecallRememberTool` | `BaseTool` (`recall_remember`) | Saves facts the person stated; searchable at once. |
| `recall_tools(user_id)` | `list[BaseTool]` | The three tools, sharing one client. |
| `recall_context(user_id, query=...)` | `str` | What Recall knows about the person, for a task or a backstory. |

The tools work blocking (`run`) and, on CrewAI versions that run tools asynchronously, with `arun`. They take
`user_id` (the Recall peer) and an optional `client=Recall(...)` (or `AsyncRecall(...)`, async only) from
[`recall-mem`](https://pypi.org/project/recall-mem/), and declare
`RECALL_API_KEY`, `RECALL_WORKSPACE_ID` and `RECALL_URL` as their environment variables. If Recall cannot be
reached, a tool tells the agent so instead of failing the crew.

To have Recall learn from conversations, store them with the SDK, e.g. the request and the crew's answer:
`recall.session("trip-1").add_messages([user.message(request), crew_peer.message(str(result))])`. See the guide.

**CrewAI's own memory.** CrewAI's `Memory` takes a pluggable `StorageBackend`, but that interface is a vector
store: CrewAI computes the embeddings and the backend stores and searches vectors. Recall does its own learning
and search from text, so it is offered as tools and context rather than as a storage backend.

## Docs

* Guide: <https://recallmem.dev/guides/crewai>
* Recall docs: <https://recallmem.dev/docs>

MIT licensed.
