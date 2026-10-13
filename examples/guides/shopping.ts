// Guide: https://recallmem.dev/guides/shopping
// A shopping assistant: account data as facts, preferences learned in chat, a return that
// updates what is known, preferences as catalogue filters, and opting out. Run by
// packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "shop-eu" })) {
  // #region setup
  // The shopper is a peer keyed by your customer id; the assistant is a peer Recall does not
  // learn about.
  const shopper = recall.peer("cust-1042", { metadata: { country: "NL" } });
  const assistant = recall.peer("shop-assistant", { configuration: { observeMe: false } });
  // Once, for the whole shop: what Recall should learn here, and what it must not.
  await recall.setConfiguration({
    reasoning: {
      customInstructions:
        "Record sizes and fit per brand, budgets, colours, styles, brands, diets the shopper " +
        "states, and returns with their reasons. Never record or guess health, pregnancy, " +
        "religion, ethnicity, sexuality or money trouble from purchases or messages.",
    },
  });
  // #endregion

  // #region account
  // What the shopper entered in their account is fact, not inference: store it as facts.
  await shopper.conclusions.create(["Shoe size EU 42.", "Eats vegan."]);
  // #endregion

  // #region return
  // A return from an earlier order, in the shopper's words from the returns form, dated when
  // it was filed. Recall learns from it like any message, and can close facts it contradicts.
  const order = recall.session("order-77120");
  await order.addMessages([
    shopper.message("Returning the Trailblaze GTX in 42: too small. I need a 43 in this brand.", {
      createdAt: "2026-10-08T17:20:00Z",
      metadata: { order: "77120", sku: "TB-GTX-42", reason: "too_small" },
    }),
  ]);
  // #endregion

  // #region chat
  // In the shop's chat: one request stores the message and returns what Recall knows about
  // the shopper for the reply. Preferences stated here are learned in the background.
  const visit = recall.session("chat-5e21c");
  const { context } = await visit.turn(
    [shopper.message("Trail shoes for muddy autumn runs, please. Nothing neon, max €150.")],
    { peerTarget: shopper, tokens: 2000 },
  );
  const prompt = context.toOpenAI(assistant);
  // Your model writes the reply from `prompt` and your catalogue; store it too.
  const reply = "The Trailblaze GTX in black grips well in mud, €139. In 43 this time?";
  await visit.addMessages([assistant.message(reply)]);
  // #endregion

  // #region filters
  // Turn memory into filters for your catalogue: ask for JSON once per visit and keep it in your
  // session. (waitForIdle is for this demo; real apps rarely block on learning.)
  await recall.waitForIdle();
  type Filters = {
    shoe_size_eu: number | null;
    max_price_eur: number | null;
    avoid_colours: string[];
    diet: string[];
  };
  const prefs = await shopper.chat("Which filters should a product search use for this shopper?", {
    reasoningLevel: "low",
    responseFormat: {
      jsonSchema: {
        type: "object",
        properties: {
          shoe_size_eu: { type: ["number", "null"] },
          max_price_eur: { type: ["number", "null"] },
          avoid_colours: { type: "array", items: { type: "string" } },
          diet: { type: "array", items: { type: "string" } },
        },
        required: ["shoe_size_eu", "max_price_eur", "avoid_colours", "diet"],
      },
      parse: (data: unknown) => data as Filters, // or a zod schema's parse
    },
  });
  const catalogue = [
    { sku: "TB-GTX-43", size: 43, price: 139, colour: "black" },
    { sku: "VX-9-43", size: 43, price: 165, colour: "neon green" },
  ];
  const picks = catalogue.filter(
    (p) =>
      (!prefs?.max_price_eur || p.price <= prefs.max_price_eur) &&
      !prefs?.avoid_colours.some((c) => p.colour.includes(c)),
  );
  // #endregion

  // #region opt-out
  // The shopper turns personalisation off: stop learning from their messages and drop every
  // fact memory holds about them. Their chats stay stored.
  // (To erase the shopper completely instead: await shopper.delete())
  await shopper.setConfiguration({ observeMe: false });
  const learned = await (await shopper.conclusions.list()).toArray();
  for (const fact of learned) await shopper.conclusions.delete(fact.id);
  await shopper.setCard([]);
  // #endregion
  return { prompt, prefs, picks, forgotten: learned.length };
}
