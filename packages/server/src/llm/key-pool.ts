import { sql } from "drizzle-orm";
import type { LlmTask } from "../config.js";
import { type Db, rows } from "../db/client.js";
import type { AccountModel, AccountModels, KeyPool } from "./client.js";
import type { Effort } from "./types.js";

/** How long a workspace's pool is remembered; flagging an account takes effect within this. */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Key pool by account: the operator marks benchmark accounts with `metadata.llm_key = "eval"`
 * (admin API only), and their workspaces' calls then use the eval provider keys.
 */
export function accountKeyPool(db: Db): KeyPool {
  const cache = new Map<string, { pool: "eval" | null; until: number }>();
  return async (workspaceId) => {
    const hit = cache.get(workspaceId);
    if (hit && hit.until > Date.now()) return hit.pool;
    const [r] = await rows<{ k: string | null }>(
      db,
      sql`SELECT a.metadata->>'llm_key' AS k FROM workspaces w JOIN accounts a ON a.id = w.account_id
          WHERE w.id = ${workspaceId}`,
    );
    const pool = r?.k === "eval" ? "eval" : null;
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(workspaceId, { pool, until: Date.now() + TTL_MS });
    return pool;
  };
}

const TASKS = new Set<string>([
  "reasoner",
  "summary",
  "card",
  "dream",
  "chat_minimal",
  "chat_low",
  "chat_medium",
  "chat_high",
  "chat_max",
]);

const EFFORTS = new Set<string>(["none", "low", "medium", "high"]);
const MODEL_REF = /^[a-z0-9_-]+\/\S+$/;

/** One task's entry: "provider/model", or {"model": "provider/model", "effort": "none"}; null if unusable. */
function accountModel(v: unknown): AccountModel | null {
  const model = typeof v === "string" ? v : (v as { model?: unknown } | null)?.model;
  if (typeof model !== "string" || !MODEL_REF.test(model) || model.endsWith(":free")) return null;
  const effort = typeof v === "object" && v ? (v as { effort?: unknown }).effort : undefined;
  if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.has(effort))) return null;
  return effort ? { model, effort: effort as Effort } : { model };
}

/**
 * Per-task models by account: on accounts the operator enabled for experiments
 * (`metadata.answer_model_override`), `metadata.models` (admin API only) picks the model of a task,
 * e.g. `{"reasoner": "openrouter/deepseek/deepseek-v4-flash"}` to build that account's memory with
 * another model, or `{"reasoner": {"model": "...", "effort": "none"}}` to also set how hard it
 * reasons. Anything else (unknown task or effort, not "provider/model", a ":free" model) is ignored.
 */
export function accountModels(db: Db): AccountModels {
  const cache = new Map<
    string,
    { models: Partial<Record<LlmTask, AccountModel>> | null; until: number }
  >();
  return async (workspaceId) => {
    const hit = cache.get(workspaceId);
    if (hit && hit.until > Date.now()) return hit.models;
    const [r] = await rows<{ m: unknown }>(
      db,
      sql`SELECT a.metadata->'models' AS m FROM workspaces w JOIN accounts a ON a.id = w.account_id
          WHERE w.id = ${workspaceId} AND a.metadata->>'answer_model_override' = 'true'`,
    );
    let models: Partial<Record<LlmTask, AccountModel>> | null = null;
    if (r?.m && typeof r.m === "object" && !Array.isArray(r.m)) {
      const picked = Object.entries(r.m as Record<string, unknown>)
        .filter(([task]) => TASKS.has(task))
        .map(([task, v]) => [task, accountModel(v)] as const)
        .filter(([, m]) => m !== null);
      if (picked.length)
        models = Object.fromEntries(picked) as Partial<Record<LlmTask, AccountModel>>;
    }
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(workspaceId, { models, until: Date.now() + TTL_MS });
    return models;
  };
}
