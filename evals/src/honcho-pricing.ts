import type { ReasoningLevel } from "./types.js";

/**
 * Honcho's managed-service price list. This is the ONLY place these numbers live;
 * everything that estimates Honcho cost reads them from here.
 *
 * Source: the price list on the honcho.dev home page
 * (fetched 2026-10-08):
 *   - memory ingestion: $2.00 per 1M tokens ingested (per token, not per message)
 *   - `.chat()` reasoning is a flat fee per query, by reasoning level
 *   - `context()` reads are unlimited and not charged
 *   - dreaming is included ("free for now")
 * Re-check the page before quoting results: prices move.
 */
export const HONCHO_PRICE_LIST = {
  source: "honcho.dev pricing (home page, fetched 2026-10-08)",
  ingestUsdPerMillionTokens: 2.0,
  queryUsd: {
    minimal: 0.001,
    low: 0.01,
    medium: 0.05,
    high: 0.1,
    max: 0.5,
  } satisfies Record<ReasoningLevel, number>,
  contextReadUsd: 0,
  dreamingUsd: 0,
} as const;

export interface HonchoEstimate {
  ingestUsd: number;
  queryUsd: number;
  totalUsd: number;
}

/** What the same workload would cost on Honcho's managed service at list price. */
export function honchoListPrice(
  tokensIngested: number,
  queries: number,
  level: ReasoningLevel,
): HonchoEstimate {
  const ingestUsd = (tokensIngested / 1_000_000) * HONCHO_PRICE_LIST.ingestUsdPerMillionTokens;
  const queryUsd = queries * HONCHO_PRICE_LIST.queryUsd[level];
  return { ingestUsd, queryUsd, totalUsd: ingestUsd + queryUsd };
}
