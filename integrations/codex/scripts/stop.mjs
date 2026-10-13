#!/usr/bin/env node
// Stop hook: record the agent's final reply for the turn into the Recall session.
// Prints nothing, never asks the agent to continue, and exits 0 whatever happens.

import {
  clip,
  finish,
  idempotencyKey,
  messageMetadata,
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
      messages: [
        {
          peer_id: settings.assistantPeer,
          content: clip(reply),
          metadata: messageMetadata(input),
        },
      ],
      setup: sessionSetup(settings, input),
    },
    env,
  );
});
finish();
