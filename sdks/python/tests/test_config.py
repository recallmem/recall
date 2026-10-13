import pytest

from recall_memory import AsyncRecall, Recall
from recall_memory._config import DEFAULT_BASE_URL, URL_ENV


def test_defaults(monkeypatch):
    for name in URL_ENV:
        monkeypatch.delenv(name, raising=False)
    p = Recall()
    assert p.base_url == DEFAULT_BASE_URL == "https://api.recallmem.dev"
    assert p.workspace_id == "default"
    assert p._core.timeout == 60.0
    assert p._core.max_retries == 2
    assert p._core.api_key is None


def test_recall_env_is_read(monkeypatch):
    monkeypatch.setenv("RECALL_URL", "http://recall.example/")
    monkeypatch.setenv("RECALL_API_KEY", "par-key")
    monkeypatch.setenv("RECALL_WORKSPACE_ID", "par-ws")
    p = Recall()
    assert (p.base_url, p._core.api_key, p.workspace_id) == (
        "http://recall.example",
        "par-key",
        "par-ws",
    )


FOREIGN_ENV = {
    "HONCHO_URL": "http://other.example",
    "HONCHO_BASE_URL": "http://other-base.example",
    "HONCHO_API_KEY": "other-key",
    "HONCHO_WORKSPACE_ID": "other-ws",
}


def test_other_products_env_is_ignored(monkeypatch):
    """A key meant for another service must never be read, let alone sent to Recall."""
    for name, value in FOREIGN_ENV.items():
        monkeypatch.setenv(name, value)
    for cls in (Recall, AsyncRecall):
        client = cls()
        assert client.base_url == DEFAULT_BASE_URL == "https://api.recallmem.dev"
        assert client._core.api_key is None
        assert client.workspace_id == "default"
    # RECALL_* wins outright; nothing is merged in from the other names.
    monkeypatch.setenv("RECALL_API_KEY", "par-key")
    client = Recall()
    assert client._core.api_key == "par-key"
    assert client.base_url == DEFAULT_BASE_URL
    assert client.workspace_id == "default"


def test_other_products_env_never_reaches_a_request(router, monkeypatch):
    from conftest import make_client

    for name, value in FOREIGN_ENV.items():
        monkeypatch.setenv(name, value)
    router.on("GET", "/v3/workspaces/default/queue/status", {"total_work_units": 0})
    client = make_client(router, base_url=None, workspace_id=None)
    client.queue_status()
    req = router.last
    assert "authorization" not in req.headers
    assert req.url.host == "api.recallmem.dev"
    assert "other" not in str(req.url)
    assert not any("other" in value for value in req.headers.values())


def test_self_hosters_keep_their_overrides(monkeypatch):
    for name in URL_ENV:
        monkeypatch.delenv(name, raising=False)
    assert Recall(base_url="http://localhost:8000/").base_url == "http://localhost:8000"
    monkeypatch.setenv("RECALL_URL", "http://localhost:8000")
    assert Recall().base_url == "http://localhost:8000"
    monkeypatch.delenv("RECALL_URL")
    monkeypatch.setenv("RECALL_BASE_URL", "http://rb.example/")
    assert Recall().base_url == "http://rb.example"


def test_arguments_beat_environment(monkeypatch):
    monkeypatch.setenv("RECALL_URL", "http://env.example")
    monkeypatch.setenv("RECALL_API_KEY", "env-key")
    monkeypatch.setenv("RECALL_WORKSPACE_ID", "env-ws")
    p = Recall(api_key="k", base_url="http://arg.example", workspace_id="w")
    assert (p.base_url, p._core.api_key, p.workspace_id) == ("http://arg.example", "k", "w")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeout": 0},
        {"timeout": -1},
        {"max_retries": -1},
        {"workspace_id": ""},
    ],
)
def test_invalid_arguments(kwargs):
    with pytest.raises(ValueError):
        Recall(**kwargs)


def test_constructor_and_handles_do_no_io(router, client):
    peer = client.peer("alice")
    session = client.session("s1")
    scope_free = client.conclusions  # noqa: F841
    assert peer.id == "alice" and session.id == "s1"
    assert peer.metadata is None and session.metadata is None
    assert router.requests == []


def test_headers(router):
    from conftest import make_client

    router.on("GET", "/v3/workspaces/ws/queue/status", {"total_work_units": 0})
    c = make_client(
        router, api_key="secret", default_headers={"X-Team": "a"}, default_query={"v": "1"}
    )
    c.queue_status()
    req = router.last
    assert req.headers["authorization"] == "Bearer secret"
    assert req.headers["x-team"] == "a"
    assert req.headers["user-agent"].startswith("recall-memory-python/")
    assert req.url.params["v"] == "1"


def test_no_auth_header_without_key(router):
    from conftest import make_client

    router.on("GET", "/v3/workspaces/ws/queue/status", {})
    make_client(router).queue_status()
    assert "authorization" not in router.last.headers
