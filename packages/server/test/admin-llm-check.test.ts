import { afterEach, describe, expect, it } from "vitest";
import { LlmError } from "../src/llm/types.js";
import { ADMIN, createHostedServer, type HostedServer } from "./hosted-helpers.js";

let s: HostedServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const admin = { authorization: `Bearer ${ADMIN}` };

describe("admin LLM check", () => {
  it("reports the model that answered, and the provider's own error when it fails", async () => {
    s = await createHostedServer();
    const ok = await (await s.api("POST", "/admin/v1/llm-check", {}, admin)).json();
    expect(ok).toMatchObject({ ok: true, task: "chat_low" });
    expect(typeof ok.model).toBe("string");

    s.ctx.llm.mock.respondWith(() => {
      throw new LlmError(
        "openrouter/x/y: 402 Insufficient credits (key sk-or-v1-abcdef0123456789)",
        "provider",
        Object.assign(new Error("402"), { status: 402 }),
      );
    });
    const failed = await (
      await s.api("POST", "/admin/v1/llm-check", { task: "reasoner" }, admin)
    ).json();
    expect(failed).toMatchObject({ ok: false, task: "reasoner", kind: "provider", status: 402 });
    expect(failed.error).toContain("402 Insufficient credits");
    expect(failed.error).not.toContain("abcdef0123456789");
  });

  it("is for operators only", async () => {
    s = await createHostedServer();
    expect((await s.api("POST", "/admin/v1/llm-check", {})).status).toBe(401);
  });
});
