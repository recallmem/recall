"""A real Recall server for the integration packages' tests (not part of any package).

Each package's ``tests/conftest.py`` puts this directory on ``sys.path`` and imports the fixtures.
The server is ``npx tsx packages/server/src/main.ts`` with an in-memory database and the offline
mock model, on a free port, started once per test session. Tests that use it are skipped when
node/npx are not available. No real model is called and no key is needed.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import socket
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

REPO = Path(__file__).resolve().parents[2]
SERVER_DIR = REPO / "packages" / "server"
SERVER_MAIN = SERVER_DIR / "src" / "main.ts"
EXAMPLES = REPO / "examples" / "guides"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="session")
def recall_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    """Base URL of a Recall server that runs for the whole test session."""
    npx = shutil.which("npx")
    if npx is None or not SERVER_MAIN.exists():
        pytest.skip("node/npx or packages/server not available")
    port = _free_port()
    env = {
        k: v
        for k, v in os.environ.items()
        # never let a developer's real keys or database reach the test server
        if not k.endswith("_API_KEY") and not k.startswith(("RECALL_", "DATABASE_URL"))
    }
    env.update(
        RECALL_DATA_DIR="memory",
        RECALL_REASONER_MAX_DELAY_MS="0",
        RECALL_PORT=str(port),
        RECALL_HOST="127.0.0.1",
        RECALL_LOG_LEVEL="warn",
    )
    log_path = tmp_path_factory.mktemp("server") / "server.log"
    log = log_path.open("w")
    proc = subprocess.Popen(
        [npx, "tsx", str(SERVER_MAIN)],
        cwd=SERVER_DIR,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 120
    try:
        while True:
            if proc.poll() is not None:
                pytest.fail(f"server exited early ({proc.returncode}):\n{log_path.read_text()[-3000:]}")
            try:
                if httpx.get(f"{url}/health", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                pytest.fail(f"server did not start in time:\n{log_path.read_text()[-3000:]}")
            time.sleep(0.25)
        yield url
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
        log.close()


@pytest.fixture
def workspace_id() -> str:
    """A fresh workspace per test, so tests never see each other's memory."""
    return f"it-{uuid.uuid4().hex[:12]}"


@pytest.fixture(autouse=True)
def _no_recall_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clients in the tests are configured explicitly, never from the developer's environment."""
    for name in ("RECALL_URL", "RECALL_BASE_URL", "RECALL_API_KEY", "RECALL_WORKSPACE_ID", "RECALL_WORKSPACE"):
        monkeypatch.delenv(name, raising=False)
