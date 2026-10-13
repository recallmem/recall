// Guide: https://recallmem.dev/guides/multi-agent
// A planner and a researcher share one workspace: each keeps its own view of the others, retries
// are safe, and a webhook wakes an agent when new knowledge is ready.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { constructWebhookEvent, Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "acme-agents" })) {
  // #region setup
  const user = recall.peer("user-8412");
  const planner = recall.peer("agent-planner");
  const researcher = recall.peer("agent-researcher");

  // One session per job. Each agent in it builds its own view of the others from what it saw.
  // The job also joins the team's scope, the memory the whole team shares.
  const job = recall.session("job-58213", {
    peers: {
      "user-8412": {},
      "agent-planner": { observeOthers: true },
      "agent-researcher": { observeOthers: true },
    },
    scopes: ["team-pricing"],
  });
  // #endregion

  // #region record
  // The orchestrator records each step under a key that names it. A retry after a crash or a
  // timeout returns the stored messages instead of storing them twice.
  const step = (n: number) => ({ idempotencyKey: `job-58213:step-${n}` });
  await job.addMessages(
    [user.message("Compare our Pro plan with the three biggest competitors by Friday.")],
    step(1),
  );
  const findings = [
    researcher.message("Competitor A raised its Pro plan to €49 a month in September."),
    researcher.message("B and C still charge €39; C gives two months free on yearly plans."),
    planner.message("Next: draft a price proposal. Researcher, check annual discounts at A."),
  ];
  await job.addMessages(findings, step(2));
  await job.addMessages(findings, step(2)); // the retry: nothing is stored twice
  // #endregion

  // #region views
  // What does the planner know about the researcher's findings? Its own view: only what it saw.
  // (waitForIdle is for this demo; agents rarely block on learning.)
  await recall.waitForIdle();
  const known = await planner.chat("What has the researcher found about competitor prices?", {
    target: researcher,
    reasoningLevel: "low",
  });
  // The researcher's view of the user, as prompt context for its next step (no model call).
  const ctx = await job.context({ peerTarget: user, peerPerspective: researcher, tokens: 2000 });
  const prompt = ctx.toOpenAI(researcher);
  // #endregion

  // #region team
  // Shared team memory: ask across every job in the team's scope, not through one agent's eyes.
  const shared = await recall.chat("What do we know about competitor pricing?", {
    scope: "team-pricing",
    reasoningLevel: "low",
  });
  // #endregion

  // #region webhook
  // Your HTTP handler for Recall's webhook: verify the raw body before you parse it.
  async function onRecallWebhook(rawBody: string, signature: string | null, secret: string) {
    const event = await constructWebhookEvent<{ observer: string; session_id: string }>(
      rawBody,
      signature,
      secret,
    );
    // queue.empty: learning for this session is done. Wake the agent whose view changed.
    if (event.type !== "queue.empty" || event.data.observer !== planner.id) return null;
    return planner.chat("What is new in this job since my last step?", {
      session: event.data.session_id,
      reasoningLevel: "minimal",
    });
  }
  // #endregion

  // Not shown in the guide: one signed delivery, the way Recall sends it.
  const { createHmac } = await import("node:crypto");
  const secret = "demo-webhook-secret";
  const body = JSON.stringify({
    data: { observed: researcher.id, observer: planner.id, session_id: job.id },
    timestamp: new Date().toISOString(),
    type: "queue.empty",
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const woken = await onRecallWebhook(body, signature, secret);
  return { known, prompt, shared, woken };
}
