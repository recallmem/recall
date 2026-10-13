import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { rows } from "../src/db/client.js";
import { accountKeyPool, accountModels } from "../src/llm/key-pool.js";
import { createTestServer } from "./helpers.js";
import { seed } from "./reasoner-fixtures.js";

type Server = Awaited<ReturnType<typeof createTestServer>>;
let server: Server | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("accountKeyPool", () => {
  it("puts workspaces of accounts marked llm_key=eval in the eval pool", async () => {
    server = await createTestServer();
    const { ctx } = server;
    const s = await seed(ctx, { peers: ["alice"] });
    const [w] = await rows<{ account_id: string }>(
      ctx.db,
      sql`SELECT account_id FROM workspaces WHERE id = ${s.workspaceId}`,
    );
    // A fresh pool per reading: the cache would otherwise keep the first answer for minutes.
    expect(await accountKeyPool(ctx.db)(s.workspaceId)).toBeNull();
    await ctx.db.execute(
      sql`UPDATE accounts SET metadata = metadata || '{"llm_key": "eval"}'::jsonb WHERE id = ${w!.account_id}`,
    );
    expect(await accountKeyPool(ctx.db)(s.workspaceId)).toBe("eval");
    expect(await accountKeyPool(ctx.db)("no-such-workspace")).toBeNull();
  });
});

describe("accountModels", () => {
  it("reads metadata.models only on accounts enabled for experiments, and drops what is not a model", async () => {
    server = await createTestServer();
    const { ctx } = server;
    const s = await seed(ctx, { peers: ["alice"] });
    const [w] = await rows<{ account_id: string }>(
      ctx.db,
      sql`SELECT account_id FROM workspaces WHERE id = ${s.workspaceId}`,
    );
    const models = {
      reasoner: "openrouter/deepseek/deepseek-v4-flash",
      summary: { model: "openrouter/deepseek/deepseek-v4-flash", effort: "none" },
      card: { model: "openrouter/deepseek/deepseek-v4-flash", effort: "extreme" },
      dream: "no-slash",
      chat_low: "openrouter/some/model:free",
      embedding: "openai/text-embedding-3-small",
    };
    await ctx.db.execute(
      sql`UPDATE accounts SET metadata = metadata || ${JSON.stringify({ models })}::jsonb WHERE id = ${w!.account_id}`,
    );
    // Without the experiments flag the operator's models are not used.
    expect(await accountModels(ctx.db)(s.workspaceId)).toBeNull();
    await ctx.db.execute(
      sql`UPDATE accounts SET metadata = metadata || '{"answer_model_override": true}'::jsonb WHERE id = ${w!.account_id}`,
    );
    expect(await accountModels(ctx.db)(s.workspaceId)).toEqual({
      reasoner: { model: "openrouter/deepseek/deepseek-v4-flash" },
      summary: { model: "openrouter/deepseek/deepseek-v4-flash", effort: "none" },
    });
    expect(await accountModels(ctx.db)("no-such-workspace")).toBeNull();
  });
});
