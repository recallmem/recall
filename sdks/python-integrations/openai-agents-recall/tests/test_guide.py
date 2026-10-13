"""The guide's code (examples/guides/openai-agents.py, on recallmem.dev/guides/openai-agents) runs."""

from __future__ import annotations

import importlib.util
import json

import pytest
from recall_memory import NotFoundError, Recall
from recall_test_server import EXAMPLES

from conftest import ScriptedModel, call, say

pytestmark = pytest.mark.integration


def test_guide_example(recall: Recall) -> None:
    path = EXAMPLES / "openai-agents.py"
    spec = importlib.util.spec_from_file_location("guide_openai_agents", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = ScriptedModel(
        [
            [call("recall_remember", json.dumps({"facts": ["Is vegetarian."]}))],
            [say("A vegetarian lasagne for four.")],
            [say("A gluten-free vegetable gratin.", n=2)],
            [say("A chickpea salad: vegetarian and gluten-free.", n=3)],
        ]
    )
    out = module.main(recall, model)
    assert out["later"].final_output == "A chickpea salad: vegetarian and gluten-free."
    # The second run in the first conversation saw its history; the new conversation did not,
    # but its instructions carried what Recall knew.
    assert len(model.calls[2]["input"]) > 1
    assert model.calls[3]["input"] == [{"content": "Any ideas for lunch tomorrow?", "role": "user"}]
    assert "Is vegetarian." in model.calls[3]["instructions"]
    with pytest.raises(NotFoundError):  # forgotten
        recall.peer("user-8412").get_metadata()
