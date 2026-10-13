import { createHmac } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { DEFAULT_ACCOUNT_ID } from "../core/tenancy.js";
import { isBlockedAddress } from "../core/webhooks.js";
import type { Db } from "../db/client.js";
import { rows } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { isoSeconds } from "../lib/time.js";
import { enqueue } from "../queue/enqueue.js";
import { type ClaimedJob, type JobOutcome, TerminalJobError } from "../queue/types.js";
import { textArray } from "../reasoner/util.js";

/**
 * Webhook events (spec 01 §5): `queue.empty` and `test.event`, POSTed as
 * compact sorted-key ASCII JSON, signed with HMAC-SHA256 over the exact body
 * in `X-Recall-Signature` (and, for compatibility, the same value in
 * `X-Honcho-Signature`). Improvements over the reference: each delivery is
 * its own queue job (retried with backoff, failures kept), and hosts that
 * resolve to private, loopback or link-local addresses are refused, checked
 * at connect time so DNS rebinding cannot slip through.
 */

type Tx = Pick<Db, "execute">;
const TIMEOUT_MS = 10_000;
/** The most one delivery may take from connecting to the response status, whatever the receiver does. */
const DEADLINE_MS = 15_000;

export type WebhookEventType = "queue.empty" | "test.event";

/** JSON with keys sorted at every level, no spaces, non-ASCII escaped as \uXXXX. */
export function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sortKeys(value)).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function signBody(body: string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(body, "utf8"))
    .digest("hex");
}

export function eventBody(
  type: string,
  data: Record<string, unknown>,
  at: Date = new Date(),
): string {
  return canonicalJson({ data, timestamp: isoSeconds(at), type });
}

/**
 * The secret that signs a workspace's webhooks: its account's own secret, or
 * RECALL_WEBHOOK_SECRET for the default (self-hosted / JWT) account. Hosted
 * accounts never share a secret, so one customer cannot forge another's events.
 */
export async function webhookSecretFor(
  ctx: Pick<AppContext, "config" | "db">,
  workspaceId: string | null,
  tx: Tx = ctx.db,
): Promise<string | null> {
  if (!workspaceId) return null;
  const [r] = await rows<{ account_id: string; secret: string | null }>(
    tx,
    sql`SELECT a.id AS account_id, a.webhook_secret AS secret
        FROM workspaces w JOIN accounts a ON a.id = w.account_id WHERE w.id = ${workspaceId}`,
  );
  if (!r) return null;
  if (r.secret) return r.secret;
  return r.account_id === DEFAULT_ACCOUNT_ID ? ctx.config.webhook.secret : null;
}

/**
 * Queues an event for every endpoint of the workspace (internal id). Pass the
 * caller's transaction when the event belongs to a write. Without a signing
 * secret, events are not sent (same as the reference).
 */
export async function emitWebhookEvent(
  ctx: Pick<AppContext, "config" | "db">,
  e: { workspaceId: string; type: WebhookEventType; data: Record<string, unknown> },
  tx: Tx = ctx.db,
): Promise<number> {
  if (!ctx.config.features.webhooks) return 0;
  if (!(await webhookSecretFor(ctx, e.workspaceId, tx))) return 0;
  const endpoints = await rows<{ id: string; url: string }>(
    tx,
    sql`SELECT id, url FROM webhook_endpoints WHERE workspace_id = ${e.workspaceId} ORDER BY created_at, id`,
  );
  const eventId = newId();
  for (const ep of endpoints) {
    await enqueue(tx, {
      kind: "webhook",
      workKey: `webhook:${ep.id}:${eventId}`,
      workspaceId: e.workspaceId,
      payload: { endpoint_id: ep.id, url: ep.url, event_id: eventId, type: e.type, data: e.data },
    });
  }
  return endpoints.length;
}

/** `queue.empty` for a drained unit: one event per (observer, observed) pair, or one with nulls. */
export async function emitQueueEmpty(
  ctx: AppContext,
  session: { id: string; name: string; workspaceId: string; workspaceName: string },
  queueType: "representation" | "summary",
  pairs: { observerId: string; observedId: string }[],
): Promise<void> {
  if (!ctx.config.features.webhooks) return;
  if (!(await webhookSecretFor(ctx, session.workspaceId))) return;
  const ids = [...new Set(pairs.flatMap((p) => [p.observerId, p.observedId]))];
  const names = new Map(
    ids.length
      ? (
          await rows<{ id: string; name: string }>(
            ctx.db,
            sql`SELECT id, name FROM peers WHERE id = ANY(${textArray(ids)})`,
          )
        ).map((p) => [p.id, p.name])
      : [],
  );
  const events = pairs.length
    ? pairs.map((p) => ({
        observer: names.get(p.observerId) ?? null,
        observed: names.get(p.observedId) ?? null,
      }))
    : [{ observer: null, observed: null }];
  for (const ev of events) {
    await emitWebhookEvent(ctx, {
      workspaceId: session.workspaceId,
      type: "queue.empty",
      data: {
        workspace_id: session.workspaceName,
        queue_type: queueType,
        session_id: session.name,
        observer: ev.observer,
        observed: ev.observed,
      },
    });
  }
}

// ------------------------------------------------------------- delivery

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/**
 * Private, loopback, link-local, CGNAT, multicast, reserved or documentation ranges, and every
 * IPv6 form that embeds an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo): the same
 * rules as when the URL was registered, applied again to each address at connect time.
 */
export function isPrivateAddress(address: string): boolean {
  if (isBlockedAddress(address)) return true;
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses embed an IPv4 target.
    const embedded = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (embedded) return PRIVATE.check(embedded, "ipv4");
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = Number.parseInt(mappedHex[1]!, 16);
      const lo = Number.parseInt(mappedHex[2]!, 16);
      return PRIVATE.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
    }
    return PRIVATE.check(address, "ipv6");
  }
  return true;
}

class RefusedAddressError extends Error {
  constructor(host: string, address: string) {
    super(`refusing webhook delivery to ${host}: resolves to non-public address ${address}`);
    this.name = "RefusedAddressError";
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: LookupCallback,
  ) => {
    dnsLookup(hostname, { family: options.family ?? 0, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad && !allowPrivate) return callback(new RefusedAddressError(hostname, bad.address), []);
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export async function deliver(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { allowPrivate: boolean; timeoutMs?: number; deadlineMs?: number },
): Promise<number> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TerminalJobError(`unsupported webhook URL scheme ${target.protocol}`);
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host) && !opts.allowPrivate) {
    throw new TerminalJobError(`refusing webhook delivery to non-public address ${host}`);
  }
  const client = target.protocol === "https:" ? https : http;
  return new Promise<number>((resolve, reject) => {
    // An absolute deadline: a receiver that trickles bytes would otherwise keep the idle
    // timeout from ever firing and hold a worker slot that other accounts' jobs need.
    const deadline = setTimeout(
      () => req.destroy(new Error("webhook delivery took too long")),
      opts.deadlineMs ?? DEADLINE_MS,
    );
    const req = client.request(
      target,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        lookup: guardedLookup(opts.allowPrivate) as never,
        timeout: opts.timeoutMs ?? TIMEOUT_MS,
      },
      (res) => {
        // Only the status matters: the body is never read.
        clearTimeout(deadline);
        resolve(res.statusCode ?? 0);
        res.destroy();
      },
    );
    req.on("timeout", () => req.destroy(new Error("webhook delivery timed out")));
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(
        err instanceof RefusedAddressError
          ? new TerminalJobError(err.message, { cause: err })
          : err,
      );
    });
    req.end(body);
  });
}

/** `webhook` job: one event to one endpoint. Throwing lets the worker retry with backoff. */
export async function handleWebhook(ctx: AppContext, job: ClaimedJob): Promise<JobOutcome> {
  const p = job.payload as {
    endpoint_id?: string;
    url?: string;
    event_id?: string;
    type?: string;
    data?: Record<string, unknown>;
  };
  if (!p.url || !p.type) throw new TerminalJobError("malformed webhook job");
  const secret = await webhookSecretFor(ctx, job.workspaceId);
  if (!secret || !ctx.config.features.webhooks)
    return { payload: { skipped: "no webhook secret configured" } };
  if (p.endpoint_id) {
    const [ep] = await rows<{ id: string }>(
      ctx.db,
      sql`SELECT id FROM webhook_endpoints WHERE id = ${p.endpoint_id}`,
    );
    if (!ep) return { payload: { skipped: "endpoint deleted" } };
  }
  const body = eventBody(p.type, p.data ?? {});
  const signature = signBody(body, secret);
  const status = await deliver(
    p.url,
    body,
    {
      "content-type": "application/json",
      "x-recall-signature": signature,
      // The same signature under the v3 API's header name, for receivers written against it.
      "x-honcho-signature": signature,
      // Recall extension: the same id on every retry of this event (and to every endpoint), so a
      // receiver can drop duplicates; a header, so the signed Honcho envelope stays byte-identical.
      ...(p.event_id ? { "x-recall-event-id": p.event_id } : {}),
    },
    { allowPrivate: ctx.config.webhook.allowPrivateHosts },
  );
  if (status >= 200 && status < 300) return { payload: { status } };
  const message = `webhook endpoint answered HTTP ${status}`;
  // A receiver that rejects the request (or redirects) will not change its mind on retry.
  if ((status >= 300 && status < 500 && status !== 408 && status !== 429) || status === 0) {
    throw new TerminalJobError(message);
  }
  throw new Error(message);
}
