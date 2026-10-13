from __future__ import annotations

import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from recall_memory import AsyncRecall, Recall
from recall_test_server import _no_recall_env, recall_url, workspace_id  # noqa: F401


@pytest.fixture
def recall(recall_url: str, workspace_id: str) -> Iterator[Recall]:  # noqa: F811
    with Recall(base_url=recall_url, workspace_id=workspace_id) as client:
        yield client


@pytest.fixture
async def arecall(recall_url: str, workspace_id: str) -> AsyncIterator[AsyncRecall]:  # noqa: F811
    async with AsyncRecall(base_url=recall_url, workspace_id=workspace_id) as client:
        yield client


class ScriptedChatModel(BaseChatModel):
    """A chat model that answers from a script and keeps every prompt it was given."""

    responses: list[AIMessage]
    prompts: list[list[BaseMessage]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(
        self, messages: list[BaseMessage], stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        self.prompts.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=self.responses.pop(0))])

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedChatModel:  # type: ignore[override]
        return self
