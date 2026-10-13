import { SessionContext } from "./context.js";
import { type Core, listPage, messageToWire, queryText, toMessageList, wsPath } from "./core.js";
import { NotFoundError, RecallTimeoutError } from "./errors.js";
import type { CallOptions } from "./http.js";
import type { Page } from "./page.js";
import type { PeerRepresentationOptions, SearchOptions } from "./peer.js";
import { AUTHOR, Peer, SETTLE } from "./peer.js";
import type {
  ListOptions,
  Message,
  MessageAddition,
  MessageInput,
  Metadata,
  QueueStatus,
  RepresentationLike,
  SessionConfig,
  SessionPeerConfig,
  SessionSummaries,
} from "./types.js";
import {
  assertId,
  chunk,
  compact,
  enc,
  type IdLike,
  idOf,
  type Obj,
  sleep,
  toIso,
  uuid,
} from "./util.js";
import {
  configFromWire,
  configToWire,
  messageFromWire,
  queueStatusFromWire,
  summaryFromWire,
} from "./wire.js";

const MAX_BATCH = 100;

/** Peers to add to a session: ids, handles, `[peer, config]` pairs, or `{ peerId: config }`. */
export type PeerAddition =
  | IdLike
  | readonly (IdLike | readonly [IdLike, SessionPeerConfig])[]
  | Record<string, SessionPeerConfig>;
export type PeerRemoval = IdLike | readonly IdLike[];

export interface SessionInit {
  metadata?: Metadata;
  configuration?: SessionConfig;
  /** Peers to put in the session when it is created. */
  peers?: PeerAddition;
  /** Scopes (ids or handles) the session should join. */
  scopes?: readonly IdLike[];
}

export interface AddMessagesOptions extends CallOptions {
  /** Makes the call safe to retry. Generated for you; pass your own to dedupe across processes. */
  idempotencyKey?: string;
  /**
   * Wait for background processing (extraction, summaries) to finish before returning.
   * `true` waits up to 30 s; a number sets the limit in milliseconds.
   */
  wait?: boolean | number;
}

export interface ContextOptions extends RepresentationLike, CallOptions {
  /** Include a summary of older turns (default true). */
  summary?: boolean;
  /** Token budget for the whole result (default and maximum 100000). */
  tokens?: number;
  /** Add the representation and card of this peer. */
  peerTarget?: IdLike;
  /** View the target through this other peer's memory. */
  peerPerspective?: IdLike;
  scope?: IdLike;
  sessions?: readonly IdLike[];
  /** Only use what was learned in this session. */
  limitToSession?: boolean;
  /** Retrieval knobs, given as one nested object (the flat fields work too and win). */
  representationOptions?: RepresentationLike;
}

export interface TurnOptions
  extends Pick<
      ContextOptions,
      | "summary"
      | "tokens"
      | "peerTarget"
      | "peerPerspective"
      | "limitToSession"
      | "searchQuery"
      | "maxConclusions"
    >,
    CallOptions {
  idempotencyKey?: string;
}
export interface TurnResult {
  /** The messages as stored. */
  messages: Message[];
  /** The context for the next prompt, taken after the new messages were stored. */
  context: SessionContext;
}

export interface WaitOptions extends CallOptions {
  /** Give up after this many milliseconds (default 30000). */
  timeout?: number;
  /** Poll interval when the server cannot long-poll (default 500). */
  pollInterval?: number;
}

export interface UploadableFile {
  filename: string;
  content: Uint8Array | ArrayBuffer;
  /** The media type. When absent it is guessed from the file name (PDF, JSON, else text). */
  contentType?: string;
  /** Snake-case spelling, accepted as an alias of `contentType`. */
  content_type?: string;
}

/** Media types the server understands, by file extension; anything else is sent as plain text. */
function guessType(filename: string): string {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "json") return "application/json";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "csv") return "text/csv";
  if (ext === "html" || ext === "htm") return "text/html";
  return "text/plain";
}

/**
 * Peer handles whose pending settings must reach the server before a write creates the peer with
 * defaults: the authors of `peer.message()` messages, and handles named in the session's peers.
 */
async function settlePeers(
  messages: readonly MessageInput[],
  peers: PeerAddition | undefined,
): Promise<void> {
  const handles = new Set<Peer>();
  for (const m of messages) {
    const author = (m as { [AUTHOR]?: Peer })[AUTHOR];
    if (author) handles.add(author);
  }
  const visit = (x: unknown) => {
    if (x instanceof Peer) handles.add(x);
  };
  if (Array.isArray(peers)) for (const e of peers) visit(Array.isArray(e) ? e[0] : e);
  else visit(peers);
  await Promise.all([...handles].map((p) => p[SETTLE]()));
}

function peerPairs(input: PeerAddition): Record<string, Obj> {
  const out: Record<string, Obj> = {};
  const put = (peer: IdLike, config?: SessionPeerConfig) => {
    out[assertId("peer id", idOf(peer))] = config ? (configToWire(config) as Obj) : {};
  };
  if (typeof input === "string") put(input);
  else if (Array.isArray(input)) {
    for (const entry of input as readonly (IdLike | readonly [IdLike, SessionPeerConfig])[]) {
      if (Array.isArray(entry)) put(entry[0] as IdLike, entry[1] as SessionPeerConfig);
      else put(entry as IdLike);
    }
  } else if (typeof (input as { id?: unknown }).id === "string") {
    put(input as IdLike); // a Peer handle
  } else {
    for (const [id, config] of Object.entries(input as Record<string, SessionPeerConfig>)) {
      put(id, config);
    }
  }
  return out;
}

/**
 * A conversation thread. A `Session` is a lazy handle: `recall.session("chat-1")` makes no request, and
 * the session is created by the first message (or peer) you add. Options passed to `session()`
 * (`metadata`, `configuration`, `peers`, `scopes`) are sent with the handle's first request.
 */
export class Session {
  readonly id: string;
  readonly workspaceId: string;
  #pending: SessionInit | null;
  #inflight: Promise<void> | null = null;
  #metadata: Metadata | undefined;
  #configuration: SessionConfig | undefined;
  #createdAt: string | undefined;
  #isActive: boolean | undefined;
  /** The server has confirmed this session exists (it came from a list, or a get-or-create ran). */
  #known = false;

  constructor(
    private readonly core: Core,
    id: string,
    init: SessionInit = {},
    known?: Obj,
  ) {
    this.id = assertId("session id", id);
    this.workspaceId = core.workspaceId;
    this.#pending = Object.values(init).some((v) => v !== undefined) ? { ...init } : null;
    if (known) this.#apply(known);
  }

  get metadata(): Metadata | undefined {
    return this.#metadata;
  }
  get configuration(): SessionConfig | undefined {
    return this.#configuration;
  }
  get createdAt(): string | undefined {
    return this.#createdAt;
  }
  get isActive(): boolean | undefined {
    return this.#isActive;
  }

  #apply(w: Obj): void {
    this.#metadata = (w.metadata as Metadata | null) ?? {};
    this.#configuration = configFromWire<SessionConfig>(w.configuration);
    this.#createdAt = typeof w.created_at === "string" ? w.created_at : undefined;
    this.#isActive = typeof w.is_active === "boolean" ? w.is_active : undefined;
    this.#known = true;
  }

  #path(suffix = ""): string {
    return `${wsPath(this.core)}/sessions/${enc(this.id)}${suffix}`;
  }

  /**
   * Sends the options given at construction, once, before the first real request. With
   * `autoCreate` it also gets-or-creates a session the handle has not seen yet.
   */
  async #settle(): Promise<void> {
    if (!this.#pending && (this.#known || !this.core.autoCreate)) return;
    this.#inflight ??= settlePeers([], this.#pending?.peers)
      .then(() => this.refresh())
      .then(() => undefined)
      .finally(() => {
        this.#inflight = null;
      });
    await this.#inflight;
  }

  /** Gets or creates the session (sending any pending options) and caches what comes back. */
  async refresh(): Promise<this> {
    const p = this.#pending;
    const w = await this.core.http.request<Obj>({
      method: "POST",
      path: `${wsPath(this.core)}/sessions`,
      body: compact({
        id: this.id,
        metadata: p?.metadata,
        configuration: p?.configuration && configToWire(p.configuration),
        peers: p?.peers === undefined ? undefined : peerPairs(p.peers),
        scopes: p?.scopes?.map(idOf),
      }),
      idempotent: true,
    });
    this.#pending = null;
    this.#apply(w);
    return this;
  }

  async getMetadata(): Promise<Metadata> {
    await this.refresh();
    return this.#metadata ?? {};
  }
  async setMetadata(metadata: Metadata): Promise<void> {
    await this.#put({ metadata });
  }
  async getConfiguration(): Promise<SessionConfig> {
    await this.refresh();
    return this.#configuration ?? {};
  }
  async setConfiguration(configuration: SessionConfig): Promise<void> {
    await this.#put({ configuration: configToWire(configuration) });
  }
  async #put(body: Obj): Promise<void> {
    await this.#settle();
    this.#apply(
      await this.core.http.request<Obj>({
        method: "PUT",
        path: this.#path(),
        body,
        idempotent: true,
      }),
    );
  }

  /** Deletes the session. The server removes its messages and conclusions in the background. */
  async delete(): Promise<void> {
    await this.core.http.request({ method: "DELETE", path: this.#path(), idempotent: true });
  }

  /** Copies the session (up to and including `messageId`, if given) into a new one with a generated id. */
  async clone(messageId?: string): Promise<Session> {
    await this.#settle();
    const w = await this.core.http.request<Obj>({
      method: "POST",
      path: this.#path("/clone"),
      query: { message_id: messageId },
      body: {},
    });
    return new Session(this.core, w.id as string, {}, w);
  }

  // ---- members --------------------------------------------------------------

  async addPeers(peers: PeerAddition): Promise<void> {
    await this.#settle();
    await this.core.http.request({
      method: "POST",
      path: this.#path("/peers"),
      body: peerPairs(peers),
      idempotent: true,
    });
  }

  /** Makes exactly these peers the members. */
  async setPeers(peers: PeerAddition): Promise<void> {
    await this.#settle();
    await this.core.http.request({
      method: "PUT",
      path: this.#path("/peers"),
      body: peerPairs(peers),
      idempotent: true,
    });
  }

  async removePeers(peers: PeerRemoval): Promise<void> {
    await this.#settle();
    const ids = (Array.isArray(peers) ? [...(peers as readonly IdLike[])] : [peers as IdLike]).map(
      idOf,
    );
    await this.core.http.request({
      method: "DELETE",
      path: this.#path("/peers"),
      body: ids,
      idempotent: true,
    });
  }

  /** Every member of the session (all pages). */
  async peers(opts: CallOptions = {}): Promise<Peer[]> {
    await this.#settle();
    const out: Peer[] = [];
    for (let page = 1; ; page++) {
      const r = await this.core.http.request<{ items: Obj[]; pages?: number }>({
        method: "GET",
        path: this.#path("/peers"),
        query: { page, size: 100 },
        ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      out.push(...r.items.map((w) => new Peer(this.core, w.id as string, {}, w)));
      if (page >= (r.pages ?? 1)) return out;
    }
  }

  async getPeerConfiguration(peer: IdLike): Promise<SessionPeerConfig> {
    await this.#settle();
    return configFromWire<SessionPeerConfig>(
      await this.core.http.request<Obj>({
        method: "GET",
        path: this.#path(`/peers/${enc(idOf(peer))}/config`),
      }),
    );
  }

  async setPeerConfiguration(peer: IdLike, config: SessionPeerConfig): Promise<void> {
    await this.#settle();
    await this.core.http.request({
      method: "PUT",
      path: this.#path(`/peers/${enc(idOf(peer))}/config`),
      body: configToWire(config),
      idempotent: true,
    });
  }

  // ---- messages -------------------------------------------------------------

  /**
   * Records messages. Safe to retry: every call carries an `Idempotency-Key`, so a request that
   * timed out but succeeded is not stored twice. More than 100 messages are sent in order, in batches.
   */
  async addMessages(messages: MessageAddition, opts: AddMessagesOptions = {}): Promise<Message[]> {
    const list = toMessageList(messages);
    await settlePeers(list, undefined);
    await this.#settle();
    const wire = list.map(messageToWire);
    const key = opts.idempotencyKey ?? uuid();
    const batches = chunk(wire, MAX_BATCH);
    const stored: Message[] = [];
    for (const [i, batch] of batches.entries()) {
      const out = await this.core.http.request<Obj[]>({
        method: "POST",
        path: this.#path("/messages"),
        body: { messages: batch },
        headers: { "idempotency-key": batches.length === 1 ? key : `${key}:${i}` },
        idempotent: true,
        // 409 means another writer held the session lock; the key makes the retry safe.
        retryStatuses: [409],
        ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      stored.push(...out.map(messageFromWire));
    }
    if (opts.wait) {
      await this.waitForIdle({
        timeout: typeof opts.wait === "number" ? opts.wait : 30_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    }
    return stored;
  }

  /**
   * One round trip for an agent turn: stores the new messages, then returns the context for the
   * next prompt (summary, recent messages, and with `peerTarget` what memory knows about them).
   */
  async turn(messages: MessageAddition, opts: TurnOptions = {}): Promise<TurnResult> {
    const list = toMessageList(messages);
    await settlePeers(list, undefined);
    await this.#settle();
    const wire = list.map(messageToWire);
    if (wire.length > MAX_BATCH) {
      throw new RangeError(
        `turn() takes at most ${MAX_BATCH} messages; use addMessages() for more`,
      );
    }
    const context = compact({
      tokens: opts.tokens,
      summary: opts.summary,
      peer_target: opts.peerTarget === undefined ? undefined : idOf(opts.peerTarget),
      peer_perspective: opts.peerPerspective === undefined ? undefined : idOf(opts.peerPerspective),
      limit_to_session: opts.limitToSession,
      search_query: opts.searchQuery === undefined ? undefined : queryText(opts.searchQuery),
      max_conclusions: opts.maxConclusions,
    });
    const r = await this.core.http.request<{ messages: Obj[]; context: Obj }>({
      method: "POST",
      path: this.#path("/turn"),
      body: { messages: wire, ...(Object.keys(context).length ? { context } : {}) },
      headers: { "idempotency-key": opts.idempotencyKey ?? uuid() },
      idempotent: true,
      retryStatuses: [409],
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { messages: r.messages.map(messageFromWire), context: contextFromWire(r.context) };
  }

  async messages(opts: ListOptions & CallOptions = {}): Promise<Page<Message, Obj>> {
    await this.#settle();
    return listPage(this.core, this.#path("/messages/list"), opts, messageFromWire);
  }

  async getMessage(id: string): Promise<Message> {
    await this.#settle();
    return messageFromWire(
      await this.core.http.request<Obj>({
        method: "GET",
        path: this.#path(`/messages/${enc(id)}`),
      }),
    );
  }

  /** Replaces a message's metadata. (Content is immutable.) */
  async updateMessage(
    message: string | { readonly id: string },
    metadata: Metadata,
  ): Promise<Message> {
    await this.#settle();
    return messageFromWire(
      await this.core.http.request<Obj>({
        method: "PUT",
        path: this.#path(`/messages/${enc(idOf(message))}`),
        body: { metadata },
        idempotent: true,
      }),
    );
  }

  /**
   * Adds a file's text to the session as messages from `peer`. PDF, text and JSON are understood;
   * long files are split into several messages.
   */
  async uploadFile(
    file: Blob | UploadableFile,
    peer: IdLike,
    opts: {
      metadata?: Metadata;
      configuration?: MessageInput["configuration"];
      createdAt?: string | Date;
    } & AddMessagesOptions = {},
  ): Promise<Message[]> {
    await this.#settle();
    const form = new FormData();
    if (file instanceof Blob) {
      form.set("file", file, (file as { name?: string }).name ?? "upload");
    } else {
      const bytes =
        file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content);
      form.set(
        "file",
        new Blob([bytes as BlobPart], {
          type: file.contentType ?? file.content_type ?? guessType(file.filename),
        }),
        file.filename,
      );
    }
    form.set("peer_id", idOf(peer));
    if (opts.metadata) form.set("metadata", JSON.stringify(opts.metadata));
    if (opts.configuration)
      form.set("configuration", JSON.stringify(configToWire(opts.configuration)));
    if (opts.createdAt) form.set("created_at", toIso(opts.createdAt));
    const out = await this.core.http.request<Obj[]>({
      method: "POST",
      path: this.#path("/messages/upload"),
      form,
      headers: { "idempotency-key": opts.idempotencyKey ?? uuid() },
      idempotent: true,
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return out.map(messageFromWire);
  }

  // ---- reading memory -----------------------------------------------------------

  /** What the next prompt needs, within a token budget. See `ContextOptions`. */
  async context(opts: ContextOptions = {}): Promise<SessionContext> {
    await this.#settle();
    const rep = { ...opts.representationOptions, ...compact({ ...opts }) } as ContextOptions &
      RepresentationLike;
    const w = await this.core.http.request<Obj>({
      method: "GET",
      path: this.#path("/context"),
      query: {
        summary: opts.summary,
        tokens: opts.tokens,
        limit_to_session: opts.limitToSession,
        peer_target: opts.peerTarget === undefined ? undefined : idOf(opts.peerTarget),
        peer_perspective:
          opts.peerPerspective === undefined ? undefined : idOf(opts.peerPerspective),
        scope: opts.scope === undefined ? undefined : idOf(opts.scope),
        sessions: opts.sessions?.map(idOf),
        search_query: rep.searchQuery === undefined ? undefined : queryText(rep.searchQuery),
        search_top_k: rep.searchTopK,
        search_max_distance: rep.searchMaxDistance,
        include_most_frequent: rep.includeMostFrequent,
        max_conclusions: rep.maxConclusions,
      },
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return contextFromWire(w);
  }

  async summaries(): Promise<SessionSummaries> {
    await this.#settle();
    const w = await this.core.http.request<Obj>({ method: "GET", path: this.#path("/summaries") });
    return {
      id: w.id as string,
      sessionId: w.id as string,
      shortSummary: summaryFromWire(w.short_summary),
      longSummary: summaryFromWire(w.long_summary),
    };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Message[]> {
    await this.#settle();
    const found = await this.core.http.request<Obj[]>({
      method: "POST",
      path: this.#path("/search"),
      body: { query, limit: opts.limit ?? 10, ...(opts.filters ? { filters: opts.filters } : {}) },
      idempotent: true,
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return found.map(messageFromWire);
  }

  /** What `peer` has come to know, restricted to this session. */
  async representation(
    peer: IdLike,
    opts: Omit<PeerRepresentationOptions, "session" | "sessions" | "scope"> = {},
  ): Promise<string> {
    await this.#settle();
    return new Peer(this.core, idOf(peer)).representation({ ...opts, session: this.id });
  }

  // ---- background processing --------------------------------------------------------

  async queueStatus(
    opts: { observer?: IdLike; sender?: IdLike } & CallOptions = {},
  ): Promise<QueueStatus> {
    await this.#settle();
    return queueStatus(this.core, {
      session: this.id,
      ...(opts.observer === undefined ? {} : { observer: opts.observer }),
      ...(opts.sender === undefined ? {} : { sender: opts.sender }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** Resolves when background processing for this session has caught up. Rejects on timeout. */
  waitForIdle(opts: WaitOptions = {}): Promise<QueueStatus> {
    return waitForIdle(this.core, { ...opts, session: this.id });
  }

  toString(): string {
    return `Session(${this.id})`;
  }
}

export function contextFromWire(w: Obj): SessionContext {
  const messages = Array.isArray(w.messages) ? (w.messages as Obj[]) : [];
  return new SessionContext(
    (w.id as string) ?? "",
    messages.map(messageFromWire),
    summaryFromWire(w.summary),
    (w.peer_representation as string | null | undefined) || null,
    (w.peer_card as string[] | null | undefined) ?? null,
  );
}

export async function queueStatus(
  core: Core,
  opts: {
    session?: IdLike;
    observer?: IdLike;
    sender?: IdLike;
    waitMs?: number;
    signal?: AbortSignal;
    timeout?: number;
  } = {},
): Promise<QueueStatus> {
  return queueStatusFromWire(
    await core.http.request<Obj>({
      method: "GET",
      path: `${wsPath(core)}/queue/status`,
      query: {
        session_id: opts.session === undefined ? undefined : idOf(opts.session),
        observer_id: opts.observer === undefined ? undefined : idOf(opts.observer),
        sender_id: opts.sender === undefined ? undefined : idOf(opts.sender),
        wait_ms: opts.waitMs,
      },
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  );
}

/**
 * Waits for the background queue (extraction, summaries, due dreams) to drain. The server holds
 * each request open until idle (`wait_ms`), so this does not poll in a tight loop; against a server
 * that cannot long-poll it falls back to polling.
 */
export async function waitForIdle(
  core: Core,
  opts: WaitOptions & { session?: IdLike; observer?: IdLike; sender?: IdLike } = {},
): Promise<QueueStatus> {
  const limit = opts.timeout ?? 30_000;
  const deadline = Date.now() + limit;
  const poll = opts.pollInterval ?? 500;
  // The server caps one wait at 60 s; stay well inside the HTTP timeout.
  const slice = 20_000;
  let last: QueueStatus | null = null;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new RecallTimeoutError(`Background processing was not idle after ${limit} ms`, {
        cause: last,
      });
    }
    const waitMs = Math.max(1, Math.min(slice, remaining));
    try {
      last = await queueStatus(core, {
        ...(opts.session === undefined ? {} : { session: opts.session }),
        ...(opts.observer === undefined ? {} : { observer: opts.observer }),
        ...(opts.sender === undefined ? {} : { sender: opts.sender }),
        waitMs,
        timeout: waitMs + 10_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      // No workspace yet means nothing has been recorded, so there is nothing to wait for.
      if (err instanceof NotFoundError) return queueStatusFromWire({ idle: true });
      throw err;
    }
    const idle = last.idle ?? (last.pendingWorkUnits === 0 && last.inProgressWorkUnits === 0);
    if (idle) return last;
    if (last.idle === undefined)
      await sleep(Math.min(poll, Math.max(0, deadline - Date.now())), opts.signal);
  }
}
