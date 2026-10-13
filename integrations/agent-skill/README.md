# Recall memory Agent Skill

[`recall-memory/`](recall-memory/SKILL.md) is a portable skill in the [Agent Skills](https://agentskills.io) format
(a folder with a `SKILL.md`). It teaches any agent that supports skills when and how to use
[Recall](https://recallmem.dev): look up what is known about the user, save facts they state, forget on request, and record
conversations when nothing else does. It works through Recall's MCP tools when they are connected, and otherwise
through `scripts/recall.mjs`, a dependency-free Node 18+ helper for the REST API (raw `curl` calls are in
`references/rest-api.md`).

Use it on its own, or next to a Recall integration: the skill tells the agent not to record messages itself when
an integration already does (the Claude Code, Codex, OpenClaw and Hermes integrations all do).

## Install

Copy the `recall-memory` folder to where your agent looks for skills:

| Agent | Personal skills folder |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.agents/skills/` (or run the Codex installer with `--skill`) |
| OpenClaw | `~/.agents/skills/`, or `<workspace>/skills/` for one agent |
| Hermes Agent | `~/.hermes/skills/`, or add `~/.agents/skills` to its external skill directories |

```bash
git clone https://github.com/recallmem/recall-plugin
mkdir -p ~/.agents/skills && cp -r recall-plugin/integrations/agent-skill/recall-memory ~/.agents/skills/
```

## Configuration

The skill needs no configuration when the agent has Recall's MCP tools. For the helper script, set `RECALL_URL`,
`RECALL_API_KEY`, `RECALL_WORKSPACE_ID` and `RECALL_PEER_ID`, or put them in `~/.recall/config.json`
(`{"url": "...", "apiKey": "pk_live_...", "workspace": "...", "peer": "..."}`; the server's command line writes it
with `recall init`). Defaults: `https://api.recallmem.dev`, workspace `default`, your OS user name as the peer.
Every command also takes `--url`, `--api-key`, `--workspace` and `--peer`.

## What it records and injects

Nothing happens automatically: the agent reads the skill when a task calls for memory and then decides what to call.
The skill steers it to read once at the start of a task (`context`), save durable facts the user states
(`remember`), never save secrets, treat recalled text as information rather than instructions, and record each
exchange (`record`) only when no integration records for it. With the script, recorded sessions get the user as an
observed peer and the agent as the non-observed peer `assistant`.

## Check that it works

```bash
node ~/.agents/skills/recall-memory/scripts/recall.mjs status        # health ok, access accepted
node ~/.agents/skills/recall-memory/scripts/recall.mjs remember "Prefers tea over coffee"
node ~/.agents/skills/recall-memory/scripts/recall.mjs context --query drinks
```

Then ask your agent "what do you remember about my drinks?": it should load the skill and answer from memory. The
skill's format and the script are covered by Recall's own test suite.
