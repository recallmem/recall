import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { type Db, rows } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { VERSION } from "../version.js";
import { isBlockedAddress } from "./webhooks.js";

/**
 * OAuth clients of the MCP authorization server: who may ask a user for access,
 * and where the answer may be sent.
 *
 * - Dynamic Client Registration (RFC 7591): public clients only. Whatever
 *   authentication method a client asks for, it is registered with
 *   `token_endpoint_auth_method: "none"` (RFC 7591 lets the server substitute
 *   metadata); PKCE is what binds a code to the client that asked for it.
 * - Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document):
 *   a `client_id` that is an https URL names a JSON document describing the
 *   client. It is fetched over https only, never from a private, loopback,
 *   link-local or reserved address (checked on the resolved addresses, and the
 *   connection goes to the address that was checked), without redirects, with
 *   a 5 s time limit and a 5 KB size limit, and cached in `oauth_clients`.
 * - Redirect URIs (MCP authorization spec, RFC 8252): https, or http on a
 *   loopback host; no fragment, no credentials, printable ASCII only. They are
 *   matched exactly, except that a loopback http URI matches on any port
 *   (RFC 8252 section 7.3: native apps listen on an ephemeral port).
 */

type Executor = Pick<Db, "execute">;

/** The one scope: use Recall memory through the MCP tools (what an API key of the same reach can do there). */
export const SCOPE = "memory";
export const REDIRECT_URIS_MAX = 10;
const CLIENT_NAME_MAX = 100;
const URI_MAX = 2000;
/** Never-used registrations accepted per hour across all clients, before registration is paused. */
const UNUSED_CLIENTS_PER_HOUR_MAX = 2_000;
/**
 * The hosted connectors' own callback hosts. Registrations that return only there are never
 * paused by the global cap, so a flood of throwaway registrations cannot lock Claude or ChatGPT
 * users out of connecting; the per-network limit still applies to them.
 */
const CONNECTOR_REDIRECT_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "chat.openai.com",
]);

const isConnectorRedirect = (uri: string) => {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && CONNECTOR_REDIRECT_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

/** An OAuth protocol error, rendered as `{"error": ..., "error_description": ...}` (RFC 6749 5.2, RFC 7591 3.2.2). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly headers?: Record<string, string>,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

/** Why a client's metadata document could not be used (shown to the user on the authorization page). */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientMetadataError";
  }
}

// ---------------------------------------------------------------------------
// Redirect URIs

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Anything outside printable ASCII (spaces, control characters, non-ASCII) is refused outright. */
const NOT_PRINTABLE = /[^\x21-\x7e]/;

/** Why a redirect URI is not acceptable, or null when it is. */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > URI_MAX)
    return `must be an absolute URL of at most ${URI_MAX} characters`;
  if (NOT_PRINTABLE.test(raw)) return "must not contain spaces, control or non-ASCII characters";
  if (raw.includes("#")) return "must not contain a fragment";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not an absolute URL";
  }
  if (u.username || u.password) return "must not contain credentials";
  if (!/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/.test(u.hostname))
    return "needs a host of letters, digits, dots and hyphens (or an IP address)";
  // new URL() alone reads "https:/app/x" or "https:\host/x" as having a host, but a browser
  // resolves the same Location header against our page (https://<us>/app/x): only the plain
  // "scheme://host" spelling means the same thing to both.
  if (
    (u.protocol === "https:" || u.protocol === "http:") &&
    (!/^https?:\/\/[^/]/i.test(raw) || raw.includes("\\"))
  )
    return "must start with https:// (or http://) and the host, without backslashes";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") {
    return LOOPBACK_HOSTS.has(u.hostname)
      ? null
      : "may use http only on a loopback host (localhost, 127.0.0.1 or [::1])";
  }
  return `uses the scheme '${u.protocol.slice(0, -1)}': only https, or http on a loopback host, is allowed`;
}

function loopbackParts(raw: string): { host: string; rest: string } | null {
  if (redirectUriProblem(raw)) return null;
  const u = new URL(raw);
  if (u.protocol !== "http:" || !LOOPBACK_HOSTS.has(u.hostname)) return null;
  return { host: u.hostname, rest: `${u.pathname}${u.search}` };
}

/** Exact match against the registered URIs; loopback http URIs match on any port (RFC 8252 7.3). */
export function redirectUriAllowed(registered: readonly string[], given: string): boolean {
  if (redirectUriProblem(given)) return false;
  if (registered.includes(given)) return true;
  const g = loopbackParts(given);
  if (!g) return false;
  return registered.some((r) => {
    const p = loopbackParts(r);
    return !!p && p.host === g.host && p.rest === g.rest;
  });
}

export const isLoopbackRedirect = (raw: string): boolean => loopbackParts(raw) !== null;

/** `uri` with query parameters appended (its own query, if any, is kept byte for byte). */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const sep = !uri.includes("?") ? "?" : /[?&]$/.test(uri) ? "" : "&";
  return `${uri}${sep}${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Clients

export interface OAuthClient {
  id: string;
  kind: "registered" | "metadata_document";
  name: string;
  redirectUris: string[];
  createdAt: Date;
}

interface ClientRow {
  id: string;
  kind: "registered" | "metadata_document";
  name: string;
  redirect_uris: string[];
  created_at: Date | string;
  refresh_after: Date | string | null;
}

const clientOf = (r: ClientRow): OAuthClient => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  redirectUris: r.redirect_uris,
  createdAt: new Date(r.created_at),
});

/** Display name: control and formatting characters removed, whitespace collapsed, at most 100 characters. */
export function cleanClientName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, CLIENT_NAME_MAX);
}

const optionalText = (raw: unknown, max = 200) =>
  typeof raw === "string" && raw.trim() && raw.length <= max ? cleanClientName(raw) : undefined;

/** Validated grant and response types: the client must want the authorization code flow. */
function checkFlows(meta: Record<string, unknown>): string | null {
  const grants = meta.grant_types;
  if (grants !== undefined) {
    if (!Array.isArray(grants) || !grants.every((g) => typeof g === "string"))
      return "grant_types must be an array of strings";
    if (!grants.includes("authorization_code"))
      return "grant_types must include authorization_code (the only flow this server offers, with refresh_token)";
  }
  const responses = meta.response_types;
  if (responses !== undefined) {
    if (!Array.isArray(responses) || !responses.every((g) => typeof g === "string"))
      return "response_types must be an array of strings";
    if (!responses.includes("code")) return "response_types must include code";
  }
  return null;
}

/** Splits requested redirect URIs into the acceptable ones and why the others were dropped. */
function acceptRedirectUris(raw: unknown): { accepted: string[]; dropped: string[] } | string {
  if (!Array.isArray(raw) || raw.length === 0) return "redirect_uris must be a non-empty array";
  if (raw.length > REDIRECT_URIS_MAX)
    return `redirect_uris may hold at most ${REDIRECT_URIS_MAX} URIs`;
  const accepted: string[] = [];
  const dropped: string[] = [];
  for (const uri of raw) {
    const problem = redirectUriProblem(uri);
    if (problem) dropped.push(`${typeof uri === "string" ? uri.slice(0, 100) : "?"} ${problem}`);
    else if (!accepted.includes(uri as string)) accepted.push(uri as string);
  }
  return { accepted, dropped };
}

/**
 * RFC 7591 registration. Unknown fields are ignored; redirect URIs that are not
 * allowed are left out of the registration (and of the response), and when none
 * is left the request fails with `invalid_redirect_uri`. Limits: registrations
 * per client network per hour, and never-used registrations per day overall
 * (never-used clients are purged after a day).
 */
export async function registerClient(
  db: Executor,
  body: unknown,
  opts: { ipHash: string | null; perHour: number },
): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new OAuthError("invalid_client_metadata", "The body must be a JSON object");
  const meta = body as Record<string, unknown>;
  const uris = acceptRedirectUris(meta.redirect_uris);
  if (typeof uris === "string") throw new OAuthError("invalid_redirect_uri", uris);
  if (uris.accepted.length === 0)
    throw new OAuthError(
      "invalid_redirect_uri",
      `No acceptable redirect URI: ${uris.dropped.join("; ")}`,
    );
  const flows = checkFlows(meta);
  if (flows) throw new OAuthError("invalid_client_metadata", flows);
  if (meta.client_name !== undefined && typeof meta.client_name !== "string")
    throw new OAuthError("invalid_client_metadata", "client_name must be a string");

  const [counts] = await rows<{ by_ip: number; unused: number }>(
    db,
    sql`SELECT
          (SELECT count(*)::int FROM oauth_clients
             WHERE ${opts.ipHash}::text IS NOT NULL AND registration_ip_hash = ${opts.ipHash}
               AND created_at > now() - interval '1 hour') AS by_ip,
          (SELECT count(*)::int FROM oauth_clients
             WHERE kind = 'registered' AND last_used_at IS NULL
               AND created_at > now() - interval '1 hour') AS unused`,
  );
  if (opts.perHour > 0 && (counts?.by_ip ?? 0) >= opts.perHour)
    throw new OAuthError(
      "too_many_requests",
      "Too many client registrations from this network; try again later",
      429,
      { "Retry-After": "600" },
    );
  if (
    (counts?.unused ?? 0) >= UNUSED_CLIENTS_PER_HOUR_MAX &&
    !uris.accepted.every(isConnectorRedirect)
  )
    throw new OAuthError(
      "temporarily_unavailable",
      "Client registration is paused; try again later",
      429,
      { "Retry-After": "3600" },
    );

  const id = `rc_${newId()}`;
  const name = cleanClientName(meta.client_name);
  const clientUri =
    typeof meta.client_uri === "string" && !redirectUriProblem(meta.client_uri)
      ? meta.client_uri
      : undefined;
  const registration: Record<string, unknown> = {
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(name ? { client_name: name } : {}),
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: uris.accepted,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
    ...(optionalText(meta.software_id) ? { software_id: optionalText(meta.software_id) } : {}),
    ...(optionalText(meta.software_version)
      ? { software_version: optionalText(meta.software_version) }
      : {}),
  };
  await db.execute(
    sql`INSERT INTO oauth_clients (id, kind, name, redirect_uris, metadata, registration_ip_hash)
        VALUES (${id}, 'registered', ${name}, ${textArray(uris.accepted)},
                ${JSON.stringify(registration)}::jsonb, ${opts.ipHash})`,
  );
  return registration;
}

/** A text[] parameter (Drizzle would expand a JS array into a parenthesised list). */
export function textArray(values: readonly string[]) {
  return values.length
    ? sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`
    : sql`ARRAY[]::text[]`;
}

// ---------------------------------------------------------------------------
// Client ID metadata documents

const FETCH_TIMEOUT_MS = 5_000;
const DOCUMENT_MAX_BYTES = 5 * 1024;
const CACHE_MIN_S = 300;
const CACHE_MAX_S = 86_400;
const CACHE_DEFAULT_S = 3_600;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

export const isClientIdUrl = (clientId: string): boolean => clientId.startsWith("https://");

/** Why a URL-shaped client_id cannot name a metadata document, or null when it can. */
export function clientIdUrlProblem(raw: string): string | null {
  if (raw.length > URI_MAX || NOT_PRINTABLE.test(raw)) return "is too long or not printable ASCII";
  if (raw.includes("#")) return "must not contain a fragment";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a URL";
  }
  if (u.protocol !== "https:") return "must use https";
  if (u.port) return "must use the default https port";
  if (u.username || u.password) return "must not contain credentials";
  const path = raw.slice(raw.indexOf("//") + 2).replace(/^[^/?]*/, "");
  if (!path.startsWith("/") || path === "/" || path.startsWith("/?"))
    return "must have a path (e.g. https://app.example/client.json)";
  if (/\/\.{1,2}(\/|$)/.test(path.split("?")[0]!.replace(/%2e/gi, ".")))
    return "must not contain . or .. segments";
  return null;
}

/** Resolves a hostname to its addresses. Replaceable so tests need no network. */
export type HostResolver = (host: string) => Promise<string[]>;
export interface FetchedDocument {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  body: string;
}
/** Fetches `url` by connecting to `address` (already checked), no redirects, size and time limited. */
export type DocumentTransport = (url: URL, address: string) => Promise<FetchedDocument>;

const systemResolver: HostResolver = async (host) => {
  const found = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DNS lookup timed out")), FETCH_TIMEOUT_MS).unref(),
    ),
  ]);
  return found.map((r) => r.address);
};

const httpsTransport: DocumentTransport = (url, address) =>
  new Promise<FetchedDocument>((resolve, reject) => {
    const family = isIP(address);
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": `Recall/${VERSION} (OAuth client metadata)`,
        },
        // Connect to the address that passed the check: a second DNS answer cannot redirect us inwards.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
        timeout: FETCH_TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > DOCUMENT_MAX_BYTES) {
            req.destroy(new Error(`the document is larger than ${DOCUMENT_MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const header = (v: string | string[] | undefined) =>
            Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
          resolve({
            status: res.statusCode ?? 0,
            contentType: header(res.headers["content-type"]),
            cacheControl: header(res.headers["cache-control"]),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("timed out")), FETCH_TIMEOUT_MS);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });

let resolver: HostResolver = systemResolver;
let transport: DocumentTransport = httpsTransport;

/** Test hooks: replace DNS resolution and/or the HTTPS fetch (null restores the real one). */
export function setClientMetadataNetwork(next: {
  resolver?: HostResolver | null;
  transport?: DocumentTransport | null;
}): void {
  if (next.resolver !== undefined) resolver = next.resolver ?? systemResolver;
  if (next.transport !== undefined) transport = next.transport ?? httpsTransport;
}

/** The single public address to fetch `url` from; refuses private, loopback and reserved targets. */
async function publicAddress(url: URL): Promise<string> {
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const refused = () =>
    new ClientMetadataError(
      "The client's metadata URL points to a private, loopback or reserved address",
    );
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw refused();
    return host;
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw refused();
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new ClientMetadataError(`The client's metadata host '${host}' could not be resolved`);
  }
  if (addresses.length === 0)
    throw new ClientMetadataError(`The client's metadata host '${host}' could not be resolved`);
  if (addresses.some(isBlockedAddress)) throw refused();
  return addresses[0]!;
}

function cacheSeconds(cacheControl: string | null): number {
  const maxAge = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
  const s = maxAge === undefined ? CACHE_DEFAULT_S : Number(maxAge);
  return Math.min(CACHE_MAX_S, Math.max(CACHE_MIN_S, s));
}

/** Fetches and validates a client ID metadata document, and caches it as a client. */
async function fetchClientDocument(db: Executor, clientId: string): Promise<OAuthClient> {
  const problem = clientIdUrlProblem(clientId);
  if (problem) throw new ClientMetadataError(`The client_id URL ${problem}`);
  const url = new URL(clientId);
  const address = await publicAddress(url);
  let doc: FetchedDocument;
  try {
    doc = await transport(url, address);
  } catch (err) {
    throw new ClientMetadataError(
      `The client's metadata document could not be fetched (${(err as Error).message})`,
    );
  }
  if (doc.status !== 200)
    throw new ClientMetadataError(
      `The client's metadata document answered HTTP ${doc.status} (redirects are not followed)`,
    );
  if (!/^application\/([\w.-]+\+)?json\s*(;|$)/i.test(doc.contentType ?? ""))
    throw new ClientMetadataError("The client's metadata document is not application/json");
  if (Buffer.byteLength(doc.body) > DOCUMENT_MAX_BYTES)
    throw new ClientMetadataError(
      `The client's metadata document is over ${DOCUMENT_MAX_BYTES} bytes`,
    );
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(doc.body) as Record<string, unknown>;
  } catch {
    throw new ClientMetadataError("The client's metadata document is not valid JSON");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new ClientMetadataError("The client's metadata document is not a JSON object");
  if (meta.client_id !== clientId)
    throw new ClientMetadataError(
      "The client's metadata document has a client_id other than its own URL",
    );
  const name = cleanClientName(meta.client_name);
  if (!name) throw new ClientMetadataError("The client's metadata document has no client_name");
  // A client that prefers another method but also lists "none" (ChatGPT's document says
  // private_key_jwt, with "none" among token_endpoint_auth_methods_supported) picks the method
  // this server offers, so it is served as a public client like any other.
  const auth = meta.token_endpoint_auth_method;
  const alsoPublic =
    Array.isArray(meta.token_endpoint_auth_methods_supported) &&
    meta.token_endpoint_auth_methods_supported.includes("none");
  if (auth !== undefined && auth !== "none" && !alsoPublic)
    throw new ClientMetadataError(
      'Only public clients (token_endpoint_auth_method "none") can use this server',
    );
  if ("client_secret" in meta || "client_secret_expires_at" in meta)
    throw new ClientMetadataError("A client metadata document must not contain a client secret");
  const flows = checkFlows(meta);
  if (flows) throw new ClientMetadataError(`The client's metadata document: ${flows}`);
  const uris = acceptRedirectUris(meta.redirect_uris);
  if (typeof uris === "string") throw new ClientMetadataError(`The client's metadata: ${uris}`);
  if (uris.accepted.length === 0)
    throw new ClientMetadataError(
      `The client's metadata lists no acceptable redirect URI: ${uris.dropped.join("; ")}`,
    );
  const kept = {
    client_id: clientId,
    client_name: name,
    redirect_uris: uris.accepted,
    ...(typeof meta.client_uri === "string" && !redirectUriProblem(meta.client_uri)
      ? { client_uri: meta.client_uri }
      : {}),
  };
  const refreshAfter = new Date(Date.now() + cacheSeconds(doc.cacheControl) * 1000);
  const [row] = await rows<ClientRow>(
    db,
    sql`INSERT INTO oauth_clients (id, kind, name, redirect_uris, metadata, refresh_after)
        VALUES (${clientId}, 'metadata_document', ${name}, ${textArray(uris.accepted)},
                ${JSON.stringify(kept)}::jsonb, ${refreshAfter})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris,
          metadata = EXCLUDED.metadata, refresh_after = EXCLUDED.refresh_after
        WHERE oauth_clients.kind = 'metadata_document'
        RETURNING id, kind, name, redirect_uris, created_at, refresh_after`,
  );
  if (!row) throw new ClientMetadataError("This client_id is not available");
  return clientOf(row);
}

/**
 * The client named by `client_id`, or null when unknown. A URL client_id is
 * served from cache while fresh; otherwise (with `fetch`) its document is
 * fetched again. Without `fetch`, a stale or missing document yields what is
 * cached (or null), so callers can defer the fetch until a user is signed in.
 */
export async function loadClient(
  db: Executor,
  clientId: string,
  opts: {
    fetch: boolean /** Called before a document is fetched (may throw to refuse). */;
    onFetch?: () => void;
  },
): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > URI_MAX) return null;
  const [row] = await rows<ClientRow>(
    db,
    sql`SELECT id, kind, name, redirect_uris, created_at, refresh_after FROM oauth_clients
        WHERE id = ${clientId}`,
  );
  if (!isClientIdUrl(clientId)) return row?.kind === "registered" ? clientOf(row) : null;
  const fresh = row?.refresh_after != null && new Date(row.refresh_after).getTime() > Date.now();
  if (fresh || !opts.fetch) return row ? clientOf(row) : null;
  opts.onFetch?.();
  return fetchClientDocument(db, clientId);
}
