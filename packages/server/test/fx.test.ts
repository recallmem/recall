import { describe, expect, it, vi } from "vitest";
import { ecbUsdPerEur, parseUsdRate } from "../src/billing/fx.js";

const ECB = `<gesmes:Envelope><Cube><Cube time='2026-10-09'>
<Cube currency='USD' rate='1.1627'/><Cube currency='JPY' rate='172.31'/></Cube></Cube></gesmes:Envelope>`;

describe("ECB exchange rate", () => {
  it("reads the USD rate from the daily file and rejects implausible values", () => {
    expect(parseUsdRate(ECB)).toBe(1.1627);
    expect(parseUsdRate(ECB.replace("1.1627", "11.627"))).toBeNull();
    expect(parseUsdRate("<html>maintenance</html>")).toBeNull();
  });

  it("caches the rate, keeps the last one when the ECB is down, and is null without any", async () => {
    const fetchFn = vi.fn(async () => new Response(ECB));
    const rate = ecbUsdPerEur(fetchFn as unknown as typeof fetch);
    expect(await rate()).toBe(1.1627);
    expect(await rate()).toBe(1.1627);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const down = ecbUsdPerEur((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(await down()).toBeNull();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 7 * 3_600_000);
      fetchFn.mockRejectedValueOnce(new Error("offline"));
      expect(await rate()).toBe(1.1627);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
