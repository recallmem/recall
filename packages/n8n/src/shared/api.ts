import type {
  IDataObject,
  IExecuteFunctions,
  IHttpRequestMethods,
  ISupplyDataFunctions,
  JsonObject,
} from "n8n-workflow";
import { NodeApiError, sleep } from "n8n-workflow";

/** The credential type both nodes use. */
export const CREDENTIAL = "recallApi";

export const DEFAULT_BASE_URL = "https://api.recallmem.dev";
export const DEFAULT_WORKSPACE = "default";

/** A message Recall stores whole is at most this long; longer text is stored as consecutive parts. */
export const MAX_MESSAGE_CHARS = 24_000;

type Context = IExecuteFunctions | ISupplyDataFunctions;

export interface RequestOptions {
  body?: IDataObject;
  query?: IDataObject;
  /** Sent as `Idempotency-Key`, so a retried write is stored once. */
  idempotencyKey?: string;
  /** Resolve to `undefined` instead of failing when Recall answers 404 (nothing known yet). */
  allowNotFound?: boolean;
}

export type Recall = <T>(
  method: IHttpRequestMethods,
  path: string,
  options?: RequestOptions,
) => Promise<T | undefined>;

/** The HTTP status of a failed request, whichever shape n8n's request helper gave it. */
export function statusOf(error: unknown): number {
  const e = error as {
    httpCode?: unknown;
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    cause?: { response?: { status?: unknown }; status?: unknown };
  };
  for (const value of [
    e?.httpCode,
    e?.statusCode,
    e?.status,
    e?.response?.status,
    e?.cause?.response?.status,
    e?.cause?.status,
  ]) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 100 && n < 600) return n;
  }
  return 0;
}

/** Worth trying again: a busy session (409), rate limits and Recall's own errors. */
const retryable = (status: number) => status === 409 || status === 429 || status >= 500;

/**
 * Calls Recall's REST API in the credential's workspace, with the credential's key. Retries what
 * Recall asks to retry, up to three times with backoff; writes carry an idempotency key, so a retry
 * never stores a message twice.
 */
export async function recallClient(ctx: Context, itemIndex = 0): Promise<Recall> {
  const credentials = await ctx.getCredentials(CREDENTIAL, itemIndex);
  const baseUrl = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const workspace = safeId(String(credentials.workspace || DEFAULT_WORKSPACE), DEFAULT_WORKSPACE);
  const root = `${baseUrl}/v3/workspaces/${encodeURIComponent(workspace)}`;

  return async <T>(method: IHttpRequestMethods, path: string, options: RequestOptions = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, {
          method,
          url: `${root}${path}`,
          ...(options.body ? { body: options.body } : {}),
          ...(options.query ? { qs: options.query } : {}),
          headers: {
            accept: "application/json",
            ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
          },
          json: true,
          timeout: 60_000,
        })) as T;
      } catch (error) {
        const status = statusOf(error);
        if (options.allowNotFound && status === 404) return undefined;
        if (retryable(status) && attempt < 3) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw new NodeApiError(ctx.getNode(), error as JsonObject, { itemIndex });
      }
    }
  };
}

/**
 * An id Recall accepts (letters, digits, `_` and `-`, at most 512 characters). Anything else, such
 * as the `@` and `.` of an email address, becomes `_`, so `jane@example.com` is `jane_example_com`.
 */
export function safeId(value: string, fallback = ""): string {
  const id = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 512);
  return id.replace(/_/g, "") ? id : fallback;
}

/** Text in parts Recall stores whole, cut at a line break or a space where it can. */
export function split(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > max / 2 ? cut + 1 : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** A fresh idempotency key. */
export const newKey = (prefix: string) =>
  `n8n-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
