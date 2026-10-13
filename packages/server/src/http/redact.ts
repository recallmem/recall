import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { publicModel } from "../llm/codenames.js";

/** Fields that reveal our provider cost (the margin) or which vendors we use; `model` see below. */
const PROVIDER_FIELDS = new Set(["cost_usd", "unpriced_calls", "provider"]);

/**
 * Customer-facing usage in hosted mode: calls and tokens per task, without our provider cost or
 * vendor names. `model` fields are dropped too, unless the caller already replaced them with
 * public names (`modelsNamed`, see `modelNamer`). Self-hosted operators see everything. The
 * operator admin API (/admin/v1) is not passed through this.
 */
export function customerUsage<T>(
  ctx: AppContext,
  body: T,
  opts: { modelsNamed?: boolean } = {},
): T {
  if (!ctx.config.tenancy.hosted) return body;
  // An account the operator set up is not billed: its month-to-date figure would be our provider
  // cost, so only the cap and its state are shown.
  if (body && typeof body === "object" && "budget" in body && !("credit" in body)) {
    const {
      month_to_date_usd: _spent,
      remaining_usd: _left,
      ...budget
    } = (body as { budget: Record<string, unknown> }).budget;
    body = { ...body, budget };
  }
  const hidden = (k: string) => PROVIDER_FIELDS.has(k) || (k === "model" && !opts.modelsNamed);
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !hidden(k))
          .map(([k, x]) => [k, strip(x)]),
      );
    }
    return v;
  };
  return strip(body) as T;
}

/** The public name of a call's model, from its task and "provider/model" reference. */
export type ModelNamer = (task: string, ref: string) => string;

/**
 * How one account's customer-facing output (usage, the data export) names models: null on a
 * self-hosted server, where the operator chose the models and keys and sees the real ids. On the
 * hosted service the default models go by their codenames (llm/codenames.ts). Only accounts the
 * operator enabled for experiments (`metadata.answer_model_override`, admin API only) choose
 * models themselves, with X-Recall-Answer-Model or per-task account models; those keep their
 * real ids, since the account asked for them by name.
 */
export async function modelNamer(ctx: AppContext, accountId: string): Promise<ModelNamer | null> {
  if (!ctx.config.tenancy.hosted) return null;
  const [row] = await rows<{ own: boolean | null }>(
    ctx.db,
    sql`SELECT (metadata->>'answer_model_override') = 'true' AS own FROM accounts WHERE id = ${accountId}`,
  );
  const ownModels = row?.own === true;
  return (task, ref) => publicModel(ctx.config, ref, task, { ownModels });
}
