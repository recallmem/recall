// Guide: https://recallmem.dev/guides/voice-agents
// A phone support agent: the caller's id is a keyed hash of their number, memory is read while the
// call connects, each utterance is one fast request and anything slow waits for the hang-up.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { createHmac } from "node:crypto";
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "support-line" })) {
  // #region setup
  // Ids show up in URLs, logs and exports, so never use the raw number. A plain hash of a phone
  // number is easy to reverse; a keyed hash is not, without the key from your secret store.
  const secret = process.env.CALLER_ID_SECRET ?? "local-dev-only";
  const callerId = (phone: string) =>
    `caller-${createHmac("sha256", secret).update(phone).digest("hex").slice(0, 32)}`;

  // Once, at startup: Recall reads the agent's lines but learns nothing from them, and keeps a
  // running summary of each call every 10 messages (the default is 20).
  const agent = recall.peer("voice-agent", { configuration: { observeMe: false } });
  await recall.setConfiguration({ summary: { messagesPerShortSummary: 10 } });

  // Per call: the caller, and a session named after your telephony provider's call id.
  // Handles make no request; the first utterance creates the session.
  const caller = recall.peer(callerId("+447700900123")); // or your account id, once verified
  const call = recall.session("call-7f3e9a2c");
  // #endregion

  // #region before-call
  // The call is connecting: read what Recall knows about the caller while your greeting plays,
  // so the first reply needs no lookup. One request; a new caller just has no memory yet.
  const start = await call.context({ peerTarget: caller, tokens: 1500 });
  const system = start.toOpenAI(agent); // peer card and known facts, as system messages
  // #endregion

  // #region turn
  // Each finished utterance (the final transcript from speech-to-text): one request that stores
  // it with the agent's previous line and returns fresh context. Start it next to your model call,
  // not before it: the model already has `system` and the call so far.
  const greeting = "Thanks for calling. How can I help?";
  const heard = "Hi, it's me again. The internet keeps dropping out in the evenings.";
  const stored = call.turn([agent.message(greeting), caller.message(heard)], {
    peerTarget: caller,
    tokens: 1500,
  });
  // Your voice model replies now, from `system`, the call so far and `heard`.
  const reply = "Sorry about that. Is it the router we replaced in August?";
  const { context } = await stored; // for the next utterance; older turns become a summary
  // #endregion

  // #region after-call
  // Hang-up: store the agent's last line. Anything slow happens now, off the call.
  await call.addMessages([agent.message(reply)]);
  // (waitForIdle is for this demo; in production the queue.empty webhook says when to read.)
  await recall.waitForIdle();
  // Recall's running summary of the call (every 10 messages, as set at startup); a call as
  // short as this one has none yet.
  const { shortSummary } = await call.summaries();
  // A question for your CRM or the next call: one model call of a few seconds, fine now.
  const followUp = await caller.chat("What have we promised this caller, and by when?", {
    reasoningLevel: "low",
  });
  // #endregion

  // #region forget
  // A caller asks to be forgotten: derive the same id from their number, delete their calls
  // (the agent's lines quote them), then the caller.
  const person = recall.peer(callerId("+447700900123"));
  for (const s of await (await person.sessions()).toArray()) await s.delete();
  const removed = await person.delete();
  // #endregion
  return { system, context, summary: shortSummary?.content ?? null, followUp, removed };
}
