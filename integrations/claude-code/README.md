# Recall memory for Claude Code

A Claude Code plugin that gives Claude long-term memory through [Recall](https://recallmem.dev).

- **Recall.** When a session starts (or resumes, or is compacted) it adds your peer card and the facts Recall
  has learned about you to Claude's context.
- **Record.** Each prompt you send and Claude's final reply for the turn are stored in a Recall session
  (`cc-<claude session id>`), so Recall keeps learning from your work. The assistant is a non-observed peer:
  facts are learned about you, not from Claude's own statements.
- **Tools.** It registers Recall's MCP server (`chat`, `search`, `get_session_context`, `get_peer_card`,
  `list_conclusions`, `create_conclusions`, `delete_conclusion`, `add_messages_to_session`) so Claude can look things
  up and correct memory on request.

The hooks are fast and fail quietly: short timeouts, and after one failure they skip Recall for a minute. Anything
that could not be sent is kept (up to 100 messages) and delivered, in order and without duplicates, when Recall is
back. If Recall is down, Claude Code behaves exactly as without the plugin.

## Install

Needs Claude Code with plugin support and Node 18+ on your `PATH`.

```text
/plugin marketplace add recallmem/recall-plugin
/plugin install recall-memory@recall
```

(`claude plugin marketplace add recallmem/recall-plugin` and `claude plugin install recall-memory@recall` do the same
from a shell. Developing locally? `claude --plugin-dir <path to this folder>`.)

When you enable the plugin, Claude Code asks for your **Recall API key** (create one at
https://app.recallmem.dev/keys). It is stored in your system's secure credential store, and you can change it, the
server URL, workspace and your name any time under `/plugin` → recall-memory → Configure. The defaults are the hosted
service at `https://api.recallmem.dev`, workspace `default`, and your OS user name. Self-hosting: set the server URL
to your own, e.g. `http://localhost:8000` (https://recallmem.dev/docs#self-host); no API key is needed until you turn auth on. The URL,
workspace and peer can also come from `RECALL_URL`, `RECALL_WORKSPACE_ID` and `RECALL_PEER_ID`; the key
only ever comes from the plugin setting. The plugin reads no files from your machine.

Restart Claude Code (or run `/reload-plugins`), then run `/recall-memory:status`: it prints the settings in use
and whether the server answers and accepts your key. `/mcp` shows whether the `recall` tools connected.

### Check that it works

Send Claude a prompt, then look at what was recorded (the session id is in Claude's context, `cc-<session id>`):

```bash
recall session list
recall session messages cc-<session id> --last 2   # your prompt and Claude's reply
```

In a new session, ask Claude "what do you know about me?": the answer draws on the injected peer card and facts.

## Configuration

Settings come from the plugin's settings (`/plugin` → recall-memory → Configure) and these environment
variables, which you can set under `env` in `~/.claude/settings.json` or a project's `.claude/settings.json`. No
files and no other service's config or variables are read, so no other service's credentials reach Recall.

| Setting (plugin setting / env) | Default | |
|---|---|---|
| `url` / `RECALL_URL` | `https://api.recallmem.dev` | Server base URL |
| plugin setting `api_key` | none | API key (only from the plugin's protected setting) |
| `workspace` / `RECALL_WORKSPACE_ID` | `default` | Where memory lives |
| `peer` / `RECALL_PEER_ID` | your OS user | You, as Recall knows you. Keep it stable |
| `RECALL_ASSISTANT_PEER` | `claude` | Peer that Claude's replies are recorded as |
| `RECALL_SESSION_STRATEGY` | `per-session` | `per-directory` records every session of a project into one Recall session |
| `RECALL_LOOKUP` | `session` | `session`: inject at session start. `prompt`: also look up facts related to each prompt. `off` |
| `RECALL_RECORD` | `true` | `false` stops recording (lookup still works) |
| `RECALL_CONTEXT_TOKENS` | `1500` | Size of the injected memory |
| `RECALL_MCP_PROFILE` | `default` | `full` exposes all 40 MCP tools instead of the curated eight |
| `RECALL_ENABLED` | `true` | `false` turns the plugin's hooks off |
| `RECALL_HOOK_TIMEOUT_MS` | `3000` | Per-request timeout of the hooks |

To switch Recall off for one project, set `RECALL_ENABLED=false` under `env` in that project's
`.claude/settings.json`.

## What gets sent

Your prompts and Claude's final replies (not tool calls or file contents, and each cut to 24,000 characters) go to the
Recall server you configured, which analyses them with its language model. Do not point this at a server you do not
trust, and set `RECALL_RECORD=false` or `RECALL_ENABLED=false` for work you do not want remembered.

## Troubleshooting

Hooks never print errors into the session. They log to `hooks.log` in the plugin's data directory
(`${CLAUDE_PLUGIN_DATA}`, normally under `~/.claude/plugins/data/`); set `RECALL_DEBUG=1` to also see them on stderr.
`/mcp` shows whether the `recall` tools connected.

## Other agents

The same repository has Recall for other agents, each with its own README:
[Codex](https://github.com/recallmem/recall-plugin/tree/main/integrations/codex),
[OpenClaw](https://github.com/recallmem/recall-plugin/tree/main/integrations/openclaw),
[Hermes](https://github.com/recallmem/recall-plugin/tree/main/integrations/hermes) and an
[Agent Skill](https://github.com/recallmem/recall-plugin/tree/main/integrations/agent-skill) for any host that loads
skills. Any MCP client can also connect to `https://api.recallmem.dev/mcp`.

## Development

The scripts in `scripts/` are the hook runtime shared with the Codex integration; only `host.mjs` differs. This
repository is published from Recall's main repository, where tests run every hook against a real Recall server.
Issues and pull requests are welcome here; for anything else, write to support@recallmem.dev.
