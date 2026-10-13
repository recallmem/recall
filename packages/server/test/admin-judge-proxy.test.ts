import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRequest } from "../src/llm/types.js";
import { ADMIN, createHostedServer, type HostedServer } from "./hosted-helpers.js";

let s: HostedServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const admin = { authorization: `Bearer ${ADMIN}` };

describe("admin OpenAI-compatible judge route", () => {
  it("runs the same OpenAI model through OpenRouter and answers in OpenAI's format", async () => {
    s = await createHostedServer();
    const seen: LlmRequest[] = [];
    s.ctx.llm.complete = vi.fn(async (req: LlmRequest) => {
      seen.push(req);
      return {
        text: "yes",
        stopReason: "end",
        provider: "openrouter",
        model: "openai/gpt-4o-2024-08-06",
        usage: { inputTokens: 90, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 0 },
        latencyMs: 5,
        costUsd: 0.0003,
        toolCalls: [],
      } as never;
    }) as never;
    // What the official LongMemEval grader sends.
    const res = await s.api(
      "POST",
      "/admin/v1/openai/chat/completions",
      {
        model: "gpt-4o-2024-08-06",
        messages: [
          { role: "system", content: "You grade answers." },
          { role: "user", content: [{ type: "text", text: "Is the model response correct?" }] },
        ],
        n: 1,
        temperature: 0,
        max_tokens: 10,
        response_format: {
          type: "json_schema",
          json_schema: { name: "v", schema: { type: "object" } },
        },
      },
      admin,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "gpt-4o-2024-08-06",
      choices: [
        { index: 0, message: { role: "assistant", content: "yes" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
    });
    expect(seen[0]).toMatchObject({
      task: "eval_judge",
      model: "openrouter/openai/gpt-4o-2024-08-06",
      system: "You grade answers.",
      messages: [{ role: "user", content: "Is the model response correct?" }],
      maxTokens: 10,
      temperature: 0,
      jsonSchema: { name: "v", schema: { type: "object" } },
      workspaceId: null,
    });
  });

  it("is for operators only and takes plain model names", async () => {
    s = await createHostedServer();
    const req = { model: "gpt-4.1-mini", messages: [{ role: "user", content: "hi" }] };
    expect((await s.api("POST", "/admin/v1/openai/chat/completions", req)).status).toBe(401);
    const odd = { ...req, model: "anthropic/../x" };
    expect((await s.api("POST", "/admin/v1/openai/chat/completions", odd, admin)).status).toBe(422);
  });
});
