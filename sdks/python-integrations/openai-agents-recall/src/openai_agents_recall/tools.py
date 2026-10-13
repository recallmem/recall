"""Recall as Agents SDK function tools, and instructions that carry what Recall knows."""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from agents import Agent, FunctionTool, RunContextWrapper, function_tool
from recall_memory import RecallError
from recall_memory.models import ReasoningLevel

from . import _memory
from ._memory import Client, async_client, resolve_user

logger = logging.getLogger("openai_agents_recall")

Instructions = Callable[[RunContextWrapper[Any], Agent[Any]], Awaitable[str]]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def recall_tools(
    *,
    user_id: str | None = None,
    client: Client | None = None,
    k: int = 8,
    reasoning_level: ReasoningLevel = "low",
    user_id_key: str = "user_id",
) -> list[FunctionTool]:
    """The Recall tools for one person: ``recall_search``, ``recall_ask`` and ``recall_remember``.

    Args:
        user_id: The Recall peer of the user. Leave it out when one agent serves many users:
            the tools then read ``user_id_key`` from the run's context
            (``Runner.run(agent, input, context={"user_id": ...})``, a mapping or an object).
        client: A ``Recall`` or ``AsyncRecall`` client. Defaults to ``Recall()``, configured
            from ``RECALL_*`` variables.
        k: Facts and messages ``recall_search`` returns (each).
        reasoning_level: How hard Recall thinks for ``recall_ask``.

    If Recall cannot be reached, the tools tell the model so (as JSON with an ``error``).
    """
    aio = async_client(client)

    async def recall_search(ctx: RunContextWrapper[Any], query: str) -> str:
        """Search long-term memory (Recall) for facts about the user and things they said that
        match a query. Fast; no model call. Returns JSON with 'facts' and 'messages'.

        Args:
            query: What to look for, e.g. 'dietary preferences'.
        """
        user = resolve_user(user_id, ctx.context, user_id_key)
        try:
            return _json(await _memory.search(aio, user, query, k))
        except RecallError as err:
            return _json({"error": str(err)})

    async def recall_ask(ctx: RunContextWrapper[Any], question: str) -> str:
        """Ask long-term memory (Recall) a question about the user and get an answer grounded in
        earlier conversations. Takes a few seconds; use recall_search for simple lookups.

        Args:
            question: The question, e.g. 'What did we decide about the trip?'
        """
        user = resolve_user(user_id, ctx.context, user_id_key)
        try:
            return await _memory.ask(aio, user, question, reasoning_level)
        except RecallError as err:
            return _json({"error": str(err)})

    async def recall_remember(ctx: RunContextWrapper[Any], facts: list[str]) -> str:
        """Save facts the user stated outright to long-term memory (Recall), one short
        self-contained statement each, such as 'Prefers window seats.' Never save secrets.

        Args:
            facts: One fact per entry.
        """
        user = resolve_user(user_id, ctx.context, user_id_key)
        try:
            saved = await _memory.remember(aio, user, facts)
        except (RecallError, ValueError) as err:
            return _json({"error": str(err)})
        return _json({"saved": [_memory.fact_dict(c) for c in saved]})

    # failure_error_function=None: a missing user is a setup error and should fail the run.
    return [
        function_tool(recall_search, failure_error_function=None),
        function_tool(recall_ask, failure_error_function=None),
        function_tool(recall_remember, failure_error_function=None),
    ]


def recall_instructions(
    instructions: str,
    *,
    user_id: str | None = None,
    client: Client | None = None,
    max_conclusions: int = 20,
    user_id_key: str = "user_id",
) -> Instructions:
    """Dynamic instructions: ``instructions`` plus what Recall knows about the user.

    Pass the result as ``Agent(instructions=...)``. Before each model call it reads the user's
    peer card and their most relevant facts (no model call; well under a second) and appends
    them. If Recall knows nothing yet, or cannot be reached, the instructions are used as they
    are. ``user_id`` and ``user_id_key`` work as in ``recall_tools``.
    """
    aio = async_client(client)

    async def with_memory(ctx: RunContextWrapper[Any], agent: Agent[Any]) -> str:
        user = resolve_user(user_id, ctx.context, user_id_key)
        try:
            memory = await _memory.context(aio, user, max_conclusions)
        except RecallError as err:
            logger.warning("Recall: could not read memory, going on without it: %s", err)
            return instructions
        if not memory:
            return instructions
        return (
            f"{instructions}\n\n<memory>\nWhat you remember about the user from earlier "
            f"conversations (it may be incomplete or out of date):\n{memory}\n</memory>"
        )

    return with_memory
