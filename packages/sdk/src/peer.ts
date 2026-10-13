import {
  type ChatOptions,
  chatOnce,
  chatStream,
  checkRecallScope,
  type PeerChatOptions,
  sessionFilter,
} from "./chat.js";
import { ConclusionsView } from "./conclusions.js";
import { PeerContext } from "./context.js";
import { type Core, listPage, queryText, wsPath } from "./core.js";
import type { CallOptions } from "./http.js";
import type { Page } from "./page.js";
import { Session } from "./session.js";
import type { DialecticStream } from "./stream.js";
import type {
  ChatResponse,
  Filters,
  JsonSchema,
  ListOptions,
  Message,
  MessageConfig,
  MessageInput,
  Metadata,
  PeerConfig,
  RepresentationLike,
  SchemaLike,
  TypedResponseFormat,
} from "./types.js";
import { assertId, compact, enc, type IdLike, idOf, type Obj } from "./util.js";
import { configFromWire, configToWire, messageFromWire } from "./wire.js";

export interface PeerInit {
  metadata?: Metadata;
  configuration?: PeerConfig;
}

export interface PeerRepresentationOptions extends RepresentationLike, CallOptions {
  /** Only use what was learned in this session. */
  session?: IdLike;
  /** Use the combined memory of these scopes. */
  scope?: IdLike | readonly IdLike[];
  /** Only use what was learned in these sessions. */
  sessions?: readonly IdLike[];
  /** The peer to describe (default: this peer, from its own point of view). */
  target?: IdLike;
}

export interface PeerContextOptions extends RepresentationLike, CallOptions {
  target?: IdLike;
}

/** What `Peer.delete()` removed. */
export interface PeerDeletion {
  peerId: string;
  messagesDeleted: number;
  conclusionsDeleted: number;
  /** Sessions the peer had written in; their summaries are rebuilt without it. */
  sessionsAffected: number;
}

export interface SearchOptions extends CallOptions {
  filters?: Filters;
  /** Max results, 1-100 (default 10). */
  limit?: number;
}

export interface MessageOptions {
  metadata?: Metadata;
  configuration?: MessageConfig;
  createdAt?: string | Date;
}

/** Internal: the handle that built a message with `peer.message()` (not serialised). */
export const AUTHOR: unique symbol = Symbol("recall.author");
/** Internal: sends a handle's pending metadata/configuration, so a session can do it before a write. */
export const SETTLE: unique symbol = Symbol("recall.settle");

/**
 * A participant: a person or an agent. A `Peer` is a lazy handle, so `recall.peer("alice")` makes
 * no request; the peer comes into existence when a message names it. Passing `metadata` or
 * `configuration` to `peer()` sends them with the first request the handle makes (or call `refresh()`).
 */
export class Peer {
  readonly id: string;
  readonly workspaceId: string;
  #pending: PeerInit | null;
  #inflight: Promise<void> | null = null;
  #metadata: Metadata | undefined;
  #configuration: PeerConfig | undefined;
  #createdAt: string | undefined;
  /** The server has confirmed this peer exists (it came from a list, or a get-or-create ran). */
  #known = false;

  constructor(
    private readonly core: Core,
    id: string,
    init: PeerInit = {},
    known?: Obj,
  ) {
    this.id = assertId("peer id", id);
    this.workspaceId = core.workspaceId;
    this.#pending =
      init.metadata !== undefined || init.configuration !== undefined ? { ...init } : null;
    if (known) this.#apply(known);
  }

  /** Cached by the last `refresh()`/`getMetadata()`/list; undefined before. */
  get metadata(): Metadata | undefined {
    return this.#metadata;
  }
  get configuration(): PeerConfig | undefined {
    return this.#configuration;
  }
  get createdAt(): string | undefined {
    return this.#createdAt;
  }

  #apply(w: Obj): void {
    this.#metadata = (w.metadata as Metadata | null) ?? {};
    this.#configuration = configFromWire<PeerConfig>(w.configuration);
    this.#createdAt = typeof w.created_at === "string" ? w.created_at : undefined;
    this.#known = true;
  }

  #path(suffix = ""): string {
    return `${wsPath(this.core)}/peers/${enc(this.id)}${suffix}`;
  }

  /**
   * Sends the metadata/configuration given at construction, once, before the first real request.
   * With `autoCreate` it also gets-or-creates a peer the handle has not seen yet.
   */
  async #settle(): Promise<void> {
    if (!this.#pending && (this.#known || !this.core.autoCreate)) return;
    this.#inflight ??= this.refresh()
      .then(() => undefined)
      .finally(() => {
        this.#inflight = null;
      });
    await this.#inflight;
  }

  /** Gets or creates the peer on the server (sending any pending metadata/configuration) and caches what comes back. */
  async refresh(): Promise<this> {
    const pending = this.#pending;
    const w = await this.core.http.request<Obj>({
      method: "POST",
      path: `${wsPath(this.core)}/peers`,
      body: compact({
        id: this.id,
        metadata: pending?.metadata,
        configuration: pending?.configuration && configToWire(pending.configuration),
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
  async getConfiguration(): Promise<PeerConfig> {
    await this.refresh();
    return this.#configuration ?? {};
  }
  async setConfiguration(configuration: PeerConfig): Promise<void> {
    await this.#put({ configuration: configToWire(configuration) });
  }
  async #put(body: Obj): Promise<void> {
    this.#pending = null; // the PUT upserts
    this.#apply(
      await this.core.http.request<Obj>({
        method: "PUT",
        path: this.#path(),
        body,
        idempotent: true,
      }),
    );
  }

  // ---- ask ------------------------------------------------------------------

  /**
   * Asks what this peer's memory knows. Returns the answer text, or with `includeEvidence` a
   * `ChatResponse`, or with `responseFormat` the parsed JSON (typed when you pass `{ jsonSchema, parse }`).
   */
  chat(query: string, opts: PeerChatOptions & { includeEvidence: true }): Promise<ChatResponse>;
  chat<T>(
    query: string,
    opts: PeerChatOptions & { responseFormat: TypedResponseFormat<T> | SchemaLike<T> },
  ): Promise<T | null>;
  chat(query: string, opts: PeerChatOptions & { responseFormat: JsonSchema }): Promise<unknown>;
  chat(query: string, opts?: PeerChatOptions): Promise<string | null>;
  async chat(query: string, opts: PeerChatOptions = {}): Promise<unknown> {
    await this.#settle();
    return chatOnce(this.core.http, this.#path("/chat"), query, opts);
  }

  /** Like `chat`, but streams the answer as it is written. */
  async chatStream(
    query: string,
    opts: Omit<PeerChatOptions, "responseFormat" | "includeEvidence"> = {},
  ): Promise<DialecticStream> {
    await this.#settle();
    return chatStream(this.core.http, this.#path("/chat"), query, opts);
  }

  // ---- messages -------------------------------------------------------------

  /**
   * Builds a message authored by this peer, ready for `session.addMessages(...)`. The message
   * remembers this handle, so the session sends the peer's pending metadata/configuration (say
   * `observeMe: false`) before the message, not after it was already learned from.
   */
  message(content: string, opts: MessageOptions = {}): MessageInput {
    const m: MessageInput = { peerId: this.id, content, ...compact({ ...opts }) };
    Object.defineProperty(m, AUTHOR, { value: this });
    return m;
  }

  async [SETTLE](): Promise<void> {
    await this.#settle();
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

  /** Sessions this peer takes part in. */
  async sessions(opts: ListOptions & CallOptions = {}): Promise<Page<Session, Obj>> {
    await this.#settle();
    return listPage(
      this.core,
      this.#path("/sessions"),
      opts,
      (w: Obj) => new Session(this.core, w.id as string, {}, w),
    );
  }

  // ---- cards and representations --------------------------------------------

  /** The short list of stable facts about this peer (or about `target`), or null when there is none yet. */
  async getCard(target?: IdLike, opts: CallOptions = {}): Promise<string[] | null> {
    await this.#settle();
    const r = await this.core.http.request<{ peer_card?: string[] | null }>({
      method: "GET",
      path: this.#path("/card"),
      query: { target: target === undefined ? undefined : idOf(target) },
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return r.peer_card ?? null;
  }

  /** @deprecated Use `getCard`. */
  card(target?: IdLike): Promise<string[] | null> {
    return this.getCard(target);
  }

  /** Replaces the card with exactly these facts. */
  async setCard(peerCard: string[], target?: IdLike): Promise<string[]> {
    await this.#settle();
    const r = await this.core.http.request<{ peer_card?: string[] | null }>({
      method: "PUT",
      path: this.#path("/card"),
      query: { target: target === undefined ? undefined : idOf(target) },
      body: { peer_card: peerCard },
      idempotent: true,
    });
    return r.peer_card ?? [];
  }

  /** A text description of what memory knows about the target, optionally focused by `searchQuery`. */
  async representation(opts: PeerRepresentationOptions = {}): Promise<string> {
    checkRecallScope(opts);
    await this.#settle();
    const scope =
      opts.scope === undefined
        ? undefined
        : Array.isArray(opts.scope)
          ? (opts.scope as readonly IdLike[]).map(idOf)
          : idOf(opts.scope as IdLike);
    const r = await this.core.http.request<{ representation?: string }>({
      method: "POST",
      path: this.#path("/representation"),
      body: compact({
        session_id: opts.session === undefined ? undefined : idOf(opts.session),
        target: opts.target === undefined ? undefined : idOf(opts.target),
        scope,
        filters: sessionFilter(opts.sessions),
        search_query: opts.searchQuery === undefined ? undefined : queryText(opts.searchQuery),
        search_top_k: opts.searchTopK,
        search_max_distance: opts.searchMaxDistance,
        include_most_frequent: opts.includeMostFrequent,
        max_conclusions: opts.maxConclusions,
      }),
      idempotent: true,
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return r.representation ?? "";
  }

  /** Representation and card together. */
  async context(opts: PeerContextOptions = {}): Promise<PeerContext> {
    await this.#settle();
    const r = await this.core.http.request<Obj>({
      method: "GET",
      path: this.#path("/context"),
      query: {
        target: opts.target === undefined ? undefined : idOf(opts.target),
        search_query: opts.searchQuery === undefined ? undefined : queryText(opts.searchQuery),
        search_top_k: opts.searchTopK,
        search_max_distance: opts.searchMaxDistance,
        include_most_frequent: opts.includeMostFrequent,
        max_conclusions: opts.maxConclusions,
      },
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return new PeerContext(
      (r.peer_id as string) ?? this.id,
      (r.target_id as string) ?? this.id,
      (r.representation as string | null | undefined) ?? null,
      (r.peer_card as string[] | null | undefined) ?? null,
    );
  }

  // ---- conclusions ------------------------------------------------------------

  /** What this peer concludes about themself. */
  get conclusions(): ConclusionsView {
    return new ConclusionsView(this.core, this.id, this.id);
  }

  /** What this peer concludes about `target`. */
  conclusionsOf(target: IdLike): ConclusionsView {
    return new ConclusionsView(this.core, this.id, idOf(target));
  }

  /**
   * Erases this peer (a Recall extension to the v3 API): the messages it wrote,
   * its memberships, and everything memory holds from or about it, including peer cards and scopes'
   * memory of it. Needs a workspace-level key. Resolves to what was removed.
   */
  async delete(opts: CallOptions = {}): Promise<PeerDeletion> {
    const r = await this.core.http.request<Obj>({
      method: "DELETE",
      path: this.#path(),
      // Not retried after a lost response: a repeat would find the peer gone and 404.
      idempotent: false,
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    this.#known = false;
    return {
      peerId: (r.peer_id as string) ?? this.id,
      messagesDeleted: Number(r.messages_deleted ?? 0),
      conclusionsDeleted: Number(r.conclusions_deleted ?? 0),
      sessionsAffected: Number(r.sessions_affected ?? 0),
    };
  }

  toString(): string {
    return `Peer(${this.id})`;
  }
}

export type { ChatOptions, ChatResponse };
