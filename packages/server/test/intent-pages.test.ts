import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTestServer } from "./helpers.js";

/**
 * The pages for what people search for (scripts/site/pages.py): memory for Claude Code and Codex,
 * and one memory for ChatGPT and Claude. Their commands must be the ones the plugin READMEs and
 * the docs give, and their prices the configured ones.
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const usd = (micros: number) => {
  const s = String(Number((micros / 1e6).toFixed(4)));
  return `$${/\.\d$/.test(s) ? `${s}0` : s}`;
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'");

type Server = Awaited<ReturnType<typeof createTestServer>>;
let s: Server;
const pages = new Map<string, string>();
beforeAll(async () => {
  s = await createTestServer();
  for (const path of ["/claude-code-memory", "/chatgpt-claude-memory"]) {
    const res = await s.app.request(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("content-security-policy"), path).toContain("default-src 'none'");
    pages.set(path, await res.text());
  }
});
afterAll(() => s.close());

describe("intent pages", () => {
  it("give the install commands the plugin READMEs give", () => {
    const page = text(pages.get("/claude-code-memory")!);
    const claude = read("integrations/claude-code/README.md");
    const codex = read("integrations/codex/README.md");
    for (const cmd of [
      "/plugin marketplace add recallmem/recall-plugin",
      "/plugin install recall-memory@recall",
    ]) {
      expect(page, cmd).toContain(cmd);
      expect(claude, cmd).toContain(cmd);
    }
    for (const cmd of [
      "codex plugin marketplace add recallmem/recall-plugin",
      "codex plugin add recall-memory@recall",
    ]) {
      expect(page, cmd).toContain(cmd);
      expect(codex, cmd).toContain(cmd);
    }
  });

  it("give the MCP URL and connect steps the docs give", async () => {
    const page = text(pages.get("/chatgpt-claude-memory")!);
    const docs = text(await (await s.app.request("/docs")).text());
    const add = "claude mcp add --transport http recall https://api.recallmem.dev/mcp";
    expect(page).toContain(add);
    expect(docs.replace(/recallmem\.dev \/mcp/g, "recallmem.dev/mcp")).toContain(add);
    for (const step of ["Add custom connector", "developer mode", "Apps & Connectors"]) {
      expect(page, step).toContain(step);
      expect(docs, step).toContain(step);
    }
    expect(pages.get("/chatgpt-claude-memory")).toContain('href="/claude-code-memory"');
  });

  it("quote the configured prices", () => {
    const { prices, signupCreditMicros } = loadConfig({ RECALL_DATA_DIR: "memory" }).hosted.billing;
    const code = pages.get("/claude-code-memory")!;
    expect(code).toContain(`${usd(prices.ingestPerMTokMicros)} per million tokens`);
    expect(code).toContain(`${usd(signupCreditMicros)} of credit`);
    // 200 messages of 300 tokens (above the per-message minimum), learned once.
    const day = (200 * Math.max(300, prices.ingestMinTokens) * prices.ingestPerMTokMicros) / 1e12;
    expect(code).toContain(`comes to about $${day.toFixed(2)}`);
    const shared = pages.get("/chatgpt-claude-memory")!;
    expect(shared).toContain(`costs ${usd(prices.chatMicros.low)} at the default level`);
    expect(shared).toContain(`${usd(signupCreditMicros)} of credit`);
  });

  it("are routed on the CDN and listed in llms.txt", async () => {
    const vercel = JSON.parse(read("packages/server/vercel.json")) as {
      headers: { source: string }[];
    };
    const route = vercel.headers.map((r) => r.source).find((r) => r.startsWith("/:page("));
    expect(route).toMatch(/[(|]claude-code-memory[|)]/);
    expect(route).toMatch(/[(|]chatgpt-claude-memory[|)]/);
    const llms = await (await s.app.request("/llms.txt")).text();
    expect(llms).toContain("(https://recallmem.dev/claude-code-memory)");
    expect(llms).toContain("(https://recallmem.dev/chatgpt-claude-memory)");
  });
});
