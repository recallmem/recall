from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

# No telemetry or trace upload from the tests (set before CrewAI is imported).
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_STORAGE_DIR", "crewai-recall-tests")

import pytest
from crewai.llms.base_llm import BaseLLM
from pydantic import Field
from recall_memory import AsyncRecall, Recall

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from recall_test_server import _no_recall_env, recall_url, workspace_id  # noqa: F401


@pytest.fixture
def recall(recall_url: str, workspace_id: str) -> Iterator[Recall]:  # noqa: F811
    with Recall(base_url=recall_url, workspace_id=workspace_id) as client:
        yield client


@pytest.fixture
async def arecall(recall_url: str, workspace_id: str) -> AsyncIterator[AsyncRecall]:  # noqa: F811
    async with AsyncRecall(base_url=recall_url, workspace_id=workspace_id) as client:
        yield client


class ScriptedLLM(BaseLLM):
    """An LLM that answers from a script (ReAct text) and keeps every prompt it was given."""

    model: str = "scripted"
    responses: list[str] = Field(default_factory=list)
    prompts: list[Any] = Field(default_factory=list)

    def call(self, messages: Any, *args: Any, **kwargs: Any) -> str:
        self.prompts.append(messages)
        return self.responses.pop(0)


def use_tool(name: str, arguments: str) -> str:
    return f"Thought: I should use a tool.\nAction: {name}\nAction Input: {arguments}"


def final(answer: str) -> str:
    return f"Thought: I now know the final answer\nFinal Answer: {answer}"
