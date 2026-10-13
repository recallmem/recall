export type Obj = Record<string, unknown>;
export type Filters = Record<string, unknown>;

export const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const NAME_MAX = 512;

/** Path segment encoding. Ids are validated first, this is the belt to that pair of braces. */
export const enc = (segment: string): string => encodeURIComponent(segment);

/** Throws a `TypeError` for an id the API would reject, before any request is made. */
export function assertId(kind: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > NAME_MAX ||
    !NAME_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${kind} must be 1-${NAME_MAX} characters of a-z, A-Z, 0-9, "_" and "-" (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/** Anything with an `id`, or the id itself. */
export type IdLike = string | { readonly id: string };
export const idOf = (x: IdLike): string => (typeof x === "string" ? x : x.id);

export const toIso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : value;

export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Drops undefined values (and nothing else) from an object. */
export function compact<T extends Obj>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `process.env`, when there is one (Node, Bun, Deno's compat layer); empty elsewhere. */
export function readEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}
