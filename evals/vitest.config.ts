import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Run against the server's sources so tests do not need `pnpm build` first.
      "@recall-memory/server": fileURLToPath(
        new URL("../packages/server/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
