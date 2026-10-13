# Recall REST calls

Every call goes to `$RECALL_URL` with `Authorization: Bearer $RECALL_API_KEY` (omit the
header when the server runs without auth). Bodies are JSON. `$W` is the workspace id,
`$P` the user's peer id, `$S` a session id; ids use letters, digits, `_` and `-`.

```bash
B=$RECALL_URL; A="authorization: Bearer $RECALL_API_KEY"; J='content-type: application/json'
```

## Read

```bash
# Profile and facts about the user, optionally focused on a topic (no model call)
curl -s -H "$A" "$B/v3/workspaces/$W/peers/$P/context?max_conclusions=40&search_query=coffee"
#  -> {"peer_id", "target_id", "representation": "markdown facts", "peer_card": ["..."]}

# The peer card alone
curl -s -H "$A" "$B/v3/workspaces/$W/peers/$P/card"

# Facts closest to a query, with ids (for forgetting)
curl -s -X POST -H "$A" -H "$J" "$B/v3/workspaces/$W/conclusions/query" \
  -d "{\"query\":\"coffee\",\"top_k\":8,\"filters\":{\"observer_id\":\"$P\",\"observed_id\":\"$P\"}}"

# Messages matching a query, across all sessions
curl -s -X POST -H "$A" -H "$J" "$B/v3/workspaces/$W/search" -d '{"query":"coffee","limit":8}'

# Ask a question (one model call; reasoning_level minimal|low|medium|high|max)
curl -s -X POST -H "$A" -H "$J" "$B/v3/workspaces/$W/peers/$P/chat" \
  -d '{"query":"How does the user take their coffee?","reasoning_level":"low"}'
#  -> {"content": "answer", ...}

# Summary, recent messages and the user's facts for one conversation, within a token budget
curl -s -H "$A" "$B/v3/workspaces/$W/sessions/$S/context?tokens=2000&peer_target=$P"
```

## Write

```bash
# Save facts (the peer must exist: POST /peers is get-or-create)
curl -s -X POST -H "$A" -H "$J" "$B/v3/workspaces/$W/peers" -d "{\"id\":\"$P\"}"
curl -s -X POST -H "$A" -H "$J" "$B/v3/workspaces/$W/conclusions" \
  -d "{\"conclusions\":[{\"content\":\"Prefers oat milk\",\"observer_id\":\"$P\",\"observed_id\":\"$P\"}]}"

# Forget one fact
curl -s -X DELETE -H "$A" "$B/v3/workspaces/$W/conclusions/$CONCLUSION_ID"

# Record a conversation: create the session once (the assistant is not a source of facts),
# then add messages. Idempotency-Key makes a retried write safe.
curl -s -X POST -H "$A" -H "$J" "$B/v3/workspaces/$W/sessions" -d "{\"id\":\"$S\",\"peers\":{
  \"$P\":{\"observe_me\":true,\"observe_others\":false},
  \"assistant\":{\"observe_me\":false,\"observe_others\":false}}}"
curl -s -X POST -H "$A" -H "$J" -H "Idempotency-Key: turn-42" \
  "$B/v3/workspaces/$W/sessions/$S/messages" -d "{\"messages\":[
  {\"peer_id\":\"$P\",\"content\":\"I moved to Utrecht\"},
  {\"peer_id\":\"assistant\",\"content\":\"Welcome to Utrecht!\"}]}"
```

Messages are at most 25,000 characters each and 100 per call.

## Status and errors

- `GET /health` -> `{"status":"ok"}` (no auth).
- Errors are `{"detail": "..."}`. `401`: missing or wrong key. `404`: unknown workspace,
  peer, session or fact. `422`: invalid body.
- `GET /v3/workspaces/$W/queue/status` shows whether background learning is still running.
