// What makes this the Codex integration. Everything else in scripts/ is the
// shared hook runtime, kept identical to integrations/claude-code/scripts/.

import { homedir } from "node:os";
import { join } from "node:path";

const codexHome = (env) =>
  env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex");

export const HOST_INFO = {
  /** Names the host in message metadata, the user agent and the `hosts.<id>` config block. */
  id: "codex",
  /** Integration version, sent in the user agent. */
  version: "0.1.0",
  /** Peer the agent's replies are recorded as, unless configured. */
  assistantPeer: "codex",
  /** Recall session ids are `<prefix>-<session id>` or `<prefix>-dir-<project>-<hash>`. */
  sessionPrefix: "codex",
  /** Metadata key for the host's session id on the Recall session. */
  sessionIdKey: "codex_session_id",
  /** Hook input field (and message metadata key) that identifies one prompt. */
  turnIdKey: "turn_id",
  /**
   * Where the circuit breaker, the unsent-message spool and the log live: the
   * plugin data directory when Codex runs these as plugin hooks, else
   * `$CODEX_HOME/recall/state` (the installer's layout).
   */
  stateDir: (env) =>
    env.RECALL_STATE_DIR ||
    env.PLUGIN_DATA ||
    env.CLAUDE_PLUGIN_DATA ||
    join(codexHome(env), "recall", "state"),
  /** API key: RECALL_API_KEY, then `apiKey` in ~/.recall/config.json (as written by `recall init` or install.mjs). */
  apiKey: (env, fromFile) => env.RECALL_API_KEY || fromFile("apiKey", "auth.apiKey"),
  /** Shown when the server refuses the key. */
  keyHint: "Set RECALL_API_KEY, or apiKey in ~/.recall/config.json.",
};
