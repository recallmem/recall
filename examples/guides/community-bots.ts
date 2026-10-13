// Guide: https://recallmem.dev/guides/community-bots
// A bot in a busy Discord server: every member a peer, channels as sessions, batched writes, the
// bot's own view for public replies and DMs kept out of it.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "discord-912847561203948572" })) {
  // #region setup
  // One workspace per server. Members are peers keyed by their platform user id, never by
  // display name, which members change and share.
  const member = (userId: string) => recall.peer(`discord-${userId}`);
  // The bot learns about members, not from its own lines.
  const bot = recall.peer("bot");
  await bot.setConfiguration({ observeMe: false });

  // A channel (or thread) is a session. In public channels the bot builds its own view of
  // every member who speaks; members join the session with their first message.
  const general = recall.session("ch-1129384756102938475", {
    peers: { bot: { observeOthers: true } },
  });
  // #endregion

  // #region channel
  // Two members talk in #general.
  const asker = member("284711093281726464");
  const helper = member("391028475610293847");
  // Messages not addressed to the bot wait in a buffer, stored in one request every few seconds.
  const buffer = [
    asker.message("Anyone stuck on the level 12 boss? I play a frost mage."),
    helper.message("Frost will not work there, it is immune. Bring a fire staff."),
  ];
  await general.addMessages(buffer.splice(0));

  // A member mentions the bot: store the message and get context in one request, read through
  // the bot's own view, so nothing said in a DM comes up in a public channel.
  const mention = asker.message("@bot any tips for that boss with my build?");
  const { context } = await general.turn([mention], {
    peerTarget: asker,
    peerPerspective: bot,
    tokens: 1500,
  });
  const prompt = context.toOpenAI(bot);
  // Your model writes the reply from `prompt`; store it so the channel history is complete.
  const answer = "As a frost mage, swap to a fire staff for this fight.";
  await general.addMessages([bot.message(answer)]);
  // #endregion

  // #region dm
  // A DM is a session of its own, and the bot does not observe it: what a member says here goes
  // only into their own memory, which the bot reads here (no perspective), never in public.
  const dm = recall.session("dm-391028475610293847", { peers: [helper, bot] });
  const reply = await dm.turn([helper.message("Between us, I may leave the raid team.")], {
    peerTarget: helper,
    tokens: 1500,
  });
  // #endregion

  // #region ask
  // Per-member memory: what has the bot learned about this member in public channels?
  // (waitForIdle is for this demo; a bot never blocks on learning.)
  await recall.waitForIdle();
  const known = await bot.chat("What does this member play, and what do they need help with?", {
    target: asker,
    reasoningLevel: "minimal",
  });
  // #endregion

  // #region forget
  // `/forget`, or a member who leaves the server: erase them from this server's memory.
  const removed = await asker.delete();
  // #endregion
  return { prompt, dmContext: reply.context, known, removed };
}
