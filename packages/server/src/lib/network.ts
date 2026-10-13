import { BlockList, isIP } from "node:net";

/**
 * The network a client address belongs to, for limits that must not be dodged
 * by rotating addresses: the address itself for IPv4 (an IPv4-mapped IPv6
 * address counts as its IPv4 address), and the /64 prefix for IPv6, because one
 * subscriber or host normally controls a whole /64. Limits on free things pass
 * `v6Groups` 3 (a /48: what a provider typically hands one customer site). Null
 * when `ip` is not an IP address at all (a garbled forwarding header), so callers
 * treat it as unknown.
 */
export function networkKey(ip: string, v6Groups: 3 | 4 = 4): string | null {
  let a = ip.trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const version = isIP(a);
  if (version === 4) return a;
  if (version !== 6) return null;

  // Expand "::" and a trailing dotted quad to eight 16-bit groups; keep the first four.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (quad) {
    const [, p, q, r, s] = quad.map(Number);
    a = `${a.slice(0, quad.index)}${((p! << 8) | q!).toString(16)}:${((r! << 8) | s!).toString(16)}`;
  }
  const [head = "", tail = ""] = a.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const fill = a.includes("::") ? 8 - headGroups.length - tailGroups.length : 0;
  const groups = [...headGroups, ...Array(Math.max(0, fill)).fill("0"), ...tailGroups];
  return `${groups
    .slice(0, v6Groups)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/${v6Groups * 16}`;
}

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and
 * https://www.cloudflare.com/ips-v6, fetched 2026-10-09). A request whose
 * proxy-reported address is in one of these came through Cloudflare, which
 * then sets (and overwrites) `CF-Connecting-IP` to the real client. Used only
 * when RECALL_CLOUDFLARE_IPS=on (Cloudflare's proxy in front); list the ranges
 * in that variable instead when Cloudflare publishes new ones.
 */
export const CLOUDFLARE_IPS: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** An IP address as given (brackets, zone and IPv4-mapped prefix removed), or null when it is not one. */
export function cleanIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let a = raw.trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  return isIP(a) ? a : null;
}

/** Why a CIDR range is not valid, or null when it is. */
export function cidrProblem(range: string): string | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(range.trim());
  if (!m) return `'${range}' is not a CIDR range (address/prefix)`;
  const version = isIP(m[1]!);
  const prefix = Number(m[2]);
  if (!version) return `'${range}' does not start with an IP address`;
  if (prefix > (version === 4 ? 32 : 128)) return `'${range}' has a prefix that is too long`;
  return null;
}

/** A matcher for a list of CIDR ranges (IPv4 and IPv6; IPv4-mapped IPv6 addresses match as IPv4). */
export function rangeMatcher(ranges: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const r of ranges) {
    const [address, prefix] = r.trim().split("/") as [string, string];
    list.addSubnet(address, Number(prefix), isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  return (ip) => {
    const a = cleanIp(ip);
    if (!a) return false;
    return list.check(a, isIP(a) === 4 ? "ipv4" : "ipv6");
  };
}
