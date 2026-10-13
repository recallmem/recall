# Recall memory for Codex

Gives [OpenAI Codex](https://developers.openai.com/codex) long-term memory through [Recall](https://recallmem.dev).

- **Recall.** When a session starts (or resumes, or after `/clear` or a compaction) Codex gets your peer card and
  the facts Recall has learned about you as developer context.
- **Record.** Each prompt you send and Codex's final reply for the turn are stored in a Recall session
  (`codex-<codex session id>`), so Recall keeps learning from your work. Codex is a non-observed peer (`codex`):
  facts are learned about you, not from Codex's own statements.
- **Tools.** Recall's MCP server (`chat`, `search`, `get_session_context`, `get_peer_card`, `list_conclusions`,
  `create_conclusions`, `delete_conclusion`, `add_messages_to_session`) lets Codex look things up and correct memory.

It uses Codex [hooks](https://learn.chatgpt.com/docs/hooks) (`SessionStart`, `UserPromptSubmit`, `Stop`) and a stdio
MCP server. The hook scripts are the same ones the [Claude Code plugin](https://github.com/RedSix6/recall-plugin#readme) runs: fast, quiet
on failure (short timeouts, then Recall is skipped for a minute), and anything that could not be sent is kept (up to
100 messages) and delivered in order once Recall is back. If Recall is down, Codex behaves as without it.

## Install

Needs Codex CLI with hooks (on by default in current releases; tested with 0.162.0) and Node 18+ on your `PATH`.
Pick one of the two routes; installing both handles every turn twice.

### As a Codex plugin

```bash
codex plugin marketplace add RedSix6/recall-plugin
codex plugin add recall-memory@recall
```

(Inside Codex, `/plugins` shows the same marketplace.) Then start Codex and run **`/hooks`**: Codex skips new
hooks until you trust them, so trust the three Recall hooks. Codex keeps the plugin in
`$CODEX_HOME/plugins/cache/recall/recall-memory/<version>/` and its state in
`$CODEX_HOME/plugins/data/recall-memory-recall/`.

### With the installer (no plugin system needed)

```bash
git clone https://github.com/RedSix6/recall-plugin
node recall-plugin/integrations/codex/install.mjs \
  --url https://your-recall.example --api-key pk_live_... --workspace my-workspace --peer your-name
```

This copies the scripts to `~/.codex/recall/scripts`, adds the three hooks to `~/.codex/hooks.json`, adds the
`recall` MCP server to `~/.codex/config.toml` (in a marked block; your other settings are untouched), and saves the
connection flags to `~/.recall/config.json` (mode 600; leave the flags out to keep an existing file). Run it again
to update; `--uninstall` removes everything it added. Then start Codex and trust the hooks with **`/hooks`**.

Options: `--codex-home DIR` (default `$CODEX_HOME` or `~/.codex`), `--no-hooks`, `--no-mcp`, `--skill` (also
installs the [recall-memory Agent Skill](../agent-skill/recall-memory/SKILL.md) into `~/.agents/skills`, where Codex
finds it), and `--agents-md` (adds a short "Recall memory" section to `~/.codex/AGENTS.md`; useful when hooks are
off, since it tells Codex what the tools are for).

## Configuration

Settings come, per setting, from the environment, then `~/.recall/config.json` (as written by `recall init` or the
installer); no other service's config or variables are read. A `hosts.codex` object in the file overrides its top level, e.g.
`{"hosts": {"codex": {"workspace": "coding"}}}`.

| Setting (file key / env) | Default | |
|---|---|---|
| `url` / `RECALL_URL` | `https://api.recallmem.dev` | Server base URL |
| `apiKey` / `RECALL_API_KEY` | none | API key (`${VAR}` placeholders allowed in the file) |
| `workspace` / `RECALL_WORKSPACE_ID` | `default` | Where memory lives |
| `peer` / `RECALL_PEER_ID` | your OS user | You, as Recall knows you. Keep it stable |
| `assistantPeer` / `RECALL_ASSISTANT_PEER` | `codex` | Peer Codex's replies are recorded as |
| `sessionStrategy` / `RECALL_SESSION_STRATEGY` | `per-session` | `per-directory`: one Recall session per project |
| `lookup` / `RECALL_LOOKUP` | `session` | `session`: at session start. `prompt`: also facts related to each prompt. `off` |
| `record` / `RECALL_RECORD` | `true` | `false` stops recording |
| `contextTokens` / `RECALL_CONTEXT_TOKENS` | `1500` | Size of the injected memory |
| `mcpProfile` / `RECALL_MCP_PROFILE` | `default` | `full` exposes all 40 MCP tools |
| `enabled` / `RECALL_ENABLED` | `true` | `false` turns the hooks off |
| `timeoutMs` / `RECALL_HOOK_TIMEOUT_MS` | `3000` | Per-request timeout of the hooks |

Codex starts MCP servers with only a short list of environment variables (`HOME`, `PATH`, `USER`, ...). The plugin and
the installer forward the `RECALL_*` variables above through `env_vars`; `~/.recall/config.json` works either way.
Codex's hook output limit is about 2,500 tokens, so keep `contextTokens` at or below that.

### MCP over HTTP instead of the bridge

If you only want the tools (no hooks) and no Node, Codex can talk to Recall's MCP endpoint directly. This follows
Codex's documented `config.toml` keys but is not covered by our tests:

```toml
[mcp_servers.recall]
url = "https://your-recall.example/mcp"
bearer_token_env_var = "RECALL_API_KEY"
http_headers = { "X-Recall-Workspace-ID" = "my-workspace", "X-Recall-User-Name" = "your-name" }
```

## What gets sent and injected

- **Sent:** your prompts (`UserPromptSubmit`) and Codex's final reply per turn (`Stop`, `last_assistant_message`),
  each cut to 24,000 characters, with `{"source": "codex", "turn_id": ...}` as metadata. Not tool calls, command
  output or file contents. The Recall server analyses them with its language model, so only point this at a server
  you trust, and use `record: false` or `RECALL_ENABLED=false` for work you do not want remembered.
- **Injected:** at session start, your peer card and the most relevant facts (about `contextTokens` tokens), plus a
  line naming the Recall session and the tools. With `lookup: prompt`, also the facts related to each prompt.

## Check that it works

```bash
node ~/.codex/recall/scripts/status.mjs     # installer route; for the plugin use the scripts/ folder in the plugin cache
codex mcp list                               # shows the recall server
codex exec "I prefer pnpm over npm"          # prints "session id: <id>"
recall session messages codex-<id> --last 2  # your prompt and Codex's reply
```

Without the `recall` CLI:
`curl -s -X POST "$RECALL_URL/v3/workspaces/<workspace>/sessions/codex-<id>/messages/list" -H "authorization: Bearer $RECALL_API_KEY" -H 'content-type: application/json' -d '{}'`.
In a new session, ask Codex "what do you know about me?".

## Troubleshooting

- Nothing recorded: the hooks are probably not trusted yet. Run `/hooks` in Codex. For unattended runs,
  `codex exec --dangerously-bypass-hook-trust` runs enabled hooks without stored trust.
- Hooks never print errors into the session. They log to `hooks.log` in their state directory
  (`$CODEX_HOME/recall/state/` for the installer, `$CODEX_HOME/plugins/data/recall-memory-recall/` for the
  plugin); set `RECALL_DEBUG=1` to also see messages on stderr.
- `/mcp` (or `codex mcp list`) shows whether the `recall` server started.

## Notes on the Codex extension points

Checked against the Codex docs and Codex CLI 0.162.0 (October 2026):

- Plugin hooks are read only from plugins that use the `.codex-plugin/plugin.json` layout. A plugin with a root
  `plugin.json` (the portable Agent Plugins layout) gets its skills and MCP servers loaded but its hooks skipped,
  which is why this plugin uses the `.codex-plugin` layout. The plugin's `.mcp.json` does not expand
  `${PLUGIN_ROOT}`, so the bridge is started with `cwd: "."` (the plugin root) and a relative path.
- `notify` (the older `agent-turn-complete` program) is not used: it cannot add context, and hooks cover recording.
- Windows: the installer writes absolute `node "<path>"` commands, which should work in any shell, but neither route
  has been tested on Windows.
