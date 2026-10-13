import { type Core, listPage, wsPath } from "./core.js";
import type { CallOptions } from "./http.js";
import type { Page } from "./page.js";
import { Session } from "./session.js";
import type { ListOptions, Metadata, ScopeStatus } from "./types.js";
import { assertId, chunk, compact, enc, type IdLike, idOf, type Obj } from "./util.js";
import { scopeStatusFromWire } from "./wire.js";

/**
 * A named bag of sessions that acts as a shared observer: add sessions to it and ask questions
 * across all of them (`chat(..., { scope })`). A lazy handle; it is created on the server by the
 * first `addSessions` (or `refresh()`), and reading a scope that does not exist is a 404.
 */
export class Scope {
  readonly id: string;
  readonly workspaceId: string;
  #pending: { metadata?: Metadata } | null;
  #inflight: Promise<void> | null = null;
  #metadata: Metadata | undefined;
  #createdAt: string | undefined;
  #exists = false;

  constructor(
    private readonly core: Core,
    id: string,
    init: { metadata?: Metadata } = {},
    known?: Obj,
  ) {
    this.id = assertId("scope id", id);
    if (this.id.startsWith("scope.")) throw new TypeError('scope ids must not start with "scope."');
    this.workspaceId = core.workspaceId;
    this.#pending = init.metadata === undefined ? null : { ...init };
    if (known) {
      this.#apply(known);
    }
  }

  get metadata(): Metadata | undefined {
    return this.#metadata;
  }
  get createdAt(): string | undefined {
    return this.#createdAt;
  }

  #apply(w: Obj): void {
    this.#metadata = (w.metadata as Metadata | null) ?? {};
    this.#createdAt = typeof w.created_at === "string" ? w.created_at : undefined;
    this.#exists = true;
  }

  #path(suffix = ""): string {
    return `${wsPath(this.core)}/scopes/${enc(this.id)}${suffix}`;
  }

  /** Gets or creates the scope on the server. */
  async refresh(): Promise<this> {
    const w = await this.core.http.request<Obj>({
      method: "POST",
      path: `${wsPath(this.core)}/scopes`,
      body: compact({ id: this.id, metadata: this.#pending?.metadata }),
      idempotent: true,
    });
    this.#pending = null;
    this.#apply(w);
    return this;
  }

  async #ensure(): Promise<void> {
    if (this.#exists && !this.#pending) return;
    this.#inflight ??= this.refresh()
      .then(() => undefined)
      .finally(() => {
        this.#inflight = null;
      });
    await this.#inflight;
  }

  /**
   * Before a read: sends the metadata given at construction, and with `autoCreate` gets-or-creates
   * a scope the handle has not seen yet. Otherwise a read of a scope that was never created is a
   * 404.
   */
  async #prepare(): Promise<void> {
    if (this.#pending || (this.core.autoCreate && !this.#exists)) await this.#ensure();
  }

  async addSessions(sessions: IdLike | readonly IdLike[]): Promise<void> {
    await this.#ensure();
    const ids = (
      Array.isArray(sessions) ? [...(sessions as readonly IdLike[])] : [sessions as IdLike]
    ).map(idOf);
    for (const batch of chunk(ids, 100)) {
      await this.core.http.request({
        method: "POST",
        path: this.#path("/sessions"),
        body: { session_ids: batch },
        idempotent: true,
      });
    }
  }

  async removeSession(session: IdLike): Promise<void> {
    await this.#prepare();
    await this.core.http.request({
      method: "DELETE",
      path: this.#path(`/sessions/${enc(idOf(session))}`),
      idempotent: true,
    });
  }

  /** @see removeSession */
  async removeSessions(sessions: readonly IdLike[]): Promise<void> {
    for (const s of sessions) await this.removeSession(s);
  }

  async sessions(opts: ListOptions & CallOptions = {}): Promise<Page<Session, Obj>> {
    await this.#prepare();
    return listPage(
      this.core,
      this.#path("/sessions/list"),
      opts,
      (w: Obj) => new Session(this.core, w.id as string, {}, w),
    );
  }

  /** Progress of copying each session's existing conclusions into the scope. */
  async status(): Promise<ScopeStatus> {
    await this.#prepare();
    return scopeStatusFromWire(
      await this.core.http.request<Obj>({ method: "GET", path: this.#path("/status") }),
    );
  }

  toString(): string {
    return `Scope(${this.id})`;
  }
}
