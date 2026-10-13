/** USD per EUR from the European Central Bank's daily reference rates. */

const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
/** The ECB publishes once a working day, around 16:00 CET. */
const FRESH_MS = 6 * 3_600_000;

/**
 * Returns a reader of the current USD-per-EUR rate, cached for six hours. When the ECB cannot be
 * reached it keeps the last rate it had, and gives null only when it never had one.
 */
export function ecbUsdPerEur(fetchFn: typeof fetch = fetch): () => Promise<number | null> {
  let known: { rate: number; at: number } | null = null;
  return async () => {
    if (known && Date.now() - known.at < FRESH_MS) return known.rate;
    try {
      const res = await fetchFn(ECB_DAILY, { signal: AbortSignal.timeout(3000) });
      const rate = parseUsdRate(await res.text());
      if (rate !== null) known = { rate, at: Date.now() };
    } catch {
      // The last known rate (if any) stands.
    }
    return known?.rate ?? null;
  };
}

/** The USD rate from the ECB's daily XML; null if missing or outside any plausible range. */
export function parseUsdRate(xml: string): number | null {
  const m = /currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml);
  const rate = m ? Number(m[1]) : Number.NaN;
  return rate > 0.5 && rate < 2.5 ? rate : null;
}
