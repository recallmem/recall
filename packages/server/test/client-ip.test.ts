import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClientIpConfig, clientIpConfig, loadConfig } from "../src/config.js";
import { clientIp } from "../src/http/common.js";
import { rangeMatcher } from "../src/lib/network.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * Where per-IP limits get the client's address: only from a header the proxy
 * in front sets and overwrites (Vercel's x-vercel-forwarded-for, Fly's
 * Fly-Client-IP, the right X-Forwarded-For hop, Cloudflare's CF-Connecting-IP
 * only from Cloudflare's own addresses), never from one a client can choose.
 */

const env = (extra: Record<string, string> = {}) =>
  loadConfig({ RECALL_DATA_DIR: "memory", ...extra }).env;

/** What clientIp returns for a request with these headers (and this socket peer). */
async function ipFor(cfg: ClientIpConfig, headers: Record<string, string>, socket?: string) {
  const app = new Hono();
  app.get("/", (c) => c.text(clientIp(c, cfg) ?? "unknown"));
  const res = await app.request(
    "/",
    { headers },
    socket ? { incoming: { socket: { remoteAddress: socket } } } : undefined,
  );
  return res.text();
}

const SPOOFS = {
  "fly-client-ip": "6.6.6.1",
  "x-forwarded-for": "6.6.6.2",
  "cf-connecting-ip": "6.6.6.3",
  "x-real-ip": "6.6.6.4",
};

describe("client IP: configuration", () => {
  it("detects the platform, and an explicit setting wins", () => {
    expect(clientIpConfig(env()).source).toEqual({ kind: "socket" });
    expect(clientIpConfig(env({ VERCEL: "1" })).source).toEqual({
      kind: "header",
      header: "x-vercel-forwarded-for",
    });
    expect(clientIpConfig(env({ FLY_APP_NAME: "recall" })).source).toEqual({
      kind: "header",
      header: "fly-client-ip",
    });
    expect(clientIpConfig(env({ VERCEL: "1", RECALL_TRUSTED_PROXY: "none" })).source).toEqual({
      kind: "socket",
    });
    expect(clientIpConfig(env({ RECALL_TRUSTED_PROXY: "2" })).source).toEqual({
      kind: "forwarded",
      hops: 2,
    });
    expect(clientIpConfig(env({ RECALL_CLIENT_IP_HEADER: "X-Real-IP" })).source).toEqual({
      kind: "header",
      header: "x-real-ip",
    });
    expect(() => loadConfig({ RECALL_TRUSTED_PROXY: "cloudflare-please" })).toThrow(
      /RECALL_TRUSTED_PROXY/,
    );
    expect(() => loadConfig({ RECALL_CLIENT_IP_HEADER: "x real ip" })).toThrow();
  });

  it("reads CF-Connecting-IP only when Cloudflare's proxy is declared", () => {
    expect(clientIpConfig(env()).cloudflare).toBeNull();
    expect(clientIpConfig(env({ RECALL_CLOUDFLARE_IPS: "off" })).cloudflare).toBeNull();
    expect(clientIpConfig(env({ RECALL_CLOUDFLARE_IPS: "on" })).cloudflare).toContain(
      "173.245.48.0/20",
    );
    expect(
      clientIpConfig(env({ RECALL_CLOUDFLARE_IPS: "10.9.0.0/16, 2001:db8::/32" })).cloudflare,
    ).toEqual(["10.9.0.0/16", "2001:db8::/32"]);
    expect(() => loadConfig({ RECALL_CLOUDFLARE_IPS: "10.9.0.0/99" })).toThrow();
  });

  it("matches IPv4, IPv6 and IPv4-mapped addresses against ranges", () => {
    const m = rangeMatcher(["173.245.48.0/20", "2606:4700::/32"]);
    expect(m("173.245.63.255")).toBe(true);
    expect(m("173.245.64.0")).toBe(false);
    expect(m("::ffff:173.245.48.1")).toBe(true);
    expect(m("2606:4700:10::6816:1")).toBe(true);
    expect(m("2001:db8::1")).toBe(false);
    expect(m("not an ip")).toBe(false);
  });
});

describe("client IP: spoofing", () => {
  it("on Vercel, only Vercel's own header counts", async () => {
    const cfg = clientIpConfig(env({ VERCEL: "1" }));
    expect(await ipFor(cfg, { ...SPOOFS, "x-vercel-forwarded-for": "198.51.100.9" })).toBe(
      "198.51.100.9",
    );
    // Without it (not through Vercel's edge) nothing else is believed.
    expect(await ipFor(cfg, SPOOFS)).toBe("unknown");
  });

  it("on Fly.io, only Fly-Client-IP counts", async () => {
    const cfg = clientIpConfig(env({ FLY_APP_NAME: "recall" }));
    expect(await ipFor(cfg, { ...SPOOFS, "fly-client-ip": "198.51.100.10" })).toBe("198.51.100.10");
    expect(await ipFor(cfg, { "x-forwarded-for": "6.6.6.2" })).toBe("unknown");
  });

  it("with no proxy, the socket peer is the client whatever the headers say", async () => {
    const cfg = clientIpConfig(env());
    expect(await ipFor(cfg, SPOOFS, "192.0.2.44")).toBe("192.0.2.44");
    expect(await ipFor(cfg, SPOOFS, "::ffff:192.0.2.45")).toBe("192.0.2.45");
    expect(await ipFor(cfg, SPOOFS)).toBe("unknown");
  });

  it("behind N proxies, the address the first of them saw (Nth from the right)", async () => {
    const one = clientIpConfig(env({ RECALL_TRUSTED_PROXY: "1" }));
    const two = clientIpConfig(env({ RECALL_TRUSTED_PROXY: "2" }));
    // The client prepended a fake entry; the proxies appended what they saw.
    const xff = { "x-forwarded-for": "6.6.6.6, 198.51.100.20, 10.0.0.2" };
    expect(await ipFor(one, xff)).toBe("10.0.0.2");
    expect(await ipFor(two, xff)).toBe("198.51.100.20");
    // No header: the request did not come through the proxy, the peer is the client.
    expect(await ipFor(one, {}, "192.0.2.50")).toBe("192.0.2.50");
    expect(await ipFor(one, { "x-forwarded-for": "not-an-ip" })).toBe("unknown");
  });

  it("CF-Connecting-IP is believed only from Cloudflare's edge, and only when declared", async () => {
    const declared = clientIpConfig(env({ VERCEL: "1", RECALL_CLOUDFLARE_IPS: "on" }));
    const fromCloudflare = { "x-vercel-forwarded-for": "172.64.1.2" };
    expect(await ipFor(declared, { ...fromCloudflare, "cf-connecting-ip": "198.51.100.30" })).toBe(
      "198.51.100.30",
    );
    // Straight to Vercel (not through Cloudflare): the header is the client's own.
    const direct = { "x-vercel-forwarded-for": "198.51.100.31", "cf-connecting-ip": "6.6.6.3" };
    expect(await ipFor(declared, direct)).toBe("198.51.100.31");
    // DNS-only (the default): never read, even from a Cloudflare address.
    const dnsOnly = clientIpConfig(env({ VERCEL: "1" }));
    expect(await ipFor(dnsOnly, { ...fromCloudflare, "cf-connecting-ip": "6.6.6.3" })).toBe(
      "172.64.1.2",
    );
  });
});

describe("client IP: per-IP limits cannot be dodged with spoofed headers", () => {
  let s: HostedServer;
  beforeAll(async () => {
    s = await createHostedServer({
      billing: false,
      env: {
        RECALL_TRUSTED_PROXY: "vercel",
        RECALL_SIGNUP_ENABLED: "true",
        RECALL_OAUTH_REGISTRATIONS_PER_HOUR: "3",
      },
    });
  });
  afterAll(async () => {
    await s.close();
  });

  it("OAuth registration: rotating Fly-Client-IP, X-Forwarded-For and CF-Connecting-IP does not help", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await s.app.request("/oauth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vercel-forwarded-for": "198.51.100.77",
          "fly-client-ip": `6.6.6.${i}`,
          "x-forwarded-for": `7.7.7.${i}`,
          "cf-connecting-ip": `8.8.8.${i}`,
        },
        body: JSON.stringify({ redirect_uris: ["https://client.example/cb"] }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });

  it("sign-in links: the per-IP limit holds against rotated spoofed headers", async () => {
    let limited = 0;
    for (let i = 0; i < 22; i++) {
      const b = new Browser(s.app, `9.9.9.${i}`); // a spoofed X-Forwarded-For per request
      await b.get("/app/login");
      const res = await s.app.request("/app/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://recall.test",
          cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          "x-vercel-forwarded-for": "198.51.100.78",
          "fly-client-ip": `6.6.7.${i}`,
          "x-forwarded-for": `9.9.9.${i}`,
        },
        body: new URLSearchParams({ _csrf: b.lastCsrf, email: `u${i}@spoof.example` }).toString(),
      });
      if (res.status === 429) limited++;
    }
    // 20 links per address per hour: the last two are refused.
    expect(limited).toBe(2);
  });
});
