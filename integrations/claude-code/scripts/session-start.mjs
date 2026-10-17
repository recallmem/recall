#!/usr/bin/env node
// SessionStart hook: set up the Recall session and put what memory knows about
// the user into the agent's context. Exits 0 if Recall is down; when recorded
// messages are still waiting to be stored, or were lost to a long outage, it says so.

import {
  additionalContext,
  backlogNotice,
  fetchMemory,
  finish,
  recallSessionId,
  renderMemory,
  runHook,
  setupSession,
} from "./lib.mjs";

let output;
await runHook("session-start", async ({ settings, input, state, env }) => {
  const sessionId = recallSessionId(settings, input);
  if (settings.record) await setupSession(settings, state, sessionId, input, env);
  const memory =
    settings.lookup === "off"
      ? null
      : await fetchMemory(settings, state, { timeoutMs: settings.timeoutMs + 1000 }, env);
  const text = [backlogNotice(env), memory ? renderMemory(settings, memory, { sessionId }) : ""]
    .filter(Boolean)
    .join("\n\n");
  if (text) output = additionalContext("SessionStart", text);
});
finish(output);
