import { NotFoundError } from "./errors.js";
import type { CallOptions, HttpClient } from "./http.js";
import { Page, type PageEnvelope } from "./page.js";
import type {
  Filters,
  ListOptions,
  MessageAddition,
  MessageInput,
  RepresentationLike,
} from "./types.js";
import { enc, type Obj, toIso } from "./util.js";
import { configToWire } from "./wire.js";

/** What every handle shares: the transport and the workspace it acts in. */
export interface Core {
  readonly http: HttpClient;
  readonly workspaceId: string;
  /** Get-or-create on a handle's first use (`RecallConfig.autoCreate`). */
  readonly autoCreate?: boolean;
}

export const wsPath = (core: Core): string => `/workspaces/${enc(core.workspaceId)}`;

/** Fetches a page-numbered list (`POST …/list?page&size&reverse`) and returns a `Page` that can walk on. */
export function listPage<T, Raw = T>(
  core: Core,
  path: string,
  opts: ListOptions & CallOptions,
  transform: (raw: Raw) => T,
  extraFilters?: Filters,
): Promise<Page<T, Raw>> {
  const filters = extraFilters || opts.filters ? { ...opts.filters, ...extraFilters } : undefined;
  const fetchPage = async (page: number): Promise<Page<T, Raw>> => {
    const envelope = await core.http.request<PageEnvelope<Raw>>({
      method: "POST",
      path,
      query: { page, size: opts.size, reverse: opts.reverse },
      body: filters ? { filters } : {},
      idempotent: true,
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return new Page(envelope, transform, fetchPage);
  };
  return fetchPage(opts.page ?? 1);
}

export function messageToWire(m: MessageInput): Obj {
  if (!m || typeof m.peerId !== "string" || typeof m.content !== "string") {
    throw new TypeError("a message needs a string peerId and a string content");
  }
  return {
    peer_id: m.peerId,
    content: m.content,
    ...(m.metadata === undefined ? {} : { metadata: m.metadata }),
    ...(m.configuration === undefined ? {} : { configuration: configToWire(m.configuration) }),
    ...(m.createdAt === undefined ? {} : { created_at: toIso(m.createdAt) }),
  };
}

export function toMessageList(input: MessageAddition): MessageInput[] {
  const list = Array.isArray(input) ? [...input] : [input as MessageInput];
  if (list.length === 0) throw new TypeError("at least one message is required");
  return list;
}

/** The text of a search query given as a string or as a message. */
export const queryText = (q: string | { readonly content: string }): string =>
  typeof q === "string" ? q : q.content;

export type { RepresentationLike };

/** Gets or creates the workspace and the named peers, for writes whose target must already exist. */
async function ensureExist(core: Core, peerIds: readonly string[]): Promise<void> {
  await core.http.request({
    method: "POST",
    path: "/workspaces",
    body: { id: core.workspaceId },
    idempotent: true,
  });
  for (const id of new Set(peerIds)) {
    await core.http.request({
      method: "POST",
      path: `${wsPath(core)}/peers`,
      body: { id },
      idempotent: true,
    });
  }
}

/**
 * Runs `attempt`; if the server says the workspace or a peer does not exist yet (handles are lazy,
 * so nothing created them), creates them and runs it once more.
 */
export async function orCreateTargets<T>(
  core: Core,
  peerIds: readonly string[],
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof NotFoundError) || !/^(Workspace|Peer) /.test(err.message)) throw err;
    await ensureExist(core, peerIds);
    return attempt();
  }
}
