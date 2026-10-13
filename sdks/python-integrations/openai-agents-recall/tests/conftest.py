from __future__ import annotations

import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from agents import set_tracing_disabled
from agents.items import ModelResponse
from agents.models.interface import Model
from agents.usage import Usage
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)
from recall_memory import AsyncRecall, Recall

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from recall_test_server import _no_recall_env, recall_url, workspace_id  # noqa: F401

set_tracing_disabled(True)  # no trace export: there is no OpenAI key in the tests


@pytest.fixture
def recall(recall_url: str, workspace_id: str) -> Iterator[Recall]:  # noqa: F811
    with Recall(base_url=recall_url, workspace_id=workspace_id) as client:
        yield client


@pytest.fixture
async def arecall(recall_url: str, workspace_id: str) -> AsyncIterator[AsyncRecall]:  # noqa: F811
    async with AsyncRecall(base_url=recall_url, workspace_id=workspace_id) as client:
        yield client


def say(text: str, n: int = 1) -> ResponseOutputMessage:
    return ResponseOutputMessage(
        id=f"msg_{n}",
        type="message",
        role="assistant",
        status="completed",
        content=[ResponseOutputText(type="output_text", text=text, annotations=[])],
    )


def call(name: str, arguments: str, n: int = 1) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(
        id=f"fc_{n}",
        call_id=f"call_{n}",
        type="function_call",
        name=name,
        arguments=arguments,
        status="completed",
    )


class ScriptedModel(Model):
    """A model that answers from a script and keeps the instructions and input of every call."""

    def __init__(self, turns: list[list[Any]]) -> None:
        self.turns = turns
        self.calls: list[dict[str, Any]] = []

    async def get_response(
        self, system_instructions: str | None, input: Any, *args: Any, **kwargs: Any
    ) -> ModelResponse:
        self.calls.append({"instructions": system_instructions, "input": input})
        return ModelResponse(output=self.turns.pop(0), usage=Usage(), response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError
