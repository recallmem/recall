/**
 * Error hierarchy. Each HTTP status maps to a class (`BadRequestError`, `NotFoundError`, ...), so
 * `catch` blocks can match on the kind of failure.
 *
 *   RecallError
 *   |- APIError                 any non-2xx response
 *   |  |- BadRequestError 400   |- AuthenticationError 401   |- PermissionDeniedError 403
 *   |  |- NotFoundError 404     |- ConflictError 409         |- UnprocessableEntityError 422
 *   |  |- RateLimitError 429 (retryAfter, seconds)           `- ServerError >= 500
 *   |- RecallTimeoutError (alias TimeoutError)
 *   `- RecallConnectionError (alias ConnectionError)
 */

export interface ErrorInit {
  code?: string | undefined;
  body?: unknown;
  requestId?: string | undefined;
  cause?: unknown;
}

export class RecallError extends Error {
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;
  /** Machine-readable error code, when the server supplied one. */
  readonly code: string | undefined;
  /** The parsed response body (or its text), when there was one. */
  readonly body: unknown;
  /** The server's `x-request-id`, when it sent one. */
  readonly requestId: string | undefined;

  constructor(message: string, status = 0, init: ErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = init.code;
    this.body = init.body;
    this.requestId = init.requestId;
  }
}

export class APIError extends RecallError {}
export class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}
export class UnprocessableEntityError extends APIError {}
export class ServerError extends APIError {}

export class RateLimitError extends APIError {
  /** Seconds the server asked us to wait, if it said. */
  readonly retryAfter: number | undefined;
  constructor(message: string, status: number, init: ErrorInit & { retryAfter?: number } = {}) {
    super(message, status, init);
    this.retryAfter = init.retryAfter;
  }
}

export class RecallTimeoutError extends RecallError {
  constructor(message = "Request timed out", init: ErrorInit = {}) {
    super(message, 0, init);
  }
}

export class RecallConnectionError extends RecallError {
  constructor(message = "Connection error", init: ErrorInit = {}) {
    super(message, 0, init);
  }
}

// Short names for the two transport errors. They shadow the built-in `TimeoutError` /
// `ConnectionError` only in modules that import them.
export { RecallConnectionError as ConnectionError, RecallTimeoutError as TimeoutError };

type Detail = { loc?: unknown[]; msg?: unknown };

/** The human message of an error body: `detail` (string or FastAPI-style list), `message`, `error`, else the status. */
export function messageFromBody(body: unknown, status: number): string {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const detail = b.detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      return detail
        .map((d: Detail | string) => {
          if (typeof d === "string") return d;
          const where = Array.isArray(d.loc) ? d.loc.slice(1).join(".") : "";
          return where ? `${where}: ${String(d.msg)}` : String(d.msg);
        })
        .join("; ");
    }
    if (typeof b.message === "string" && b.message) return b.message;
    if (typeof b.error === "string" && b.error) return b.error;
    if (b.error && typeof b.error === "object") {
      const m = (b.error as Record<string, unknown>).message;
      if (typeof m === "string" && m) return m;
    }
  }
  return `HTTP ${status}`;
}

/** Seconds from a `Retry-After` header (delta-seconds or an HTTP date). */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - now) / 1000);
}

export function errorFromResponse(status: number, body: unknown, headers: Headers): RecallError {
  const message = messageFromBody(body, status);
  const code =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).code === "string"
      ? ((body as Record<string, unknown>).code as string)
      : undefined;
  const init: ErrorInit = {
    code,
    body,
    requestId: headers.get("x-request-id") ?? headers.get("request-id") ?? undefined,
  };
  switch (status) {
    case 400:
      return new BadRequestError(message, status, init);
    case 401:
      return new AuthenticationError(message, status, init);
    case 403:
      return new PermissionDeniedError(message, status, init);
    case 404:
      return new NotFoundError(message, status, init);
    case 409:
      return new ConflictError(message, status, init);
    case 422:
      return new UnprocessableEntityError(message, status, init);
    case 429:
      return new RateLimitError(message, status, {
        ...init,
        retryAfter: parseRetryAfter(headers.get("retry-after")),
      });
    default:
      return status >= 500
        ? new ServerError(message, status, init)
        : new APIError(message, status, init);
  }
}
