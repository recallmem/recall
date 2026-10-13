import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests and the guide example (examples/guides) import the packages by name, as readers do.
    alias: {
      "@recall-memory/sdk": here("../sdk/src/index.ts"),
      "@recall-memory/ai-sdk": here("./src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
