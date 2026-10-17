#!/usr/bin/env node
// Stop hook: record the agent's final reply for the turn into the Recall session.
// Prints nothing, never asks the agent to continue, and exits 0 whatever happens.

import {
  finish,
  idempotencyKey,
  messagesOf,
  recallSessionId,
  record,
  runHook,
  sessionSetup,
  turnId,
} from "./lib.mjs";

await runHook("stop", async ({ settings, input, state, env }) => {
  const reply =
    typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  if (!reply || !settings.record) return;
  const sessionId = recallSessionId(settings, input);
  await record(
    settings,
    state,
    {
      workspace: settings.workspace,
      session: sessionId,
      key: idempotencyKey("a", input.session_id, turnId(input) ?? "", reply),
      messages: messagesOf(settings.assistantPeer, reply, input),
      setup: sessionSetup(settings, input),
    },
    env,
  );
});
finish();
