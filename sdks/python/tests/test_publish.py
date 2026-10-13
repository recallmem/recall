"""What gets published must not name another product."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile("honcho", re.IGNORECASE)


def _published_files() -> list[Path]:
    files = [
        path
        for path in (ROOT / "src").rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    ]
    files += [ROOT / "README.md", ROOT / "pyproject.toml", ROOT / "LICENSE"]
    return files


def test_source_readme_and_metadata_never_name_another_product():
    files = _published_files()
    assert len(files) > 10
    offenders = [
        str(path.relative_to(ROOT))
        for path in files
        if NAME.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_package_version_matches_pyproject():
    """The release workflow compares the tag with pyproject.toml; the module must agree."""
    import recall_memory

    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    assert match is not None
    assert recall_memory.__version__ == match.group(1)
