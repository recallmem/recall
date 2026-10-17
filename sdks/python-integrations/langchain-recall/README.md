# langchain-recall

[Recall](https://recallmem.dev) memory for LangChain and LangGraph agents. Recall learns about the people your
agent talks to from their conversations, and gives that back as context, search results and answers.

## Install

```bash
pip install "langchain-recall[agents]"    # without [agents] if you do not use create_agent
```

Create an API key at <https://app.recallmem.dev/keys> and export it as `RECALL_API_KEY` (and `RECALL_WORKSPACE_ID`
to pick a workspace). Running your own server? Set `RECALL_URL=http://localhost:8000`.

## Quickstart

```python
from langchain.agents import create_agent
from langchain_recall import RecallMiddleware, RecallToolkit

agent = create_agent(
    model,  # any LangChain chat model
    tools=RecallToolkit().get_tools(),  # recall_search, recall_ask, recall_remember
    middleware=[RecallMiddleware()],  # memory in the prompt, every exchange recorded
)
agent.invoke(
    {"messages": [{"role": "user", "content": "Plan my weekend, you know what I like."}]},
    {"configurable": {"thread_id": "chat-1"}},
    context={"user_id": "user-42"},
)
```

The middleware adds the user's peer card and the facts Recall learned that relate to the new message to the
system prompt (no model call, well under a second), then stores the user's message and the final answer in the
Recall session named after the thread. Tool calls and their results are not recorded. The user comes from the
run's context, `context={"user_id": ...}`, or pass `user_id=` to a component when there is one user.

## What is in the package

| Import | LangChain interface | What it does |
|---|---|---|
| `RecallMiddleware` | `AgentMiddleware` for `create_agent` (needs the `[agents]` extra) | Recalls before each run, records after it. |
| `RecallToolkit` | `BaseToolkit` | `RecallSearchTool`, `RecallAskTool`, `RecallRememberTool`. |
| `RecallSearchTool` | `BaseTool` (`recall_search`) | Facts about the user and messages they wrote that match a query. No model call. |
| `RecallAskTool` | `BaseTool` (`recall_ask`) | A question answered from memory (one Recall model call, a few seconds). |
| `RecallRememberTool` | `BaseTool` (`recall_remember`) | Saves facts the user stated; searchable at once. |
| `RecallRetriever` | `BaseRetriever` | Facts (`source="facts"`), messages (`"messages"`) or both, as `Document`s. |
| `RecallChatMessageHistory` | `BaseChatMessageHistory` | A chat history kept in a Recall session. |

Every component has blocking and `async` methods. Pass `client=Recall(...)` (serves both) or `AsyncRecall(...)`
(`async` only) from [`recall-mem`](https://pypi.org/project/recall-mem/); without one they use `Recall()`, configured
from the environment.

```python
from langchain_core.messages import AIMessage, HumanMessage
from langchain_recall import RecallChatMessageHistory, RecallRetriever

history = RecallChatMessageHistory("chat-1", user_id="user-42")
history.add_messages([HumanMessage("I moved to New York."), AIMessage("Welcome to New York!")])
docs = RecallRetriever(user_id="user-42", source="facts").invoke("where does the user live?")
```

`RecallChatMessageHistory` stores human messages as the user's (Recall learns from them) and AI messages as the
assistant's (read as context, not learned about). Tool and system messages are kept for the history only. Every
message comes back exactly as it was added. `clear()` hides the messages from the history; Recall keeps them and
what it learned. Delete the Recall session to erase them. LangChain marks `BaseChatMessageHistory` as deprecated
in favour of LangGraph persistence; for new agents use the middleware.

**LangGraph.** The tools and the retriever work in any graph node or `ToolNode`, and read the user from the
run's `context` when you leave `user_id` out. There is no Recall `BaseStore` or checkpointer: a store is a
key-value document store and a checkpointer saves graph state, and Recall is neither. It learns from
conversations. Keep your checkpointer for graph state and use Recall for what the agent should remember.

## Docs

* Guide: <https://recallmem.dev/guides/langchain>
* Recall docs: <https://recallmem.dev/docs>

MIT licensed.
