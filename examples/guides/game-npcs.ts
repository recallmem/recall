// Guide: https://recallmem.dev/guides/game-npcs
// Two NPCs in one save game. Each remembers the player from what it saw itself; the game decides
// when a rumour spreads. Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "save-7f3a" })) {
  // #region setup
  const player = recall.peer("player");
  // Your game writes the NPCs' lines, so Recall need not learn about them (cheaper, see below).
  const npc = { configuration: { observeMe: false } };
  const mira = recall.peer("npc-mira", { ...npc, metadata: { role: "blacksmith" } });
  const tomas = recall.peer("npc-tomas", { ...npc, metadata: { role: "innkeeper" } });

  // One session per scene. Mira takes part and keeps her own view of the player.
  const forge = recall.session("forge-day-3", {
    peers: [player, [mira, { observeOthers: true }]],
  });
  // #endregion

  // #region turn
  // One request per line of dialogue: store the player's line, get back what Mira knows.
  const { context } = await forge.turn(
    [
      player.message(
        "I lost your hammer in the river. I'll pay you 30 gold by the harvest festival.",
      ),
    ],
    { peerTarget: player, peerPerspective: mira, tokens: 2000 },
  );
  const prompt = context.toOpenAI(mira); // Mira's memory as system messages, then the scene
  // Your game's own model writes Mira's line from `prompt`; store it so she remembers saying it.
  const line = "Thirty gold by the festival, then. I'll hold you to that.";
  await forge.addMessages([mira.message(line)]);
  // #endregion

  // #region ask
  // Quest logic, not dialogue: what does Mira believe? One model call, so keep it off the
  // frame loop. (waitForIdle is for this demo; a game asks later, when learning is done.)
  await recall.waitForIdle();
  const debt = await mira.chat("Does the player owe me anything? How much, and by when?", {
    target: player,
    reasoningLevel: "minimal",
  });
  // #endregion

  // #region gossip
  // Tomas was not at the forge, so he knows nothing yet. When your story says the news has
  // travelled, write it into his view of the player yourself.
  await tomas
    .conclusionsOf(player)
    .create("Heard from Mira: the player lost her hammer and owes her 30 gold.");
  const rumour = await tomas.chat("What have I heard about the player?", {
    target: player,
    reasoningLevel: "minimal",
  });
  // #endregion

  // #region forget
  // A new game drops the whole save: its scenes first, then the workspace.
  const scenes = [];
  for await (const scene of await recall.sessions()) scenes.push(scene);
  for (const scene of scenes) await scene.delete();
  await recall.deleteWorkspace();
  // To forget one player and keep the world: await player.delete()
  // #endregion
  return { prompt, debt, rumour };
}
