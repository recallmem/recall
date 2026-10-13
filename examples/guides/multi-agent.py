# Guide: https://recallmem.dev/guides/multi-agent
# A planner and a researcher share one workspace: each keeps its own view of the others, retries
# are safe, and a webhook wakes an agent when new knowledge is ready.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import Recall, SessionPeerConfig, construct_webhook_event


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="acme-agents")
    # region setup
    user = recall.peer("user-8412")
    planner = recall.peer("agent-planner")
    researcher = recall.peer("agent-researcher")

    # One session per job. Each agent in it builds its own view of the others from what it saw.
    # The job also joins the team's scope, the memory the whole team shares.
    job = recall.session(
        "job-58213",
        peers=[
            user,
            (planner, SessionPeerConfig(observe_others=True)),
            (researcher, SessionPeerConfig(observe_others=True)),
        ],
        scopes=["team-pricing"],
    )
    # endregion

    # region record
    # The orchestrator records each step under a key that names it. A retry after a crash or a
    # timeout returns the stored messages instead of storing them twice.
    def step(n: int) -> str:
        return f"job-58213:step-{n}"

    job.add_messages(
        [user.message("Compare our Pro plan with the three biggest competitors by Friday.")],
        idempotency_key=step(1),
    )
    findings = [
        researcher.message("Competitor A raised its Pro plan to €49 a month in September."),
        researcher.message("B and C still charge €39; C gives two months free on yearly plans."),
        planner.message("Next: draft a price proposal. Researcher, check annual discounts at A."),
    ]
    job.add_messages(findings, idempotency_key=step(2))
    job.add_messages(findings, idempotency_key=step(2))  # the retry: nothing is stored twice
    # endregion

    # region views
    # What does the planner know about the researcher's findings? Its own view: only what it saw.
    # (wait_for_idle is for this demo; agents rarely block on learning.)
    recall.wait_for_idle()
    known = planner.chat(
        "What has the researcher found about competitor prices?",
        target=researcher,
        reasoning_level="low",
    )
    # The researcher's view of the user, as prompt context for its next step (no model call).
    ctx = job.context(peer_target=user, peer_perspective=researcher, tokens=2000)
    prompt = ctx.to_openai(assistant=researcher)
    # endregion

    # region team
    # Shared team memory: ask across every job in the team's scope, not through one agent's eyes.
    shared = recall.chat(
        "What do we know about competitor pricing?", scope="team-pricing", reasoning_level="low"
    )
    # endregion

    # region webhook
    # Your HTTP handler for Recall's webhook: verify the raw body before you parse it.
    def on_recall_webhook(raw_body: bytes, signature: str | None, secret: str) -> str | None:
        event = construct_webhook_event(raw_body, signature, secret)
        # queue.empty: learning for this session is done. Wake the agent whose view changed.
        if event.type != "queue.empty" or event.data.get("observer") != planner.id:
            return None
        return planner.chat(
            "What is new in this job since my last step?",
            session=event.data["session_id"],
            reasoning_level="minimal",
        )

    # endregion

    # Not shown in the guide: one signed delivery, the way Recall sends it.
    import hashlib
    import hmac
    import json
    from datetime import datetime, timezone

    secret = "demo-webhook-secret"
    body = json.dumps(
        {
            "data": {"observed": researcher.id, "observer": planner.id, "session_id": job.id},
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": "queue.empty",
        }
    ).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    woken = on_recall_webhook(body, signature, secret)
    return {"known": known, "prompt": prompt, "shared": shared, "woken": woken}
