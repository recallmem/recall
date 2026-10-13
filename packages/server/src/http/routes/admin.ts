import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { getBillingRow, ledgerEntries } from "../../billing/ledger.js";
import { dashboardLink } from "../../config.js";
import type { AppContext } from "../../context.js";
import {
  accountUsage,
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from "../../core/accounts.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../../core/apikeys.js";
import { eraseAccount } from "../../core/erase.js";
import { datetimeInput, metadata } from "../../core/schemas.js";
import { suspendAccount, unsuspendAccount } from "../../core/suspend.js";
import { addMember, issueLoginToken, normalizeEmail } from "../../core/users.js";
import { rows } from "../../db/client.js";
import { conflict, notFound, unprocessable } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { LlmError } from "../../llm/types.js";
import type { App } from "../app.js";
import { type AppEnv, requireOperator } from "../auth.js";
import { parseBody, parseQuery } from "../validate.js";

/**
 * Operator control plane (Recall extension, not part of Honcho's API):
 *
 *   POST   /admin/v1/accounts                     create an account (returns its webhook_secret)
 *   GET    /admin/v1/accounts                     list accounts
 *   GET    /admin/v1/accounts/{id}                one account (with webhook_secret)
 *   PATCH  /admin/v1/accounts/{id}                rename, set/clear monthly_budget_usd, rotate_webhook_secret
 *   DELETE /admin/v1/accounts/{id}                delete the account and all its data
 *   POST   /admin/v1/accounts/{id}/keys           create an API key (the key is shown once)
 *   GET    /admin/v1/accounts/{id}/keys           list keys (never the secret)
 *   GET    /admin/v1/accounts/{id}/usage          usage and budget for a period
 *   GET    /admin/v1/accounts/{id}/credits        prepaid balance and ledger (hosted billing)
 *   POST   /admin/v1/accounts/{id}/credits        grant (or correct) credit: {amount_usd, idempotency_key, note?}
 *   POST   /admin/v1/accounts/{id}/suspend        suspend: {reason}; its keys, OAuth tokens, sessions get 403
 *   POST   /admin/v1/accounts/{id}/unsuspend      lift the suspension
 *   DELETE /admin/v1/keys/{key_id}                revoke a key
 *
 * Protected by `Authorization: Bearer $RECALL_ADMIN_TOKEN` (constant-time
 * compare). When the token is not configured, every route answers 404.
 */

function adminOnly(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!ctx.config.tenancy.adminToken) return c.json({ detail: "Not Found" }, 404);
    await requireOperator(ctx, c);
    return next();
  };
}

const Budget = z.number().min(0).max(1_000_000_000);

/** OpenAI's chat-completions request, the fields a judge sends (anything else is ignored). */
const JudgeChat = z.object({
  model: z
    .string()
    .max(100)
    .regex(/^[a-z0-9][a-z0-9.:-]*$/i),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "developer", "user", "assistant"]),
        content: z.union([
          z.string(),
          z.array(z.object({ type: z.string(), text: z.string().optional() })),
        ]),
      }),
    )
    .min(1)
    .max(50),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(8000).optional(),
  max_completion_tokens: z.number().int().min(1).max(8000).optional(),
  response_format: z
    .object({
      type: z.string(),
      json_schema: z
        .object({ name: z.string(), schema: z.record(z.string(), z.unknown()) })
        .optional(),
    })
    .optional(),
});

const AccountCreate = z.object({
  name: z.string().min(1).max(200),
  monthly_budget_usd: Budget.nullish(),
  metadata: metadata.nullish(),
});

const LoginLink = z.object({
  email: z.string().min(3).max(254),
  /** Make the address an owner of this account first (e.g. one created with POST /accounts). */
  account_id: z.string().min(1).nullish(),
  /** How long the link works; links sent out of band may need longer than the default 15 minutes. */
  expires_in_minutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(15),
});

const AccountUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  /** null removes the cap. */
  monthly_budget_usd: Budget.nullable().optional(),
  metadata: metadata.nullish(),
  /** Issue a new webhook signing secret; the response then includes it. */
  rotate_webhook_secret: z.boolean().optional(),
});

const KeyCreate = z.object({
  name: z.string().max(200).nullish(),
  mode: z.enum(["live", "test"]).default("live"),
  workspace_id: z.string().min(1).nullish(),
  peer_id: z.string().min(1).nullish(),
  session_id: z.string().min(1).nullish(),
  rate_limit_per_min: z.number().int().min(1).max(1_000_000).nullish(),
  expires_at: datetimeInput.nullish(),
});

/** Positive grants credit; negative corrects. The key makes a retried grant a no-op. */
const CreditGrant = z.object({
  amount_usd: z.number().min(-1_000_000).max(1_000_000),
  idempotency_key: z.string().min(1).max(200),
  note: z.string().max(500).nullish(),
});

const Suspend = z.object({
  /** Why (kept for operators; the account's users see only that it is suspended). */
  reason: z.string().trim().min(1).max(500),
});

const LlmCheck = z.object({ task: z.string().trim().min(1).max(40).default("chat_low") });

/** Masks anything shaped like an API key or bearer token in a provider's error text. */
const redactSecrets = (text: string): string =>
  text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***");

const UsageQuery = z.object({
  since: datetimeInput.optional(),
  until: datetimeInput.optional(),
});

export function register(app: App, ctx: AppContext): void {
  app.use("/admin/*", adminOnly(ctx));
  const id = (c: { req: { param(name: string): string | undefined } }) =>
    c.req.param("account_id") ?? "";

  /**
   * One tiny completion on a task's configured model, for operators: when chat or the reasoner
   * fail with "provider unavailable", this returns the provider's own error (status and message),
   * which callers never see. Credentials never appear: the message is the provider's reply.
   */
  app.post("/admin/v1/llm-check", async (c) => {
    const { task } = await parseBody(c, LlmCheck);
    const started = Date.now();
    try {
      const r = await ctx.llm.complete({
        task,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        maxTokens: 16,
        workspaceId: null,
      });
      return c.json({
        ok: true,
        task,
        provider: r.provider,
        model: r.model,
        latency_ms: Date.now() - started,
        text: r.text.slice(0, 50),
      });
    } catch (err) {
      const cause = err instanceof LlmError ? err.cause : undefined;
      const status = (cause as { status?: unknown } | undefined)?.status;
      return c.json({
        ok: false,
        task,
        kind: err instanceof LlmError ? err.kind : "internal",
        status: typeof status === "number" ? status : null,
        error: redactSecrets(String((err as Error)?.message ?? err)).slice(0, 1000),
        latency_ms: Date.now() - started,
      });
    }
  });

  /**
   * OpenAI-compatible chat completions for the operator's benchmark judges, run on the same OpenAI
   * model through the server's OpenRouter account ("gpt-4o-2024-08-06" -> openrouter/openai/...),
   * metered as task eval_judge. Point a judge's OPENAI_BASE_URL at /admin/v1/openai with the admin
   * token as its key. Text only: one choice, no tools, no streaming.
   */
  app.post("/admin/v1/openai/chat/completions", async (c) => {
    const body = await parseBody(c, JudgeChat);
    const text = (content: z.infer<typeof JudgeChat>["messages"][number]["content"]) =>
      typeof content === "string" ? content : content.map((p) => p.text ?? "").join("");
    const system = body.messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => text(m.content))
      .join("\n\n");
    const messages = body.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: text(m.content) }));
    const schema = body.response_format?.json_schema;
    try {
      const r = await ctx.llm.complete({
        task: "eval_judge",
        model: `openrouter/openai/${body.model}`,
        ...(system ? { system } : {}),
        messages,
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 1000,
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(schema ? { jsonSchema: { name: schema.name, schema: schema.schema } } : {}),
        workspaceId: null,
      });
      return c.json({
        id: `chatcmpl-${newId()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: r.text },
            finish_reason: r.stopReason === "max_tokens" ? "length" : "stop",
          },
        ],
        usage: {
          prompt_tokens: r.usage.inputTokens + r.usage.cacheReadTokens,
          completion_tokens: r.usage.outputTokens,
          total_tokens: r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.outputTokens,
        },
      });
    } catch (err) {
      const status = (err instanceof LlmError ? err.cause : undefined) as
        | { status?: unknown }
        | undefined;
      const code = typeof status?.status === "number" ? status.status : 502;
      return c.json(
        { error: { message: redactSecrets(String((err as Error)?.message ?? err)).slice(0, 500) } },
        code === 429 ? 429 : 502,
      );
    }
  });

  app.post("/admin/v1/accounts", async (c) => {
    const body = await parseBody(c, AccountCreate);
    const account = await createAccount(ctx.db, {
      name: body.name,
      monthlyBudgetUsd: body.monthly_budget_usd ?? null,
      metadata: body.metadata ?? null,
    });
    return c.json(account, 201);
  });

  /**
   * A one-time dashboard sign-in link, for support and for deployments without
   * an email provider. With `account_id` the address becomes an owner of that
   * account; otherwise it must already belong to one (or sign-up must be open).
   */
  app.post("/admin/v1/login-links", async (c) => {
    const body = await parseBody(c, LoginLink);
    // On the dashboard's own host when it has one (RECALL_DASHBOARD_URL).
    const base = ctx.config.server.dashboardUrl;
    if (!ctx.config.hosted.dashboard || !base)
      throw unprocessable("The dashboard is off: set RECALL_PUBLIC_URL");
    const email = normalizeEmail(body.email);
    if (!email) throw unprocessable("Invalid email address");
    if (body.account_id) {
      await getAccount(ctx.db, body.account_id); // 404 when unknown
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO users (id, email) VALUES (${`usr_${newId()}`}, ${email})
                             ON CONFLICT (email) DO NOTHING`);
        const [user] = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM users WHERE email = ${email}`,
        );
        if (!user) throw notFound("user");
        await addMember(tx, body.account_id!, user.id, "owner");
      });
    }
    // Audited: a link with account_id makes its address an owner of that account.
    ctx.log.warn(
      { audit: "admin.login_link", email, account: body.account_id ?? null },
      "operator issued a sign-in link",
    );
    const issued = await issueLoginToken(ctx.db, email, null, body.expires_in_minutes * 60_000);
    if (!("token" in issued))
      throw conflict("Too many sign-in links for this address; wait 15 minutes");
    return c.json(
      {
        url: dashboardLink(ctx.config, `/auth/verify?token=${encodeURIComponent(issued.token)}`),
        email,
        account_id: body.account_id ?? null,
        expires_in_seconds: body.expires_in_minutes * 60,
      },
      201,
    );
  });

  app.get("/admin/v1/accounts", async (c) => c.json({ items: await listAccounts(ctx.db) }));

  app.get("/admin/v1/accounts/:account_id", async (c) =>
    c.json(await getAccount(ctx.db, id(c), { secrets: true })),
  );

  app.patch("/admin/v1/accounts/:account_id", async (c) => {
    const body = await parseBody(c, AccountUpdate);
    const account = await updateAccount(ctx.db, id(c), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.monthly_budget_usd !== undefined
        ? { monthlyBudgetUsd: body.monthly_budget_usd }
        : {}),
      metadata: body.metadata ?? null,
      rotateWebhookSecret: body.rotate_webhook_secret ?? false,
    });
    ctx.tenancy.budget.invalidate(account.id);
    return c.json(account);
  });

  app.delete("/admin/v1/accounts/:account_id", async (c) => {
    await eraseAccount(ctx, id(c));
    return c.body(null, 204);
  });

  // Prepaid credit (hosted billing): balance and history, and operator grants/corrections.
  app.get("/admin/v1/accounts/:account_id/credits", async (c) => {
    const account = await getAccount(ctx.db, id(c));
    const row = await getBillingRow(ctx.db, account.id);
    return c.json({
      account_id: account.id,
      billed: !!row,
      balance_usd: row ? row.balance_micros / 1_000_000 : null,
      entries: row ? await ledgerEntries(ctx.db, account.id, 200) : [],
    });
  });

  app.post("/admin/v1/accounts/:account_id/credits", async (c) => {
    if (!ctx.billing.enabled) throw conflict("Billing is not enabled on this server");
    const body = await parseBody(c, CreditGrant);
    const account = await getAccount(ctx.db, id(c));
    const micros = Math.round(body.amount_usd * 1_000_000);
    if (micros === 0) throw unprocessable("amount_usd must not be zero");
    const r = await ctx.billing.grant(account.id, micros, body.idempotency_key, body.note ?? null);
    return c.json(
      {
        account_id: account.id,
        applied: !!r?.applied,
        balance_usd: (r?.balanceMicros ?? 0) / 1_000_000,
      },
      r?.applied ? 201 : 200,
    );
  });

  // Suspension: the account's API keys, OAuth tokens and dashboard sessions get 403 until lifted.
  app.post("/admin/v1/accounts/:account_id/suspend", async (c) => {
    const body = await parseBody(c, Suspend);
    const account = await suspendAccount(ctx, id(c), body.reason);
    ctx.log.info(
      { account: account.id, operator: "admin_token", reason: body.reason },
      "admin api: account suspended",
    );
    return c.json(account);
  });

  app.post("/admin/v1/accounts/:account_id/unsuspend", async (c) => {
    const account = await unsuspendAccount(ctx, id(c));
    ctx.log.info(
      { account: account.id, operator: "admin_token" },
      "admin api: account unsuspended",
    );
    return c.json(account);
  });

  app.post("/admin/v1/accounts/:account_id/keys", async (c) => {
    const body = await parseBody(c, KeyCreate);
    const account = await getAccount(ctx.db, id(c));
    const { key, record } = await createApiKey(ctx.db, {
      accountId: account.id,
      name: body.name ?? "",
      mode: body.mode,
      workspace: body.workspace_id ?? null,
      peer: body.peer_id ?? null,
      session: body.session_id ?? null,
      rateLimitPerMin: body.rate_limit_per_min ?? null,
      expiresAt: body.expires_at ?? null,
    });
    return c.json({ ...record, key }, 201);
  });

  app.get("/admin/v1/accounts/:account_id/keys", async (c) => {
    const account = await getAccount(ctx.db, id(c));
    return c.json({ items: await listApiKeys(ctx.db, account.id) });
  });

  app.get("/admin/v1/accounts/:account_id/usage", async (c) => {
    const q = parseQuery(c, UsageQuery);
    await ctx.usage.flush();
    return c.json(await accountUsage(ctx.db, id(c), q));
  });

  app.delete("/admin/v1/keys/:key_id", async (c) => {
    const keyId = c.req.param("key_id");
    const record = await revokeApiKey(ctx.db, keyId);
    ctx.tenancy.keys.forget(keyId);
    return c.json(record);
  });
}
