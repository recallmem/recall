# Guide: https://recallmem.dev/guides/coding-agents
# A coding agent of your own: the developer's preferences, the repository's rules and its past
# decisions. Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

import re
from typing import Any

from recall_memory import PeerConfig, Recall


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="acme-eng")
    # region setup
    dev = recall.peer("dev-4821")
    # Recall learns about the developer, not from the agent's own replies.
    agent = recall.peer("coding-agent")
    agent.set_configuration(PeerConfig(observe_me=False))
    # The repository's rules live on a peer of their own. Nobody speaks as it.
    repo = recall.peer("repo-billing-api")
    repo.set_configuration(PeerConfig(observe_me=False))

    # One session per coding session, filed under the repository's scope.
    session = recall.session("cs-20261010-7f2c", peers=[dev, agent], scopes=["billing-api"])
    # endregion

    # region rules
    # Rules the team states outright: write them as facts, so they hold from the first session.
    team_rules = [
        "Migrations are generated with `pnpm db:generate`; never edit them by hand.",
        "billing-api runs on Node 22 and uses pnpm, not npm.",
        "Money amounts are integers in cents; never floats.",
    ]
    repo.conclusions.create([{"content": rule} for rule in team_rules])
    # endregion

    # region start
    # At session start: what is known about the developer and the rules that touch the task.
    # Two reads: no answer is generated, so they are fast and included in the price.
    task = "Add a refund_reason column to the payments table"
    ctx = session.context(peer_target=dev, search_query=task, tokens=1500)
    rules = repo.context(search_query=task)
    messages = [
        {"role": "system", "content": f"Rules of this repository:\n{rules.representation or ''}"},
        *ctx.to_openai(assistant=agent),
    ]
    # endregion

    # region record
    # After each turn: the developer's prompt and the agent's final answer. No tool output, no file
    # contents, no secrets (this pattern is crude: run your own secret scanner too).
    def redact(text: str) -> str:
        return re.sub(r"\b(?:sk|pk|ghp|xox[bp])[-_][\w-]{16,}", "[redacted]", text)[:24_000]

    prompt = "Add refund_reason to payments. Nullable for now, we backfill next sprint."
    # Your model wrote this answer from `messages`.
    answer = "Added a nullable refund_reason column and generated migration 0042."
    session.add_messages([dev.message(redact(prompt)), agent.message(redact(answer))])
    # endregion

    # region decisions
    # Weeks later, from any session: what was decided in this repository? Only sessions in its
    # scope are read. (wait_for_idle is for this demo; an agent rarely blocks on learning.)
    recall.wait_for_idle()
    decided = recall.chat(
        "Is refund_reason nullable, and why?", scope="billing-api", reasoning_level="low"
    )
    # endregion

    # region forget
    # A rule that changed: delete the old fact and write the new one.
    stale = [rule.id for rule in repo.conclusions.list() if "Node 22" in rule.content]
    for rule_id in stale:
        repo.conclusions.delete(rule_id)
    repo.conclusions.create([{"content": "billing-api runs on Node 24 and uses pnpm, not npm."}])
    # A developer who leaves: erase them and everything learned from or about them.
    dev.delete()
    # endregion
    return {"messages": messages, "decided": decided}
