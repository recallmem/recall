import { type ChatOptions, chatOnce, chatStream as openChatStream } from "./chat.js";
import { WorkspaceConclusions } from "./conclusions.js";
import { type RecallConfig, resolveConfig } from "./config.js";
import { type Core, listPage, orCreateTargets, wsPath } from "./core.js";
import { type CallOptions, HttpClient } from "./http.js";
import { Page, type PageEnvelope } from "./page.js";
import { Peer, type PeerInit, type SearchOptions } from "./peer.js";
import { Scope } from "./scope.js";
import {
  queueStatus,
  Session,
  type SessionInit,
  type WaitOptions,
  waitForIdle,
} from "./session.js";
import type { DialecticStream } from "./stream.js";
import type {
  ChatResponse,
  JsonSchema,
  ListOptions,
  Message,
  Metadata,
  QueueStatus,
  SchemaLike,
  TypedResponseFormat,
  Usage,
  WebhookEndpoint,
  WorkspaceConfig,
} from "./types.js";
import { assertId, compact, enc, type IdLike, idOf, type Obj, toIso } from "./util.js";
import {
  configFromWire,
  configToWire,
  messageFromWire,
  usageFromWire,
  webhookFromWire,
} from "./wire.js";

/** `recall.webhooks`: the endpoints that receive `queue.empty` events. */
export class Webhooks {
  constructor(private readonly core: Core) {}

  /** Registers an endpoint (idempotent per URL). Verify deliveries with `constructWebhookEvent`. */
  async create(url: string): Promise<WebhookEndpoint> {
    return webhookFromWire(
      await orCreateTargets(this.core, [], () =>
        this.core.http.request<Obj>({
          method: "POST",
          path: `${wsPath(this.core)}/webhooks`,
          body: { url },
          idempotent: true,
        }),
      ),
    );
  }

  list(opts: ListOptions & CallOptions = {}): Promise<Page<WebhookEndpoint, Obj>> {
    // This route lists with GET, not POST.
    return listWebhooks(this.core, opts);
  }

  async delete(id: string): Promise<void> {
    await this.core.http.request({
      method: "DELETE",
      path: `${wsPath(this.core)}/webhooks/${enc(id)}`,
      idempotent: true,
    });
  }

  /** Asks the server to send a `test.event` to every endpoint. */
  async test(): Promise<void> {
    await this.core.http.request({ method: "GET", path: `${wsPath(this.core)}/webhooks/test` });
  }
}

function listWebhooks(
  core: Core,
  opts: ListOptions & CallOptions,
): Promise<Page<WebhookEndpoint, Obj>> {
  const fetchPage = async (page: number): Promise<Page<WebhookEndpoint, Obj>> => {
    const envelope = await core.http.request<PageEnvelope<Obj>>({
      method: "GET",
      path: `${wsPath(core)}/webhooks`,
      query: { page, size: opts.size, reverse: opts.reverse },
    });
    return new Page(envelope, webhookFromWire, fetchPage);
  };
  return fetchPage(opts.page ?? 1);
}

/**
 * The client. One instance talks to one Recall server and acts in one workspace. With no `baseURL`
 * it uses the hosted API (`https://api.recallmem.dev`); `apiKey` comes from https://app.recallmem.dev/keys.
 *
 * ```ts
 * const recall = new Recall({ apiKey: process.env.RECALL_API_KEY });
 * // your own server: new Recall({ baseURL: "http://localhost:8000" })
 * const alice = recall.peer("alice");            // no request: handles are lazy
 * const session = recall.session("chat-1");
 * await session.addMessages([alice.message("I moved to New York last month.")]);
 * await recall.waitForIdle();                     // let background reasoning finish
 * console.log(await alice.chat("Where do I live?"));
 * ```
 */
export class Recall {
  readonly workspaceId: string;
  readonly baseURL: string;
  /** The transport, for calling routes the SDK has no method for. */
  readonly http: HttpClient;
  readonly #core: Core;
  #metadata: Metadata | undefined;
  #configuration: WorkspaceConfig | undefined;
  #conclusions: WorkspaceConclusions | undefined;
  #webhooks: Webhooks | undefined;

  constructor(options: RecallConfig = {}) {
    const config = resolveConfig(options);
    this.http = new HttpClient(config);
    this.workspaceId = config.workspaceId;
    this.baseURL = config.baseURL;
    this.#core = {
      http: this.http,
      workspaceId: this.workspaceId,
      autoCreate: config.autoCreate,
    };
  }

  // ---- handles (no network) ----------------------------------------------------------

  /**
   * A handle for a peer. Makes no request; `metadata`/`configuration` go out with its first call
   * (with `autoCreate`, that first call also gets-or-creates the peer).
   */
  peer(id: string, init: PeerInit = {}): Peer {
    return new Peer(this.#core, id, init);
  }

  /** A handle for a session. Makes no request; options (and, with `autoCreate`, a get-or-create) go out with its first call. */
  session(id: string, init: SessionInit = {}): Session {
    return new Session(this.#core, id, init);
  }

  /** A handle for a scope. Makes no request; it is created by the first `addSessions` (with `autoCreate`, by its first call). */
  scope(id: string, init: { metadata?: Metadata } = {}): Scope {
    return new Scope(this.#core, id, init);
  }

  /** Conclusions across the whole workspace. */
  get conclusions(): WorkspaceConclusions {
    this.#conclusions ??= new WorkspaceConclusions(this.#core);
    return this.#conclusions;
  }

  get webhooks(): Webhooks {
    this.#webhooks ??= new Webhooks(this.#core);
    return this.#webhooks;
  }

  // ---- lists ----------------------------------------------------------------------

  peers(opts: ListOptions & CallOptions = {}): Promise<Page<Peer, Obj>> {
    return listPage(
      this.#core,
      `${wsPath(this.#core)}/peers/list`,
      opts,
      (w: Obj) => new Peer(this.#core, w.id as string, {}, w),
    );
  }

  sessions(opts: ListOptions & CallOptions = {}): Promise<Page<Session, Obj>> {
    return listPage(
      this.#core,
      `${wsPath(this.#core)}/sessions/list`,
      opts,
      (w: Obj) => new Session(this.#core, w.id as string, {}, w),
    );
  }

  scopes(opts: ListOptions & CallOptions = {}): Promise<Page<Scope, Obj>> {
    return listPage(
      this.#core,
      `${wsPath(this.#core)}/scopes/list`,
      opts,
      (w: Obj) => new Scope(this.#core, w.id as string, {}, w),
    );
  }

  /** Fetches an existing scope; 404 if there is none. */
  async getScope(id: string): Promise<Scope> {
    assertId("scope id", id);
    const w = await this.http.request<Obj>({
      method: "GET",
      path: `${wsPath(this.#core)}/scopes/${enc(id)}`,
    });
    return new Scope(this.#core, id, {}, w);
  }

  /** Workspace ids (admin tokens only). */
  workspaces(opts: ListOptions & CallOptions = {}): Promise<Page<string, Obj>> {
    return listPage(this.#core, "/workspaces/list", opts, (w: Obj) => w.id as string);
  }

  /** Deletes a workspace (default: this client's). Fails with 409 while it has active sessions. */
  async deleteWorkspace(id: string = this.workspaceId): Promise<void> {
    assertId("workspace id", id);
    await this.http.request({
      method: "DELETE",
      path: `/workspaces/${enc(id)}`,
      idempotent: true,
    });
  }

  // ---- the workspace itself -------------------------------------------------------------

  /** Gets or creates the workspace and caches its metadata and configuration. */
  async refresh(): Promise<this> {
    const w = await this.http.request<Obj>({
      method: "POST",
      path: "/workspaces",
      body: { id: this.workspaceId },
      idempotent: true,
    });
    this.#metadata = (w.metadata as Metadata | null) ?? {};
    this.#configuration = configFromWire<WorkspaceConfig>(w.configuration);
    return this;
  }

  get metadata(): Metadata | undefined {
    return this.#metadata;
  }
  get configuration(): WorkspaceConfig | undefined {
    return this.#configuration;
  }

  async getMetadata(): Promise<Metadata> {
    await this.refresh();
    return this.#metadata ?? {};
  }
  async setMetadata(metadata: Metadata): Promise<void> {
    await this.#put({ metadata });
  }
  async getConfiguration(): Promise<WorkspaceConfig> {
    await this.refresh();
    return this.#configuration ?? {};
  }
  async setConfiguration(configuration: WorkspaceConfig): Promise<void> {
    await this.#put({ configuration: configToWire(configuration) });
  }
  async #put(body: Obj): Promise<void> {
    await this.refresh(); // the PUT route needs the workspace to exist
    const w = await this.http.request<Obj>({
      method: "PUT",
      path: `/workspaces/${enc(this.workspaceId)}`,
      body,
      idempotent: true,
    });
    this.#metadata = (w.metadata as Metadata | null) ?? {};
    this.#configuration = configFromWire<WorkspaceConfig>(w.configuration);
  }

  // ---- asking and searching ------------------------------------------------------------

  /** Searches every message in the workspace (or in one `scope`). */
  async search(query: string, opts: SearchOptions & { scope?: IdLike } = {}): Promise<Message[]> {
    const found = await this.http.request<Obj[]>({
      method: "POST",
      path: `${wsPath(this.#core)}/search`,
      body: {
        query,
        limit: opts.limit ?? 10,
        ...(opts.filters ? { filters: opts.filters } : {}),
        ...(opts.scope === undefined ? {} : { scope: idOf(opts.scope) }),
      },
      idempotent: true,
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return found.map(messageFromWire);
  }

  /** Asks a question of the whole workspace's memory. See `Peer.chat` for the option and return shapes. */
  chat(query: string, opts: ChatOptions & { includeEvidence: true }): Promise<ChatResponse>;
  chat<T>(
    query: string,
    opts: ChatOptions & { responseFormat: TypedResponseFormat<T> | SchemaLike<T> },
  ): Promise<T | null>;
  chat(query: string, opts: ChatOptions & { responseFormat: JsonSchema }): Promise<unknown>;
  chat(query: string, opts?: ChatOptions): Promise<string | null>;
  async chat(query: string, opts: ChatOptions = {}): Promise<unknown> {
    return chatOnce(this.http, `${wsPath(this.#core)}/chat`, query, opts);
  }

  chatStream(
    query: string,
    opts: Omit<ChatOptions, "responseFormat" | "includeEvidence"> = {},
  ): Promise<DialecticStream> {
    return openChatStream(this.http, `${wsPath(this.#core)}/chat`, query, opts);
  }

  // ---- background work --------------------------------------------------------------------

  async queueStatus(
    opts: { observer?: IdLike; sender?: IdLike; session?: IdLike } & CallOptions = {},
  ): Promise<QueueStatus> {
    return queueStatus(this.#core, opts);
  }

  /**
   * Resolves once background processing (extraction, summaries, due dreams) has caught up, so the
   * next `chat` sees everything you just recorded. Rejects with a timeout error after `timeout` ms (default 30000).
   */
  waitForIdle(
    opts: WaitOptions & { observer?: IdLike; sender?: IdLike; session?: IdLike } = {},
  ): Promise<QueueStatus> {
    return waitForIdle(this.#core, opts);
  }

  /** Asks for a consolidation pass over what `observer` knows about `observed` now, instead of waiting for the schedule. */
  async scheduleDream(opts: {
    observer: IdLike;
    observed?: IdLike;
    session?: IdLike;
    dreamType?: "omni" | "card_refresh";
  }): Promise<void> {
    await this.http.request({
      method: "POST",
      path: `${wsPath(this.#core)}/schedule_dream`,
      body: compact({
        observer: idOf(opts.observer),
        observed: opts.observed === undefined ? undefined : idOf(opts.observed),
        session_id: opts.session === undefined ? undefined : idOf(opts.session),
        dream_type: opts.dreamType ?? "omni",
      }),
      idempotent: true,
    });
  }

  /**
   * This workspace's model calls and tokens by task and model. On a server of your own, also the
   * provider cost (`costUsd`); on the hosted service, what the workspace was charged (`billed`).
   */
  async usage(
    opts: { since?: string | Date; until?: string | Date } & CallOptions = {},
  ): Promise<Usage> {
    return usageFromWire(
      await this.http.request<Obj>({
        method: "GET",
        path: `${wsPath(this.#core)}/usage`,
        query: {
          since: opts.since === undefined ? undefined : toIso(opts.since),
          until: opts.until === undefined ? undefined : toIso(opts.until),
        },
        ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );
  }

  /**
   * Mints a scoped API key (admin token required; the server needs auth enabled). Give at least a
   * workspace; add a peer or session to narrow it further.
   */
  async createKey(opts: {
    workspaceId?: string;
    peerId?: string;
    sessionId?: string;
    expiresAt?: string | Date;
  }): Promise<string> {
    const r = await this.http.request<{ key: string }>({
      method: "POST",
      path: "/keys",
      query: {
        workspace_id: opts.workspaceId,
        peer_id: opts.peerId,
        session_id: opts.sessionId,
        expires_at: opts.expiresAt === undefined ? undefined : toIso(opts.expiresAt),
      },
      body: {},
    });
    return r.key;
  }

  toString(): string {
    return `Recall(${this.baseURL}, workspace=${this.workspaceId})`;
  }
}
