#!/usr/bin/env node
// Prints the settings the hooks use and whether Recall answers.
//   node scripts/status.mjs

import { HOST, loadSettings, request } from "./lib.mjs";

const s = loadSettings();
const key = s.apiKey
  ? `${s.apiKey.match(/^[a-z]{2}_(?:live|test)_/)?.[0] ?? ""}…${s.apiKey.slice(-4)}`
  : "(none)";
const lines = [
  `agent           ${HOST}`,
  `enabled         ${s.enabled}`,
  `server          ${s.url}`,
  `api key         ${key}`,
  `workspace       ${s.workspace}`,
  `user peer       ${s.peer}`,
  `assistant peer  ${s.assistantPeer}`,
  `sessions        ${s.sessionStrategy}`,
  `record / lookup ${s.record} / ${s.lookup}`,
  `mcp profile     ${s.mcpProfile}`,
  `config file     ${s.configPath ?? "(none found)"}`,
];
console.log(lines.join("\n"));

const health = await request(s, "GET", "/health", { timeoutMs: 5000 });
console.log(
  `\nhealth          ${health.status === 200 ? "ok" : `FAILED (${health.error ?? `HTTP ${health.status}`})`}`,
);
if (health.status === 200) {
  const auth = await request(
    s,
    "POST",
    `/v3/workspaces/${encodeURIComponent(s.workspace)}/peers/list?size=1`,
    { body: {}, timeoutMs: 5000 },
  );
  console.log(
    `credentials     ${auth.status === 200 ? "accepted" : `REJECTED (HTTP ${auth.status})`}`,
  );
  const queue = await request(
    s,
    "GET",
    `/v3/workspaces/${encodeURIComponent(s.workspace)}/queue/status`,
    { timeoutMs: 5000 },
  );
  if (queue.status === 200) {
    console.log(
      `background     ${queue.json.pending_work_units} pending, ${queue.json.in_progress_work_units} running, ${queue.json.completed_work_units} done`,
    );
  }
}
process.exit(health.status === 200 ? 0 : 1);
