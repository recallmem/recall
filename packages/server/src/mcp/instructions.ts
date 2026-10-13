/**
 * The `instructions` string sent to an MCP client when it connects. Short on
 * purpose: every connected agent pays for these tokens on every session.
 */
export const MCP_INSTRUCTIONS = `Recall is the user's long-term memory across conversations. Look things up in it before answering anything that depends on what the user said earlier, and save what the user asks you to remember. Send only what a call needs: never the whole conversation or earlier turns.

Look up: chat answers a question from memory, with sources ("what do I prefer", "what did we decide"). search returns matching facts and messages. get_peer_card gives the most stable facts about a person. get_session_context gives the summary and latest messages of a recorded conversation.

Remember: when the user asks you to remember something, or corrects something stored, save it with create_conclusions, one short sentence per fact. add_messages_to_session stores specific messages the user wants kept, as they were said.

Forget: list_conclusions shows what is stored; delete_conclusion removes a fact the user wants forgotten or that is wrong.

Reading never creates anything: an unknown workspace, peer or session is reported as an error. Values you leave out (workspace_id, peer_id, session_id) fall back to this connection's defaults when it has them.`;

/**
 * The default profile for a connection with "Remember automatically" on (the OAuth default): the
 * app saves lasting facts as they come up instead of waiting to be asked.
 */
export const MCP_INSTRUCTIONS_AUTO = `Recall is the user's long-term memory across conversations. Look things up in it before answering anything that depends on what the user said earlier. Save lasting facts the user shares as they come up, without being asked, one short sentence per fact with create_conclusions. Send only what a call needs: never the whole conversation or earlier turns.

Look up: chat answers a question from memory, with sources ("what do I prefer", "what did we decide"). search returns matching facts and messages. get_peer_card gives the most stable facts about a person. get_session_context gives the summary and latest messages of a recorded conversation.

Remember: save a fact when the user states something lasting about themselves or the people in their life ("I'm vegetarian now", "my sister Ana lives in Porto"), makes a decision or a plan, asks you to remember something, or corrects something stored. Skip small talk, passing moods, one-off requests and anything the user asks you not to keep. Never save passwords, keys, payment details or health data unless the user explicitly asks. add_messages_to_session stores specific messages the user wants kept, as they were said.

Forget: list_conclusions shows what is stored; delete_conclusion removes a fact the user wants forgotten or that is wrong.

Reading never creates anything: an unknown workspace, peer or session is reported as an error. Values you leave out (workspace_id, peer_id, session_id) fall back to this connection's defaults when it has them.`;

/** Instructions for the `full` profile (all 40 tools). Still short: every connected agent pays for them. */
export const FULL_INSTRUCTIONS = `Recall is long-term memory. It learns durable facts (conclusions) about the people (peers) in the conversations (sessions) recorded in a workspace, and answers from them. This connection exposes the whole surface: workspaces, peers, sessions, scopes, conclusions and processing status.

Typical flow. Record: add_messages_to_session with one entry per turn (peer_id names the speaker); it creates the session and speakers on first use. Recall, cheapest first: get_peer_card, get_peer_context, get_session_context, search, list_conclusions or query_conclusions; use chat (one peer's memory) or workspace_chat (everything) only when a written answer is worth the wait. Learning from new messages is asynchronous: check get_queue_status instead of waiting.

Conventions. Use one stable peer_id per real person or agent, one session per coherent conversation, and scopes to group sessions you want to recall together. workspace_id is optional everywhere and defaults to this connection's workspace. Reading never creates anything: an unknown workspace, peer or session is reported as an error. Tools marked destructive (set_metadata, set_peer_card, delete_*, remove_*, schedule_dream) overwrite or remove data, so read first and change only what the user asked for. chat and workspace_chat return "None" when memory has no answer; pass include_evidence for the facts and messages behind one.`;
