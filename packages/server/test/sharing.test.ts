import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer } from "./helpers.js";

/**
 * How the site is found and shared: public/sitemap.xml (scripts/site/sitemap.py) lists every page
 * that names a canonical URL, and each of those pages carries a share card, so a link to it posted
 * on X, LinkedIn or Slack shows a preview.
 */

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));
const SITE = "https://recallmem.dev";

function htmlFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? htmlFiles(dir, `${prefix}${e.name}/`)
      : e.name.endsWith(".html")
        ? [`${prefix}${e.name}`]
        : [],
  );
}

/** Pages that name a canonical URL, by that URL. */
const canonical = new Map<string, string>();
for (const file of htmlFiles(PUBLIC)) {
  const html = readFileSync(join(PUBLIC, file), "utf8");
  const m = /<link rel="canonical" href="([^"]+)"\s*\/?>/.exec(html);
  if (m) canonical.set(m[1]!, html);
}

type Server = Awaited<ReturnType<typeof createTestServer>>;
let s: Server;
beforeAll(async () => {
  s = await createTestServer();
});
afterAll(() => s.close());

describe("sitemap and share cards", () => {
  it("lists every canonical page in the sitemap, which robots.txt names", async () => {
    const res = await s.app.request("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const listed = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(new Set(listed), "run python3 scripts/site/sitemap.py").toEqual(
      new Set(canonical.keys()),
    );
    expect(listed[0]).toBe(`${SITE}/`);
    for (const page of ["/docs", "/calculator", "/evals", "/compare/mem0", "/guides/support"])
      expect(listed, page).toContain(`${SITE}${page}`);
    for (const url of listed)
      expect((await s.app.request(url.slice(SITE.length) || "/")).status, url).toBe(200);
    const robots = await (await s.app.request("/robots.txt")).text();
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    const vercel = readFileSync(join(PUBLIC, "../vercel.json"), "utf8");
    expect(vercel).toContain("sitemap\\\\.xml");
  });

  it("serves the IndexNow key that scripts/site/indexnow.py submits the sitemap with", async () => {
    const keys = readdirSync(PUBLIC).filter(
      (f) =>
        /^[0-9a-f]{32}\.txt$/.test(f) &&
        readFileSync(join(PUBLIC, f), "utf8").trim() === f.slice(0, 32),
    );
    expect(keys).toHaveLength(1);
    const res = await s.app.request(`/${keys[0]}`);
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe(keys[0]!.slice(0, 32));
  });

  it("publishes Glama's ownership claim and the icon the MCP server names", async () => {
    // public/.well-known is served by the CDN on every host (recallmem.dev and api.recallmem.dev),
    // as the MCP registry's key is; the API server itself does not serve it.
    const claim = JSON.parse(
      readFileSync(join(PUBLIC, ".well-known/glama.json"), "utf8"),
    ) as Record<string, string>;
    expect(claim.$schema).toBe("https://glama.ai/mcp/schemas/connector.json");
    expect(claim.claim).toMatch(/^glama_claim_[A-Za-z0-9]+$/);
    expect((await s.app.request("/icon.png")).headers.get("content-type")).toBe("image/png");
  });

  it("gives every canonical page a share card with an absolute image that exists", () => {
    for (const [url, html] of canonical) {
      const meta = (attr: string, key: string) =>
        new RegExp(`<meta ${attr}="${key}" content="([^"]*)" />`).exec(html)?.[1];
      expect(meta("property", "og:title"), url).toBeTruthy();
      expect(meta("property", "og:description"), url).toBeTruthy();
      expect(meta("name", "twitter:card"), url).toBe("summary_large_image");
      const image = meta("property", "og:image");
      expect(image, url).toMatch(new RegExp(`^${SITE}/[\\w-]+\\.png$`));
      expect(existsSync(join(PUBLIC, image!.slice(SITE.length))), url).toBe(true);
      const ogUrl = meta("property", "og:url");
      if (ogUrl) expect(ogUrl, url).toBe(url);
    }
    // The calculator has a card of its own; its image is served with the site's headers.
    expect(canonical.get(`${SITE}/calculator`)).toContain(
      `<meta property="og:image" content="${SITE}/og-bill.png" />`,
    );
    expect(readFileSync(join(PUBLIC, "../vercel.json"), "utf8")).toContain("og-bill\\\\.png");
  });
});
