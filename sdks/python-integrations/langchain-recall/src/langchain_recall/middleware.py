"""``RecallMiddleware``: long-term memory for agents built with LangChain's ``create_agent``.

Needs the ``langchain`` package (``pip install "langchain-recall[agents]"``).
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    ModelRequest,
    ModelResponse,
    PrivateStateAttr,
)
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage
from langgraph.channels.untracked_value import UntrackedValue
from langgraph.config import get_config
from langgraph.runtime import Runtime
from recall_memory import RecallError, SessionPeerConfig
from typing_extensions import NotRequired

from . import _memory
from ._memory import Client, async_client, context_value, default_client, safe_id, sync_client

logger = logging.getLogger("langchain_recall")

MAX_QUERY = 500
_KNOWN_SESSIONS_MAX = 10_000


class RecallState(AgentState[Any]):
    """Agent state with the memory fetched for this run (never checkpointed or returned)."""

    recall_memory: NotRequired[Annotated[str, UntrackedValue, PrivateStateAttr]]


def _last_exchange(messages: list[AnyMessage]) -> tuple[HumanMessage | None, AIMessage | None]:
    """The run's question (last human message) and its final answer (last AI text after it)."""
    human_at = next(
        (i for i in range(len(messages) - 1, -1, -1) if isinstance(messages[i], HumanMessage)),
        None,
    )
    if human_at is None:
        return None, None
    human = messages[human_at]
    assert isinstance(human, HumanMessage)
    answer = next(
        (
            m
            for m in reversed(messages[human_at + 1 :])
            if isinstance(m, AIMessage) and not m.tool_calls and m.text.strip()
        ),
        None,
    )
    return human, answer


def _with_memory(system: SystemMessage | None, memory: str) -> SystemMessage:
    block = (
        "<memory>\nWhat you remember about the user from earlier conversations "
        f"(it may be incomplete or out of date):\n{memory}\n</memory>"
    )
    if system is None:
        return SystemMessage(content=block)
    if isinstance(system.content, str):
        content = f"{system.content}\n\n{block}" if system.content else block
        return system.model_copy(update={"content": content})
    return system.model_copy(update={"content": [*system.content, {"type": "text", "text": block}]})


class RecallMiddleware(AgentMiddleware[RecallState, Any]):
    """Recalls what Recall knows about the user before each run and records the exchange after.

    Before the agent runs, it reads the user's peer card and the facts Recall learned that
    relate to the new message (no model call; well under a second) and adds them to the system
    prompt. After the run it stores the user's message and the agent's final answer in a Recall
    session, so Recall keeps learning. Tool calls and their results are not recorded.

    Args:
        client: A ``Recall`` client (blocking and ``async`` runs) or an ``AsyncRecall`` (``async``
            runs only). Defaults to ``Recall()``, configured from ``RECALL_*`` variables.
        user_id: The Recall peer of the user. If unset, read from the run's context:
            ``agent.invoke(..., context={"user_id": "user-42"})`` (key set by ``user_id_key``).
        session_id: The Recall session to record into. If unset, the run's ``thread_id``
            (``config={"configurable": {"thread_id": ...}}``) is used.
        assistant_id: The Recall peer that writes the agent's answers (not learned about).
        recall: Add memory to the system prompt.
        record: Store each exchange in Recall.
        max_conclusions: Most facts to add to the prompt.

    Example:
        .. code-block:: python

            from langchain.agents import create_agent
            from langchain_recall import RecallMiddleware, RecallToolkit

            # `model`: your chat model
            agent = create_agent(
                model,
                tools=RecallToolkit(user_id="user-42").get_tools(),
                middleware=[RecallMiddleware(user_id="user-42")],
            )
            agent.invoke(
                {"messages": [{"role": "user", "content": "Plan my weekend"}]},
                {"configurable": {"thread_id": "chat-1"}},
            )

    If Recall cannot be reached the run goes on without memory, and a warning is logged.
    """

    state_schema = RecallState

    def __init__(
        self,
        client: Client | None = None,
        *,
        user_id: str | None = None,
        session_id: str | None = None,
        assistant_id: str = "assistant",
        recall: bool = True,
        record: bool = True,
        max_conclusions: int = 20,
        user_id_key: str = "user_id",
    ) -> None:
        super().__init__()
        self.client = default_client(client)
        self.user_id = user_id
        self.session_id = session_id
        self.assistant_id = assistant_id
        self.recall = recall
        self.record = record
        self.max_conclusions = max_conclusions
        self.user_id_key = user_id_key
        self.tools = []
        self._known_sessions: set[str] = set()

    # ---- who and where ------------------------------------------------------------------

    def _user(self, runtime: Runtime[Any]) -> str:
        if self.user_id:
            return self.user_id
        value = context_value(runtime.context, self.user_id_key)
        if not value:
            raise ValueError(
                "RecallMiddleware does not know the user: pass user_id=..., or invoke the agent "
                f"with context={{'{self.user_id_key}': ...}}"
            )
        return value

    def _session(self) -> str:
        if self.session_id:
            return self.session_id
        try:
            thread = get_config().get("configurable", {}).get("thread_id")
        except RuntimeError:
            thread = None
        if not thread:
            raise ValueError(
                "RecallMiddleware needs a session to record into: pass session_id=..., or invoke "
                "the agent with config={'configurable': {'thread_id': ...}}, or record=False"
            )
        return safe_id(str(thread))

    def _start(self, state: RecallState, runtime: Runtime[Any]) -> tuple[str, str | None] | None:
        """Checks the run has a user (and a session to record into) before it starts, and
        returns the user and the search query when memory is to be read."""
        if not (self.recall or self.record):
            return None
        user = self._user(runtime)
        if self.record:
            self._session()  # fail before the run, not after it
        if not self.recall:
            return None
        human, _ = _last_exchange(state["messages"])
        query = human.text.strip()[:MAX_QUERY] if human is not None else None
        return user, query

    def _members(self) -> dict[str, Any]:
        return {self.assistant_id: SessionPeerConfig(observe_me=False)}

    def _batch(
        self, state: RecallState, runtime: Runtime[Any]
    ) -> tuple[str, list[dict[str, Any]], str] | None:
        human, answer = _last_exchange(state["messages"])
        if human is None or answer is None or not human.text.strip():
            return None
        user, session = self._user(runtime), self._session()
        messages = [
            {"peer_id": user, "content": human.text[:25_000]},
            {"peer_id": self.assistant_id, "content": answer.text[:25_000]},
        ]
        basis = "\x00".join([session, human.id or human.text, answer.id or answer.text])
        return session, messages, "lc-" + hashlib.sha256(basis.encode()).hexdigest()[:40]

    def _remember_session(self, session: str) -> None:
        if len(self._known_sessions) >= _KNOWN_SESSIONS_MAX:
            self._known_sessions.clear()
        self._known_sessions.add(session)

    # ---- blocking hooks -----------------------------------------------------------------

    def before_agent(self, state: RecallState, runtime: Runtime[Any]) -> dict[str, Any] | None:
        start = self._start(state, runtime)
        if start is None:
            return None
        user, query = start
        try:
            memory = _memory.context(sync_client(self.client), user, query, self.max_conclusions)
        except RecallError as err:
            logger.warning("Recall: could not read memory, going on without it: %s", err)
            return None
        return {"recall_memory": memory}

    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> Any:
        memory = request.state.get("recall_memory")
        if isinstance(memory, str) and memory:
            request = request.override(system_message=_with_memory(request.system_message, memory))
        return handler(request)

    def after_agent(self, state: RecallState, runtime: Runtime[Any]) -> dict[str, Any] | None:
        if not self.record:
            return None
        batch = self._batch(state, runtime)
        if batch is None:
            return None
        session_id, messages, key = batch
        client = sync_client(self.client)
        try:
            if session_id in self._known_sessions:
                session = client.session(session_id)
            else:
                session = client.session(session_id, peers=self._members())
                self._remember_session(session_id)
            session.add_messages(messages, idempotency_key=key)
        except RecallError as err:
            logger.warning("Recall: could not record the exchange: %s", err)
        return None

    # ---- async hooks --------------------------------------------------------------------

    async def abefore_agent(
        self, state: RecallState, runtime: Runtime[Any]
    ) -> dict[str, Any] | None:
        start = self._start(state, runtime)
        if start is None:
            return None
        user, query = start
        try:
            memory = await _memory.acontext(
                async_client(self.client), user, query, self.max_conclusions
            )
        except RecallError as err:
            logger.warning("Recall: could not read memory, going on without it: %s", err)
            return None
        return {"recall_memory": memory}

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> Any:
        memory = request.state.get("recall_memory")
        if isinstance(memory, str) and memory:
            request = request.override(system_message=_with_memory(request.system_message, memory))
        return await handler(request)

    async def aafter_agent(
        self, state: RecallState, runtime: Runtime[Any]
    ) -> dict[str, Any] | None:
        if not self.record:
            return None
        batch = self._batch(state, runtime)
        if batch is None:
            return None
        session_id, messages, key = batch
        client = async_client(self.client)
        try:
            if session_id in self._known_sessions:
                session = await client.session(session_id)
            else:
                session = await client.session(session_id, peers=self._members())
                self._remember_session(session_id)
            await session.add_messages(messages, idempotency_key=key)
        except RecallError as err:
            logger.warning("Recall: could not record the exchange: %s", err)
        return None
