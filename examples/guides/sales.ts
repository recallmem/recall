// Guide: https://recallmem.dev/guides/sales
// A sales copilot: contacts and reps as peers, a call transcript and an email thread with a
// file, account and deal scopes, and a structured meeting brief. Run by
// packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "crm-org-5531" })) {
  // #region setup
  // Contacts at the prospect are peers, keyed by your CRM contact ids.
  const cfo = recall.peer("contact-2210", { metadata: { title: "CFO" } });
  const itLead = recall.peer("contact-2211", { metadata: { title: "Head of IT" } });
  // Recall learns about prospects, not about your reps.
  const rep = recall.peer("rep-104", { configuration: { observeMe: false } });
  // One scope per account and one per deal: every call and thread about them.
  const account = recall.scope("acct-381");
  const deal = recall.scope("deal-7781", { metadata: { stage: "evaluation" } });
  // #endregion

  // #region call
  // A discovery call from your recorder's transcript: one message per turn, each dated with when
  // it was said, so "next quarter" is reckoned from the call, not from the upload.
  const call = recall.session("call-90211", { scopes: [account] });
  const start = Date.parse("2026-10-02T14:00:00Z");
  const at = (seconds: number) => new Date(start + seconds * 1000);
  await call.addMessages([
    rep.message("Thanks for making time. What made you start looking?", { createdAt: at(0) }),
    cfo.message("Month-end close takes eight days. I want it under five by next quarter.", {
      createdAt: at(9),
    }),
    itLead.message("Whatever we pick must use our SSO. The last vendor failed our review.", {
      createdAt: at(31),
    }),
    cfo.message("Budget is approved up to 40k a year. Above that it goes to the board.", {
      createdAt: at(88),
    }),
  ]);
  await deal.addSessions([call]);
  // #endregion

  // #region email
  // An email thread is a session too. The requirements the Head of IT attached go in with
  // uploadFile, as their words (PDF, text or JSON; long files become several messages).
  const thread = recall.session("email-4410", { scopes: [account, deal] });
  const sent = "2026-10-05T08:30:00Z";
  await thread.addMessages([
    itLead.message("Attached are our requirements. SSO and EU hosting are must-haves.", {
      createdAt: sent,
    }),
  ]);
  const requirements =
    "Must: SAML single sign-on.\nMust: data stored in the EU.\nNice: ERP export.";
  await thread.uploadFile(
    { filename: "requirements.txt", content: new TextEncoder().encode(requirements) },
    itLead,
    { createdAt: sent },
  );
  // #endregion

  // #region brief
  // Before the next meeting: one question across the whole deal, answered as JSON your UI lays
  // out. (With zod: { jsonSchema: z.toJSONSchema(Brief), parse: (d) => Brief.parse(d) }.)
  type MeetingBrief = {
    stakeholders: { contact: string; role: string; cares_about: string }[];
    objections: string[];
    next_steps: string[];
    open_questions: string[];
  };
  const text = { type: "string" };
  const list = { type: "array", items: text };
  const schema = {
    type: "object",
    properties: {
      stakeholders: {
        type: "array",
        items: {
          type: "object",
          properties: { contact: text, role: text, cares_about: text },
          required: ["contact", "role", "cares_about"],
        },
      },
      objections: list,
      next_steps: list,
      open_questions: list,
    },
    required: ["stakeholders", "objections", "next_steps", "open_questions"],
  };
  await recall.waitForIdle(); // for this demo; briefs are made later, when learning is done
  const brief = await recall.chat(
    "Prepare me for the next meeting on this deal: who is involved and what each cares about, " +
      "their objections, the next steps we agreed and the questions still open.",
    {
      scope: deal,
      reasoningLevel: "medium",
      responseFormat: { jsonSchema: schema, parse: (data) => data as MeetingBrief },
    },
  );
  // #endregion

  // #region contact
  // A quick question about one person, from everything they said in any call or thread.
  const cfoNeeds = await cfo.chat("What does this contact need to see before signing?", {
    reasoningLevel: "low",
  });
  // #endregion

  // #region forget
  // A contact asks you to delete their data: erase their words and everything learned about
  // them, in every call, thread and scope. Keep the result for your deletion log.
  const removed = await itLead.delete();
  // #endregion
  return { brief, cfoNeeds, removed };
}
