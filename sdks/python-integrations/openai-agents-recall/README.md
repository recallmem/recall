# openai-agents-recall

[Recall](https://recallmem.dev) memory for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/).
Recall learns about the people your agent talks to from their conversations, and gives that back as context,
search results and answers.

## Install

```bash
pip install openai-agents-recall
```

Create an API key at <https://app.recallmem.dev/keys> and export it as `RECALL_API_KEY` (and `RECALL_WORKSPACE_ID`
to pick a workspace). Running your own server? Set `RECALL_URL=http://localhost:8000`.

## Quickstart

```python
from agents import Agent, Runner
from openai_agents_recall import RecallSession, recall_instructions, recall_tools

agent = Agent(
    name="Assistant",
    instructions=recall_instructions("You are a helpful assistant."),  # + what Recall knows
    tools=recall_tools(),  # recall_search, recall_ask, recall_remember
)
session = RecallSession("chat-1", user_id="user-42")  # the history, kept in Recall
result = await Runner.run(
    agent, "Plan my weekend.", session=session, context={"user_id": "user-42"}
)
```

The session loads the conversation before each run and stores the new items after it, and Recall learns from
the user's messages among them. The instructions add the user's peer card and their most relevant facts (no model
call, well under a second). The tools let the model look things up and save facts the user states. One agent can
serve many users: the tools and instructions read `user_id` from the run's context, or pass `user_id=` to them.

## What is in the package

| Import | Agents SDK interface | What it does |
|---|---|---|
| `RecallSession` | `Session` protocol | Conversation history in a Recall session: `get_items`, `add_items`, `pop_item`, `clear_session`. |
| `recall_tools()` | `FunctionTool`s | `recall_search` (facts and messages, no model call), `recall_ask` (an answer from memory, a few seconds), `recall_remember` (save facts, searchable at once). |
| `recall_instructions()` | Dynamic `instructions` | Your instructions plus what Recall knows about the user. |

`RecallSession` stores the user's messages as written by `user_id` (Recall learns from them) and the agent's as
written by `assistant_id` (read as context, not learned about). Tool calls, tool results and reasoning items are
kept for the history only, and every item comes back exactly as it was added. Messages other clients write to
the same Recall session are read back as user or assistant messages. `pop_item()` and `clear_session()` hide
items from the history; Recall keeps the messages and what it learned. Delete the Recall session to erase them.

Pass `client=Recall(...)` or `AsyncRecall(...)` from [`recall-mem`](https://pypi.org/project/recall-mem/) to any of
them; without one they use `Recall()`, configured from the environment.

## Docs

* Guide: <https://recallmem.dev/guides/openai-agents>
* Recall docs: <https://recallmem.dev/docs>

MIT licensed.
