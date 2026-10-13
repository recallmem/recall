---
description: Show how the Recall memory plugin is configured and whether the server answers
---

Run this command with the Bash tool and show its output exactly as printed, without commentary:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"`

If it reports that the server is unreachable or the credentials are rejected, say so in one sentence and name the setting to fix: the server URL or the API key, both under `/plugin` → recall-memory → Configure.
