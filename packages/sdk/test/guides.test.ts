import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Recall } from "../src/index.js";
import { startTestServer, type TestServer } from "./harness.js";

/**
 * Every TypeScript sample in the guides (recallmem.dev/guides) runs here, end to end. The samples
 * of the framework guides have no Python twin; they run in their integration's own tests
 * (packages/ai-sdk, packages/langchain, packages/mastra), which have the framework installed.
 */
const DIR = fileURLToPath(new URL("../../../examples/guides/", import.meta.url));
const all = readdirSync(DIR);
const files = all.filter((f) => f.endsWith(".ts") && all.includes(f.replace(/\.ts$/, ".py")));

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

describe("guide examples", () => {
  it("exist", () => expect(files.length).toBeGreaterThan(0));
  for (const file of files) {
    it(file, async () => {
      const mod = (await import(`${DIR}${file}`)) as { main: (r: Recall) => Promise<unknown> };
      const workspaceId = `guide-${file.replace(/\.ts$/, "")}-${Math.random().toString(36).slice(2, 7)}`;
      const recall = new Recall({ baseURL: server.url, workspaceId, retryBaseDelay: 5 });
      expect(await mod.main(recall)).toBeDefined();
    }, 60_000);
  }
});
