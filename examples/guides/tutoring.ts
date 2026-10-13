// Guide: https://recallmem.dev/guides/tutoring
// A maths tutor that follows one learner across lessons: a structured learner model, a
// misconception that gets corrected, a teacher's search and the end-of-year deletion.
// Run by packages/sdk/test/guides.test.ts against a real server.
import { Recall } from "@recall-memory/sdk";

export async function main(recall = new Recall({ workspaceId: "school-2207-y2026" })) {
  // #region setup
  // A pseudonymous id from your own system: no name, email or class in Recall.
  const learner = recall.peer("learner-5531");
  // The tutor is your app, so Recall learns about the learner, not from the tutor's own lines.
  const tutor = recall.peer("tutor", { configuration: { observeMe: false } });

  // One session per lesson or homework session, filed under the course it belongs to.
  const course = "course-math-7";
  const lesson = recall.session("lesson-40817", { peers: [learner, tutor], scopes: [course] });
  // #endregion

  // #region lesson
  // Each learner message: store it and get back what the tutor should know, in one request.
  const { context } = await lesson.turn(
    [learner.message("1/8 is bigger than 1/4, right? Because 8 is bigger than 4.")],
    { peerTarget: learner, tokens: 2000 },
  );
  const prompt = context.toOpenAI(tutor); // what Recall knows about the learner, then the lesson
  // Your model writes the tutor's reply from `prompt`; store it so the lesson stays complete.
  await lesson.addMessages([
    tutor.message("One pizza cut into 8 slices, one cut into 4. Which slice is bigger?"),
  ]);
  // #endregion

  // #region learner-model
  // Before the next lesson: the learner model as JSON your app can show and act on.
  // (waitForIdle is for this demo; by the next lesson, learning has long finished.)
  await recall.waitForIdle();
  type LearnerModel = { mastered: string[]; misconceptions: string[]; nextGoal: string };
  const list = { type: "array", items: { type: "string" } };
  const learnerModel = {
    jsonSchema: {
      type: "object",
      properties: {
        mastered: { ...list, description: "Skills the learner has shown they can do" },
        misconceptions: { ...list, description: "Mistakes the learner still makes" },
        nextGoal: { type: "string", description: "The one thing to practise next" },
      },
      required: ["mastered", "misconceptions", "nextGoal"],
    },
    // With zod: { jsonSchema: z.toJSONSchema(Schema), parse: (data) => Schema.parse(data) }
    parse: (data: unknown) => data as LearnerModel,
  };
  const model = await learner.chat(
    "What has this learner mastered, what do they still get wrong, and what should come next?",
    { scope: course, reasoningLevel: "low", responseFormat: learnerModel },
  );
  // #endregion

  // #region corrected
  // Two weeks later, in homework, the learner has it right. Recall closes the old fact instead
  // of deleting it: context and the learner model show what holds now; chat can say what changed.
  const homework = recall.session("homework-40822", { peers: [learner, tutor], scopes: [course] });
  await homework.addMessages([
    learner.message("Wait, 1/8 is smaller than 1/4. More slices means smaller slices."),
  ]);
  await recall.waitForIdle(); // demo only, as above
  const progress = await learner.chat(
    "Which misconceptions has this learner corrected, and when?",
    { scope: course, reasoningLevel: "low" },
  );
  // #endregion

  // #region teacher
  // The teacher's view: the learner's own words about a topic, across every lesson, with the
  // session each came from. Search takes about a second and is included in the price.
  const found = await learner.search("fractions pizza slices", { limit: 20 });
  const excerpts = found.map((m) => ({ lesson: m.sessionId, at: m.createdAt, said: m.content }));
  // #endregion

  // #region forget
  // A learner leaves: delete their sessions (the tutor's replies quote them), then the learner.
  for (const s of await (await learner.sessions()).toArray()) await s.delete();
  await learner.delete();
  // End of the school year: every session, then the workspace (refused while sessions remain).
  for (const s of await (await recall.sessions()).toArray()) await s.delete();
  await recall.deleteWorkspace();
  // #endregion
  return { prompt, model, progress, excerpts };
}
