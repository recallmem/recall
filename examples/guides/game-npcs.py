# Guide: https://recallmem.dev/guides/game-npcs
# Two NPCs in one save game. Each remembers the player from what it saw itself; the game decides
# when a rumour spreads. Run by sdks/python/tests/test_guides.py against a real server.
from __future__ import annotations

from typing import Any

from recall_memory import PeerConfig, Recall, SessionPeerConfig


def main(recall: Recall | None = None) -> dict[str, Any]:
    recall = recall or Recall(workspace_id="save-7f3a")
    # region setup
    player = recall.peer("player")
    # Your game writes the NPCs' lines, so Recall need not learn about them (cheaper, see below).
    npc = PeerConfig(observe_me=False)
    mira = recall.peer("npc-mira", configuration=npc, metadata={"role": "blacksmith"})
    tomas = recall.peer("npc-tomas", configuration=npc, metadata={"role": "innkeeper"})

    # One session per scene. Mira takes part and keeps her own view of the player.
    forge = recall.session(
        "forge-day-3",
        peers=[player, (mira, SessionPeerConfig(observe_others=True))],
    )
    # endregion

    # region turn
    # One request per line of dialogue: store the player's line, get back what Mira knows.
    result = forge.turn(
        [
            player.message(
                "I lost your hammer in the river. I'll pay you 30 gold by the harvest festival."
            )
        ],
        peer_target=player,
        peer_perspective=mira,
        tokens=2000,
    )
    prompt = result.context.to_openai(assistant=mira)  # Mira's memory, then the scene
    # Your game's own model writes Mira's line from `prompt`; store it so she remembers saying it.
    line = "Thirty gold by the festival, then. I'll hold you to that."
    forge.add_messages([mira.message(line)])
    # endregion

    # region ask
    # Quest logic, not dialogue: what does Mira believe? One model call, so keep it off the
    # frame loop. (wait_for_idle is for this demo; a game asks later, when learning is done.)
    recall.wait_for_idle()
    debt = mira.chat(
        "Does the player owe me anything? How much, and by when?",
        target=player,
        reasoning_level="minimal",
    )
    # endregion

    # region gossip
    # Tomas was not at the forge, so he knows nothing yet. When your story says the news has
    # travelled, write it into his view of the player yourself.
    tomas.conclusions_of(player).create(
        [{"content": "Heard from Mira: the player lost her hammer and owes her 30 gold."}]
    )
    rumour = tomas.chat(
        "What have I heard about the player?", target=player, reasoning_level="minimal"
    )
    # endregion

    # region forget
    # A new game drops the whole save: its scenes first, then the workspace.
    for scene in list(recall.sessions()):
        scene.delete()
    recall.delete_workspace(recall.workspace_id)
    # To forget one player and keep the world: player.delete()
    # endregion
    return {"prompt": prompt, "debt": debt, "rumour": rumour}
