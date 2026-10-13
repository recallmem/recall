"""What gets published: the version the release workflow checks, and no other product's name."""

from __future__ import annotations

import re
from pathlib import Path

import crewai_recall

ROOT = Path(__file__).resolve().parent.parent


def test_version_matches_pyproject() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    assert match is not None and crewai_recall.__version__ == match.group(1)


def test_published_files_never_name_another_product() -> None:
    files = [p for p in (ROOT / "src").rglob("*.py")]
    files += [ROOT / "README.md", ROOT / "pyproject.toml", ROOT / "LICENSE"]
    assert len(files) > 5
    offenders = [p.name for p in files if re.search("honcho", p.read_text(encoding="utf-8"), re.I)]
    assert offenders == []
