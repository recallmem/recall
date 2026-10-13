import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/context.js";
import { customerUsage } from "../src/http/redact.js";

const ctx = (hosted: boolean) => ({ config: { tenancy: { hosted } } }) as unknown as AppContext;
const usage = {
  total: { calls: 3, input_tokens: 10, cost_usd: 0.002, unpriced_calls: 0 },
  items: [{ task: "chat_low", provider: "openai", model: "gpt-6-luna", calls: 3, cost_usd: 0.002 }],
};

describe("customer usage in hosted mode", () => {
  it("hides provider cost, vendors and models from customers", () => {
    const out = JSON.stringify(customerUsage(ctx(true), usage));
    expect(out).not.toMatch(/cost_usd|unpriced|openai|gpt-6-luna|provider|model/);
    expect(out).toMatch(/"calls":3/);
  });
  it("keeps models the route already named publicly, still without provider or cost", () => {
    const named = {
      items: [{ task: "chat_low", provider: "openrouter", model: "recall-lumen", cost_usd: 0.002 }],
    };
    expect(customerUsage(ctx(true), named, { modelsNamed: true })).toEqual({
      items: [{ task: "chat_low", model: "recall-lumen" }],
    });
  });
  it("leaves self-hosted responses untouched", () => {
    expect(customerUsage(ctx(false), usage)).toEqual(usage);
  });
});
