import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { createdAtKeys, type Page, type Paging, paginate } from "../http/pagination.js";
import { WEBHOOK_COLS, type WebhookRow, webhookOut } from "../http/serialize.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { emitWebhookEvent } from "../webhooks/index.js";
import { type WsKey, wsIs } from "./tenancy.js";

export const MAX_WEBHOOK_ENDPOINTS = 10;
export const MAX_WEBHOOK_URL_LENGTH = 2048;

// ---------------------------------------------------------------------------
// URL safety (SSRF)

/** Resolves a hostname to all of its addresses. Replaceable so tests need no network. */
export type HostResolver = (host: string) => Promise<string[]>;

const systemResolver: HostResolver = async (host) => {
  const found = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DNS lookup timed out")), 5000).unref(),
    ),
  ]);
  return found.map((r) => r.address);
};

let resolver: HostResolver = systemResolver;

export function setHostResolver(next: HostResolver | null): void {
  resolver = next ?? systemResolver;
}

function ipv4Blocked(a: number, b: number, c: number, d: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // documentation
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  void d;
  return false;
}

/** Expands an IPv6 literal to eight 16-bit groups, or null when malformed. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [o1, o2, o3, o4] = dotted.slice(1).map(Number) as [number, number, number, number];
    if ([o1, o2, o3, o4].some((o) => o > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((o1 << 8) | o2).toString(16)}:${((o3 << 8) | o4).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [
    ...head,
    ...(halves.length === 2 ? new Array<string>(fill).fill("0") : []),
    ...tail,
  ].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/** True for loopback, private, link-local, reserved, multicast, unspecified and documentation addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c, d] = address.split(".").map(Number) as [number, number, number, number];
    return ipv4Blocked(a, b, c, d);
  }
  if (family === 6) {
    const g = ipv6Groups(address);
    if (!g) return true;
    const v4 = (hi: number, lo: number) => ipv4Blocked(hi >> 8, hi & 255, lo >> 8, lo & 255);
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6]!, g[7]!); // ::ffff:a.b.c.d
    if (g.slice(0, 6).every((x) => x === 0)) return v4(g[6]!, g[7]!); // IPv4-compatible
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
      return v4(g[6]!, g[7]!); // NAT64
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64 (64:ff9b:1::/48)
    if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0)
      return v4(g[6]!, g[7]!); // IPv4-translated (::ffff:0:a.b.c.d)
    if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 6to4
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
    if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
    if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
    if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/**
 * Validates a webhook URL: absolute http(s) URL with a host, no embedded
 * credentials, and no host that is (or resolves to) a private, loopback,
 * link-local, reserved or metadata address. Unlike a literal-only check this
 * also catches hostnames such as `localhost` or DNS names that point inwards.
 * Returns the parsed URL; delivery code should call it again (and connect to a
 * checked address) so DNS rebinding after registration is covered as well.
 */
export async function validateWebhookUrl(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<URL> {
  if (raw.length > MAX_WEBHOOK_URL_LENGTH) {
    throw unprocessable(`Webhook URL must be at most ${MAX_WEBHOOK_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unprocessable("Webhook URL must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw unprocessable("Webhook URL must use http or https");
  }
  if (url.username || url.password) throw unprocessable("Webhook URL must not contain credentials");
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!host) throw unprocessable("Webhook URL must include a host");
  const blocked = () =>
    unprocessable(
      "Webhook URL must not point to a private, loopback, link-local or reserved address",
    );
  // Local development can opt out (RECALL_WEBHOOK_ALLOW_PRIVATE); delivery applies the same switch.
  if (opts.allowPrivate) return url;
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw blocked();
    return url;
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw blocked();
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw unprocessable(`Webhook URL host '${host}' could not be resolved`);
  }
  if (addresses.length === 0)
    throw unprocessable(`Webhook URL host '${host}' could not be resolved`);
  if (addresses.some(isBlockedAddress)) throw blocked();
  return url;
}

// ---------------------------------------------------------------------------
// Endpoints

const FROM_WEBHOOK = sql`FROM webhook_endpoints e JOIN workspaces w ON w.id = e.workspace_id`;

export async function createWebhookEndpoint(ctx: AppContext, workspace: WsKey, url: string) {
  await validateWebhookUrl(url, { allowPrivate: ctx.config.webhook.allowPrivateHosts });
  return ctx.db.transaction(async (tx) => {
    // Locking the workspace row serialises concurrent registrations, so the cap cannot be exceeded.
    const [ws] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM workspaces w WHERE ${wsIs(workspace)} FOR UPDATE`,
    );
    if (!ws) throw notFound(`Workspace ${workspace.name}`);
    const [existing] = await rows<WebhookRow>(
      tx,
      sql`SELECT ${WEBHOOK_COLS} ${FROM_WEBHOOK} WHERE e.workspace_id = ${ws.id} AND e.url = ${url}`,
    );
    if (existing) return { endpoint: webhookOut(existing), created: false };
    const [count] = await rows<{ n: number }>(
      tx,
      sql`SELECT count(*)::int AS n FROM webhook_endpoints WHERE workspace_id = ${ws.id}`,
    );
    if (Number(count?.n ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
      throw conflict(
        `Maximum number of webhook endpoints (${MAX_WEBHOOK_ENDPOINTS}) reached for this workspace.`,
      );
    }
    const id = newId();
    await tx.execute(
      sql`INSERT INTO webhook_endpoints (id, workspace_id, url) VALUES (${id}, ${ws.id}, ${url})`,
    );
    const [created] = await rows<WebhookRow>(
      tx,
      sql`SELECT ${WEBHOOK_COLS} ${FROM_WEBHOOK} WHERE e.id = ${id}`,
    );
    return { endpoint: webhookOut(created!), created: true };
  });
}

export async function listWebhookEndpoints(
  ctx: AppContext,
  workspace: WsKey,
  paging: Paging,
): Promise<Page<ReturnType<typeof webhookOut>>> {
  return paginate(ctx.db, paging, {
    select: WEBHOOK_COLS,
    from: FROM_WEBHOOK,
    where: [wsIs(workspace)],
    keys: createdAtKeys(sql`e.created_at`, sql`e.id`),
    map: (r) => webhookOut(r as unknown as WebhookRow),
  });
}

export async function deleteWebhookEndpoint(
  ctx: AppContext,
  workspace: WsKey,
  id: string,
): Promise<void> {
  const deleted = await rows<{ id: string }>(
    ctx.db,
    sql`DELETE FROM webhook_endpoints e USING workspaces w
        WHERE w.id = e.workspace_id AND ${wsIs(workspace)} AND e.id = ${id} RETURNING e.id`,
  );
  if (deleted.length === 0) throw notFound("Webhook endpoint");
}

/** Queues a `test.event` for delivery to every endpoint of the workspace. */
export async function sendTestWebhook(ctx: AppContext, workspace: WsKey): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [ws] = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM workspaces w WHERE ${wsIs(workspace)}`,
    );
    if (!ws) throw notFound(`Workspace ${workspace.name}`);
    await emitWebhookEvent(
      ctx,
      { workspaceId: ws.id, type: "test.event", data: { workspace_id: workspace.name } },
      tx,
    );
  });
}
