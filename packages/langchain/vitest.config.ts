import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests and the guide example (examples/guides) import the packages by name, as readers do.
    alias: [
      { find: /^@recall-memory\/sdk$/, replacement: here("../sdk/src/index.ts") },
      { find: /^@recall-memory\/langchain\/middleware$/, replacement: here("./src/middleware.ts") },
      { find: /^@recall-memory\/langchain$/, replacement: here("./src/index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
