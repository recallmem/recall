"""Retries, backoff, idempotency and error mapping."""

from __future__ import annotations

import httpx
import pytest

import recall_memory as pm
from conftest import Router, make_async_client, make_client, message_json, session_json
from recall_memory import (
    APIError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    RecallConnectionError,
    RecallError,
    RecallTimeoutError,
    ServerError,
    UnprocessableEntityError,
)

STATUS = "/v3/workspaces/ws/queue/status"
MESSAGES = "/v3/workspaces/ws/sessions/s1/messages"


class Script:
    """Answer successive requests from a list of responses/exceptions."""

    def __init__(self, *steps):
        self.steps = list(steps)
        self.calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        if isinstance(step, Exception):
            raise step
        return step


def with_script(router: Router, path: str, *steps, method: str = "GET") -> Script:
    script = Script(*steps)
    router.on(method, path, handler=script)
    return script


def r(status: int, body=None, **headers) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


# ---- error mapping -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "cls"),
    [
        (400, BadRequestError),
        (401, AuthenticationError),
        (403, PermissionDeniedError),
        (404, NotFoundError),
        (409, ConflictError),
        (422, UnprocessableEntityError),
        (429, RateLimitError),
        (500, ServerError),
        (503, ServerError),
        (418, APIError),
    ],
)
def test_status_maps_to_class(router: Router, status: int, cls):
    client = make_client(router, max_retries=0)
    router.on("GET", STATUS, {"detail": "boom"}, status=status)
    with pytest.raises(cls) as info:
        client.queue_status()
    assert type(info.value) is cls
    assert info.value.status == status and info.value.message == "boom"
    assert isinstance(info.value, (APIError, RecallError))
    assert info.value.body == {"detail": "boom"}


def test_message_extraction_order(router: Router):
    client = make_client(router, max_retries=0)
    for body, expected in [
        ({"detail": "d", "message": "m"}, "d"),
        ({"message": "m", "error": "e"}, "m"),
        ({"error": "e"}, "e"),
        ({"other": 1}, "{'other': 1}"),
    ]:
        router._routes.clear()
        router.on("GET", STATUS, body, status=400)
        with pytest.raises(BadRequestError) as info:
            client.queue_status()
        assert info.value.message == expected


def test_empty_and_non_json_bodies(router: Router):
    client = make_client(router, max_retries=0)
    router.on("GET", STATUS, content=b"", status=400)
    with pytest.raises(BadRequestError, match="HTTP 400"):
        client.queue_status()
    router._routes.clear()
    router.on("GET", STATUS, content=b"upstream exploded", status=502)
    with pytest.raises(ServerError, match="upstream exploded"):
        client.queue_status()


def test_validation_error_list_is_readable(router: Router):
    client = make_client(router, max_retries=0)
    detail = [{"type": "missing", "loc": ["body", "query"], "msg": "Field required", "input": {}}]
    router.on("GET", STATUS, {"detail": detail}, status=422)
    with pytest.raises(UnprocessableEntityError) as info:
        client.queue_status()
    assert "body.query: Field required" in info.value.message
    assert info.value.body["detail"] == detail


def test_request_id_and_retry_after_on_errors(router: Router):
    client = make_client(router, max_retries=0)
    router.on(
        "GET",
        STATUS,
        {"detail": "slow down"},
        status=429,
        headers={"Retry-After": "7", "X-Request-Id": "req_1"},
    )
    with pytest.raises(RateLimitError) as info:
        client.queue_status()
    assert info.value.retry_after == 7.0
    assert info.value.request_id == "req_1"
    assert "req_1" in str(info.value)


def test_short_error_names():
    assert pm.TimeoutError is RecallTimeoutError
    assert pm.ConnectionError is RecallConnectionError
    assert "TimeoutError" not in pm.__all__ and "ConnectionError" not in pm.__all__
    assert issubclass(NotFoundError, APIError)
    assert issubclass(RecallTimeoutError, RecallError)


# ---- retries -------------------------------------------------------------------------


def test_retries_5xx_then_succeeds_with_jittered_backoff(router: Router):
    client = make_client(router, max_retries=3)
    slept: list[float] = []
    client._core.sleep = slept.append
    client._core.random = lambda: 0.5
    script = with_script(
        router, STATUS, r(503, {"detail": "x"}), r(502), r(200, {"total_work_units": 4})
    )
    assert client.queue_status().total_work_units == 4
    assert script.calls == 3
    # full jitter: random() * min(cap, 0.5 * 2**attempt)
    assert slept == [0.5 * 0.5, 0.5 * 1.0]


def test_backoff_is_capped(router: Router):
    client = make_client(router, max_retries=10)
    client._core.random = lambda: 1.0
    assert client._core.backoff(0, None) == 0.5
    assert client._core.backoff(3, None) == 4.0
    assert client._core.backoff(9, None) == 8.0


def test_honours_retry_after_seconds_and_http_date(router: Router):
    client = make_client(router, max_retries=2)
    slept: list[float] = []
    client._core.sleep = slept.append
    with_script(router, STATUS, r(429, {"detail": "x"}, **{"Retry-After": "3"}), r(200, {}))
    client.queue_status()
    assert slept == [3.0]

    router._routes.clear()
    slept.clear()
    with_script(
        router, STATUS, r(503, None, **{"Retry-After": "Wed, 21 Oct 2099 07:28:00 GMT"}), r(200, {})
    )
    client.queue_status()
    assert slept == [60.0]  # capped


def test_gives_up_after_max_retries(router: Router):
    client = make_client(router, max_retries=2)
    script = with_script(router, STATUS, r(500, {"detail": "down"}))
    with pytest.raises(ServerError, match="down"):
        client.queue_status()
    assert script.calls == 3


def test_max_retries_zero_never_retries(router: Router):
    client = make_client(router, max_retries=0)
    script = with_script(router, STATUS, r(503))
    with pytest.raises(ServerError):
        client.queue_status()
    assert script.calls == 1


def test_non_retryable_statuses_raise_at_once(router: Router):
    client = make_client(router)
    script = with_script(router, STATUS, r(404, {"detail": "no"}), r(200, {}))
    with pytest.raises(NotFoundError):
        client.queue_status()
    assert script.calls == 1


def test_timeout_and_connection_errors(router: Router):
    client = make_client(router, max_retries=1)
    script = with_script(router, STATUS, httpx.ReadTimeout("slow"))
    with pytest.raises(RecallTimeoutError):
        client.queue_status()
    assert script.calls == 2
    router._routes.clear()
    script = with_script(
        router, STATUS, httpx.ConnectError("refused"), r(200, {"total_work_units": 1})
    )
    assert client.queue_status().total_work_units == 1
    router._routes.clear()
    script = with_script(router, STATUS, httpx.ConnectError("refused"))
    with pytest.raises(RecallConnectionError):
        client.queue_status()


def test_retried_message_create_reuses_the_idempotency_key(router: Router):
    client = make_client(router, max_retries=2)
    keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers["idempotency-key"])
        if len(keys) < 3:
            return httpx.Response(504)
        return httpx.Response(201, json=[message_json()])

    router.on("POST", MESSAGES, handler=handler)
    out = client.session("s1").add_messages([client.peer("alice").message("hi")])
    assert len(out) == 1
    assert len(keys) == 3 and len(set(keys)) == 1


def test_unsafe_writes_only_retry_when_provably_unapplied(router: Router):
    client = make_client(router, max_retries=3)
    path = "/v3/workspaces/ws/conclusions"
    body = [{"content": "x"}]
    view = client.peer("alice").conclusions_of("bob")

    # 500/502/504 and read timeouts could mean "applied": never replay
    for response in (r(500), r(502), r(504)):
        router._routes.clear()
        script = with_script(router, path, response, method="POST")
        with pytest.raises(ServerError):
            view.create(body)
        assert script.calls == 1
    router._routes.clear()
    script = with_script(router, path, httpx.ReadTimeout("slow"), method="POST")
    with pytest.raises(RecallTimeoutError):
        view.create(body)
    assert script.calls == 1

    # 429/503 and connect failures never reached the application: safe to replay
    from conftest import conclusion_json

    router._routes.clear()
    script = with_script(
        router,
        path,
        r(429),
        httpx.ConnectError("x"),
        r(503),
        r(201, [conclusion_json()]),
        method="POST",
    )
    assert len(view.create(body)) == 1
    assert script.calls == 4


def test_clone_is_unsafe_to_replay(router: Router):
    client = make_client(router, max_retries=3)
    script = with_script(
        router,
        "/v3/workspaces/ws/sessions/s1/clone",
        r(500),
        r(201, session_json("n")),
        method="POST",
    )
    with pytest.raises(ServerError):
        client.session("s1").clone()
    assert script.calls == 1


def test_delete_retried_after_lost_response_treats_404_as_done(router: Router):
    client = make_client(router, max_retries=2)
    script = with_script(
        router,
        "/v3/workspaces/ws/sessions/s1",
        httpx.ReadTimeout("lost"),
        r(404, {"detail": "gone"}),
        method="DELETE",
    )
    client.session("s1").delete()
    assert script.calls == 2
    # but a first-attempt 404 is a real error
    router._routes.clear()
    with_script(
        router, "/v3/workspaces/ws/sessions/s1", r(404, {"detail": "gone"}), method="DELETE"
    )
    with pytest.raises(NotFoundError):
        client.session("s1").delete()


# ---- async ---------------------------------------------------------------------------


async def test_async_retry_and_errors(router: Router):
    client = make_async_client(router, max_retries=2)
    slept: list[float] = []

    async def asleep(s: float) -> None:
        slept.append(s)

    client._core.asleep = asleep
    client._core.random = lambda: 1.0
    with_script(
        router,
        STATUS,
        r(503),
        r(429, None, **{"Retry-After": "2"}),
        r(200, {"total_work_units": 9}),
    )
    assert (await client.queue_status()).total_work_units == 9
    assert slept == [0.5, 2.0]
    router._routes.clear()
    router.on("GET", STATUS, {"detail": "nope"}, status=404)
    with pytest.raises(NotFoundError):
        await client.queue_status()


async def test_async_timeout_maps_to_recall_timeout(router: Router):
    client = make_async_client(router, max_retries=0)
    with_script(router, STATUS, httpx.ReadTimeout("slow"))
    with pytest.raises(RecallTimeoutError):
        await client.queue_status()


# ---- wait_for_idle -------------------------------------------------------------------


def test_wait_for_idle_uses_long_poll_and_flag(router: Router):
    client = make_client(router)
    router.on(
        "GET",
        STATUS,
        {"total_work_units": 3, "pending_work_units": 1, "completed_work_units": 2, "idle": True},
    )
    status = client.wait_for_idle(timeout=10)
    assert status.idle is True
    wait_ms = int(router.params()["wait_ms"][0])
    assert 9000 <= wait_ms <= 10000
    assert router.last.extensions["timeout"]["read"] > 10  # the HTTP timeout outlives the long-poll


def test_wait_for_idle_keeps_polling_until_flag_is_true(router: Router):
    client = make_client(router)
    script = with_script(
        router,
        STATUS,
        r(200, {"pending_work_units": 1, "idle": False}),
        r(200, {"in_progress_work_units": 1, "idle": False}),
        r(200, {"completed_work_units": 2, "idle": True}),
    )
    assert client.wait_for_idle(timeout=30).completed_work_units == 2
    assert script.calls == 3


def test_wait_for_idle_times_out(router: Router):
    client = make_client(router)
    with_script(router, STATUS, r(200, {"pending_work_units": 2, "idle": False}))
    with pytest.raises(RecallTimeoutError, match="2 pending"):
        client.wait_for_idle(timeout=0.01)


def test_wait_for_idle_without_idle_flag_falls_back_to_counts(router: Router):
    client = make_client(router)
    with_script(
        router,
        STATUS,
        r(200, {"pending_work_units": 0, "in_progress_work_units": 0, "completed_work_units": 5}),
    )
    assert client.wait_for_idle().completed_work_units == 5


def test_wait_for_idle_missing_workspace_is_idle(router: Router):
    client = make_client(router)
    router.on("GET", STATUS, {"detail": "Workspace not found"}, status=404)
    assert client.wait_for_idle().is_idle


def test_session_wait_for_idle_scopes_the_poll(router: Router):
    client = make_client(router)
    router.on("GET", STATUS, {"idle": True})
    client.session("s1").wait_for_idle(timeout=5, observer="alice")
    assert router.params()["session_id"] == ["s1"] and router.params()["observer_id"] == ["alice"]


async def test_async_wait_for_idle(router: Router):
    client = make_async_client(router)
    router.on("GET", STATUS, {"idle": True})
    assert (await client.wait_for_idle(timeout=5)).idle is True
