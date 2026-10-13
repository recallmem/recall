"""The public API type-checks the way the docs promise (mypy strict, sync and async)."""

from pathlib import Path

import pytest

mypy_api = pytest.importorskip("mypy.api")


def test_public_types_hold():
    probe = Path(__file__).with_name("typing_probe.py")
    out, err, status = mypy_api.run(
        ["--strict", "--no-incremental", "--python-version", "3.10", str(probe)]
    )
    assert status == 0, out + err
