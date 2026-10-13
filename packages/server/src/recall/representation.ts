import type { AppContext } from "../context.js";
import { truncateTokens } from "../lib/tokens.js";
import type { Allowlist, PeerRef, WsRef } from "./lookup.js";
import {
  allowlistCond,
  type ConclusionHit,
  type ConclusionRow,
  conclusionsByIds,
  listConclusions,
  pairCond,
  rankScore,
  searchConclusions,
} from "./search.js";
import { and, stamp } from "./util.js";

export const EMBED_TOKEN_LIMIT = 8192;

export interface RepOptions {
  ws: WsRef;
  observer: PeerRef;
  observed: PeerRef;
  /** Session allowlist (internal ids); an empty list recalls nothing. */
  allowlist: Allowlist | null;
  searchQuery?: string | null;
  searchTopK?: number | null;
  searchMaxDistance?: number | null;
  includeMostFrequent: boolean;
  maxConclusions: number;
}

/** Embeds a query, returning null instead of throwing: recall degrades to lexical + prior. */
export async function embedQuery(
  ctx: AppContext,
  wsId: string,
  text: string,
): Promise<number[] | null> {
  try {
    const [v] = await ctx.embeddings.embed([truncateTokens(text, EMBED_TOKEN_LIMIT)], wsId);
    return v ?? null;
  } catch (err) {
    ctx.log.debug({ err }, "query embedding failed; continuing without the vector leg");
    return null;
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Chooses the conclusions of one (observer, observed) collection with a single
 * scored ranking and renders them. Parameters follow spec 01 §3.2.6:
 *  - `search_query`: up to `search_top_k` (default total/3) of the best hybrid matches,
 *    optionally within `search_max_distance`;
 *  - `include_most_frequent`: a quota of the most re-derived facts;
 *  - the rest is filled by importance + reinforcement + recency (not just recency).
 * Only current facts are used; superseded ones are history, not representation.
 */
export async function selectConclusions(ctx: AppContext, o: RepOptions): Promise<ConclusionRow[]> {
  const total = Math.max(1, o.maxConclusions);
  if (o.allowlist && !o.allowlist.ids.length) return [];
  const now = new Date();
  const cond = and(
    pairCond(o.ws.id, o.observer.id, o.observed.id),
    o.allowlist && allowlistCond(o.allowlist.ids),
  );
  const chosen = new Map<string, ConclusionRow>();
  const take = (r: ConclusionRow) => {
    if (chosen.size < total && !chosen.has(r.id)) chosen.set(r.id, r);
  };

  const query = o.searchQuery?.trim() || null;
  const semanticN = query ? clamp(o.searchTopK ?? Math.floor(total / 3), 1, total) : 0;
  // Matches beyond the semantic quota stay in the running for the remaining slots.
  let leftover: ConclusionHit[] = [];
  if (query) {
    const vec = await embedQuery(ctx, o.ws.id, query);
    const hits = await searchConclusions(ctx, {
      workspaceId: o.ws.id,
      query,
      vectors: vec ? [vec] : [],
      pool: Math.max(semanticN * 3, 30),
      cond,
      state: "current",
    });
    const max = o.searchMaxDistance;
    const ranked = hits
      .filter((h) => max == null || (h.dist != null && h.dist <= max))
      .sort((a, b) => rankScore(b, now) - rankScore(a, now));
    for (const h of ranked.slice(0, semanticN)) take(h.row);
    leftover = ranked.slice(semanticN);
  }

  const frequentN = o.includeMostFrequent
    ? Math.min(query ? Math.floor(total / 3) : Math.floor(total / 2), total - semanticN)
    : 0;
  if (frequentN > 0) {
    const frequent = await listConclusions(ctx, {
      cond,
      state: "current",
      order: "frequent",
      limit: frequentN + chosen.size,
    });
    let added = 0;
    for (const r of frequent) {
      if (added >= frequentN) break;
      if (!chosen.has(r.id)) {
        take(r);
        added++;
      }
    }
  }

  if (chosen.size < total) {
    // The rest by the one ranking: relevance where there is a match, importance, reinforcement and recency otherwise.
    const candidates = new Map<string, { row: ConclusionRow; rel: number }>();
    for (const row of await listConclusions(ctx, {
      cond,
      state: "current",
      order: "recent",
      limit: 400,
    })) {
      candidates.set(row.id, { row, rel: 0 });
    }
    for (const h of leftover) candidates.set(h.row.id, { row: h.row, rel: h.rel });
    const ordered = [...candidates.values()]
      .filter((c) => !chosen.has(c.row.id))
      .sort((a, b) => rankScore(b, now) - rankScore(a, now));
    for (const c of ordered) take(c.row);
  }
  return [...chosen.values()];
}

const SECTION_TITLES = [
  ["explicit", "## Explicit Observations"],
  ["deductive", "## Deductive Observations"],
  ["inductive", "## Inductive Observations"],
  ["contradiction", "## Contradictions"],
] as const;

const when = (r: ConclusionRow) => r.validFrom ?? r.createdAt;

/** Renders conclusions as the Markdown the reference clients expect (sections per level, `[ts]` prefixes). */
export async function renderRepresentation(
  ctx: AppContext,
  rows: ConclusionRow[],
): Promise<string> {
  if (!rows.length) return "";
  const sourceIds = [
    ...new Set(rows.filter((r) => r.level !== "explicit").flatMap((r) => r.sourceIds)),
  ];
  const premises = new Map((await conclusionsByIds(ctx, sourceIds)).map((r) => [r.id, r.content]));
  const sections: string[] = [];
  for (const [level, title] of SECTION_TITLES) {
    const items = rows
      .filter((r) => r.level === level)
      .sort((a, b) => when(a).getTime() - when(b).getTime());
    if (!items.length) continue;
    const lines: string[] = [title];
    for (const r of items) {
      const sources = r.sourceIds.map((id) => premises.get(id)).filter((s): s is string => !!s);
      if (level === "explicit") {
        lines.push(`[${stamp(when(r))}] ${r.content}`);
      } else if (level === "deductive") {
        lines.push(`[${stamp(when(r))}] ${r.content}`);
        if (sources.length) lines.push("   Premises:", ...sources.map((s) => `   - ${s}`));
      } else if (level === "inductive") {
        lines.push(` **Pattern** [${r.confidence.toFixed(2)}]: ${r.content}`);
        if (r.category) lines.push(`   **Type**: ${r.category}`);
        if (sources.length) {
          lines.push("   **Sources**:", ...sources.slice(0, 5).map((s) => `   - ${s}`));
          if (sources.length > 5) lines.push(`   - ... and ${sources.length - 5} more`);
        }
      } else {
        lines.push(` **CONTRADICTION**: ${r.content}`);
        if (sources.length)
          lines.push("   **Conflicting statements**:", ...sources.map((s) => `   - ${s}`));
      }
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

export async function buildRepresentation(
  ctx: AppContext,
  o: RepOptions,
): Promise<{ text: string; rows: ConclusionRow[] }> {
  const rows = await selectConclusions(ctx, o);
  return { text: await renderRepresentation(ctx, rows), rows };
}
