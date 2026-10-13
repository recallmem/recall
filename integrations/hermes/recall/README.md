# Recall memory provider for Hermes Agent

Long-term memory from a [Recall](https://recallmem.dev) server: recalled context before each turn,
each exchange recorded, built-in user facts mirrored, and `recall_search` / `recall_ask` / `recall_remember` /
`recall_forget` tools.

Copy this folder to `~/.hermes/plugins/recall`, then run `hermes memory setup` and pick `recall` (or set
`memory.provider: recall` and put `url`, `workspace` and `peer` in `~/.hermes/recall.json`, the API key in
`RECALL_API_KEY`). Full documentation: `integrations/hermes/README.md` in the Recall repository.
