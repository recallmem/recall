import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MAX_FILE_BYTES } from "../src/core/files.js";
import { MAX_IDEMPOTENCY_KEY } from "../src/core/messages.js";
import { MAX_MESSAGE_CHARS } from "../src/core/schemas.js";
import { MAX_BODY_BYTES } from "../src/http/security.js";
import { createTestServer } from "./helpers.js";
import { mentionsOldName } from "./integration-helpers.js";

type Server = Awaited<ReturnType<typeof createTestServer>>;
let s: Server;
beforeAll(async () => {
  s = await createTestServer();
});
afterAll(() => s.close());

describe("site", () => {
  it("serves the home page and the docs", async () => {
    const home = await s.app.request("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("Recall keeps receipts.");
    const docs = await s.app.request("/docs");
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('id="quickstart"');
  });

  it("serves /llms.txt: what Recall is, with links to sections of the docs that exist", async () => {
    const res = await s.app.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    expect(text.startsWith("# Recall\n\n> ")).toBe(true);
    expect(text).toContain("https://recallmem.dev/docs#quickstart");
    expect(text).toContain("https://app.recallmem.dev/keys");
    expect(text).not.toContain("{{");
    const docsIds = idsOf(await (await s.app.request("/docs")).text());
    const anchors = [...text.matchAll(/https:\/\/recallmem\.dev\/docs#([\w-]+)/g)].map(
      (m) => m[1]!,
    );
    expect(anchors.length).toBeGreaterThan(10);
    expect(anchors.filter((id) => !docsIds.has(id))).toEqual([]);
    for (const m of text.matchAll(
      /https:\/\/recallmem\.dev\/((?:guides|compare)\/[\w-]+|[a-z]+)\)/g,
    ))
      expect((await s.app.request(`/${m[1]}`)).status, m[1]).toBe(200);
    // On Vercel the CDN serves it from public/ with the site's headers.
    const vercel = read("packages/server/vercel.json");
    expect(vercel).toContain("robots\\\\.txt|llms\\\\.txt");
  });

  it("serves assets with their types and leaves the API alone", async () => {
    expect((await s.app.request("/site.css")).headers.get("content-type")).toContain("text/css");
    expect((await s.app.request("/fonts/geist-sans.woff2")).headers.get("content-type")).toBe(
      "font/woff2",
    );
    const missing = await s.app.request("/nope.html");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "Not Found" });
    expect((await s.app.request("/health")).status).toBe(200);
  });
});

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const idsOf = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
const hrefsOf = (html: string) => [...html.matchAll(/\shref="([^"]+)"/g)].map((m) => m[1]!);
/** The text of the page as written in a code block: entities decoded. */
const decode = (html: string) =>
  html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

describe("site content", () => {
  let home = "";
  let docs = "";
  beforeAll(async () => {
    home = await (await s.app.request("/")).text();
    docs = await (await s.app.request("/docs")).text();
  });

  it("links only to anchors that exist", () => {
    const homeIds = idsOf(home);
    const docsIds = idsOf(docs);
    const missing: string[] = [];
    for (const href of hrefsOf(home)) {
      if (href.startsWith("#") && href.length > 1 && !homeIds.has(href.slice(1)))
        missing.push(`index ${href}`);
      if (href.startsWith("/docs#") && !docsIds.has(href.slice("/docs#".length)))
        missing.push(`index ${href}`);
    }
    for (const href of hrefsOf(docs)) {
      if (href.startsWith("#") && href.length > 1 && !docsIds.has(href.slice(1)))
        missing.push(`docs ${href}`);
      if (href.startsWith("/#") && !homeIds.has(href.slice(2))) missing.push(`docs ${href}`);
    }
    expect(missing).toEqual([]);
  });

  it("documents integrations, models, the CLI, the dashboard and forgetting a person", () => {
    const ids = idsOf(docs);
    for (const id of [
      "integrations",
      "claude-code",
      "codex",
      "openclaw",
      "hermes",
      "agent-skill",
      "mcp",
      "cli",
      "models",
      "openrouter",
      "metering",
      "webhooks",
      "dashboard",
      "read-only-gets",
      "search-filters",
      "forget-a-person",
      "cors",
    ])
      expect(ids.has(id), id).toBe(true);
    for (const text of [
      "DELETE /v3/workspaces/{workspace}/peers/{peer}",
      "recall peer delete alice --yes",
      "peer_perspective",
      "X-Recall-Event-Id",
      "RECALL_CORS_ORIGINS",
      "recall doctor",
      "RECALL_OPENROUTER_ROUTING",
    ])
      expect(docs, text).toContain(text);
  });

  it("links the works-with chips to the integrations", () => {
    const chips = /<div class="works[^"]*">([\s\S]*?)<\/div>/.exec(home)?.[1] ?? "";
    const targets = hrefsOf(chips);
    expect(targets).toEqual(
      expect.arrayContaining([
        "/docs#claude-code",
        "/docs#codex",
        "/docs#openclaw",
        "/docs#hermes",
        "/docs#mcp",
        "/docs#api",
      ]),
    );
    expect(hrefsOf(home)).toContain("/docs#integrations");
  });

  it("copies the install commands from the integration READMEs", () => {
    const commands: Record<string, string[]> = {
      "integrations/claude-code/README.md": [
        "/plugin marketplace add recallmem/recall-plugin",
        "/plugin install recall-memory@recall",
        "claude plugin marketplace add recallmem/recall-plugin",
        "claude plugin install recall-memory@recall",
        "/reload-plugins",
        "/recall-memory:status",
      ],
      "integrations/codex/README.md": [
        "codex plugin marketplace add recallmem/recall-plugin",
        "codex plugin add recall-memory@recall",
        "git clone https://github.com/recallmem/recall-plugin",
        "node recall-plugin/integrations/codex/install.mjs",
        "codex mcp list",
      ],
      "integrations/openclaw/README.md": [
        "openclaw plugins install ./recall-plugin/integrations/openclaw --force --accept-capabilities",
        `openclaw config set plugins.entries.recall-memory.hooks '{"allowConversationAccess":true}' --strict-json --merge`,
        "openclaw plugins reload recall-memory",
        "openclaw plugins inspect recall-memory --runtime --json",
      ],
      "integrations/hermes/README.md": [
        "cp -r recall-plugin/integrations/hermes/recall ~/.hermes/plugins/recall",
        "hermes memory setup",
        "hermes memory status",
      ],
      "integrations/agent-skill/README.md": [
        "mkdir -p ~/.agents/skills && cp -r recall-plugin/integrations/agent-skill/recall-memory ~/.agents/skills/",
      ],
    };
    const page = decode(docs);
    for (const [readme, list] of Object.entries(commands)) {
      const source = read(readme);
      for (const command of list) {
        expect(source, `${readme}: ${command}`).toContain(command);
        expect(page, command).toContain(command);
      }
    }
  });

  it("mentions only settings that exist", () => {
    const known = [
      read("packages/server/src/config.ts"),
      ...readdirSync(join(REPO, "packages/server/src/cli")).map((f) =>
        read(`packages/server/src/cli/${f}`),
      ),
      ...["claude-code", "codex", "openclaw", "hermes", "agent-skill"].map((d) =>
        read(`integrations/${d}/README.md`),
      ),
    ].join("\n");
    const used = new Set(
      decode(docs).match(
        /\b(?:RECALL|OPENAI|ANTHROPIC|GEMINI|OPENROUTER|GROQ|DEEPSEEK|TOGETHER|FIREWORKS)_[A-Z0-9_]+\b/g,
      ) ?? [],
    );
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((name) => !known.includes(name))).toEqual([]);
  });

  it("documents the limits the server enforces, with the server's own numbers", () => {
    const page = decode(docs);
    const { tenancy } = loadConfig({ RECALL_DATA_DIR: "memory" });
    const n = (x: number) => x.toLocaleString("en-US");
    for (const text of [
      `${n(MAX_MESSAGE_CHARS)} characters`,
      `${tenancy.keyRateLimitPerMin} requests a minute`,
      `${tenancy.chatRateLimitPerMin} questions a minute`,
      `After ${tenancy.authFailuresPerMin} failed sign-ins`,
      `${MAX_BODY_BYTES / 1024 / 1024} MB; file uploads ${MAX_FILE_BYTES / 1024 / 1024} MB`,
      `up to ${MAX_IDEMPOTENCY_KEY} characters`,
      "Retry-After",
      "no rate-limit headers",
      // 422s from validation carry a list, other errors a sentence.
      '{"detail":[{"type":"too_big","loc":["body","messages",0,"content"]',
    ])
      expect(page, text).toContain(text);
    expect(MAX_MESSAGE_CHARS).toBe(25_000);
  });

  it("documents self-hosting, retries and the request bodies people asked about", () => {
    const ids = idsOf(docs);
    for (const id of ["self-host", "idempotency", "add-facts", "dreams", "errors"])
      expect(ids.has(id), id).toBe(true);
    const page = decode(docs);
    for (const text of [
      // Every get-or-create route is in the REST table.
      "<code>POST …/sessions</code>",
      "<code>POST …/peers</code>",
      // Deleting a workspace with sessions is refused.
      "<code>DELETE /v3/workspaces/{w}</code></td><td>Delete a workspace: <code>409</code>",
      // Bodies of schedule_dream and conclusions.
      '{"observer":"alice","observed":"alice","dream_type":"omni"}',
      '"observer_id":"alice","observed_id":"alice"',
      // A repeated key replays what the first request did; another request under it is a 409.
      "the same key with the same request returns the first answer again",
      "<code>Idempotent-Replayed: true</code>",
      "The same key with different messages answers <code>409</code>",
      "while the first request is still running",
      "kept for 24 hours",
      // The minimal level is answered by the memory model on the hosted service.
      "Recall Loom answers at <code>minimal</code>",
      "docker compose up --build",
      "about 20 seconds",
      "wait_ms=30000",
    ])
      expect(page, text).toContain(text);
    expect(page).not.toMatch(
      /runs one answer|different number of messages|sending (?:it|the same key) again answers|usually finishes within seconds/,
    );
    // The FAQ agrees with the docs: the server can be self-hosted.
    const faq = /<summary>Can I self-host\?<\/summary><p>([\s\S]*?)<\/p>/.exec(home)?.[1] ?? "";
    expect(faq).toMatch(/^Yes\./);
    expect(faq).toContain('href="/docs#self-host"');
    // The night shift demo shows what happened to the facts, not a weekly schedule.
    const night = /<section class="block[^"]*" id="night-shift"[^>]*>[\s\S]*?<\/section>/.exec(
      home,
    )?.[0];
    expect(night).toContain("goes quiet");
    expect(night).not.toMatch(/every (?:mon|tues|wednes|thurs|fri|satur|sun)day/i);
  });

  it("links the public repository from one constant", () => {
    // REPO_URL in scripts/site/pages.py feeds the generated pages; the hand-written docs, the
    // README and the packages' metadata must say the same, so a rename is one search away.
    const repo = /^REPO_URL = "([^"]+)"$/m.exec(read("packages/server/scripts/site/pages.py"))?.[1];
    expect(repo).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    const owner = repo!.split("/").slice(0, 4).join("/");
    const files = [
      "README.md",
      "packages/server/public/docs.html",
      "packages/server/public/home.html",
      "packages/server/public/llms.txt",
      "packages/server/public/security.html",
      "packages/sdk/package.json",
      "sdks/python/pyproject.toml",
    ];
    // The organisation's other repositories: the plugins' marketplace and the GitHub Action.
    const repos = [repo, `${owner}/recall-plugin`, `${owner}/memory-action`];
    for (const file of files) {
      const text = read(file);
      expect(text, file).toContain(repo);
      for (const m of text.matchAll(new RegExp(`${owner.replaceAll(".", "\\.")}/[\\w.-]+`, "g")))
        expect(repos, file).toContain(m[0].replace(/\.git$/, ""));
    }
    expect(home).toContain(`<a href="${repo}">GitHub</a>`);
    expect(docs).toContain(`<a href="${repo}">GitHub</a>`);
  });

  it("keeps the home page to the pitch: how, use cases, why, integrations, evals, pricing, FAQ", () => {
    for (const id of [
      "how",
      "night-shift",
      "use-cases",
      "why",
      "agents",
      "benchmarks",
      "pricing",
      "faq",
    ])
      expect(idsOf(home).has(id), id).toBe(true);
    expect(home).toContain('href="/docs#forget-a-person"');
    expect(home).toContain("See what it knows");
  });

  it("shows the configured prices, and a worked example that adds up", () => {
    // scripts/site/prices.py reads the defaults in src/config.ts; these are the same defaults.
    const { prices, signupCreditMicros } = loadConfig({ RECALL_DATA_DIR: "memory" }).hosted.billing;
    const usd = (micros: number) => {
      const s = String(Number((micros / 1e6).toFixed(4)));
      return `$${/\.\d$/.test(s) ? `${s}0` : s}`;
    };
    const rates = /<div class="window rates[\s\S]*?<\/table>/.exec(home)?.[0] ?? "";
    for (const micros of [prices.ingestPerMTokMicros, ...Object.values(prices.chatMicros)])
      expect(rates, usd(micros)).toContain(`<td class="n">${usd(micros)}</td>`);
    expect(rates).toContain(`at least ${prices.ingestMinTokens} tokens`);
    expect(home).toContain(`${usd(signupCreditMicros)}<small>free to start</small>`);
    // The example's lines add up to its total.
    const example = /<table class="ex-table">[\s\S]*?<\/table>/.exec(home)?.[0] ?? "";
    const cents = [...example.matchAll(/<td class="n">\$([\d,.]+)<\/td>/g)].map((m) =>
      Math.round(Number(m[1]!.replaceAll(",", "")) * 100),
    );
    expect(cents.length).toBe(3);
    expect(cents[0]! + cents[1]!).toBe(cents[2]);
  });

  it("keeps the first screen visible: no reveal animation in the hero", () => {
    const hero = /<section class="hero"[^>]*>[\s\S]*?<\/section>/.exec(home)?.[0] ?? "";
    expect(hero).toContain("Recall keeps receipts.");
    expect(hero).not.toContain("reveal");
    expect(hero).toContain('class="proof-line"');
  });

  it("publishes only the benchmark results that were run", () => {
    // The site's figures come from EVALS in scripts/site/pages.py: run v3 of 11 October 2026 (full
    // LongMemEval-S, BEAM 100K and BEAM 500K, BEAM scored with BEAM's own code).
    const source = read("packages/server/scripts/site/pages.py");
    for (const figure of [
      '"score": 0.683,\n        "ci": (0.653, 0.713),',
      '"score": 0.670,\n        "ci": (0.643, 0.695),',
      '"score": 91.0,\n        "ci": (88.2, 93.2),',
    ])
      expect(source, figure).toContain(figure);
    // The private repository also keeps the record of every run (docs/BENCHMARKS.md, not part of
    // the public source): the current run, and the earlier ones as history.
    if (existsSync(join(REPO, "docs/BENCHMARKS.md"))) {
      const record = read("docs/BENCHMARKS.md");
      expect(record).toContain("**91.0%** correct (455/500, 95% Wilson interval 88.2-93.2%)");
      expect(record).toMatch(
        /\*\*Overall\*\* \(mean of abilities\) \| \*\*0\.683\*\* \(95% CI 0\.653-0\.713\) \| \*\*0\.670\*\* \(95% CI 0\.643-0\.695\)/,
      );
      expect(record).toContain("protocol `beam-ref-b2da22e`");
      // History: the previously published full runs, the unpublished v4 and the samples.
      expect(record).toContain("**88.4%** correct (442/500, 95% Wilson interval 85.3-90.9%)");
      expect(record).toMatch(
        /\*\*Overall\*\* \(mean of abilities\) \| \*\*0\.627\*\* \(95% CI 0\.587-0\.666\) \| \*\*0\.610\*\* \(95% CI 0\.582-0\.640\)/,
      );
      expect(record).toMatch(
        /\*\*Overall\*\* \(mean of abilities\) \| \*\*0\.557\*\* \| \*\*0\.630\*\*/,
      );
      expect(record).toContain("LongMemEval-S **89.0%** (445/500");
      expect(record).toContain("**LongMemEval-S, sample** (50 of 500 questions");
      expect(record).toContain("**78.0%** correct (39/50");
      expect(record).toContain("**84.0%** correct (42/50");
      expect(record).toContain("**86.0%** correct (43/50");
    }
    expect(home).toContain('<div class="n">0.68</div>');
    expect(home).toContain('<div class="n">0.67</div>');
    expect(home).toContain('<div class="n">91.0%</div>');
    const evals = read("packages/server/public/evals.html");
    expect(evals).toContain("overall 0.683 · 95% interval 0.653-0.713");
    expect(evals).toContain("overall 0.670 · 95% interval 0.643-0.695");
    expect(evals).toContain("overall 91.0% · 95% interval 88.2-93.2%");
    // On the home and evals pages a LongMemEval percentage is only ever the full run's 91.0%.
    for (const m of `${home}${evals}`.matchAll(/LongMemEval[^<.]{0,80}?(\d{2}(?:\.\d)?)\s?%/g))
      expect(Number(m[1])).toBe(91.0);
    // BEAM is scored with BEAM's own evaluation code now; the harness-grader wording is gone.
    for (const text of [home, evals, docs]) {
      expect(text).not.toContain("in our harness");
      expect(text).not.toMatch(/not BEAM(?:'|&#x27;)s reference judge;/);
      expect(text).not.toContain("unscored");
    }
    expect(evals).toContain("beam-ref-b2da22e");
    // The docs page (public/docs.html) is written by hand: it must show the same three figures.
    expect(docs).toContain("<b>91.0%</b> (455 correct)");
    expect(docs).toContain("<b>0.683</b>");
    expect(docs).toContain("<b>0.670</b>");
    expect(docs).toContain("BEAM's own evaluation code");
    for (const stale of ["0.630", "0.557", "0.598", "86.0%", "88.4%", "0.627", "0.610"])
      expect(docs, stale).not.toContain(stale);
  });

  it("names other memory systems only in the sourced comparison charts and pages", () => {
    const dir = join(REPO, "packages/server/public");
    const chart = /<figure class="cmp [\s\S]*?<\/figure>/g;
    // Links to the comparison pages and the switching guide may name the product they are about
    // (the guides index and its nav, llms.txt, the sitemap); the comparison pages are checked below.
    const dedicated =
      /<a [^>]*href="\/(?:compare\/[\w-]+|guides\/switch-from-honcho)"[^>]*>[\s\S]*?<\/a>|^.*https:\/\/recallmem\.dev\/(?:compare\/[\w-]+|guides\/switch-from-honcho)\).*$|<loc>https:\/\/recallmem\.dev\/(?:compare\/[\w-]+|guides\/switch-from-honcho)<\/loc>/gm;
    for (const file of readdirSync(dir).filter((f) => /\.(html|js|css|txt|xml)$/.test(f))) {
      if (file === "compare.html") continue;
      const text = read(`packages/server/public/${file}`).replace(dedicated, "");
      const charts = text.match(chart) ?? [];
      if (file === "evals.html") expect(charts.length).toBeGreaterThanOrEqual(2);
      if (file === "home.html") expect(charts.length).toBe(1);
      for (const c of charts) {
        // Every bar carries a source number, and every number is a link to that source.
        const refs = [...c.matchAll(/<sup>(\d+)<\/sup>/g)].map((m) => m[1]);
        const listed = [...c.matchAll(/<span class="sn">(\d+)<\/span><a href="https:\/\//g)];
        expect(c.match(/class="cmp-row/g)?.length).toBe(refs.length);
        expect(new Set(refs)).toEqual(new Set(listed.map((m) => m[1])));
      }
      expect(text.replace(chart, ""), file).not.toMatch(/honcho/i);
    }
  });

  it("keeps the brand and repository names straight", () => {
    const files = [
      ...readdirSync(join(REPO, "packages/server/public")).filter((f) =>
        /\.(html|css|js|txt)$/.test(f),
      ),
      ...readdirSync(join(REPO, "packages/server/public/compare")).map((f) => `compare/${f}`),
    ].map((f) => `packages/server/public/${f}`);
    files.push(
      "packages/server/scripts/site/versus.py",
      "packages/server/scripts/site/index.tpl.html",
      "packages/server/scripts/site/build.py",
      "packages/server/scripts/site/sprites.py",
      "packages/server/scripts/site/scene.py",
      "packages/server/scripts/site/pages.py",
    );
    for (const file of files) {
      const text = read(file);
      expect(mentionsOldName(text), file).toBe(false);
      expect(text, file).not.toMatch(/RedSix6\//i);
      // The template's sprite placeholders are all filled in the published pages.
      if (file.startsWith("packages/server/public/") && file.endsWith(".html"))
        expect(text, file).not.toContain("{{");
    }
  });
});

describe("legal pages and security.txt", () => {
  const LEGAL = ["privacy", "terms", "dpa", "security", "support"];
  const PUBLIC = join(REPO, "packages/server/public");
  const pub = (file: string) => read(`packages/server/public/${file}`);

  it("serves the legal pages and the security page, dated and versioned", async () => {
    for (const page of LEGAL) {
      const res = await s.app.request(`/${page}`);
      expect(res.status, page).toBe(200);
      expect(res.headers.get("content-type"), page).toContain("text/html");
      expect(res.headers.get("content-security-policy"), page).toContain("default-src 'none'");
      const html = await res.text();
      expect(html, page).toContain(`<link rel="canonical" href="https://recallmem.dev/${page}" />`);
      expect(html, page).toMatch(/Last updated: \d{1,2} [A-Z][a-z]+ 2026 · Version \d+\.\d+/);
      expect(html, page).not.toContain('style="');
    }
  });

  it("serves security.txt (RFC 9116) with a future expiry and a link to the policy", async () => {
    const res = await s.app.request("/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const fields = (await res.text())
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()] as const);
    const field = (name: string) => fields.filter(([k]) => k === name).map(([, v]) => v);
    expect(field("Contact")).toEqual([
      "mailto:security@recallmem.dev",
      "mailto:support@recallmem.dev",
    ]);
    expect(field("Policy")).toEqual(["https://recallmem.dev/security"]);
    expect(field("Preferred-Languages")).toEqual(["en, nl"]);
    expect(field("Canonical")).toContain("https://recallmem.dev/.well-known/security.txt");
    const expires = field("Expires");
    expect(expires).toHaveLength(1);
    // RFC 9116: an expired file must not be relied on. Renew Expires (about a year out) yearly.
    expect(Date.parse(expires[0]!), "security.txt has expired: renew Expires").toBeGreaterThan(
      Date.now(),
    );
    // Other /.well-known paths are not files of the site.
    expect((await s.app.request("/.well-known/nope.txt")).status).toBe(404);
  });

  it("lets Vercel's CDN serve the new paths with the site's headers", () => {
    const vercel = JSON.parse(read("packages/server/vercel.json")) as {
      outputDirectory: string;
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    expect(vercel.outputDirectory).toBe("public");
    const files = readdirSync(PUBLIC);
    for (const page of LEGAL) expect(files, page).toContain(`${page}.html`);
    expect(readdirSync(join(PUBLIC, ".well-known"))).toContain("security.txt");
    const pageRule = vercel.headers.find((r) => r.source.startsWith("/:page("));
    for (const page of LEGAL) expect(pageRule?.source, page).toMatch(new RegExp(`[(|]${page}[|)]`));
    const txt = vercel.headers.find((r) => r.source === "/.well-known/security.txt");
    expect(txt?.headers.map((h) => h.key)).toContain("X-Content-Type-Options");
    // OpenAI's domain check wants the bare token as plain text: no newline, no JSON.
    const challenge = vercel.headers.find((r) => r.source === "/.well-known/openai-apps-challenge");
    expect(challenge?.headers.find((h) => h.key === "Content-Type")?.value).toBe(
      "text/plain; charset=utf-8",
    );
    expect(read("packages/server/public/.well-known/openai-apps-challenge")).toMatch(
      /^[A-Za-z0-9_-]{20,}$/,
    );
  });

  it("links every public page to the legal pages, with anchors that exist", () => {
    const pages = readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
    const slug = (file: string) => file.replace(/\.html$/, "");
    const ids = new Map(pages.map((f) => [slug(f), idsOf(pub(f))]));
    const missing: string[] = [];
    for (const file of pages) {
      const hrefs = hrefsOf(pub(file));
      for (const page of LEGAL)
        if (!hrefs.includes(`/${page}`)) missing.push(`${file}: no link to /${page}`);
      if (!LEGAL.includes(slug(file))) continue;
      for (const href of hrefs) {
        const m = /^(?:\/([a-z]+))?#(.+)$/.exec(href);
        const target = m && (m[1] ?? slug(file));
        if (m && target && ids.has(target) && !ids.get(target)!.has(m[2]!))
          missing.push(`${file}: ${href}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("uses only the real mailboxes on the public pages", () => {
    const addresses = new Set<string>();
    for (const file of readdirSync(PUBLIC).filter((f) => f.endsWith(".html")))
      for (const m of pub(file).matchAll(/mailto:([^"?]+)/g)) addresses.add(m[1]!);
    // Cloudflare Email Routing delivers all three to the owner's inbox.
    expect([...addresses].sort()).toEqual([
      "privacy@recallmem.dev",
      "security@recallmem.dev",
      "support@recallmem.dev",
    ]);
  });
});

describe("guides", () => {
  const manifest = JSON.parse(read("packages/server/site/guides/manifest.json")) as {
    slug: string;
    languages?: string[];
  }[];
  const pages = new Map<string, string>();
  beforeAll(async () => {
    for (const path of ["/docs", "/", "/guides", ...manifest.map((g) => `/guides/${g.slug}`)]) {
      const res = await s.app.request(path);
      expect(res.status, path).toBe(200);
      pages.set(path === "/" ? "/home" : path, await res.text());
    }
  });

  it("are built from their sources (run scripts/site/guides.mjs after editing site/guides)", () => {
    expect(() =>
      execFileSync("node", [join(REPO, "packages/server/scripts/site/guides.mjs"), "--check"], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("describe a chat retry with an Idempotency-Key as the docs do", () => {
    const caching = /<h2 id="caching">[\s\S]*?<\/p>/.exec(
      pages.get("/guides/levels-and-models")!,
    )?.[0];
    expect(caching).toContain("returns the first answer again");
    expect(caching).toContain("answers <code>409</code>");
    expect(caching).not.toMatch(/sending the same key again answers/);
  });

  it("are all listed on the index", () => {
    const index = hrefsOf(pages.get("/guides")!);
    for (const g of manifest) expect(index, g.slug).toContain(`/guides/${g.slug}`);
  });

  it("link only to pages and anchors that exist", () => {
    const sitePages = new Set(
      [
        ...readdirSync(join(REPO, "packages/server/public")),
        ...readdirSync(join(REPO, "packages/server/public/compare")).map((f) => `compare/${f}`),
      ]
        .filter((f) => f.endsWith(".html"))
        .map((f) => `/${f.replace(/\.html$/, "")}`),
    );
    const missing: string[] = [];
    for (const [path, html] of pages) {
      if (!path.startsWith("/guides")) continue;
      for (const href of hrefsOf(html)) {
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [target, anchor] = href.split("#") as [string, string | undefined];
        const page = target === "" ? path : target === "/" ? "/home" : target;
        const known =
          pages.get(page) ?? (sitePages.has(page) || page.startsWith("/app") ? "" : null);
        if (known === null && !/^\/[\w./-]+\.(css|js|svg|png|woff2)$/.test(page))
          missing.push(`${path} ${href}`);
        else if (anchor && known && !idsOf(known).has(anchor)) missing.push(`${path} ${href}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("only show code that CI runs, in both languages (framework guides: the framework's language)", () => {
    const dir = join(REPO, "examples/guides");
    // A framework guide (manifest `languages: ["ts"]` or `["py"]`) has no twin in the other
    // language; its examples run in the integration package's own tests.
    const single = new Map(
      manifest.filter((g) => g.languages?.length === 1).map((g) => [g.slug, g.languages![0]!]),
    );
    const singleExamples = new Set(
      [...single].flatMap(([slug, lang]) =>
        [
          ...read(`packages/server/site/guides/${slug}.html`).matchAll(
            /<!-- example: ([a-z0-9-]+)#/g,
          ),
        ].map((m) => `${m[1]}.${lang}`),
      ),
    );
    const testsIn = (root: string, sub: string) =>
      readdirSync(join(REPO, root))
        .filter((p) => existsSync(join(REPO, root, p, sub)))
        .flatMap((p) =>
          readdirSync(join(REPO, root, p, sub))
            .filter((t) => /\.(ts|py)$/.test(t))
            .map((t) => read(`${root}/${p}/${sub}/${t}`)),
        );
    const packageTests = [
      ...testsIn("packages", "test"),
      ...testsIn("sdks/python-integrations", "tests"),
    ];
    for (const f of singleExamples) {
      const tested = packageTests.some(
        (source) => source.includes(`examples/guides/${f}`) || source.includes(`"${f}"`),
      );
      expect(tested, `${f} is run by a package's tests`).toBe(true);
    }
    const files = readdirSync(dir).filter((f) => !singleExamples.has(f));
    for (const f of files.filter((f) => f.endsWith(".ts")))
      expect(files, f).toContain(f.replace(/\.ts$/, ".py"));
    for (const f of files.filter((f) => f.endsWith(".py")))
      expect(files, f).toContain(f.replace(/\.py$/, ".ts"));
    for (const [path, html] of pages) {
      if (!path.startsWith("/guides/")) continue;
      // Code windows come from examples/guides; free-standing blocks are REST/shell/engine snippets.
      const tsPanels = html.match(/data-panel="ts"/g)?.length ?? 0;
      const pyPanels = html.match(/data-panel="py"/g)?.length ?? 0;
      const lang = single.get(path.slice("/guides/".length));
      if (lang === "ts") {
        expect(tsPanels, path).toBeGreaterThan(0);
        expect(pyPanels, path).toBe(0);
      } else if (lang === "py") {
        expect(pyPanels, path).toBeGreaterThan(0);
        expect(tsPanels, path).toBe(0);
      } else expect(tsPanels, path).toBe(pyPanels);
    }
  });

  it("are linked from the docs and the home page", () => {
    expect(hrefsOf(pages.get("/docs")!)).toContain("/guides");
    expect(hrefsOf(pages.get("/home")!)).toContain("/guides");
  });
});

describe("comparison pages", () => {
  // Written by scripts/site/pages.py from scripts/site/versus.py.
  const SLUGS = ["honcho", "mem0", "zep", "letta"];
  const pages = new Map<string, string>();
  beforeAll(async () => {
    for (const path of ["/compare", ...SLUGS.map((slug) => `/compare/${slug}`)]) {
      const res = await s.app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-security-policy"), path).toContain("default-src 'none'");
      pages.set(path, await res.text());
    }
  });

  it("are dated, canonical, and cite a listed source for every fact about another product", () => {
    for (const [path, html] of pages) {
      expect(html, path).toContain(`<link rel="canonical" href="https://recallmem.dev${path}" />`);
      expect(html, path).toMatch(/Read on \d{1,2} [A-Z][a-z]+ 2026\./);
      expect(html, path).not.toContain("[[");
      expect(html, path).not.toContain('style="');
      const cited = new Set(
        [...html.matchAll(/<sup class="src"><a href="#source-(\d+)">\1<\/a><\/sup>/g)].map(
          (m) => m[1],
        ),
      );
      const listed = new Set(
        [...html.matchAll(/<li id="source-(\d+)"><a href="https:\/\/[^"]+" rel="noopener">/g)].map(
          (m) => m[1],
        ),
      );
      expect(cited.size, path).toBeGreaterThan(0);
      expect(cited, path).toEqual(listed);
    }
    const index = hrefsOf(pages.get("/compare")!);
    for (const slug of SLUGS) expect(index, slug).toContain(`/compare/${slug}`);
  });

  it("show Recall's published figures and the configured prices", () => {
    const { prices, signupCreditMicros } = loadConfig({ RECALL_DATA_DIR: "memory" }).hosted.billing;
    const usd = (micros: number) => {
      const s = String(Number((micros / 1e6).toFixed(4)));
      return `$${/\.\d$/.test(s) ? `${s}0` : s}`;
    };
    for (const slug of SLUGS) {
      const html = pages.get(`/compare/${slug}`)!;
      expect(html, slug).toContain(">91.0%</a> (455 of 500)");
      expect(html, slug).toContain(usd(prices.ingestPerMTokMicros));
      expect(html, slug).toContain(`${usd(signupCreditMicros)} of credit`);
      // No other LongMemEval percentage is attributed to Recall.
      expect(html, slug).not.toMatch(/8[68]\.[04]%/);
    }
    const honcho = pages.get("/compare/honcho")!;
    for (const micros of Object.values(prices.chatMicros))
      expect(honcho).toContain(`<td class="n">${usd(micros)}</td>`);
    expect(honcho).toContain(">0.683</a>");
    expect(honcho).toContain(">0.670</a>");
    expect(honcho).toContain('href="/guides/switch-from-honcho"');
  });

  it("are linked from the footers, llms.txt and the switching guide", async () => {
    for (const path of ["/", "/docs", "/evals", "/guides", "/privacy"]) {
      const html = await (await s.app.request(path)).text();
      expect(hrefsOf(html), path).toContain("/compare");
    }
    const llms = await (await s.app.request("/llms.txt")).text();
    for (const slug of SLUGS) expect(llms).toContain(`https://recallmem.dev/compare/${slug})`);
    const guide = await (await s.app.request("/guides/switch-from-honcho")).text();
    expect(hrefsOf(guide)).toContain("/compare/honcho");
    // The home page links them from the footer only, not from the hero.
    const home = await (await s.app.request("/")).text();
    const hero = /<section class="hero"[^>]*>[\s\S]*?<\/section>/.exec(home)?.[0] ?? "";
    expect(hero).not.toContain("/compare");
    // On Vercel the CDN serves them with the site's headers.
    const vercel = JSON.parse(read("packages/server/vercel.json")) as {
      headers: { source: string }[];
    };
    const sources = vercel.headers.map((r) => r.source);
    expect(sources.find((r) => r.startsWith("/:page("))).toMatch(/[(|]compare[|)]/);
    expect(sources).toContain("/compare/:slug");
  });
});
