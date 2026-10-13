# Recall for ChatGPT and Codex (OpenAI plugin package)

A portable plugin package (`plugin.json`, `mcp.json`, `assets/`) for OpenAI's plugin directory. It
connects ChatGPT and Codex to Recall's hosted MCP server, `https://api.recallmem.dev/mcp`, with
OAuth: the client is ChatGPT's own public client ID metadata document
(`https://chatgpt.com/oauth/client.json`), which the server resolves as a CIMD client with its
redirect URIs. The package has no hooks and no skills, as the public directory requires.

To use Recall in ChatGPT without the directory, add it as a connector in developer mode with the
same URL and sign in; see [the docs](https://recallmem.dev/docs#mcp-connector). For Codex with
hooks that recall and record every turn, use [`integrations/codex`](../codex/README.md) instead.

Build the ZIP for an upload (files at the archive root, nothing else):

```sh
cd integrations/openai && zip -X -r ../../recall-memory-openai.zip plugin.json mcp.json assets
```

Raise `version` in `plugin.json` for every new upload. Reviewer credentials go in the portal,
never in the package.
