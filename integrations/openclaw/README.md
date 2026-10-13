# Recall memory for OpenClaw

An [OpenClaw](https://docs.openclaw.ai) plugin that gives your assistant long-term memory through
[Recall](https://recallmem.dev).

- **Recall.** Before each turn (`before_prompt_build`) it adds what Recall knows about you, focused on the message
  at hand: your peer card and the most relevant facts, in a `<recall-memory>` block marked as background
  information, not instructions.
- **Record.** After each turn (`agent_end`) it stores your message and the assistant's final reply in a Recall
  session per OpenClaw session (`oc-<session key>`, e.g. `oc-agent-main-main`). The assistant is a non-observed
  peer (`openclaw`): facts are learned about you, not from its own replies. Heartbeat and cron turns are not
  recorded.
- **Tools.** `recall_search` (facts and past messages, with fact ids), `recall_ask` (a reasoned answer from
  memory), `recall_remember` (save facts you state) and `recall_forget` (delete a fact by id).

It runs next to OpenClaw's own memory: it does not take the `memory` slot, so `memory-core` (or whichever memory
plugin you use) keeps working. Lookups time out after a few seconds, a failure makes it skip Recall for a minute,
and turns that could not be sent are kept in memory (up to 100) and delivered in order once Recall answers again.
A turn never fails because Recall is down.

## Install

Needs OpenClaw 2026.9.9 or later. The plugin is plain JavaScript with no dependencies; it is not published to
ClawHub or npm yet, so install it from a checkout:

```bash
git clone https://github.com/RedSix6/recall-plugin
openclaw plugins install ./recall-plugin/integrations/openclaw --force --accept-capabilities
```

(`--force` confirms the local source and `--accept-capabilities` records your consent to its tools and hooks;
without them OpenClaw asks interactively. Use `plugins install -l <path>` to link the checkout instead of
copying it.)

Both hooks read the conversation, which OpenClaw only allows for a third-party plugin once you grant it:

```bash
openclaw config set plugins.entries.recall-memory.hooks '{"allowConversationAccess":true}' --strict-json --merge
```

Then say where Recall is, either in the plugin's config:

```bash
openclaw config set plugins.entries.recall-memory.config \
  '{"url":"https://your-recall.example","workspace":"my-workspace","peer":"your-name"}' --strict-json --merge
```

or with `RECALL_URL`, `RECALL_API_KEY`, `RECALL_WORKSPACE_ID` and `RECALL_PEER_ID` in the Gateway's environment, or
in `~/.recall/config.json` (written by `recall init`). Put the API key in the environment or that file rather than
in `openclaw.json`; if you do set `apiKey` in the plugin config, `${VAR}` placeholders are expanded. Restart the
Gateway (or run `openclaw plugins reload recall-memory`) to load it.

## Configuration

`plugins.entries.recall-memory.config` keys, falling back to the environment and then to `~/.recall/config.json`
(where a `hosts.openclaw` object overrides the top level):

| Key (env) | Default | |
|---|---|---|
| `url` (`RECALL_URL`) | `https://api.recallmem.dev` | Recall server URL |
| `apiKey` (`RECALL_API_KEY`) | none | API key |
| `workspace` (`RECALL_WORKSPACE_ID`) | `default` | Where memory lives |
| `peer` (`RECALL_PEER_ID`) | your OS user | You, as Recall knows you. Keep it stable |
| `assistantPeer` (`RECALL_ASSISTANT_PEER`) | `openclaw` | Peer the assistant's replies are recorded as |
| `lookup` (`RECALL_LOOKUP`) | `turn` | `turn`: memory on every user turn. `first-turn`: once per session. `off`: tools only |
| `record` (`RECALL_RECORD`) | `true` | `false` stops recording |
| `recordAutomated` | `false` | Also record heartbeat and cron turns |
| `peerFromSender` | `false` | Use the channel sender (`<channel>-<sender id>`) as the peer, for an assistant several people talk to |
| `contextTokens` (`RECALL_CONTEXT_TOKENS`) | `1200` | Size of the memory added to a turn |
| `timeoutMs` (`RECALL_TIMEOUT_MS`) | `4000` | Timeout for lookups and recording |

The tools always act on the configured `peer`.

## What gets sent and injected

- **Sent:** for each successful user turn, your message as you typed it (OpenClaw's `currentUserMessage`, without
  channel envelopes; the transcript's last user message when that is missing) and the assistant's final text, each
  cut to 24,000 characters, with the run id as metadata. Not tool calls or tool results. The Recall server analyses
  them with its language model, so only point this at a server you trust.
- **Injected:** a `<recall-memory>` block prepended to the turn (`prependContext`), about `contextTokens` tokens.

## Check that it works

```bash
openclaw plugins inspect recall-memory --runtime --json   # lists the four recall_* tools
openclaw agent --local -m "I moved to Utrecht last month" --session-key agent:main:recall-check
recall session messages oc-agent-main-recall-check --last 2   # your message and the reply
```

(`plugins inspect` loads plugins for tool discovery only, so it shows the tools but not the hooks.) In a later
conversation ask "where do I live?" or have the agent call `recall_search`.

## Troubleshooting

- Nothing recorded or injected: check `plugins.entries.recall-memory.hooks.allowConversationAccess` is `true`, and
  that `hooks.allowPromptInjection` is not `false`.
- Warnings appear in the Gateway log prefixed `[recall]`, e.g. when Recall is unreachable.
- `Plugin manifest id "recall-memory" differs from npm package name` during install is expected.

## Notes on the OpenClaw extension points

Built against the OpenClaw plugin SDK docs and type declarations of 2026.9.9 and tested with that release: the
plugin was installed with `openclaw plugins install`, and an `openclaw agent --local` turn (embedded runner)
received the memory block and was recorded (Recall's own test suite runs this when `OPENCLAW_BIN` points at an
`openclaw` command). Not tested: turns run by the Codex or Copilot harness
runtimes, whose hook coverage OpenClaw documents separately, and taking the exclusive `memory` slot (this plugin
deliberately does not).
