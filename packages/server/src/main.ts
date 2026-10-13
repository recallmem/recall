#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startRecall, stopOnSignals } from "./serve.js";

// `recall-server [all|api|worker]`: the optional argument sets RECALL_ROLE, so one
// image can run as separate process groups (e.g. Fly.io `[processes]`).
const role = process.argv[2];
if (role !== undefined && !["all", "api", "worker"].includes(role)) {
  process.stderr.write(`recall-server: unknown role "${role}" (use all, api or worker)\n`);
  process.exit(2);
}
stopOnSignals(
  await startRecall(loadConfig(role ? { ...process.env, RECALL_ROLE: role } : process.env)),
);
