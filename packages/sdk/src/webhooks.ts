import { RecallError } from "./errors.js";

/**
 * Verifying the webhooks Recall sends. Every delivery carries an
 * `X-Recall-Signature` header: the hex HMAC-SHA256 of the exact request body,
 * keyed with your account's webhook secret (dashboard → Settings; a self-hosted server without
 * accounts uses `RECALL_WEBHOOK_SECRET`). Verify the raw body text, before parsing it.
 */

export interface WebhookEvent<T = Record<string, unknown>> {
  type: string;
  timestamp: string;
  data: T;
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, body: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is not available in this runtime");
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await subtle.sign("HMAC", key, body as BufferSource));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `signature` is the correct HMAC of `body` under `secret`. Never throws on a bad signature. */
export async function verifyWebhookSignature(
  body: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const expected = await hmacHex(secret, bytes);
  const given = signature
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  return equalConstantTime(expected, given);
}

/**
 * Checks the signature and returns the parsed event, or throws `RecallError`.
 * With `toleranceSeconds`, events older than that are rejected too (replay protection).
 */
export async function constructWebhookEvent<T = Record<string, unknown>>(
  body: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<WebhookEvent<T>> {
  if (!(await verifyWebhookSignature(body, signature, secret))) {
    throw new RecallError("Webhook signature does not match", 0, { code: "invalid_signature" });
  }
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let event: WebhookEvent<T>;
  try {
    event = JSON.parse(text) as WebhookEvent<T>;
  } catch {
    throw new RecallError("Webhook body is not JSON", 0, { code: "invalid_body" });
  }
  if (opts.toleranceSeconds !== undefined) {
    const sent = Date.parse(event.timestamp);
    const now = opts.now ?? Date.now();
    if (Number.isNaN(sent) || Math.abs(now - sent) > opts.toleranceSeconds * 1000) {
      throw new RecallError("Webhook timestamp is outside the tolerance window", 0, {
        code: "stale_event",
      });
    }
  }
  return event;
}
