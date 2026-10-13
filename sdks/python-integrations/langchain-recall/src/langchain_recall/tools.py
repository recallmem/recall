"""Recall as LangChain tools: search, ask and remember, for one person."""

from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import BaseTool, BaseToolkit
from pydantic import BaseModel, Field
from recall_memory import RecallError
from recall_memory.models import ReasoningLevel

from . import _memory
from ._memory import async_client, default_client, resolve_user, sync_client


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _error(err: Exception) -> str:
    return _json({"error": str(err)})


class SearchInput(BaseModel):
    query: str = Field(description="What to look for, e.g. 'dietary preferences'.")


class AskInput(BaseModel):
    question: str = Field(description="The question, e.g. 'What did we decide about the trip?'")


class RememberInput(BaseModel):
    facts: list[str] = Field(
        description="One short, self-contained fact per entry, e.g. 'Prefers window seats.'"
    )


class _RecallTool(BaseTool):
    user_id: str | None = None
    """The Recall peer to use. If unset, ``user_id_key`` of the LangGraph run's context."""
    user_id_key: str = "user_id"
    client: Any = Field(default=None, exclude=True)
    """A ``Recall`` or ``AsyncRecall`` client; ``Recall()`` from ``RECALL_*`` variables if unset."""

    def model_post_init(self, context: Any, /) -> None:
        self.client = default_client(self.client)

    def _user(self) -> str:
        return resolve_user(self.user_id, self.user_id_key)


class RecallSearchTool(_RecallTool):
    """Searches long-term memory for facts about the user and messages they wrote."""

    name: str = "recall_search"
    description: str = (
        "Search long-term memory (Recall) for facts about the user and things they said that "
        "match a query. Fast; no model call. Returns JSON with 'facts' and 'messages'."
    )
    args_schema: type[BaseModel] = SearchInput
    k: int = 8
    """Facts and messages to return (each)."""

    def _run(self, query: str) -> str:
        user = self._user()
        try:
            return _json(_memory.search(sync_client(self.client), user, query, self.k))
        except RecallError as err:
            return _error(err)

    async def _arun(self, query: str) -> str:
        user = self._user()
        try:
            return _json(await _memory.asearch(async_client(self.client), user, query, self.k))
        except RecallError as err:
            return _error(err)


class RecallAskTool(_RecallTool):
    """Asks long-term memory a question and gets an answer grounded in earlier conversations."""

    name: str = "recall_ask"
    description: str = (
        "Ask long-term memory (Recall) a question about the user and get an answer grounded in "
        "earlier conversations. Takes a few seconds; use recall_search for simple lookups."
    )
    args_schema: type[BaseModel] = AskInput
    reasoning_level: ReasoningLevel = "low"
    """How hard Recall thinks: ``minimal``, ``low``, ``medium``, ``high`` or ``max``."""

    def _run(self, question: str) -> str:
        user = self._user()
        try:
            return _memory.ask(sync_client(self.client), user, question, self.reasoning_level)
        except RecallError as err:
            return _error(err)

    async def _arun(self, question: str) -> str:
        user = self._user()
        try:
            client = async_client(self.client)
            return await _memory.aask(client, user, question, self.reasoning_level)
        except RecallError as err:
            return _error(err)


class RecallRememberTool(_RecallTool):
    """Saves facts the user stated to long-term memory, searchable at once."""

    name: str = "recall_remember"
    description: str = (
        "Save facts the user stated outright to long-term memory (Recall), one short "
        "self-contained statement each, such as 'Prefers window seats.' Never save secrets."
    )
    args_schema: type[BaseModel] = RememberInput

    def _run(self, facts: list[str]) -> str:
        user = self._user()
        try:
            saved = _memory.remember(sync_client(self.client), user, facts)
        except (RecallError, ValueError) as err:
            return _error(err)
        return _json({"saved": [_memory.fact_dict(c) for c in saved]})

    async def _arun(self, facts: list[str]) -> str:
        user = self._user()
        try:
            saved = await _memory.aremember(async_client(self.client), user, facts)
        except (RecallError, ValueError) as err:
            return _error(err)
        return _json({"saved": [_memory.fact_dict(c) for c in saved]})


class RecallToolkit(BaseToolkit):
    """The Recall tools for one person: ``recall_search``, ``recall_ask`` and ``recall_remember``.

    Give ``user_id`` for a single user. Leave it out when one agent serves many users: the tools
    then read the user from the run's context, ``agent.invoke(..., context={"user_id": ...})``.

    Example:
        .. code-block:: python

            from langchain_recall import RecallToolkit

            tools = RecallToolkit(user_id="user-42").get_tools()
    """

    user_id: str | None = None
    user_id_key: str = "user_id"
    client: Any = Field(default=None, exclude=True)
    k: int = 8
    reasoning_level: ReasoningLevel = "low"

    def model_post_init(self, context: Any, /) -> None:
        self.client = default_client(self.client)

    def get_tools(self) -> list[BaseTool]:
        common: dict[str, Any] = {
            "user_id": self.user_id,
            "user_id_key": self.user_id_key,
            "client": self.client,
        }
        return [
            RecallSearchTool(k=self.k, **common),
            RecallAskTool(reasoning_level=self.reasoning_level, **common),
            RecallRememberTool(**common),
        ]
