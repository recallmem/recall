"""Every Python sample in the guides (recallmem.dev/guides) runs here against the real server."""

from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
from test_integration import server_url  # noqa: F401  (the session-wide real server)

from recall_memory import Recall

EXAMPLES = Path(__file__).resolve().parents[3] / "examples" / "guides"
FILES = sorted(EXAMPLES.glob("*.py"))
# Framework guides (LangChain, OpenAI Agents SDK, CrewAI) run in their integration package's
# tests (sdks/python-integrations/*/tests/test_guide.py), with the framework and a scripted model.
FRAMEWORK_EXAMPLES = {"langchain", "openai-agents", "crewai"}


def test_examples_exist() -> None:
    assert FILES


def test_framework_examples_are_run_by_their_package() -> None:
    integrations = EXAMPLES.parents[1] / "sdks" / "python-integrations"
    for name in FRAMEWORK_EXAMPLES:
        assert (EXAMPLES / f"{name}.py").exists(), name
        runner = integrations / f"{name}-recall" / "tests" / "test_guide.py"
        assert f'"{name}.py"' in runner.read_text(encoding="utf-8"), runner


@pytest.mark.parametrize(
    "path", [p for p in FILES if p.stem not in FRAMEWORK_EXAMPLES], ids=lambda p: p.stem
)
def test_guide_example(path: Path, server_url: str) -> None:  # noqa: F811
    spec = importlib.util.spec_from_file_location(f"guide_{path.stem.replace('-', '_')}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    workspace = f"guide-{path.stem}-{uuid.uuid4().hex[:8]}"
    with Recall(base_url=server_url, workspace_id=workspace) as recall:
        assert module.main(recall) is not None
