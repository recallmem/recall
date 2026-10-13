import { z } from "zod";
import { normalizeDatetime } from "../http/filters.js";
import { NAME_MAX, NAME_PATTERN } from "../lib/ids.js";
import { objectDepth } from "../lib/json.js";
import { countTokens } from "../lib/tokens.js";

/** Shared request-body building blocks (spec 01 sections 1.3, 1.5, 4). */

export const SCOPE_NAME_MAX = NAME_MAX - "scope.".length;
export const MAX_CUSTOM_INSTRUCTIONS_TOKENS = 2000;
export const MAX_METADATA_KEYS = 100;
export const MAX_METADATA_DEPTH = 5;
/** Serialized size of one metadata object (characters of JSON). */
export const MAX_METADATA_CHARS = 64 * 1024;
/** Largest message `content` accepted by the API (characters). */
export const MAX_MESSAGE_CHARS = 25_000;

const reserved = (v: string) => !v.startsWith("scope.");

/** A user-chosen resource id as sent on creation: 1-512 chars of `[a-zA-Z0-9_-]`, never `scope.`-prefixed. */
export const newName = z
  .string()
  .min(1)
  .max(NAME_MAX)
  .regex(NAME_PATTERN, { message: "String should match pattern '^[a-zA-Z0-9_-]+$'" })
  .refine(reserved, { message: "The prefix 'scope.' is reserved for scopes" });

export const scopeName = z
  .string()
  .min(1)
  .max(SCOPE_NAME_MAX)
  .regex(NAME_PATTERN, { message: "String should match pattern '^[a-zA-Z0-9_-]+$'" })
  .refine(reserved, { message: "Scope ids must not start with the reserved prefix 'scope.'" });

/** Free-form object with at most 100 top-level keys, nesting depth 5 and 64 KiB of JSON. */
export const metadata = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  if (Object.keys(value).length > MAX_METADATA_KEYS) {
    ctx.addIssue({
      code: "custom",
      message: `metadata may have at most ${MAX_METADATA_KEYS} keys`,
    });
  }
  if (objectDepth(value) > MAX_METADATA_DEPTH) {
    ctx.addIssue({
      code: "custom",
      message: `metadata nesting depth may be at most ${MAX_METADATA_DEPTH}`,
    });
  }
  if (JSON.stringify(value).length > MAX_METADATA_CHARS) {
    ctx.addIssue({
      code: "custom",
      message: `metadata may be at most ${MAX_METADATA_CHARS} characters of JSON`,
    });
  }
});

const instructions = z.string().nullish();
const flag = z.boolean().nullish();

/** `reasoning` block shared by workspace/session/message configuration. */
const reasoning = z.looseObject({ enabled: flag, custom_instructions: instructions }).nullish();

/**
 * Workspace and session configuration (identical shapes). Unknown keys are
 * accepted and preserved; null means "not set at this level".
 */
export const configuration = z
  .looseObject({
    custom_instructions: instructions,
    reasoning,
    peer_card: z
      .looseObject({ use: flag, create: flag, custom_instructions: instructions })
      .nullish(),
    summary: z
      .looseObject({
        enabled: flag,
        messages_per_short_summary: z.number().int().min(10).nullish(),
        messages_per_long_summary: z.number().int().min(20).nullish(),
        custom_instructions: instructions,
      })
      .nullish(),
    dream: z.looseObject({ enabled: flag, custom_instructions: instructions }).nullish(),
    dialectic: z.looseObject({ custom_instructions: instructions }).nullish(),
  })
  .superRefine((cfg, ctx) => {
    const short = cfg.summary?.messages_per_short_summary;
    const long = cfg.summary?.messages_per_long_summary;
    if (short != null && long != null && short >= long) {
      ctx.addIssue({
        code: "custom",
        path: ["summary"],
        message: "messages_per_short_summary must be less than messages_per_long_summary",
      });
    }
    const check = (value: unknown, path: (string | number)[]) => {
      if (typeof value !== "string" || value.trim() === "") return;
      // A token is rarely under two characters: far longer text is refused before counting it.
      if (
        value.length > MAX_CUSTOM_INSTRUCTIONS_TOKENS * 8 ||
        countTokens(value) > MAX_CUSTOM_INSTRUCTIONS_TOKENS
      ) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `custom_instructions exceeds the maximum of ${MAX_CUSTOM_INSTRUCTIONS_TOKENS} tokens`,
        });
      }
    };
    check(cfg.custom_instructions, ["custom_instructions"]);
    for (const block of ["reasoning", "peer_card", "summary", "dream", "dialectic"] as const) {
      check(
        (cfg[block] as { custom_instructions?: unknown } | null | undefined)?.custom_instructions,
        [block, "custom_instructions"],
      );
    }
  });

/** Per-message configuration: only reasoning can be overridden. */
export const messageConfiguration = z.looseObject({
  reasoning,
});

/** Session-membership configuration (`observe_me` / `observe_others`, both nullable). */
export const sessionPeerConfig = z.looseObject({
  observe_me: z.boolean().nullish(),
  observe_others: z.boolean().nullish(),
});
export type SessionPeerConfigInput = z.infer<typeof sessionPeerConfig>;

/** Body of add/set peers: peer id -> membership config. */
export const peersMap = z.record(z.string().min(1), sessionPeerConfig);

/** ISO-8601 request timestamp (offset optional, naive values are UTC), parsed to a Date. */
export const datetimeInput = z.string().transform((value, ctx) => {
  const iso = normalizeDatetime(value);
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: "custom", message: "Input should be a valid datetime" });
    return z.NEVER;
  }
  return date;
});

export const messageCreate = z.object({
  content: z.string().max(MAX_MESSAGE_CHARS),
  peer_id: z.string().min(1),
  metadata: metadata.nullish(),
  configuration: messageConfiguration.nullish(),
  created_at: datetimeInput.nullish(),
});

export const messageBatchCreate = z.object({ messages: z.array(messageCreate).min(1).max(100) });
