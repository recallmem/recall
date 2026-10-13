"""Recall as CrewAI tools: search, ask and remember, for one person."""

from __future__ import annotations

import json
from typing import Any

from crewai.tools import BaseTool, EnvVar
from pydantic import BaseModel, Field
from recall_memory import Recall, RecallError
from recall_memory.models import ReasoningLevel

from . import _memory
from ._memory import Client, async_client, default_client, sync_client


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _error(err: Exception) -> str:
    return _json({"error": str(err)})


def _env_vars() -> list[EnvVar]:
    return [
        EnvVar(
            name="RECALL_API_KEY",
            description="API key for Recall's hosted API (https://app.recallmem.dev/keys)",
            required=False,
        ),
        EnvVar(name="RECALL_WORKSPACE_ID", description="Recall workspace to use", required=False),
        EnvVar(
            name="RECALL_URL",
            description="URL of a Recall server you run yourself (default: the hosted API)",
            required=False,
        ),
    ]


class RecallSearchInput(BaseModel):
    query: str = Field(description="What to look for, e.g. 'dietary preferences'.")


class RecallAskInput(BaseModel):
    question: str = Field(description="The question, e.g. 'What did we decide about the trip?'")


class RecallRememberInput(BaseModel):
    facts: list[str] = Field(
        description="One short, self-contained fact per entry, e.g. 'Prefers window seats.'"
    )


class _RecallTool(BaseTool):
    user_id: str = Field(description="The Recall peer this tool reads and writes memory for.")
    client: Any = Field(default=None, exclude=True)
    env_vars: list[EnvVar] = Field(default_factory=_env_vars)

    def model_post_init(self, context: Any, /) -> None:
        self.client = default_client(self.client)
        super().model_post_init(context)


class RecallSearchTool(_RecallTool):
    """Searches long-term memory for facts about the user and messages they wrote."""

    name: str = "recall_search"
    description: str = (
        "Search long-term memory (Recall) for facts about the user and things they said that "
        "match a query. Fast; no model call. Returns JSON with 'facts' and 'messages'."
    )
    args_schema: type[BaseModel] = RecallSearchInput
    k: int = Field(default=8, description="Facts and messages to return (each).")

    def _run(self, query: str) -> str:
        try:
            return _json(_memory.search(sync_client(self.client), self.user_id, query, self.k))
        except RecallError as err:
            return _error(err)

    async def _arun(self, query: str) -> str:
        try:
            client = async_client(self.client)
            return _json(await _memory.asearch(client, self.user_id, query, self.k))
        except RecallError as err:
            return _error(err)


class RecallAskTool(_RecallTool):
    """Asks long-term memory a question and gets an answer grounded in earlier conversations."""

    name: str = "recall_ask"
    description: str = (
        "Ask long-term memory (Recall) a question about the user and get an answer grounded in "
        "earlier conversations. Takes a few seconds; use recall_search for simple lookups."
    )
    args_schema: type[BaseModel] = RecallAskInput
    reasoning_level: ReasoningLevel = Field(
        default="low", description="How hard Recall thinks: minimal, low, medium, high or max."
    )

    def _run(self, question: str) -> str:
        try:
            client = sync_client(self.client)
            return _memory.ask(client, self.user_id, question, self.reasoning_level)
        except RecallError as err:
            return _error(err)

    async def _arun(self, question: str) -> str:
        try:
            client = async_client(self.client)
            return await _memory.aask(client, self.user_id, question, self.reasoning_level)
        except RecallError as err:
            return _error(err)


class RecallRememberTool(_RecallTool):
    """Saves facts the user stated to long-term memory, searchable at once."""

    name: str = "recall_remember"
    description: str = (
        "Save facts the user stated outright to long-term memory (Recall), one short "
        "self-contained statement each, such as 'Prefers window seats.' Never save secrets."
    )
    args_schema: type[BaseModel] = RecallRememberInput

    def _run(self, facts: list[str]) -> str:
        try:
            saved = _memory.remember(sync_client(self.client), self.user_id, facts)
        except (RecallError, ValueError) as err:
            return _error(err)
        return _json({"saved": [_memory.fact_dict(c) for c in saved]})

    async def _arun(self, facts: list[str]) -> str:
        try:
            saved = await _memory.aremember(async_client(self.client), self.user_id, facts)
        except (RecallError, ValueError) as err:
            return _error(err)
        return _json({"saved": [_memory.fact_dict(c) for c in saved]})


def recall_tools(
    user_id: str,
    *,
    client: Client | None = None,
    k: int = 8,
    reasoning_level: ReasoningLevel = "low",
) -> list[BaseTool]:
    """``recall_search``, ``recall_ask`` and ``recall_remember`` for one person, sharing a client.

    Args:
        user_id: The Recall peer of the person the crew works for.
        client: A ``Recall`` client (serves both ``run`` and ``arun``) or an ``AsyncRecall``
            (``arun`` only). Defaults to ``Recall()``, configured from ``RECALL_*`` variables.
        k: Facts and messages ``recall_search`` returns (each).
        reasoning_level: How hard Recall thinks for ``recall_ask``.
    """
    shared = default_client(client)
    return [
        RecallSearchTool(user_id=user_id, client=shared, k=k),
        RecallAskTool(user_id=user_id, client=shared, reasoning_level=reasoning_level),
        RecallRememberTool(user_id=user_id, client=shared),
    ]


def recall_context(
    user_id: str,
    *,
    query: str | None = None,
    client: Client | None = None,
    max_conclusions: int = 20,
) -> str:
    """What Recall knows about a person, as text for a task or an agent's backstory.

    The peer card and the facts that relate to ``query`` (the most frequent ones without it).
    No model call; '' when Recall knows nothing about them yet. Typical use:
    ``crew.kickoff(inputs={"memory": recall_context("user-42", query=request)})`` with a
    ``{memory}`` placeholder in a task description.
    """
    if client is None:
        with Recall() as own:
            return _memory.context(own, user_id, query, max_conclusions)
    return _memory.context(sync_client(client), user_id, query, max_conclusions)
