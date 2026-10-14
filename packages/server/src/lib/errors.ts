/**
 * Application error rendered as `{"detail": string}` with the given status.
 * Validation failures from request schemas render as the 422 array form instead
 * (see http/app.ts).
 */
export class ApiError extends Error {
  readonly detail: string;
  constructor(
    readonly status: number,
    detail: string,
    /** Extra response headers (e.g. `Retry-After` on a 429). */
    readonly headers?: Record<string, string>,
  ) {
    // A message quotes what was sent (an id, a filter value): a huge one is not sent back whole.
    const clipped =
      detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail;
    super(clipped);
    this.name = "ApiError";
    this.detail = clipped;
  }
}

/** Longest error message sent; the longest written one is under 200 characters. */
export const MAX_DETAIL_CHARS = 500;

export const notFound = (what: string) => new ApiError(404, `${what} not found`);
export const badRequest = (detail: string) => new ApiError(400, detail);
export const unprocessable = (detail: string) => new ApiError(422, detail);
export const conflict = (detail: string) => new ApiError(409, detail);
/** An `Idempotency-Key` sent again with a request other than the one it was first used for. */
export const idempotencyKeyReused = () =>
  conflict("Idempotency-Key was already used for a different request");
export const unauthorized = (detail = "JWT not permissioned for this resource") =>
  new ApiError(401, detail);
export const tooManyRequests = (retryAfterS: number, detail = "Rate limit exceeded") =>
  new ApiError(429, detail, { "Retry-After": String(Math.max(1, Math.ceil(retryAfterS))) });
export const paymentRequired = (detail = "Monthly budget exceeded") => new ApiError(402, detail);
/** 402 for a billed account without credit, pointing at the dashboard's billing page. */
export const outOfCreditMessage = (publicUrl: string | null | undefined) => {
  const url = publicUrl?.replace(/\/+$/, "");
  return `Out of credit: add credits${url ? ` at ${url}/app/billing` : ""} to continue`;
};

/** What a suspended account's credentials (API keys, OAuth tokens, dashboard sessions) are told. */
export const SUSPENDED_DETAIL = "This account is suspended. Contact support@recallmem.dev.";
export const accountSuspended = () => new ApiError(403, SUSPENDED_DETAIL);
