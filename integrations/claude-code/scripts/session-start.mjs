#!/usr/bin/env node
// SessionStart hook: set up the Recall session and put what memory knows about
// the user into the agent's context. Prints nothing and exits 0 if Recall is down.

import {
  additionalContext,
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
  if (settings.lookup === "off") return;
  const memory = await fetchMemory(settings, state, { timeoutMs: settings.timeoutMs + 1000 }, env);
  if (!memory) return;
  output = additionalContext("SessionStart", renderMemory(settings, memory, { sessionId }));
});
finish(output);
