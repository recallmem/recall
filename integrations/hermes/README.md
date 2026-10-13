# Recall memory for Hermes Agent

A memory provider for [Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) that gives it
long-term memory through [Recall](https://recallmem.dev). Hermes' own `MEMORY.md` / `USER.md` memory keeps working; Recall
is the one external provider next to it.

- **Recall.** Before each turn Hermes asks the provider for context (`prefetch`); it returns your peer card and the
  facts most related to the message, which Hermes wraps in its `<memory-context>` block. A short static note in the
  system prompt says Recall is active and names the tools.
- **Record.** After each turn (`sync_turn`) your message and Hermes' reply are stored in a Recall session per
  Hermes session (`hermes-<session id>`), in order and in the background. Hermes is a non-observed peer (`hermes`):
  facts are learned about you, not from its replies. Cron runs, subagents and flushes are not recorded.
- **Mirror.** Facts Hermes' built-in memory adds about you (`target: user`) are saved to Recall as well.
- **Tools.** `recall_search`, `recall_ask`, `recall_remember` and `recall_forget`.

Standard library only (no pip dependencies). Requests time out after a few seconds, a failure makes it skip Recall
for a minute, and writes that could not be sent wait (up to 200) and go out in order once Recall answers.

## Install

The provider is the `recall/` folder. Hermes loads user-installed memory providers from
`$HERMES_HOME/plugins/<name>/` (default `~/.hermes/plugins/`):

```bash
git clone https://github.com/RedSix6/recall-plugin
mkdir -p ~/.hermes/plugins
cp -r recall-plugin/integrations/hermes/recall ~/.hermes/plugins/recall
hermes memory setup        # pick "recall" and enter the URL, API key, workspace and your peer id
```

`hermes memory setup` writes the API key to `~/.hermes/.env` (`RECALL_API_KEY`) and the rest to
`~/.hermes/recall.json`. Instead of the wizard you can set `memory.provider: recall` in `~/.hermes/config.yaml` and
configure it as below.

Hermes can also install straight from Git with
`hermes plugins install RedSix6/recall-plugin/integrations/hermes/recall --enable` (a sub-folder install, per the
Hermes docs). That route has not been tested; the copy above has.

## Configuration

Read per setting from the environment, then `$HERMES_HOME/recall.json`, then `~/.recall/config.json` (as written by
`recall init`; a `hosts.hermes` object there overrides its top level).

| `recall.json` key (env) | Default | |
|---|---|---|
| `url` (`RECALL_URL`) | `https://api.recallmem.dev` | Recall server URL |
| `api_key` (`RECALL_API_KEY`) | none | API key (keep it in `.env`) |
| `workspace` (`RECALL_WORKSPACE_ID`) | `default` | Where memory lives |
| `peer` (`RECALL_PEER_ID`) | your OS user | You, as Recall knows you. Keep it stable |
| `assistant_peer` (`RECALL_ASSISTANT_PEER`) | `hermes` | Peer Hermes' replies are recorded as |
| `lookup` (`RECALL_LOOKUP`) | `turn` | `turn`: recall before every turn. `off`: tools only |
| `record` (`RECALL_RECORD`) | `true` | `false` stops recording |
| `session_strategy` (`RECALL_SESSION_STRATEGY`) | `per-session` | `per-chat`: one Recall session per messaging chat (gateway). `global`: one session for everything |
| `peer_from_user` | `false` | On the gateway, use `<platform>-<user id>` as the peer, for an assistant several people use |
| `mirror_memory_writes` | `true` | Copy facts the built-in memory saves about you |
| `context_tokens` (`RECALL_CONTEXT_TOKENS`) | `1200` | Size of the recalled context |
| `timeout` (`RECALL_TIMEOUT`) | `4` | Seconds per request |
| `enabled` | `true` | `false` makes the provider unavailable |

## What gets sent and injected

- **Sent:** each completed exchange (your message and Hermes' reply, after Hermes' own secret scrubbing, each cut to
  24,000 characters), facts the built-in memory adds about you, and whatever the tools are asked. Not tool calls or
  tool output. The Recall server analyses them with its language model, so only point this at a server you trust.
- **Injected:** up to about `context_tokens` tokens of peer card and related facts per turn (Hermes adds the
  `<memory-context>` fence and its system note), plus the static system-prompt note.

## Check that it works

```bash
hermes memory status                              # "recall ... ← active"
hermes chat -q "I moved to Utrecht last month" -Q  # prints session_id: <id>
recall session messages hermes-<id> --last 2       # your message and the reply
```

Then, in a new chat, ask "where do I live?".

## Tests

`tests/test_recall_provider.py` (unittest, no dependencies) covers settings, recording, recall, tools and outages
against a live server, and, when run with the Python of a Hermes install, loads the provider through Hermes' plugin
loader and drives it with Hermes' `MemoryManager`:

```bash
RECALL_TEST_URL=http://localhost:8000 python3 integrations/hermes/tests/test_recall_provider.py -v
```

Recall's own test suite starts a Recall server and runs this file against it, also through a Hermes interpreter.

## Notes on the Hermes extension points

Built against the Hermes developer guide ("Building a Memory Provider Plugin") and `agent/memory_provider.py` of
hermes-agent 0.19.0, and tested with that release: through `plugins.memory.load_memory_provider` and
`MemoryManager`, and with a one-shot `hermes chat -q` turn against a local stand-in model, where the recalled context
reached the model and the turn was recorded. Not tested: gateway platforms (Telegram, Discord, ...), where
`user_id` and `gateway_session_key` drive `peer_from_user` and `per-chat`, and installing with
`hermes plugins install`.
