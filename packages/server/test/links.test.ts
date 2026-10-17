import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanPath, linkUrl, mediumFor, parseLinkForm, slugTag } from "../src/core/links.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * The operator console's Links page: tagged links to the site made in the console, with each
 * link's visitors from Umami (stubbed) and its sign-ups from Recall's own accounts.
 */

const UMAMI = {
  UMAMI_URL: "https://stats.example.com",
  UMAMI_WEBSITE_ID: "0b9a4c1e-6f3d-4a52-9d1e-2c7b8a9f0e11",
  UMAMI_API_KEY: "umami-test-key",
};

/** Umami's stats, 9 visitors for the reddit campaign and 0 for anything else; records requests. */
function stubUmami(status = 200) {
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      if (status !== 200) return new Response("nope", { status });
      const hit = url.searchParams.get("utmCampaign") === "localllama-launch";
      return Response.json({ visitors: hit ? 9 : 0, visits: 0, pageviews: 0, bounces: 0 });
    }),
  );
  return calls;
}

let s: HostedServer;
let ops: Browser;
beforeAll(async () => {
  s = await createHostedServer({ env: { RECALL_OPERATOR_EMAILS: "ops@example.com", ...UMAMI } });
  ops = new Browser(s.app, "203.0.113.20");
  await ops.signIn(s, "ops@example.com");
}, 60_000);
afterAll(async () => {
  await s.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tagged links", () => {
  it("cleans tags and paths and builds the link with the anchor last", () => {
    expect(slugTag("  LocalLLaMA Launch!! ")).toBe("localllama-launch");
    expect(slugTag("r/ClaudeAI -- thread")).toBe("rclaudeai-thread");
    expect(slugTag(42)).toBe("");
    expect(cleanPath("/#pricing")).toBe("/#pricing");
    expect(cleanPath("/guides/langchain")).toBe("/guides/langchain");
    for (const bad of [
      "//evil.example",
      "https://evil.example/",
      "docs",
      "/a b",
      "/x?y=1",
      "/x#a b",
    ])
      expect(cleanPath(bad), bad).toBeNull();
    expect(mediumFor("reddit")).toBe("social");
    expect(mediumFor("hn")).toBe("community");
    expect(mediumFor("someblog")).toBe("referral");
    const l = parseLinkForm({ path: "/#pricing", source: "Reddit", campaign: "LocalLLaMA launch" });
    expect(l).toEqual({
      path: "/#pricing",
      source: "reddit",
      medium: "social",
      campaign: "localllama-launch",
      content: null,
      note: null,
    });
    expect(linkUrl("https://recallmem.dev/", { ...l, content: "comment" })).toBe(
      "https://recallmem.dev/?utm_source=reddit&utm_medium=social&utm_campaign=localllama-launch&utm_content=comment#pricing",
    );
    expect(() => parseLinkForm({ source: "reddit", campaign: "" })).toThrow(/campaign/);
    expect(() => parseLinkForm({ source: "", campaign: "x" })).toThrow(/source/);
    expect(() => parseLinkForm({ custom_path: "//evil", source: "x", campaign: "y" })).toThrow(
      /path of the site/,
    );
  });

  it("is hidden from everyone but operators, like an unknown page", async () => {
    const cust = new Browser(s.app, "203.0.113.31");
    await cust.signIn(s, "someone@example.com");
    const unknown = await cust.get("/app/no-such-page");
    const r = await cust.get("/app/admin/links");
    expect(r.res.status).toBe(404);
    expect(r.html).toBe(unknown.html);
    const made = await cust.post("/app/admin/links", { source: "reddit", campaign: "x" });
    expect(made.res.status).toBe(404);
  });

  it("makes a link, shows it with its visitors and sign-ups, and refuses the same tags twice", async () => {
    stubUmami();
    const page = await ops.get("/app/admin/links");
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("No links yet.");
    expect(page.html).toContain('data-utm-form data-site="https://recall.test"');
    expect(page.html).not.toContain("style=");
    // Without the form's CSRF token, nothing is made.
    const forged = await ops.post(
      "/app/admin/links",
      { source: "reddit", campaign: "x" },
      { csrf: null },
    );
    expect(forged.res.status).toBe(403);

    const made = await ops.post("/app/admin/links", {
      path: "/#pricing",
      source: "Reddit",
      campaign: "LocalLLaMA launch",
      note: "https://www.reddit.com/r/LocalLLaMA/comments/abc/",
    });
    expect(made.res.status).toBe(303);
    const where = made.res.headers.get("location")!;
    expect(where).toMatch(/^\/app\/admin\/links\?made=/);

    // A sign-up that came through the link counts for it.
    const reader = new Browser(s.app, "198.51.100.60");
    await reader.get("/app/login?src=reddit&campaign=localllama-launch");
    await reader.post("/app/login", {
      email: "reader-links@example.com",
      src: "reddit",
      campaign: "localllama-launch",
    });
    const mail = s.mailer.outbox.filter((m) => m.to === "reader-links@example.com").at(-1)!;
    const token = new URL(mail.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    await reader.get(`/app/auth/verify?token=${token}`);
    await reader.post("/app/auth/verify", { token });

    const calls = stubUmami();
    const h = (await ops.get(where)).html;
    const url =
      "https://recall.test/?utm_source=reddit&amp;utm_medium=social&amp;utm_campaign=localllama-launch#pricing";
    expect(h).toContain("Link ready");
    expect(h).toContain(`<pre data-copy>${url}</pre>`);
    expect(h).toContain(`data-copy-text="${url}"`);
    expect(h).toContain('<tr class="fresh">');
    expect(h).toContain(
      'href="https://www.reddit.com/r/LocalLLaMA/comments/abc/" rel="noopener noreferrer"',
    );
    // Visitors 9, sign-ups 1, first API call 0.
    expect(h).toMatch(
      /data-label="Visitors">9<\/td>\s*<td class="num" data-label="Sign-ups">1<\/td>\s*<td class="num" data-label="First API call">0<\/td>/,
    );
    const stats = calls.find((c) => c.pathname.endsWith("/stats"))!;
    expect(stats.pathname).toBe(`/api/websites/${UMAMI.UMAMI_WEBSITE_ID}/stats`);
    expect(Object.fromEntries(stats.searchParams)).toMatchObject({
      utmSource: "reddit",
      utmMedium: "social",
      utmCampaign: "localllama-launch",
    });
    expect(stats.searchParams.has("utmContent")).toBe(false);

    const again = await ops.post("/app/admin/links", {
      path: "/",
      source: "reddit",
      campaign: "localllama-launch",
    });
    expect(again.res.status).toBe(409);
    expect(again.html).toContain("A link with these tags exists already");
    // A content tag tells two links of one campaign apart.
    const second = await ops.post("/app/admin/links", {
      source: "reddit",
      campaign: "localllama-launch",
      content: "comment",
    });
    expect(second.res.status).toBe(303);
  });

  it("shows a question mark when Umami does not answer, and archives links", async () => {
    stubUmami(500);
    const h = (await ops.get("/app/admin/links")).html;
    expect(h).toContain('title="Umami did not answer for this link">?</span>');
    const ids = [...h.matchAll(/\/app\/admin\/links\/([^/"]+)\/archive/g)].map((m) => m[1]!);
    expect(ids.length).toBe(2);
    for (const id of ids) {
      const r = await ops.post(`/app/admin/links/${id}/archive`);
      expect(r.res.status).toBe(303);
      expect(r.res.headers.get("location")).toBe("/app/admin/links?msg=link_archived");
    }
    const after = await ops.get("/app/admin/links?msg=link_archived");
    expect(after.html).toContain("Link archived.");
    expect(after.html).toContain("No links yet.");
    expect((await ops.post(`/app/admin/links/${ids[0]}/archive`)).res.status).toBe(404);
    // Archived tags can be used again.
    stubUmami();
    const remade = await ops.post("/app/admin/links", {
      source: "reddit",
      campaign: "localllama-launch",
    });
    expect(remade.res.status).toBe(303);
  });

  it("is in the console's tabs", async () => {
    stubUmami();
    const h = (await ops.get("/app/admin/traffic")).html;
    expect(h).toContain('<a href="/app/admin/links">Links</a>');
  });
});
