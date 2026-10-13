import { describe, expect, it } from "vitest";
import { asksAboutReplies, focusClip, focusTerms } from "../src/recall/pack.js";

describe("excerpts of long messages", () => {
  const reply = [
    "Great question! Here is a quick guide to budget places to stay in Amsterdam.",
    "Stayokay Amsterdam Vondelpark is near the park and popular with families.",
    "ClinkNOORD sits across the IJ river and has a free ferry to Centraal station.",
    "The Bulldog Hostel is lively and close to the canals.",
    ..."Prices vary by season, so book early, and check reviews before you pay. "
      .repeat(8)
      .split("  "),
    "If you want to be right by the Red Light District, the International Budget Hostel is a short walk away.",
    "Enjoy your trip!",
  ].join(" ");

  it("shows the part of a long reply that answers the question", () => {
    const terms = focusTerms("What was the name of that hostel near the Red Light District?");
    expect(terms).toEqual(expect.arrayContaining(["hostel", "near", "light", "district"]));
    expect(terms).not.toContain("what");
    const clipped = focusClip(reply, 300, terms);
    expect(clipped).toContain("International Budget Hostel");
    expect(clipped.startsWith("Great question!")).toBe(true); // the opening stays for context
    expect(clipped.length).toBeLessThan(470);
  });

  it("keeps short messages whole and falls back to the start without a better window", () => {
    expect(focusClip("Short and sweet.", 300, ["hostel"])).toBe("Short and sweet.");
    expect(focusClip(reply, 120, [])).toBe(`${reply.slice(0, 119)}…`);
    expect(focusClip(reply, 120, ["zebra"])).toBe(`${reply.slice(0, 119)}…`);
  });

  it("finds the item a question numbers, in a numbered list", () => {
    const list = Array.from(
      { length: 40 },
      (_, i) =>
        `${i + 1}. Parameter ${i + 1}: setting ${String.fromCharCode(65 + (i % 26))} for the output.`,
    ).join("\n");
    const reply = `Here are the parameters you can use to shape the output: ${list} Use them freely.`;
    const terms = focusTerms("Can you remind me what the 27th parameter was?");
    expect(terms).toContain("#27");
    expect(focusClip(reply, 160, terms)).toContain("27. Parameter 27");
    expect(focusTerms("What was the fifth bottle you recommended?")).toContain("#5");
    // "127." is not item 27: without a real item 27 the excerpt is the plain start.
    const noItem = "Intro. Total 127. Then more text that goes on for quite a while here.";
    expect(focusClip(noItem, 30, ["#27"])).toBe(`${noItem.slice(0, 29)}…`);
  });

  it("tells questions about what was said back from questions about the person", () => {
    for (const q of [
      "Can you remind me what was the 7th job in the list you provided?",
      "You recommended five bottles for gin cocktails. What was the fifth?",
      "I'm going back to our previous chat about the one-shot. How many mummies were there?",
      "I think we discussed work from home jobs for seniors earlier.",
      "Which game did you say was performed by skilled dancers?",
    ])
      expect(asksAboutReplies(q), q).toBe(true);
    for (const q of [
      "What degree did I graduate with?",
      "Can you recommend a hotel in Lisbon?",
      "How many days did I spend in Japan?",
      "What did I say my sister's name was?",
    ])
      expect(asksAboutReplies(q), q).toBe(false);
  });
});
