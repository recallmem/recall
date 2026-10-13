import { createRequire } from "node:module";

/** The server package version. Read from package.json so `src/` and `dist/` agree. */
export const VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
