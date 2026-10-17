import { type Core, listPage, orCreateTargets, queryText, wsPath } from "./core.js";
import type { CallOptions } from "./http.js";
import type { Page } from "./page.js";
import type {
  Conclusion,
  ConclusionHistory,
  ConclusionInput,
  Filters,
  ListOptions,
  RepresentationLike,
} from "./types.js";
import { chunk, compact, enc, type IdLike, idOf, type Obj } from "./util.js";
import { conclusionFromWire } from "./wire.js";

const MAX_BATCH = 100;

export interface ConclusionListOptions extends ListOptions, CallOptions {
  /** Only conclusions filed under this session. */
  session?: IdLike;
}
export interface ConclusionQueryOptions extends CallOptions {
  /** Number of results, 1-100 (default 10). */
  topK?: number;
  /** Maximum cosine distance, 0-1. */
  distance?: number;
  filters?: Filters;
}

/** Rejects filters that would override the view's own observer/observed. */
function userFilters(filters: Filters | undefined): Filters {
  if (filters) {
    for (const key of ["observer_id", "observed_id", "observer", "observed"]) {
      if (key in filters) {
        throw new TypeError(
          `filters.${key} is set by the view; use peer.conclusionsOf(target) instead`,
        );
      }
    }
  }
  return filters ?? {};
}

/**
 * The conclusions one peer (the observer) holds about another (the observed):
 * `peer.conclusions` for themself, `peer.conclusionsOf(other)` for someone else.
 */
export class ConclusionsView {
  constructor(
    private readonly core: Core,
    readonly observer: string,
    readonly observed: string,
  ) {}

  private pair(): Filters {
    return { observer_id: this.observer, observed_id: this.observed };
  }

  list(opts: ConclusionListOptions = {}): Promise<Page<Conclusion, Obj>> {
    return listPage(this.core, `${wsPath(this.core)}/conclusions/list`, opts, conclusionFromWire, {
      ...userFilters(opts.filters),
      ...this.pair(),
      ...(opts.session === undefined ? {} : { session_id: idOf(opts.session) }),
    });
  }

  /** Semantic search: the conclusions closest in meaning to `query`. */
  async query(
    query: string,
    topKOrOptions: number | ConclusionQueryOptions = {},
    distance?: number,
    filters?: Filters,
  ): Promise<Conclusion[]> {
    const o: ConclusionQueryOptions =
      typeof topKOrOptions === "number"
        ? { topK: topKOrOptions, distance, filters }
        : topKOrOptions;
    const found = await this.core.http.request<Obj[]>({
      method: "POST",
      path: `${wsPath(this.core)}/conclusions/query`,
      body: {
        query,
        top_k: o.topK ?? 10,
        ...(o.distance === undefined ? {} : { distance: o.distance }),
        filters: { ...userFilters(o.filters), ...this.pair() },
      },
      idempotent: true,
      ...(o.timeout === undefined ? {} : { timeout: o.timeout }),
      ...(o.signal ? { signal: o.signal } : {}),
    });
    return found.map(conclusionFromWire);
  }

  async get(id: string): Promise<Conclusion> {
    return getConclusion(this.core, id);
  }

  async getMany(ids: readonly string[]): Promise<Conclusion[]> {
    return getManyConclusions(this.core, ids, this.pair());
  }

  /** Conclusions that were derived from this one (their `sourceIds` include it). */
  derived(id: string, opts: ListOptions & CallOptions = {}): Promise<Page<Conclusion, Obj>> {
    return listPage(this.core, `${wsPath(this.core)}/conclusions/list`, opts, conclusionFromWire, {
      ...userFilters(opts.filters),
      ...this.pair(),
      source_ids: { contains: id },
    });
  }

  async delete(id: string): Promise<void> {
    await this.core.http.request({
      method: "DELETE",
      path: `${wsPath(this.core)}/conclusions/${enc(id)}`,
      idempotent: true,
    });
  }

  /**
   * Records facts you know directly. They are searchable at once, without waiting for
   * background reasoning. More than 100 are sent in several requests, in order.
   */
  async create(
    input: string | ConclusionInput | readonly (string | ConclusionInput)[],
  ): Promise<Conclusion[]> {
    const items = (Array.isArray(input) ? [...input] : [input]) as (string | ConclusionInput)[];
    if (items.length === 0) throw new TypeError("at least one conclusion is required");
    const created: Conclusion[] = [];
    for (const batch of chunk(items, MAX_BATCH)) {
      const wire = batch.map((item) => {
        const c = typeof item === "string" ? { content: item } : item;
        return compact({
          content: c.content,
          observer_id: this.observer,
          observed_id: this.observed,
          session_id: c.sessionId === undefined ? undefined : idOf(c.sessionId),
          event_start: c.eventStart,
          event_end: c.eventEnd,
          tags: c.tags,
          pinned: c.pinned,
          expires_at: c.expiresAt,
        });
      });
      // POST /conclusions is not idempotent, so the client only retries it after a 429.
      const out = await orCreateTargets(this.core, [this.observer, this.observed], () =>
        this.core.http.request<Obj[]>({
          method: "POST",
          path: `${wsPath(this.core)}/conclusions`,
          body: { conclusions: wire },
        }),
      );
      created.push(...out.map(conclusionFromWire));
    }
    return created;
  }

  /** The text description of what the observer believes about the observed. */
  async representation(opts: RepresentationLike & CallOptions = {}): Promise<string> {
    const r = await this.core.http.request<{ representation?: string }>({
      method: "POST",
      path: `${wsPath(this.core)}/peers/${enc(this.observer)}/representation`,
      body: compact({
        target: this.observed,
        search_query: opts.searchQuery === undefined ? undefined : queryText(opts.searchQuery),
        search_top_k: opts.searchTopK,
        search_max_distance: opts.searchMaxDistance,
        include_most_frequent: opts.includeMostFrequent,
        max_conclusions: opts.maxConclusions,
      }),
      idempotent: true,
    });
    return r.representation ?? "";
  }
}

/** Conclusions across the whole workspace (`recall.conclusions`). */
export class WorkspaceConclusions {
  constructor(private readonly core: Core) {}

  list(opts: ListOptions & CallOptions = {}): Promise<Page<Conclusion, Obj>> {
    return listPage(this.core, `${wsPath(this.core)}/conclusions/list`, opts, conclusionFromWire);
  }
  get(id: string): Promise<Conclusion> {
    return getConclusion(this.core, id);
  }
  getMany(ids: readonly string[]): Promise<Conclusion[]> {
    return getManyConclusions(this.core, ids, {});
  }
  /** What happened to a fact: who changed it, why and from what, and what it replaced. */
  async history(id: string): Promise<ConclusionHistory> {
    const r = await this.core.http.request<Obj>({
      method: "GET",
      path: `${wsPath(this.core)}/conclusions/${enc(id)}/history`,
    });
    const events = Array.isArray(r.events) ? (r.events as Obj[]) : [];
    return {
      conclusion: conclusionFromWire(r.conclusion as Obj),
      events: events.map((e) => ({
        action: String(e.action),
        actor: String(e.actor),
        reason: (e.reason as string | null) ?? null,
        sources: Array.isArray(e.sources) ? (e.sources as string[]) : [],
        before: e.before ?? null,
        after: e.after ?? null,
        createdAt: String(e.created_at),
      })),
      replaced: (Array.isArray(r.replaced) ? (r.replaced as Obj[]) : []).map(conclusionFromWire),
      replacedBy: r.replaced_by ? conclusionFromWire(r.replaced_by as Obj) : null,
    };
  }
  /** Pins a fact (or unpins it): Recall never replaces a pinned fact; what disagrees is flagged. */
  async pin(id: string, pinned = true): Promise<Conclusion> {
    return conclusionFromWire(
      await this.core.http.request<Obj>({
        method: "PATCH",
        path: `${wsPath(this.core)}/conclusions/${enc(id)}`,
        body: { pinned },
        idempotent: true,
      }),
    );
  }
}

async function getConclusion(core: Core, id: string): Promise<Conclusion> {
  return conclusionFromWire(
    await core.http.request<Obj>({ method: "GET", path: `${wsPath(core)}/conclusions/${enc(id)}` }),
  );
}

/** Batch get, emulated with list filters in chunks of 100; results follow the order of `ids`, missing ids are skipped. */
async function getManyConclusions(
  core: Core,
  ids: readonly string[],
  extra: Filters,
): Promise<Conclusion[]> {
  const byId = new Map<string, Conclusion>();
  for (const batch of chunk([...new Set(ids)], MAX_BATCH)) {
    const page = await listPage(
      core,
      `${wsPath(core)}/conclusions/list`,
      { size: MAX_BATCH },
      conclusionFromWire,
      { ...extra, id: { in: batch } },
    );
    for (const c of await page.toArray()) byId.set(c.id, c);
  }
  return ids.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
}
