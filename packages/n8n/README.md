# @recall-memory/n8n-nodes-recall

[Recall](https://recallmem.dev) for [n8n](https://n8n.io): long-term memory for the AI Agent that remembers each
user across conversations, and a node (also usable as an agent tool) to ask, search and update what Recall knows.

Recall learns dated facts about each person from the conversations it stores, closes facts that stop being true,
and links every fact to the message it came from.

## Install

In a self-hosted n8n: **Settings → Community Nodes → Install**, and enter `@recall-memory/n8n-nodes-recall`.

Then add a **Recall API** credential: an API key from <https://app.recallmem.dev/keys> ($5 of free credit, no card),
a workspace name (one per app), and the server (leave `https://api.recallmem.dev`, or your self-hosted Recall).

## Recall Memory (AI Agent memory)

Connect it to an **AI Agent** node's Memory input, like n8n's own memory nodes. On every run it gives the agent:

1. what Recall knows about the user from **every** earlier conversation (a profile and the most relevant facts), and
2. this conversation within a token budget: a summary of older turns, then the latest messages.

After the agent answers, the turn is stored, so Recall keeps learning. The agent's replies are kept as context,
never as facts about anyone.

| Field | What to put |
|---|---|
| Session ID | The conversation. The default reads the Chat Trigger's session. |
| User ID | Who the agent talks to: an email address, `{{ $json.message.from.id }}` for Telegram, a customer ID. Recall remembers this person in every conversation. With the default (the session) it only remembers within one. |
| Options → Memory Placement | **System Message** (default) or **User Message**. Choose User Message with Anthropic or Gemini chat models, which accept a system message only first. |
| Options → Context Tokens | Budget for the conversation's history (default 2,000). |
| Options → Relevant To | Recall brings the facts most relevant to this text (default: the incoming chat message). |
| Options → Include What Recall Knows | Turn off to use Recall only as conversation memory. |

Clearing the memory (the Chat Memory Manager's delete) deletes the session from Recall.

## Recall (node and agent tool)

| Operation | Does |
|---|---|
| Ask Memory | Answers a question in plain language from everything Recall remembers about a person. |
| Remember a Fact | Saves a fact, for example one the user asked the agent to remember. |
| Search Memory | Facts and messages about a person that match a query. |
| Get Profile | The short list of stable facts Recall keeps about a person. |
| Add Message | Stores a message (a support ticket, an email) so Recall learns from it, outside an AI Agent. |

Connected to an AI Agent's **Tool** input, the agent decides when to call it: "What did this customer order last
time?", "Remember that I'm vegetarian".

IDs may use letters, digits, `_` and `-`. Any other id is cleaned up and given a short hash of the original, so `jane@example.com` becomes `jane_example_com_` plus 10 characters and two different ids never share a memory. (Version 0.1.0 left out the hash; ids that had other characters map to new peers from 0.2.0. The workspace name is mapped as before.)

## Pricing and data

Learning costs $1.75 per million message tokens; a question at the default level costs $0.005. Data is stored in
Frankfurt. Self-host Recall to keep everything on your own servers. Docs: <https://recallmem.dev/guides/n8n>.

## License

MIT. The Recall server is source-available (FSL-1.1-ALv2): <https://github.com/recallmem/recall>.
