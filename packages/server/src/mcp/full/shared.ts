import { z } from "zod";
import type { AppContext } from "../../context.js";
import { newName, scopeName } from "../../core/schemas.js";
import { limitChat } from "../../http/auth.js";
import { type ChatInput, prepareChat, runChat } from "../../recall/chat.js";
import { fail, type McpSession } from "../kit.js";

/** Helpers and argument schemas used only by the full profile. */

/** Runs a non-streaming chat. Text by default (`"None"` when empty), a JSON object with evidence on request. */
export async function chatAnswer(
  ctx: AppContext,
  input: ChatInput,
  includeEvidence: boolean,
): Promise<unknown> {
  limitChat(ctx, input.auth);
  const prepared = await prepareChat(ctx, input);
  for await (const ev of runChat(ctx, prepared, false)) {
    if (ev.type !== "done") continue;
    const r = ev.result;
    if (!includeEvidence) return r.content?.length ? r.content : "None";
    return {
      content: r.content ?? "None",
      evidence: r.evidence,
      citations: r.citations,
      confidence: r.confidence,
      abstained: r.abstained,
    };
  }
  return fail("memory produced no answer");
}

/** A session id from the argument or the connection's default. */
export function sessionIdOf(arg: string | undefined, s: McpSession): string {
  return (
    arg ??
    s.session ??
    fail("session_id is required: pass it, or connect with the X-Recall-Session-ID header.")
  );
}

/** Fails when more than one of the named options is set. */
export function exclusive(options: Record<string, unknown>): void {
  const set = Object.entries(options)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k]) => k);
  if (set.length > 1) fail(`${set.join(", ")} are mutually exclusive: pass only one.`);
}

export const newScopeIdArg = scopeName.describe("Id for the scope.");
export const newPeerIdArg = newName;

export const scopeListArg = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(100)])
  .describe(
    "Limit to the sessions of one scope, or of up to 100 scopes. Exclusive with session_id and sessions.",
  );

export const sessionsAllowlistArg = z
  .array(z.string().min(1))
  .min(1)
  .max(1000)
  .describe("Only draw on these conversations (up to 1000). Exclusive with session_id and scope.");

export const filtersArg = (what: string) => z.record(z.string(), z.unknown()).describe(what);
