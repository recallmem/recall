"""The guide's code (examples/guides/crewai.py, shown on recallmem.dev/guides/crewai) runs."""

from __future__ import annotations

import importlib.util
import json

import pytest
from recall_memory import NotFoundError, Recall
from recall_test_server import EXAMPLES

from conftest import ScriptedLLM, final, use_tool

pytestmark = pytest.mark.integration


def test_guide_example(recall: Recall) -> None:
    spec = importlib.util.spec_from_file_location("guide_crewai", EXAMPLES / "crewai.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    traveller = recall.peer("user-8412", metadata={})
    traveller.conclusions.create([{"content": "Prefers small hotels."}])
    llm = ScriptedLLM(
        model="scripted",
        responses=[
            use_tool("recall_remember", json.dumps({"facts": ["Is vegetarian."]})),
            final("Saturday: Alfama, a vegetarian lunch; Sunday: Belém. Afternoon flights."),
        ],
    )
    out = module.main(recall, llm)
    assert str(out["result"]).startswith("Saturday: Alfama")
    assert "Prefers small hotels." in out["memory"]
    assert "Prefers small hotels." in json.dumps(llm.prompts[0])
    with pytest.raises(NotFoundError):  # forgotten
        recall.peer("user-8412").get_metadata()
