import hashlib
import hmac
import json
from datetime import datetime, timezone

import pytest

from recall_memory import RecallError, construct_webhook_event, verify_webhook_signature

SECRET = "whsec_test"
BODY = json.dumps(
    {"data": {"workspace_id": "ws"}, "timestamp": "2026-01-01T12:00:00Z", "type": "test.event"},
    separators=(",", ":"),
    sort_keys=True,
)


def sign(body: str | bytes, secret: str = SECRET) -> str:
    raw = body.encode() if isinstance(body, str) else body
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def test_verifies_str_and_bytes_bodies():
    assert verify_webhook_signature(BODY, sign(BODY), SECRET)
    assert verify_webhook_signature(BODY.encode(), sign(BODY), SECRET)
    assert verify_webhook_signature(BODY, "sha256=" + sign(BODY).upper(), SECRET)


@pytest.mark.parametrize("sig", [None, "", "deadbeef", "0" * 64])
def test_rejects_bad_signatures(sig):
    assert not verify_webhook_signature(BODY, sig, SECRET)


def test_rejects_tampered_body_and_wrong_secret_and_empty_secret():
    assert not verify_webhook_signature(BODY + " ", sign(BODY), SECRET)
    assert not verify_webhook_signature(BODY, sign(BODY, "other"), SECRET)
    assert not verify_webhook_signature(BODY, sign(BODY, ""), "")


def test_construct_event():
    event = construct_webhook_event(BODY, sign(BODY), SECRET)
    assert (event.type, event.data) == ("test.event", {"workspace_id": "ws"})
    with pytest.raises(RecallError) as info:
        construct_webhook_event(BODY, "nope", SECRET)
    assert info.value.code == "invalid_signature"
    bad = "not json"
    with pytest.raises(RecallError) as info:
        construct_webhook_event(bad, sign(bad), SECRET)
    assert info.value.code == "invalid_body"


def test_replay_window():
    now = datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc)
    assert construct_webhook_event(BODY, sign(BODY), SECRET, tolerance_seconds=60, now=now)
    late = datetime(2026, 1, 1, 12, 10, tzinfo=timezone.utc)
    with pytest.raises(RecallError) as info:
        construct_webhook_event(BODY, sign(BODY), SECRET, tolerance_seconds=60, now=late)
    assert info.value.code == "stale_event"
