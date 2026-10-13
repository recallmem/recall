#!/usr/bin/env node
// Stdio MCP server that forwards every JSON-RPC message to Recall's /mcp endpoint.
// It exists so the server's URL, API key, workspace and user come from the user's
// Recall config (~/.recall/config.json) or environment, not from the agent's
// config files. Recall's MCP endpoint is stateless, so forwarding is all there is to it.

import { createInterface } from "node:readline";
import { HOST_INFO } from "./host.mjs";
import { HOST, loadSettings, PLUGIN_VERSION } from "./lib.mjs";

const settings = loadSettings();
const endpoint = `${settings.url}/mcp`;
const timeoutMs =
  Number(process.env.RECALL_MCP_TIMEOUT_MS) > 0
    ? Number(process.env.RECALL_MCP_TIMEOUT_MS)
    : 120_000;

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "user-agent": `recall-${HOST}-plugin/${PLUGIN_VERSION}`,
  "x-recall-workspace-id": settings.workspace,
  "x-recall-user-name": settings.peer,
};
if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
if (settings.mcpProfile && settings.mcpProfile !== "default")
  headers["x-recall-mcp-profile"] = settings.mcpProfile;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const isRequest = (m) => m && typeof m === "object" && "id" in m && "method" in m;

/** Answers a request that could not be forwarded; a notification has nobody to tell. */
function fail(message, text) {
  process.stderr.write(`[recall] ${text}\n`);
  if (isRequest(message))
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
}

/** The JSON-RPC messages in a response body, whether plain JSON or an event stream. */
function replies(text, contentType) {
  if (!contentType.includes("text/event-stream")) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

async function forward(message) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 202 || res.status === 204) return;
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const d = JSON.parse(text).detail;
        if (typeof d === "string") detail = d;
      } catch {}
      const hint = res.status === 401 ? ` ${HOST_INFO.keyHint}` : "";
      return fail(message, `Recall answered HTTP ${res.status} at ${endpoint}: ${detail}.${hint}`);
    }
    for (const reply of replies(text, res.headers.get("content-type") ?? "")) send(reply);
  } catch (err) {
    const why =
      err?.name === "TimeoutError"
        ? `no answer within ${timeoutMs} ms`
        : (err?.cause?.code ?? err?.message ?? String(err));
    fail(message, `Could not reach Recall at ${endpoint} (${why}). Is the server running?`);
  }
}

const pending = new Set();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const task = forward(message).finally(() => pending.delete(task));
  pending.add(task);
});
lines.on("close", async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
