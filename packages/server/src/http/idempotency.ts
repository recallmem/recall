import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { idempotencyKeyOf } from "../core/messages.js";
import { type Db, rows } from "../db/client.js";
import { ApiError, idempotencyKeyReused } from "../lib/errors.js";
import { fingerprint, stableStringify } from "../lib/json.js";
import type { AuthState } from "./auth.js";

/**
 * `Idempotency-Key` for requests whose result is an answer rather than stored rows (chat).
 *
 * The first request with a key claims it (a `pending` row in `idempotency_records`), runs, and
 * stores its response. A retry of the same request gets that response again, byte for byte, with
 * `Idempotent-Replayed: true`, and nothing runs or is charged a second time. The same key with a
 * different request is a 409, and so is a duplicate that arrives while the first is still running.
 * A request that ends without an answer (an error, or no model call) gives the key back, so it
 * can be tried again. Keys are scoped to the caller's credential and the route, and kept a day:
 * after that the same key is a new request. Messages keep their keys on the rows themselves
 * (`core/messages.ts`), so they do not come here.
 */

/** How long a response is replayed; after this the key starts a new request. */
const TTL: SQL = sql`interval '1 day'`;
/**
 * A claim still pending after this belongs to a request that died with its process (a crash or
 * a deploy): the key is free again. Far longer than any answer takes.
 */
const ABANDONED: SQL = sql`interval '15 minutes'`;
/** Expired rows deleted per cleanup statement, so one pass never holds a long lock. */
const PRUNE_BATCH = 5_000;

export const REPLAYED_HEADER = "Idempotent-Replayed";
/** Response headers stored for a replay; the rest (security, CORS) are added again on the way out. */
const KEPT_HEADER = /^(content-type|cache-control|x-accel-buffering|x-recall-.*)$/i;

/** One caller: an API key, an OAuth connection, a token's claims, or the account itself. */
function callerOf(auth: AuthState): string {
  if (auth.via === "api_key" && auth.keyId) return `key:${auth.keyId}`;
  if (auth.via === "oauth" && auth.grantId) return `oauth:${auth.grantId}`;
  if (auth.via === "jwt") {
    const { w, p, s, ad } = auth.claims;
    return `jwt:${stableStringify({ w: w ?? null, p: p ?? null, s: s ?? null, ad: !!ad })}`;
  }
  return auth.via;
}

const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

/** Fields that are absent, null or undefined all mean "not sent". */
const sent = (request: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(request).filter(([, v]) => v != null));

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The headers of `res` that a replay sends again. */
export function keptHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(entries.filter(([name]) => KEPT_HEADER.test(name)));
}

/** A key this request owns until it stores its response (`complete`) or gives it back (`release`). */
export class IdempotencyClaim {
  private settled = false;

  constructor(
    private readonly db: Db,
    private readonly log: AppContext["log"],
    /** The client's key. */
    readonly key: string,
    private readonly scope: string,
    /** The claim's `created_at` (ISO 8601, to the microsecond): tells it from a later claim of the key. */
    private readonly generation: string,
  ) {}

  /**
   * Names this claim for billing: the per-key guard there charges it once. A later claim of the
   * same key (after a failure gave it back, or after it expired) is a new request.
   */
  get billingKey(): string {
    return `${this.key}:${sha(this.generation).slice(0, 10)}`;
  }

  private where(): SQL {
    return sql`scope = ${this.scope} AND key = ${this.key}
               AND created_at = ${this.generation}::timestamptz AND status = 'pending'`;
  }

  /** Stores the response for retries. A failure to store gives the key back instead. */
  async complete(res: StoredResponse): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    try {
      await this.db.execute(
        sql`UPDATE idempotency_records SET status = 'done', response_status = ${res.status},
              response_headers = ${JSON.stringify(keptHeaders(res.headers))}::jsonb,
              response_body = ${res.body}
            WHERE ${this.where()}`,
      );
    } catch (err) {
      this.log.error({ err }, "could not store an idempotent response");
      this.settled = false;
      await this.release();
    }
  }

  /** Gives the key back: the request produced no answer, so the same key may try again. */
  async release(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    try {
      await this.db.execute(sql`DELETE FROM idempotency_records WHERE ${this.where()}`);
    } catch (err) {
      // The claim stays pending until ABANDONED frees it.
      this.log.error({ err }, "could not release an Idempotency-Key");
    }
  }
}

export type Idempotency = { replay: Response } | { claim: IdempotencyClaim };

const inProgress = () =>
  new ApiError(409, "A request with this Idempotency-Key is still in progress; retry shortly", {
    "Retry-After": "1",
  });

/**
 * Looks up the request's `Idempotency-Key` (if any) before anything runs. Returns the stored
 * response to send again, or a claim the caller settles; throws 409 when the key belongs to a
 * different request or its first request is still running, 422 when it is too long.
 */
export async function beginIdempotent(
  ctx: AppContext,
  args: {
    auth: AuthState;
    /** Route template, e.g. "POST /v3/workspaces/:workspace_id/peers/:peer_id/chat". */
    route: string;
    key: string | null | undefined;
    /** Everything that makes the request what it is: path parameters, the parsed body, headers. */
    request: Record<string, unknown>;
  },
): Promise<Idempotency | null> {
  const key = idempotencyKeyOf(args.key);
  if (!key) return null;
  const scope = sha(`${args.auth.account}\n${callerOf(args.auth)}\n${args.route}`);
  const fp = fingerprint({ route: args.route, request: sent(args.request) });

  // A row that vanishes between the two statements (released by its request) is simply retried.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [claimed] = await rows<{ generation: string }>(
      ctx.db,
      sql`INSERT INTO idempotency_records AS r (scope, key, fingerprint, account_id, status, created_at)
          VALUES (${scope}, ${key}, ${fp}, ${args.auth.account}, 'pending', clock_timestamp())
          ON CONFLICT (scope, key) DO UPDATE SET
            fingerprint = EXCLUDED.fingerprint, account_id = EXCLUDED.account_id, status = 'pending',
            response_status = NULL, response_headers = NULL, response_body = NULL,
            created_at = EXCLUDED.created_at
          WHERE r.created_at < now() - ${TTL}
             OR (r.status = 'pending' AND r.created_at < now() - ${ABANDONED})
          RETURNING to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generation`,
    );
    if (claimed) {
      return { claim: new IdempotencyClaim(ctx.db, ctx.log, key, scope, claimed.generation) };
    }
    const [found] = await rows<{
      fingerprint: string;
      status: "pending" | "done";
      response_status: number | null;
      response_headers: Record<string, string> | null;
      response_body: string | null;
    }>(
      ctx.db,
      sql`SELECT fingerprint, status, response_status, response_headers, response_body
          FROM idempotency_records WHERE scope = ${scope} AND key = ${key}`,
    );
    if (!found) continue;
    if (found.fingerprint !== fp) throw idempotencyKeyReused();
    if (found.status !== "done") throw inProgress();
    return {
      replay: new Response(found.response_body ?? "", {
        status: found.response_status ?? 200,
        headers: { ...(found.response_headers ?? {}), [REPLAYED_HEADER]: "true" },
      }),
    };
  }
  throw inProgress();
}

/** Deletes expired records, a bounded batch at a time (the periodic cleanup). */
export async function pruneIdempotencyRecords(db: Db, maxBatches = 10): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const [r] = await rows<{ n: number | string }>(
      db,
      sql`WITH gone AS (
            DELETE FROM idempotency_records
            WHERE (scope, key) IN (SELECT scope, key FROM idempotency_records
                                   WHERE created_at < now() - ${TTL} LIMIT ${PRUNE_BATCH})
            RETURNING 1)
          SELECT count(*) AS n FROM gone`,
    );
    const n = Number(r?.n ?? 0);
    total += n;
    if (n < PRUNE_BATCH) break;
  }
  return total;
}
