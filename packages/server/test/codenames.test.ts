import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { rows } from "../src/db/client.js";
import { CODENAMES, hostedModels, publicModel, roleOfTask } from "../src/llm/codenames.js";
import { createTestServer } from "./helpers.js";
import { Browser, createHostedServer, type HostedServer } from "./hosted-helpers.js";

/**
 * The hosted service's models go by codenames (src/llm/codenames.ts) everywhere a customer or the
 * public can read: the website, the usage API, the dashboard and the data export. The real ids
 * stay in the database and the operator's routes.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLIC = join(REPO, "packages/server/public");

/**
 * A server configured the way the hosted service is: one OpenRouter key, and its models set per
 * task through the environment. The model ids are made up; nothing here says which models the
 * hosted service runs.
 */
const ANSWER = "openrouter/acme/answer-large-1";
const MEMORY = "openrouter/acme/memory-small-1";
const EMBEDDING = "openrouter/acme/embed-small-1";
const hostedEnv = {
  RECALL_DATA_DIR: "memory",
  OPENROUTER_API_KEY: "sk-or-test-unused",
  RECALL_MODEL_REASONER: MEMORY,
  RECALL_MODEL_SUMMARY: MEMORY,
  RECALL_MODEL_CARD: MEMORY,
  RECALL_MODEL_DREAM: MEMORY,
  RECALL_MODEL_CHAT_MINIMAL: MEMORY,
  RECALL_MODEL_CHAT_LOW: ANSWER,
  RECALL_MODEL_CHAT_MEDIUM: ANSWER,
  RECALL_MODEL_CHAT_HIGH: ANSWER,
  RECALL_MODEL_CHAT_MAX: ANSWER,
  RECALL_EMBEDDING_MODEL: EMBEDDING,
  RECALL_ANSWER_FALLBACK: "acme/answer-backup-1",
};
const hosted = loadConfig(hostedEnv);
const bare = (ref: string) => ref.split("/").at(-1)!.replace(/:.*$/, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Model names that must never be published, as case-insensitive regular expressions, one per line
 * (`#` starts a comment). The public tree holds no list of the hosted service's real model names:
 * the private repository keeps it in scripts/release/hosted-models.txt (read here when it exists,
 * and by the release scan). RECALL_FORBIDDEN_NAMES (the patterns themselves) or
 * RECALL_FORBIDDEN_NAMES_FILE (a file of them) take its place, e.g. in another deployment's CI.
 */
function forbiddenNames(): { source: string; patterns: RegExp[] } {
  const parse = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => new RegExp(l, "i"));
  const inline = process.env.RECALL_FORBIDDEN_NAMES;
  if (inline?.trim()) return { source: "RECALL_FORBIDDEN_NAMES", patterns: parse(inline) };
  const file =
    process.env.RECALL_FORBIDDEN_NAMES_FILE || join(REPO, "scripts/release/hosted-models.txt");
  if (existsSync(file)) return { source: file, patterns: parse(readFileSync(file, "utf8")) };
  return { source: "none", patterns: [] };
}

/** The models a server picks by itself with one OpenRouter key and no per-task settings. */
const defaults = loadConfig({ RECALL_DATA_DIR: "memory", OPENROUTER_API_KEY: "sk-or-test-unused" });

const LISTED = forbiddenNames();
/**
 * Names the public must never read: the listed ones (when a list is available), and whatever the
 * configured defaults are now, both the code's own and those of the hosted-like configuration.
 */
const REAL_NAMES: RegExp[] = [
  ...LISTED.patterns,
  ...new Set(
    [...hostedModels(defaults).keys(), ...hostedModels(hosted).keys()].map((ref) => bare(ref)),
  ),
].map((name) => (typeof name === "string" ? new RegExp(escapeRe(name), "i") : name));
const leaks = (text: string) => REAL_NAMES.filter((re) => re.test(text)).map(String);

describe("codenames", () => {
  it("name every default model of the hosted configuration by its role", () => {
    const roles = hostedModels(hosted);
    expect(roles.get(hosted.models.chat_low)).toBe("answer");
    expect(roles.get(hosted.models.reasoner)).toBe("memory");
    expect(roles.get(hosted.models.chat_minimal)).toBe("memory");
    expect(roles.get(hosted.embedding.model)).toBe("embedding");
    // The answer models' OpenRouter fallback is named as an answer model...
    expect(hosted.openrouter.routing.chat_low?.fallbacks).toEqual(["acme/answer-backup-1"]);
    expect(roles.get("openrouter/acme/answer-backup-1")).toBe("answer");
    // ...unless it is also a memory model, which keeps the memory name.
    const shared = loadConfig({ ...hostedEnv, RECALL_ANSWER_FALLBACK: "acme/memory-small-1" });
    expect(shared.openrouter.routing.chat_low?.fallbacks).toEqual(["acme/memory-small-1"]);
    expect(hostedModels(shared).get(MEMORY)).toBe("memory");
    const name = (task: string, ref: string, ownModels = false) =>
      publicModel(hosted, ref, task, { ownModels });
    expect(name("chat_low", hosted.models.chat_low)).toBe("recall-lumen");
    expect(name("chat_minimal", hosted.models.chat_minimal)).toBe("recall-loom");
    expect(name("reasoner", hosted.models.reasoner)).toBe("recall-loom");
    expect(name("embedding", hosted.embedding.model)).toBe("recall-embed");
    // A model that is not a default (say, one since replaced) goes by its task's role, unless the
    // account picks its own models: then it keeps the name it asked for.
    expect(name("dream", "openrouter/oldco/memory-old-0")).toBe("recall-loom");
    expect(name("chat_max", "openrouter/x/y")).toBe("recall-lumen");
    expect(name("chat_max", "openrouter/x/y", true)).toBe("openrouter/x/y");
    expect(name("chat_max", hosted.models.chat_max, true)).toBe("recall-lumen");
    expect(roleOfTask("embedding")).toBe("embedding");
    expect(roleOfTask("chat_minimal")).toBe("memory");
  });

  it("are the names the site generators use", () => {
    // scripts/site/compare.py reads CODENAMES from the TypeScript source with this pattern.
    const compare = readFileSync(join(REPO, "packages/server/scripts/site/compare.py"), "utf8");
    expect(compare).toContain('src" / "llm" / "codenames.ts');
    expect(compare).toContain(String.raw`r'(\w+): \{ id: "[^"]+", name: "([^"]+)" \}'`);
    const source = readFileSync(join(REPO, "packages/server/src/llm/codenames.ts"), "utf8");
    const parsed = Object.fromEntries(
      [...source.matchAll(/(\w+): \{ id: "[^"]+", name: "([^"]+)" \}/g)].map((m) => [m[1], m[2]]),
    );
    expect(parsed).toEqual(
      Object.fromEntries(Object.entries(CODENAMES).map(([role, c]) => [role, c.name])),
    );
    for (const c of Object.values(CODENAMES)) {
      expect(c.id).toMatch(/^recall-[a-z]+$/);
      expect(c.name).toMatch(/^Recall [A-Z][a-z]+$/);
    }
  });
});

/** Every text file the website publishes (pages, guides, scripts, styles, .well-known). */
function publicTextFiles(dir = PUBLIC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return publicTextFiles(path);
    return /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|webm|pdf)$/i.test(name) ? [] : [path];
  });
}

describe("the website", () => {
  it("checks against the configured defaults, and the listed names when a list is available", () => {
    // The code's own defaults and the hosted-like configuration always count; the private
    // repository adds the hosted service's real names (scripts/release/hosted-models.txt).
    expect(leaks(`answers by ${bare(ANSWER)}`)).toEqual([String(/answer-large-1/i)]);
    for (const ref of hostedModels(defaults).keys()) expect(leaks(bare(ref))).not.toEqual([]);
    for (const re of LISTED.patterns) expect(re.flags).toContain("i");
    if (LISTED.source !== "none") expect(LISTED.patterns.length, LISTED.source).toBeGreaterThan(0);
  });

  it("never names the hosted models' real ids", () => {
    const files = publicTextFiles();
    expect(files.length).toBeGreaterThan(20);
    const sources = [
      join(REPO, "packages/server/scripts/site/index.tpl.html"),
      join(REPO, "packages/server/scripts/site/llms.tpl.txt"),
      ...readdirSync(join(REPO, "packages/server/site/guides")).map((f) =>
        join(REPO, "packages/server/site/guides", f),
      ),
    ];
    const found = [...files, ...sources].flatMap((f) =>
      leaks(readFileSync(f, "utf8")).map((re) => `${f.slice(REPO.length)}: ${re}`),
    );
    expect(found).toEqual([]);
  });

  it("names the hosted models by their current codenames", () => {
    const page = (f: string) => readFileSync(join(PUBLIC, f), "utf8");
    const { answer, memory, embedding } = CODENAMES;
    // Generated pages (scripts/site) and the hand-written ones: rename them too when a codename changes.
    for (const [file, names] of [
      ["home.html", [answer.name, memory.name]],
      ["evals.html", [answer.name, memory.name, embedding.name]],
      ["docs.html", [memory.name, answer.id, memory.id, embedding.id]],
      ["guides/levels-and-models.html", [answer.id, memory.id, embedding.id]],
    ] as const)
      for (const name of names) expect(page(file), `${file}: ${name}`).toContain(name);
  });

  it("names every model provider in the privacy policy and the DPA, but not which does what", () => {
    for (const file of ["privacy.html", "dpa.html", "guides/privacy.html"]) {
      const html = readFileSync(join(PUBLIC, file), "utf8");
      for (const company of ["OpenRouter", "OpenAI", "Anthropic"])
        expect(html, `${file}: ${company}`).toContain(company);
      expect(html, file).not.toMatch(/when Anthropic is unavailable|Anthropic \(USA\), to answer/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Customer-facing output on a hosted server configured like production (no model is ever called).

let s: HostedServer;
let key: Record<string, string>;
let accountId: string;
let browser: Browser;

/** Usage records as the hosted service writes them, with the real provider and model ids. */
async function recordUsage(account: string, workspace: string) {
  const { models, embedding } = s.ctx.config;
  const split = (ref: string) => [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
  const calls: [string, string][] = [
    ["reasoner", models.reasoner],
    ["reasoner", "openrouter/oldco/memory-old-0"], // a default since replaced
    ["summary", models.summary],
    ["chat_minimal", models.chat_minimal],
    ["chat_low", models.chat_low],
    ["chat_low", models.chat_low],
    ["chat_low", "openrouter/deepseek/deepseek-v4-flash"], // asked for by an experiment account
    ["embedding", embedding.model],
  ];
  for (const [task, ref] of calls) {
    const [provider, model] = split(ref);
    await s.ctx.db.execute(
      sql`INSERT INTO llm_usage (workspace_id, account_id, task, provider, model, input_tokens, output_tokens, cost_usd)
          VALUES (${workspace}, ${account}, ${task}, ${provider}, ${model}, 100, 10, 0.001)`,
    );
  }
}

describe("customer-facing output of the hosted service", () => {
  beforeAll(async () => {
    s = await createHostedServer({
      env: { ...hostedEnv, RECALL_OPENROUTER_LIVE_PRICES: "false" },
    });
    browser = new Browser(s.app, "198.51.100.77");
    await browser.signIn(s, "codenames@example.com");
    const created = await browser.createKey({ name: "k" });
    key = { authorization: `Bearer ${created.html.match(/pk_live_[A-Za-z0-9]{32}/)![0]}` };
    expect((await s.api("POST", "/v3/workspaces", { id: "w" }, key)).status).toBe(201);
    const [ws] = await rows<{ id: string; account_id: string }>(
      s.ctx.db,
      sql`SELECT id, account_id FROM workspaces WHERE name = 'w'`,
    );
    accountId = ws!.account_id;
    await recordUsage(accountId, ws!.id);
  }, 60_000);
  afterAll(() => s?.close());

  it("runs with the real model ids underneath", () => {
    expect(leaks(JSON.stringify(s.ctx.config.models)).length).toBeGreaterThan(0);
  });

  it("the usage API returns codenames, one item per task and model", async () => {
    const res = await s.api("GET", "/v3/workspaces/w/usage", undefined, key);
    expect(res.status).toBe(200);
    const usage = await res.json();
    const items = usage.items.map((i: { task: string; model: string; calls: number }) => [
      i.task,
      i.model,
      i.calls,
    ]);
    expect(items).toEqual([
      ["chat_low", "recall-lumen", 3],
      ["chat_minimal", "recall-loom", 1],
      ["embedding", "recall-embed", 1],
      ["reasoner", "recall-loom", 2],
      ["summary", "recall-loom", 1],
    ]);
    expect(usage.total.calls).toBe(8);
    const text = JSON.stringify(usage);
    expect(leaks(text)).toEqual([]);
    expect(text).not.toMatch(/openrouter|acme|deepseek|provider|cost_usd/i);
  });

  it("the account usage API names no model", async () => {
    const text = JSON.stringify(await (await s.api("GET", "/v3/usage", undefined, key)).json());
    expect(text).toContain('"calls":8');
    expect(leaks(text)).toEqual([]);
    expect(text).not.toMatch(/openrouter|acme|deepseek/i);
  });

  it("the dashboard and the data export show codenames", async () => {
    for (const path of ["/app", "/app/usage", "/app/billing", "/app/keys", "/app/settings"]) {
      const { res, html } = await browser.get(path);
      expect(res.status, path).toBe(200);
      expect(leaks(html), path).toEqual([]);
      expect(html, path).not.toMatch(/openrouter\/|acme\/|deepseek/i);
    }
    const exp = await browser.post("/app/settings/export");
    expect(exp.res.status).toBe(200);
    const data = JSON.parse(exp.html);
    expect(new Set(data.llm_usage.map((u: { model: string }) => u.model))).toEqual(
      new Set(["recall-lumen", "recall-loom", "recall-embed"]),
    );
    expect(data.llm_usage[0].provider).toBeUndefined();
    expect(leaks(exp.html)).toEqual([]);
    expect(exp.html).not.toMatch(/openrouter|acme|deepseek/i);
  });

  it("keeps the real ids in the database", async () => {
    const stored = await rows<{ model: string }>(
      s.ctx.db,
      sql`SELECT DISTINCT provider || '/' || model AS model FROM llm_usage WHERE account_id = ${accountId}`,
    );
    expect(stored.map((r) => r.model)).toContain(s.ctx.config.models.chat_low);
  });

  it("shows an experiment account the models it picked by their real names", async () => {
    await s.ctx.db.execute(
      sql`UPDATE accounts SET metadata = metadata || '{"answer_model_override": true}'::jsonb
          WHERE id = ${accountId}`,
    );
    try {
      const usage = await (await s.api("GET", "/v3/workspaces/w/usage", undefined, key)).json();
      const chat = usage.items
        .filter((i: { task: string }) => i.task === "chat_low")
        .map((i: { model: string; calls: number }) => [i.model, i.calls]);
      expect(chat).toEqual([
        ["recall-lumen", 2],
        ["openrouter/deepseek/deepseek-v4-flash", 1],
      ]);
      expect(leaks(JSON.stringify(usage))).toEqual([]);
      expect(JSON.stringify(usage)).not.toMatch(/acme|cost_usd|provider/i);
    } finally {
      await s.ctx.db.execute(
        sql`UPDATE accounts SET metadata = metadata - 'answer_model_override' WHERE id = ${accountId}`,
      );
    }
  });
});

describe("a self-hosted server", () => {
  it("shows its operator the real providers, models and cost", async () => {
    const plain = await createTestServer();
    try {
      expect((await plain.request("POST", "/v3/workspaces", { id: "w" })).status).toBe(201);
      const [ws] = await rows<{ id: string }>(
        plain.ctx.db,
        sql`SELECT id FROM workspaces WHERE name = 'w'`,
      );
      await plain.ctx.db.execute(
        sql`INSERT INTO llm_usage (workspace_id, task, provider, model, input_tokens, cost_usd)
            VALUES (${ws!.id}, 'chat_low', 'openrouter', 'acme/answer-large-1', 100, 0.001)`,
      );
      const usage = (await (await plain.request("GET", "/v3/workspaces/w/usage")).json()) as {
        items: unknown[];
      };
      expect(usage.items).toEqual([
        expect.objectContaining({
          task: "chat_low",
          provider: "openrouter",
          model: "acme/answer-large-1",
          cost_usd: 0.001,
        }),
      ]);
    } finally {
      await plain.close();
    }
  });
});
