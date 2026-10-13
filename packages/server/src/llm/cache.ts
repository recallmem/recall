import { countTokens } from "../lib/tokens.js";
import type { LlmRequest } from "./types.js";

/**
 * Prompt caching, provider-neutral. Every request is laid out static-first
 * (docs/ARCHITECTURE.md, "Prompt layout and caching"): tools and the output
 * schema, then the fixed `system` instructions, then `context`, then the
 * messages. This module decides where the cache breakpoints go; each provider
 * writes them in its own wire format.
 *
 * - Anthropic caches only at explicit `cache_control` breakpoints.
 * - OpenAI GPT-5.6 and later bill cache writes at 1.25x input, and by default
 *   write one implicit breakpoint at the end of the last user message: the
 *   whole prompt, dynamic part included, is written on every call and almost
 *   never read again, while the shared instructions are never written on their
 *   own. Recall switches those models to explicit mode and marks the end of the
 *   static prefix instead. Earlier OpenAI models cache automatically at no
 *   write cost.
 */

/** Where a request gets cache breakpoints. */
export interface CachePlan {
  /** After the static prefix: tools, output schema and `system`. Shared by every call of a task. */
  system: boolean;
  /** After `context` (tool loops re-send it within seconds). */
  context: boolean;
  /** At the end of the conversation, so the next tool round reads this one. */
  messages: boolean;
}

export const NO_CACHE: CachePlan = { system: false, context: false, messages: false };

/** OpenAI's minimum cacheable prefix on GPT-5.6 and later, in visible tokens. */
export const OPENAI_CACHE_MINIMUM = 1024;

/**
 * Minimum cacheable prefix per Claude model (platform.claude.com prompt-caching
 * docs, Oct 2026). Accepts "claude-haiku-5-5" and OpenRouter's
 * "anthropic/claude-haiku-4.5". Unknown models get 1,024.
 */
export function anthropicCacheMinimum(model: string): number {
  const id = model.replace(/^anthropic\//, "").replace(/\./g, "-");
  if (/mythos-preview|3-5-haiku|haiku-3-5/.test(id)) return 2048;
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (!m) return 1024;
  const family = m[1]!;
  const major = Number(m[2]);
  const minor = Number(m[3] ?? 0);
  if (major >= 5) return family === "sonnet" && minor === 0 ? 1024 : 512;
  if (major === 4) {
    if (family === "haiku") return 4096;
    if (family === "opus") return minor === 5 || minor === 6 ? 4096 : minor === 7 ? 2048 : 1024;
  }
  return 1024;
}

/**
 * OpenAI models with explicit cache breakpoints and billed cache writes:
 * GPT-5.6 and later ("gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol"; also as
 * OpenRouter's "openai/gpt-6-luna").
 */
export function openAiExplicitCaching(model: string): boolean {
  const m = /^(?:openai\/)?gpt-(\d+)(?:\.(\d+))?/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

/**
 * The request's cache grouping key (OpenAI `prompt_cache_key`, OpenRouter
 * `session_id`). One key per task: the cached prefix is Recall's own static
 * prompt, identical for every workspace, so all workspaces share one cache
 * entry (one 1.25x write per task and 30 minutes on GPT-5.6+, and on earlier
 * models one routing group). Requests that also cache tenant content (tool
 * loops cache the memory pack) get a key per workspace, so no other tenant can
 * probe that content through cache hits.
 */
export function cacheKey(req: Pick<LlmRequest, "task" | "workspaceId" | "cacheContext">): string {
  return req.cacheContext && req.workspaceId
    ? `recall:${req.task}:${req.workspaceId}`
    : `recall:${req.task}`;
}

const counted = new Map<string, number>();

/** Token counts of the few static prompts, memoised (they repeat on every call). */
function countStatic(text: string): number {
  const hit = counted.get(text);
  if (hit !== undefined) return hit;
  const n = countTokens(text);
  if (counted.size >= 64) counted.clear();
  counted.set(text, n);
  return n;
}

/** o200k estimate of the static prefix: tool definitions, output schema and system prompt. */
export function staticPrefixTokens(req: LlmRequest): number {
  return (
    countStatic(req.system ?? "") +
    (req.tools?.length ? countStatic(JSON.stringify(req.tools)) : 0) +
    (req.jsonSchema ? countStatic(JSON.stringify(req.jsonSchema.schema)) : 0)
  );
}

/**
 * Breakpoints for a request on a provider whose minimum cacheable prefix is
 * `minimum` tokens. A breakpoint goes where the prefix before it can actually
 * be cached; the estimate is o200k with a 10% allowance, because Claude's
 * tokenizer counts more and a breakpoint that falls short is ignored at no cost.
 */
export function cachePlan(req: LlmRequest, minimum: number): CachePlan {
  const enough = (n: number) => n >= minimum * 0.9;
  const fixed = staticPrefixTokens(req);
  const plan: CachePlan = {
    system: !!req.system && enough(fixed),
    context: false,
    messages: false,
  };
  if (!req.cacheContext) return plan;
  const withContext = fixed + countTokens(req.context ?? "");
  plan.context = !!req.context && enough(withContext);
  plan.messages =
    req.messages.length > 0 &&
    (plan.context ||
      enough(withContext + req.messages.reduce((n, m) => n + countTokens(m.content), 0)));
  return plan;
}
