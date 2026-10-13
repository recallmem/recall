# Guide: https://recallmem.dev/guides/support
# A help desk where a bot and human agents share one memory per customer across tickets, chat
# and email, with account scopes, handoffs, a CRM webhook and deletion requests. Run by
# sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import PeerConfig, Recall, construct_webhook_event


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="support-tenant-4471")
    # region setup
    # The customer is a peer keyed by your stable customer id, whatever channel they use.
    customer = recall.peer("cust-1042", metadata={"plan": "pro", "account": "acct-2209"})
    # Recall learns about customers, not about your staff: the bot and agents are not observed.
    staff = PeerConfig(observe_me=False)
    bot = recall.peer("bot-support", configuration=staff)
    agent = recall.peer("agent-317", configuration=staff, metadata={"team": "billing"})
    # One session per ticket, across every channel it moves through.
    ticket = recall.session("ticket-58213", metadata={"subject": "Charged twice"})
    # endregion

    # region email
    # The ticket starts by email. Add each email with the time it was sent, so what Recall learns
    # is dated correctly. Strip quoted earlier emails and signatures first.
    email = {"channel": "email"}
    ticket.add_messages(
        [
            customer.message(
                "You charged us twice for September, order 77120. Please refund one.",
                metadata=email,
                created_at="2026-10-06T08:05:00Z",
            ),
            agent.message(
                "Sorry about that. I've refunded the duplicate €49; allow 3 to 5 days.",
                metadata=email,
                created_at="2026-10-06T09:12:00Z",
            ),
        ]
    )
    # endregion

    # region chat
    # Days later the customer opens the chat widget. One request stores the message and returns
    # the context for the bot's reply: the whole ticket so far and what Recall knows about them.
    chat = {"channel": "chat"}
    text = "Still no refund. And can we switch to yearly billing from November?"
    result = ticket.turn([customer.message(text, metadata=chat)], peer_target=customer, tokens=3000)
    prompt = result.context.to_openai(assistant=bot)
    # Your model writes the bot's reply from `prompt`; store it so the ticket is complete.
    reply = "The €49 refund was sent on 6 October, so it should arrive by 11 October."
    ticket.add_messages([bot.message(reply, metadata=chat)])
    # endregion

    # region account
    # cust-1042 and cust-1043 work at the same company. A scope per customer account collects
    # their tickets, so you can ask about the whole account.
    account = recall.scope("acct-2209")
    account.add_sessions([ticket])
    # A new ticket can join the scope when you create it.
    other = recall.session("ticket-58190", scopes=[account])
    other.add_messages([recall.peer("cust-1043").message("Please send invoices to finance.")])
    # endregion

    # region handoff
    # Handing over to a human: the ticket's summary and latest messages plus the customer's card,
    # in one call with no model, for your agent's sidebar.
    # (wait_for_idle is for this demo; real apps rarely block on learning.)
    recall.wait_for_idle()
    brief = ticket.context(peer_target=customer, tokens=4000)
    sidebar = {
        "summary": brief.summary.content if brief.summary else "",
        "customer": brief.peer_card or [],
        "latest": [f"{m.peer_id}: {m.content}" for m in brief.messages[-5:]],
    }
    # Questions about the whole account read the scope instead of one customer.
    account_notes = recall.chat(
        "What has this account asked us to change?", scope=account, reasoning_level="low"
    )
    # endregion

    # region history
    # "Has this happened before?": search what the customer wrote across all their tickets.
    earlier = customer.search("charged twice", limit=5)
    related_tickets = sorted({m.session_id for m in earlier})
    # endregion

    # region webhook
    # Your endpoint for Recall's webhooks. queue.empty means Recall has finished learning from a
    # ticket: verify the signature on the raw body, then refresh the customer's note in your CRM.
    def on_recall_webhook(raw_body: bytes, signature: str | None, secret: str) -> dict | None:
        event = construct_webhook_event(raw_body, signature, secret)
        customer_id = event.data.get("observed")
        if event.type != "queue.empty" or not isinstance(customer_id, str):
            return None
        latest = recall.session(str(event.data["session_id"])).context(
            peer_target=customer_id, tokens=2000
        )
        # Write this to the customer's record in your CRM.
        return {
            "customer_id": customer_id,
            "summary": latest.summary.content if latest.summary else "",
            "card": latest.peer_card or [],
        }

    # endregion

    # Demo only: the delivery Recall would POST to your endpoint once it has finished learning.
    secret = "whsec-demo"  # your account's webhook secret (Settings)
    data = {"observed": customer.id, "observer": customer.id, "session_id": ticket.id}
    body, signature = _signed_delivery(data, secret)
    crm = on_recall_webhook(body, signature, secret)

    # region forget
    # A deletion request: erase the customer (their messages, every fact and card about them, and
    # the account scope's memory of them), then their tickets, which still hold your replies.
    tickets = list(customer.sessions())
    removed = customer.delete()
    for t in tickets:
        t.delete()
    # endregion
    return {
        "prompt": prompt,
        "sidebar": sidebar,
        "account_notes": account_notes,
        "related_tickets": related_tickets,
        "crm": crm,
        "removed": removed,
    }


def _signed_delivery(data: dict[str, str], secret: str) -> tuple[bytes, str]:
    """Demo only: a queue.empty delivery signed the way Recall signs it (HMAC-SHA256, hex)."""
    import hashlib
    import hmac
    import json
    from datetime import datetime, timezone

    event = {
        "data": {**data, "queue_type": "representation"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": "queue.empty",
    }
    body = json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
    return body, hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
