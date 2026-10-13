# Guide: https://recallmem.dev/guides/voice-agents
# A phone support agent: the caller's id is a keyed hash of their number, memory is read while the
# call connects, each utterance is one fast request and anything slow waits for the hang-up.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

import hashlib
import hmac
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="support-line")
    # region setup
    # Ids show up in URLs, logs and exports, so never use the raw number. A plain hash of a phone
    # number is easy to reverse; a keyed hash is not, without the key from your secret store.
    secret = os.environ.get("CALLER_ID_SECRET", "local-dev-only").encode()

    def caller_id(phone: str) -> str:
        return "caller-" + hmac.new(secret, phone.encode(), hashlib.sha256).hexdigest()[:32]

    # Once, at startup: Recall reads the agent's lines but learns nothing from them, and keeps a
    # running summary of each call every 10 messages (the default is 20).
    agent = recall.peer("voice-agent", configuration=PeerConfig(observe_me=False))
    recall.set_configuration({"summary": {"messages_per_short_summary": 10}})

    # Per call: the caller, and a session named after your telephony provider's call id.
    # Handles make no request; the first utterance creates the session.
    caller = recall.peer(caller_id("+447700900123"))  # or your account id, once verified
    call = recall.session("call-7f3e9a2c")
    # endregion

    # region before-call
    # The call is connecting: read what Recall knows about the caller while your greeting plays,
    # so the first reply needs no lookup. One request; a new caller just has no memory yet.
    start = call.context(peer_target=caller, tokens=1500)
    system = start.to_openai(assistant=agent)  # peer card and known facts, as system messages
    # endregion

    # region turn
    # Each finished utterance (the final transcript from speech-to-text): one request that stores
    # it with the agent's previous line and returns fresh context. Start it next to your model
    # call, not before it: the model already has `system` and the call so far. (In an asyncio
    # voice stack, use AsyncRecall and asyncio.create_task instead of a thread.)
    greeting = "Thanks for calling. How can I help?"
    heard = "Hi, it's me again. The internet keeps dropping out in the evenings."
    with ThreadPoolExecutor(max_workers=1) as pool:
        stored = pool.submit(
            call.turn,
            [agent.message(greeting), caller.message(heard)],
            peer_target=caller,
            tokens=1500,
        )
        # Your voice model replies now, from `system`, the call so far and `heard`.
        reply = "Sorry about that. Is it the router we replaced in August?"
        context = stored.result().context  # for the next utterance; older turns become a summary
    # endregion

    # region after-call
    # Hang-up: store the agent's last line. Anything slow happens now, off the call.
    call.add_messages([agent.message(reply)])
    # (wait_for_idle is for this demo; in production the queue.empty webhook says when to read.)
    recall.wait_for_idle()
    # Recall's running summary of the call (every 10 messages, as set at startup); a call as
    # short as this one has none yet.
    summary = call.summaries().short_summary
    # A question for your CRM or the next call: one model call of a few seconds, fine now.
    follow_up = caller.chat(
        "What have we promised this caller, and by when?", reasoning_level="low"
    )
    # endregion

    # region forget
    # A caller asks to be forgotten: derive the same id from their number, delete their calls
    # (the agent's lines quote them), then the caller.
    person = recall.peer(caller_id("+447700900123"))
    for s in list(person.sessions()):
        s.delete()
    removed = person.delete()
    # endregion
    return {
        "system": system,
        "context": context,
        "summary": summary.content if summary else None,
        "follow_up": follow_up,
        "removed": removed,
    }
