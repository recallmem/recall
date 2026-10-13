import {
  AuthenticationError,
  ConflictError,
  Honcho,
  type Message,
  NotFoundError,
} from "@honcho-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainQueue } from "../src/queue/worker.js";
import { type Served, startServer } from "./integration-helpers.js";

/**
 * Switching from Honcho (recallmem.dev/guides/switch-from-honcho): Honcho's own published
 * TypeScript client, used as a black box, works against Recall after changing only the base URL
 * and the API key. The server runs with authentication on and a `pk_live_` key, as the hosted
 * service does. The guide's claims rest on this test; keep the two in step.
 */

const ADMIN = "operator-token-0123456789abcdef";
const op = { authorization: `Bearer ${ADMIN}` };

let s: Served;
let key: string;
beforeAll(async () => {
  s = await startServer({
    RECALL_AUTH_ENABLED: "true",
    RECALL_AUTH_SECRET: "honcho-client-secret-0123456789",
    RECALL_ADMIN_TOKEN: ADMIN,
    // Learn from new messages at once instead of waiting for a batch.
    RECALL_REASONER_MAX_DELAY_MS: "0",
  });
  const account = await (
    await s.server.request("POST", "/admin/v1/accounts", { name: "Migrating" }, op)
  ).json();
  key = (
    await (
      await s.server.request("POST", `/admin/v1/accounts/${account.id}/keys`, { name: "app" }, op)
    ).json()
  ).key;
  expect(key).toMatch(/^pk_live_/);
});
afterAll(() => s.stop());

describe("Honcho's TypeScript client (@honcho-ai/sdk) against Recall", () => {
  it("runs a whole app after changing only baseURL and apiKey", async () => {
    // The only two settings that change when moving from Honcho.
    const honcho = new Honcho({ baseURL: s.url, apiKey: key, workspaceId: "my-app" });

    const alice = await honcho.peer("alice");
    const assistant = await honcho.peer("assistant");
    const session = await honcho.session("support-42");
    await session.addPeers([alice, assistant]);
    const added: Message[] = await session.addMessages([
      alice.message("Hi! I live in Amsterdam and I'm vegetarian."),
      assistant.message("Noted. How can I help?"),
      alice.message("Update: we moved to Utrecht last week."),
    ]);
    expect(added.map((m) => m.peerId)).toEqual(["alice", "assistant", "alice"]);
    await drainQueue(s.server.ctx);
    const status = await honcho.queueStatus();
    expect(status.pendingWorkUnits).toBe(0);
    expect(status.completedWorkUnits).toBeGreaterThan(0);

    // Prompt context, in the client's own OpenAI and Anthropic shapes.
    const context = await session.context({ tokens: 2000, peerTarget: alice });
    expect(context.messages).toHaveLength(3);
    const openai = context.toOpenAI(assistant);
    expect(openai.at(-1)).toMatchObject({ role: "user", name: "alice" });
    expect(context.toAnthropic(assistant).length).toBeGreaterThan(0);

    // Questions: plain, with a level and session, with evidence, about another peer, streamed.
    expect(typeof (await alice.chat("Where does alice live?"))).toBe("string");
    expect(
      typeof (await alice.chat("Where does alice live?", {
        session,
        reasoningLevel: "minimal",
      })),
    ).toBe("string");
    const withEvidence = await alice.chat("Where does alice live?", { includeEvidence: true });
    expect(withEvidence.content?.length).toBeGreaterThan(0);
    expect(withEvidence.evidence).toBeDefined();
    expect(typeof (await assistant.chat("Where does alice live?", { target: alice }))).toBe(
      "string",
    );
    let streamed = "";
    for await (const chunk of await alice.chatStream("Where does alice live?")) streamed += chunk;
    expect(streamed.length).toBeGreaterThan(0);
    expect(typeof (await honcho.chat("Who moved recently?"))).toBe("string");

    // Search at every level.
    for (const hits of [
      await session.search("Utrecht"),
      await alice.search("Utrecht"),
      await honcho.search("Utrecht"),
    ])
      expect(hits.map((m) => m.content)).toContain("Update: we moved to Utrecht last week.");

    // Cards, representation, conclusions.
    await alice.setCard(["Lives in Utrecht", "Vegetarian"]);
    expect(await alice.getCard()).toEqual(["Lives in Utrecht", "Vegetarian"]);
    expect(typeof (await alice.representation())).toBe("string");
    expect((await alice.context()).peerId).toBe("alice");
    const created = await alice.conclusions.create({
      content: "Prefers email over phone",
      sessionId: "support-42",
    });
    expect(created[0]?.content).toBe("Prefers email over phone");
    expect((await alice.conclusions.list()).items.length).toBeGreaterThan(0);
    expect((await alice.conclusions.query("email")).map((c) => c.content)).toContain(
      "Prefers email over phone",
    );

    // Lists, metadata, files, clones, scopes.
    expect((await honcho.peers()).items.map((p) => p.id).sort()).toEqual(["alice", "assistant"]);
    expect((await session.messages()).items).toHaveLength(3);
    await alice.setMetadata({ plan: "pro" });
    expect(await alice.getMetadata()).toEqual({ plan: "pro" });
    const uploaded = await session.uploadFile(
      {
        filename: "notes.txt",
        content: Buffer.from("Alice's dog is Bo."),
        content_type: "text/plain",
      },
      alice,
    );
    expect(uploaded[0]?.content).toBe("Alice's dog is Bo.");
    expect((await session.clone()).id).not.toBe("support-42");
    expect((await honcho.scope("household")).id).toBe("household");
    expect((await session.summaries()).id).toBe("support-42");
  }, 60_000);

  it("raises the client's own errors", async () => {
    const wrongKey = new Honcho({
      baseURL: s.url,
      apiKey: `pk_live_${"x".repeat(32)}`,
      workspaceId: "my-app",
    });
    await expect(wrongKey.peers()).rejects.toBeInstanceOf(AuthenticationError);

    const honcho = new Honcho({ baseURL: s.url, apiKey: key, workspaceId: "errors" });
    const session = await honcho.session("s1");
    await session.addMessages([(await honcho.peer("bob")).message("I prefer tea.")]);
    await expect(session.getMessage("does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    // A workspace with sessions cannot be deleted, as in Honcho.
    await expect(honcho.deleteWorkspace("errors")).rejects.toBeInstanceOf(ConflictError);
  });
});
