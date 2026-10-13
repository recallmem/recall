"""The guide's code (examples/guides/langchain.py, shown on recallmem.dev/guides/langchain) runs."""

from __future__ import annotations

import importlib.util

import pytest
from langchain_core.messages import AIMessage, SystemMessage
from recall_memory import NotFoundError, Recall
from recall_test_server import EXAMPLES

from conftest import ScriptedChatModel

pytestmark = pytest.mark.integration


def test_guide_example(recall: Recall) -> None:
    spec = importlib.util.spec_from_file_location("guide_langchain", EXAMPLES / "langchain.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = ScriptedChatModel(
        responses=[
            AIMessage(
                "",
                tool_calls=[
                    {"name": "recall_remember", "args": {"facts": ["Is vegetarian."]}, "id": "c1"}
                ],
            ),
            AIMessage("Day one: Alfama and a vegetarian lunch at the market."),
            AIMessage("Try a vegetarian tasca near Bolhão."),
        ]
    )
    out = module.main(recall, model)
    assert out["later"]["messages"][-1].text == "Try a vegetarian tasca near Bolhão."
    later_prompt = model.prompts[-1]
    system = next(m.text for m in later_prompt if isinstance(m, SystemMessage))
    assert "<memory>" in system and "vegetarian" in system.lower()
    assert "Is vegetarian." in [d.page_content for d in out["docs"]]
    with pytest.raises(NotFoundError):  # forgotten
        recall.peer("user-8412").get_metadata()
