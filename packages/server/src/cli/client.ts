import { VERSION } from "../version.js";
import { CliError, type CliIo } from "./common.js";
import { isHostedUrl, KEYS_URL, type Settings } from "./settings.js";

/**
 * A small `fetch` client for the REST API. Deliberately not the SDK: the
 * command line stays dependency-free and works against any Honcho-compatible
 * server.
 */

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface Api {
  readonly settings: Settings;
  call(
    method: string,
    path: string,
    opts?: { body?: unknown; query?: Query; form?: FormData },
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are JSON of a shape each command knows
  ): Promise<any>;
  /** `/v3/workspaces/<workspace><path>`. */
  ws(path: string): string;
}

const CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  402: "BUDGET_EXCEEDED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "TOO_LARGE",
  422: "INVALID_REQUEST",
  429: "RATE_LIMITED",
};

function detailText(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) =>
        [Array.isArray(d.loc) ? d.loc.slice(1).join(".") : "", d.msg].filter(Boolean).join(": "),
      )
      .join("; ");
  }
  return body ? JSON.stringify(body) : "";
}

export function createApi(settings: Settings, io: CliIo, timeoutMs: number): Api {
  const call: Api["call"] = async (method, path, opts = {}) => {
    const url = new URL(`${settings.url}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `recall-cli/${VERSION}`,
    };
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
    if (opts.body !== undefined && !opts.form) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await io.fetch(url, {
        method,
        headers,
        ...(opts.form
          ? { body: opts.form }
          : opts.body === undefined
            ? {}
            : { body: JSON.stringify(opts.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string; message?: string } };
      if (e.name === "TimeoutError") {
        throw new CliError(
          "TIMEOUT",
          `No answer from ${settings.url} within ${timeoutMs} ms (raise it with --timeout).`,
          { url: settings.url },
        );
      }
      const why = e.cause?.code ?? e.cause?.message ?? (err as Error).message;
      const advice = isHostedUrl(settings.url)
        ? 'Check your connection. To use a server you run yourself, start it with "recall start" and point at it with --url, RECALL_URL=http://localhost:8000 or "recall init".'
        : 'Is the server running? Start one with "recall start", or point at another with --url or "recall init".';
      throw new CliError(
        "CONNECTION_FAILED",
        `Could not reach ${settings.url} (${why}). ${advice}`,
        {
          url: settings.url,
        },
      );
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { detail: text.slice(0, 300) };
      }
    }
    if (!res.ok) {
      const detail = detailText(body);
      const hint =
        res.status === 401
          ? ` Check the API key: set RECALL_API_KEY, pass --api-key, or run "recall init".${
              isHostedUrl(settings.url) ? ` Create a key at ${KEYS_URL}.` : ""
            }`
          : "";
      throw new CliError(
        CODES[res.status] ?? (res.status >= 500 ? "SERVER_ERROR" : "REQUEST_FAILED"),
        `${method} ${url.pathname} answered HTTP ${res.status}${detail ? `: ${detail}` : ""}.${hint}`,
        { status: res.status, detail },
      );
    }
    return body;
  };
  return {
    settings,
    call,
    ws: (path) => `/v3/workspaces/${encodeURIComponent(settings.workspace)}${path}`,
  };
}
