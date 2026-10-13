// What makes this the Claude Code integration. Everything else in scripts/ is
// the shared hook runtime, kept identical to integrations/codex/scripts/.

import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOST_INFO = {
  /** Names the host in message metadata, the user agent and the `hosts.<id>` config block. */
  id: "claude-code",
  /** Plugin version, sent in the user agent. */
  version: "0.1.0",
  /** Peer the agent's replies are recorded as, unless configured. */
  assistantPeer: "claude",
  /** Recall session ids are `<prefix>-<session id>` or `<prefix>-dir-<project>-<hash>`. */
  sessionPrefix: "cc",
  /** Metadata key for the host's session id on the Recall session. */
  sessionIdKey: "claude_session_id",
  /** Hook input field (and message metadata key) that identifies one prompt. */
  turnIdKey: "prompt_id",
  /** Where the circuit breaker, the unsent-message spool and the log live. */
  stateDir: (env) => env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "recall-claude-code"),
  /** The API key comes only from the plugin's protected `api_key` setting, never from files or the shell. */
  apiKey: (env) => env.CLAUDE_PLUGIN_OPTION_API_KEY,
  /** Shown when the server refuses the key. */
  keyHint:
    "Set your Recall API key in the plugin's settings (/plugin → recall-memory → Configure).",
};
