// Guide: https://recallmem.dev/guides/support
// A help desk where a bot and human agents share one memory per customer across tickets, chat
// and email, with account scopes, handoffs, a CRM webhook and deletion requests. Run by
// packages/sdk/test/guides.test.ts against a real server.
import { constructWebhookEvent, Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "support-tenant-4471" })) {
  // #region setup
  // The customer is a peer keyed by your stable customer id, whatever channel they use.
  const customer = recall.peer("cust-1042", { metadata: { plan: "pro", account: "acct-2209" } });
  // Recall learns about customers, not about your staff: the bot and agents are not observed.
  const staff = { configuration: { observeMe: false } };
  const bot = recall.peer("bot-support", staff);
  const agent = recall.peer("agent-317", { ...staff, metadata: { team: "billing" } });
  // One session per ticket, across every channel it moves through.
  const ticket = recall.session("ticket-58213", { metadata: { subject: "Charged twice" } });
  // #endregion

  // #region email
  // The ticket starts by email. Add each email with the time it was sent, so what Recall learns
  // is dated correctly. Strip quoted earlier emails and signatures first.
  const email = { metadata: { channel: "email" } };
  await ticket.addMessages([
    customer.message("You charged us twice for September, order 77120. Please refund one.", {
      ...email,
      createdAt: "2026-10-06T08:05:00Z",
    }),
    agent.message("Sorry about that. I've refunded the duplicate €49; allow 3 to 5 days.", {
      ...email,
      createdAt: "2026-10-06T09:12:00Z",
    }),
  ]);
  // #endregion

  // #region chat
  // Days later the customer opens the chat widget. One request stores the message and returns
  // the context for the bot's reply: the whole ticket so far and what Recall knows about them.
  const chat = { metadata: { channel: "chat" } };
  const { context } = await ticket.turn(
    [customer.message("Still no refund. And can we switch to yearly billing from November?", chat)],
    { peerTarget: customer, tokens: 3000 },
  );
  const prompt = context.toOpenAI(bot);
  // Your model writes the bot's reply from `prompt`; store it so the ticket is complete.
  const reply = "The €49 refund was sent on 6 October, so it should arrive by 11 October.";
  await ticket.addMessages([bot.message(reply, chat)]);
  // #endregion

  // #region account
  // cust-1042 and cust-1043 work at the same company. A scope per customer account collects
  // their tickets, so you can ask about the whole account.
  const account = recall.scope("acct-2209");
  await account.addSessions([ticket]);
  // A new ticket can join the scope when you create it.
  const other = recall.session("ticket-58190", { scopes: [account] });
  await other.addMessages([recall.peer("cust-1043").message("Please send invoices to finance.")]);
  // #endregion

  // #region handoff
  // Handing over to a human: the ticket's summary and latest messages plus the customer's card,
  // in one call with no model, for your agent's sidebar.
  // (waitForIdle is for this demo; real apps rarely block on learning.)
  await recall.waitForIdle();
  const brief = await ticket.context({ peerTarget: customer, tokens: 4000 });
  const sidebar = {
    summary: brief.summary?.content ?? "",
    customer: brief.peerCard ?? [],
    latest: brief.messages.slice(-5).map((m) => `${m.peerId}: ${m.content}`),
  };
  // Questions about the whole account read the scope instead of one customer.
  const accountNotes = await recall.chat("What has this account asked us to change?", {
    scope: account,
    reasoningLevel: "low",
  });
  // #endregion

  // #region history
  // "Has this happened before?": search what the customer wrote across all their tickets.
  const earlier = await customer.search("charged twice", { limit: 5 });
  const relatedTickets = [...new Set(earlier.map((m) => m.sessionId))];
  // #endregion

  // #region webhook
  // Your endpoint for Recall's webhooks. queue.empty means Recall has finished learning from a
  // ticket: verify the signature on the raw body, then refresh the customer's note in your CRM.
  async function onRecallWebhook(rawBody: string, signature: string | null, secret: string) {
    const event = await constructWebhookEvent(rawBody, signature, secret);
    const { session_id: ticketId, observed: customerId } = event.data;
    if (event.type !== "queue.empty" || typeof customerId !== "string") return null;
    const latest = await recall
      .session(String(ticketId))
      .context({ peerTarget: customerId, tokens: 2000 });
    // Write this to the customer's record in your CRM.
    return { customerId, summary: latest.summary?.content ?? "", card: latest.peerCard ?? [] };
  }
  // #endregion

  // Demo only: the delivery Recall would POST to your endpoint once it has finished learning.
  const secret = "whsec-demo"; // your account's webhook secret (Settings)
  const data = { observed: customer.id, observer: customer.id, session_id: ticket.id };
  const { body, signature } = await signedDelivery(data, secret);
  const crm = await onRecallWebhook(body, signature, secret);

  // #region forget
  // A deletion request: erase the customer (their messages, every fact and card about them, and
  // the account scope's memory of them), then their tickets, which still hold your replies.
  const tickets = await (await customer.sessions()).toArray();
  const removed = await customer.delete();
  for (const t of tickets) await t.delete();
  // #endregion
  return { prompt, sidebar, accountNotes, relatedTickets, crm, removed };
}

/** Demo only: a queue.empty delivery signed the way Recall signs it (HMAC-SHA256, hex). */
async function signedDelivery(data: Record<string, string>, secret: string) {
  const body = JSON.stringify({
    data: { ...data, queue_type: "representation" },
    timestamp: new Date().toISOString(),
    type: "queue.empty",
  });
  const text = new TextEncoder();
  const hmac = { name: "HMAC", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("raw", text.encode(secret), hmac, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, text.encode(body)));
  return { body, signature: [...mac].map((b) => b.toString(16).padStart(2, "0")).join("") };
}
