import type { Context } from "hono";
import { z } from "zod";
import type { ClientIpConfig, ClientIpSource } from "../config.js";
import { cleanIp, rangeMatcher } from "../lib/network.js";
import { parseBody, ValidationError } from "./validate.js";

/** FastAPI-style boolean query parameter (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`, `t`/`f`, `y`/`n`). */
export const boolParam = z
  .string()
  .transform((v, ctx) => {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on", "t", "y"].includes(s)) return true;
    if (["false", "0", "no", "off", "f", "n"].includes(s)) return false;
    ctx.addIssue({
      code: "custom",
      message: "Input should be a valid boolean, unable to interpret input",
    });
    return z.NEVER;
  })
  .pipe(z.boolean());

/**
 * Parses a JSON body that may be absent or `null` (the list routes). Returns
 * undefined when there is no body, otherwise the validated value.
 */
export async function optionalBody<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.infer<T> | undefined> {
  const parsed = await parseBody(c, schema.nullish());
  return parsed ?? undefined;
}

/** A `{ "type": "...", "loc": [...], "msg": "..." }` 422 for a single offending field. */
export function invalid(
  where: "body" | "query" | "path",
  field: string,
  msg: string,
  input: unknown = null,
): ValidationError {
  return new ValidationError([{ type: "value_error", loc: [where, field], msg, input }]);
}

/** Filters accepted by every list route: `{ "filters": object|null }`. */
export const FiltersBody = z.object({ filters: z.record(z.string(), z.unknown()).nullish() });

const matchers = new WeakMap<readonly string[], (ip: string) => boolean>();

/** The TCP peer's address (Node server); null on runtimes without one (Vercel's Web handlers). */
function socketAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return cleanIp(env?.incoming?.socket?.remoteAddress);
}

/** The address the configured proxy reports (or the socket's), before the Cloudflare step. */
function proxyAddress(c: Context, source: ClientIpSource): string | null {
  if (source.kind === "socket") return socketAddress(c);
  if (source.kind === "header") {
    // Proxies that set these overwrite them; if one ever appended, the last entry is its own.
    return cleanIp(c.req.header(source.header)?.split(",").at(-1));
  }
  const entries = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  // Without the header the request did not come through the proxy: the peer is the client.
  if (entries.length === 0) return socketAddress(c);
  // Each trusted proxy appended the address it saw; anything further left is client-supplied.
  return cleanIp(entries[Math.max(0, entries.length - source.hops)]);
}

/**
 * The client's IP address, for per-IP limits, from the source the operator trusts
 * (RECALL_TRUSTED_PROXY / RECALL_CLIENT_IP_HEADER; see config.ts). Headers the
 * trusted proxy does not set are ignored, so a client cannot choose its address
 * by sending `Fly-Client-IP`, `X-Forwarded-For` or `CF-Connecting-IP` itself.
 * When that address is one of Cloudflare's edge servers, Cloudflare's
 * `CF-Connecting-IP` is the client. Null when unknown (limits then skip the
 * per-IP check).
 */
export function clientIp(c: Context, cfg: ClientIpConfig): string | null {
  const seen = proxyAddress(c, cfg.source);
  if (!seen || !cfg.cloudflare) return seen;
  let viaCloudflare = matchers.get(cfg.cloudflare);
  if (!viaCloudflare) {
    viaCloudflare = rangeMatcher(cfg.cloudflare);
    matchers.set(cfg.cloudflare, viaCloudflare);
  }
  if (!viaCloudflare(seen)) return seen;
  return cleanIp(c.req.header("cf-connecting-ip")) ?? seen;
}
