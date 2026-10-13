import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliver, isPrivateAddress } from "../src/webhooks/index.js";

/** Delivery cannot be held open by a slow receiver, and refuses every inward-pointing address form. */

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/drip") {
      // A byte every 100 ms: never idle long enough for a socket timeout.
      res.writeHead(200);
      const t = setInterval(() => res.write("."), 100);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (req.url === "/slow-headers") {
      const t = setInterval(() => req.socket.write(""), 100);
      setTimeout(() => {
        clearInterval(t);
        res.writeHead(204).end();
      }, 5_000);
      return;
    }
    res.writeHead(204).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("webhook delivery", () => {
  it("returns the status without reading a body that never ends", async () => {
    const t = Date.now();
    expect(await deliver(`${url}/drip`, "{}", {}, { allowPrivate: true })).toBe(200);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it("gives up at the deadline however the receiver trickles", async () => {
    const t = Date.now();
    await expect(
      deliver(`${url}/slow-headers`, "{}", {}, { allowPrivate: true, deadlineMs: 500 }),
    ).rejects.toThrow(/took too long/);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it("refuses IPv6 forms that embed an inward IPv4 address", () => {
    for (const a of [
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::169.254.169.254",
      "64:ff9b:1::1",
      "2002:a9fe:a9fe::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "::7f00:1",
      "::ffff:0:7f00:1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
  });
});
