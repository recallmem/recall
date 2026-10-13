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


def test_examples_exist() -> None:
    assert FILES


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_guide_example(path: Path, server_url: str) -> None:  # noqa: F811
    spec = importlib.util.spec_from_file_location(f"guide_{path.stem.replace('-', '_')}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    workspace = f"guide-{path.stem}-{uuid.uuid4().hex[:8]}"
    with Recall(base_url=server_url, workspace_id=workspace) as recall:
        assert module.main(recall) is not None
