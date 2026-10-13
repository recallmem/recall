# Guide: https://recallmem.dev/guides/community-bots
# A bot in a busy Discord server: every member a peer, channels as sessions, batched writes, the
# bot's own view for public replies and DMs kept out of it.
# Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import Peer, PeerConfig, Recall, SessionPeerConfig


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="discord-912847561203948572")

    # region setup
    # One workspace per server. Members are peers keyed by their platform user id, never by
    # display name, which members change and share.
    def member(user_id: str) -> Peer:
        return recall.peer(f"discord-{user_id}")

    # The bot learns about members, not from its own lines.
    bot = recall.peer("bot")
    bot.set_configuration(PeerConfig(observe_me=False))

    # A channel (or thread) is a session. In public channels the bot builds its own view of
    # every member who speaks; members join the session with their first message.
    general = recall.session(
        "ch-1129384756102938475", peers={"bot": SessionPeerConfig(observe_others=True)}
    )
    # endregion

    # region channel
    # Two members talk in #general.
    asker = member("284711093281726464")
    helper = member("391028475610293847")
    # Messages not addressed to the bot wait in a buffer, stored in one request every few seconds.
    buffer = [
        asker.message("Anyone stuck on the level 12 boss? I play a frost mage."),
        helper.message("Frost will not work there, it is immune. Bring a fire staff."),
    ]
    general.add_messages(buffer)
    buffer.clear()

    # A member mentions the bot: store the message and get context in one request, read through
    # the bot's own view, so nothing said in a DM comes up in a public channel.
    mention = asker.message("@bot any tips for that boss with my build?")
    result = general.turn([mention], peer_target=asker, peer_perspective=bot, tokens=1500)
    prompt = result.context.to_openai(assistant=bot)
    # Your model writes the reply from `prompt`; store it so the channel history is complete.
    answer = "As a frost mage, swap to a fire staff for this fight."
    general.add_messages([bot.message(answer)])
    # endregion

    # region dm
    # A DM is a session of its own, and the bot does not observe it: what a member says here goes
    # only into their own memory, which the bot reads here (no perspective), never in public.
    dm = recall.session("dm-391028475610293847", peers=[helper, bot])
    reply = dm.turn(
        [helper.message("Between us, I may leave the raid team.")], peer_target=helper, tokens=1500
    )
    # endregion

    # region ask
    # Per-member memory: what has the bot learned about this member in public channels?
    # (wait_for_idle is for this demo; a bot never blocks on learning.)
    recall.wait_for_idle()
    known = bot.chat(
        "What does this member play, and what do they need help with?",
        target=asker,
        reasoning_level="minimal",
    )
    # endregion

    # region forget
    # `/forget`, or a member who leaves the server: erase them from this server's memory.
    removed = asker.delete()
    # endregion
    return {"prompt": prompt, "dm_context": reply.context, "known": known, "removed": removed}
