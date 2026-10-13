#!/usr/bin/env node
// Recall from the command line, for agents that have no Recall MCP tools.
// Node 18+, no dependencies. Run with --help for the commands.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HELP = `Usage: node recall.mjs <command> [arguments] [options]

Commands
  status                       Settings in use, and whether the server answers
  context [--query TEXT]       What memory knows about the user (peer card and facts),
                               focused on TEXT when given
  ask "QUESTION" [--level L]   Answer a question from memory (L: minimal, low, medium, high, max)
  search "QUERY" [--limit N]   Facts (with ids) and past messages that match
  remember "FACT" ["FACT" ...] Save facts the user stated outright
  forget ID                    Delete one saved fact by its id
  record --session ID [--user TEXT] [--assistant TEXT]
                               Store one exchange of a conversation. Alternatively pipe
                               {"messages":[{"role":"user"|"assistant","content":"..."}]} on stdin

Options
  --url URL  --api-key KEY  --workspace ID  --peer ID   override the settings
  --assistant-peer ID          peer for assistant messages in record (default: assistant)
  --json                       print the server's JSON instead of text

Settings come from RECALL_URL, RECALL_API_KEY, RECALL_WORKSPACE_ID and RECALL_PEER_ID,
then ~/.recall/config.json ({"url", "apiKey", "workspace", "peer"}; \`recall init\` writes it).`;

const MAX_CHARS = 24_000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const safeId = (v, fallback) =>
  String(v ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || fallback;

function readConfigFile(env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const paths = [
    env.RECALL_CONFIG_PATH || join(env.RECALL_CONFIG_DIR || join(home, ".recall"), "config.json"),
  ];
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    } catch {
      // An unreadable file is treated as absent.
    }
  }
  return {};
}

function settings(flags, env = process.env) {
  const file = readConfigFile(env);
  const expand = (v) => {
    const m = typeof v === "string" ? v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) : null;
    return m ? str(env[m[1]]) : str(v);
  };
  const user = (() => {
    try {
      return env.USER || env.USERNAME || userInfo().username;
    } catch {
      return "user";
    }
  })();
  const url =
    str(flags.url) ??
    str(env.RECALL_URL) ??
    str(file.url ?? file.baseUrl ?? file.environmentUrl) ??
    "https://api.recallmem.dev";
  return {
    url: url.replace(/\/+$/, ""),
    apiKey:
      str(flags["api-key"]) ?? str(env.RECALL_API_KEY) ?? expand(file.apiKey ?? file.auth?.apiKey),
    workspace: safeId(
      str(flags.workspace) ??
        str(env.RECALL_WORKSPACE_ID) ??
        str(file.workspace ?? file.workspaceId),
      "default",
    ),
    peer: safeId(
      str(flags.peer) ?? str(env.RECALL_PEER_ID) ?? str(file.peer ?? file.peerName) ?? user,
      "user",
    ),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class RecallError extends Error {}

async function call(s, method, path, body, headers = {}) {
  const h = { accept: "application/json", "user-agent": "recall-agent-skill/0.1.0", ...headers };
  if (s.apiKey) h.authorization = `Bearer ${s.apiKey}`;
  if (body !== undefined) h["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`${s.url}${path}`, {
      method,
      headers: h,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const why = err?.name === "TimeoutError" ? "timed out" : (err?.cause?.code ?? err?.message);
    throw new RecallError(`Could not reach Recall at ${s.url} (${why}). Check RECALL_URL.`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json };
}

function failure(res) {
  const detail = typeof res.json?.detail === "string" ? res.json.detail : JSON.stringify(res.json);
  const hint = res.status === 401 ? " Check RECALL_API_KEY." : "";
  return new RecallError(`Recall answered HTTP ${res.status}: ${detail}.${hint}`);
}

async function must(s, method, path, body, headers) {
  const res = await call(s, method, path, body, headers);
  if (res.status >= 200 && res.status < 300) return res.json;
  throw failure(res);
}

const ws = (s, path = "") => `/v3/workspaces/${encodeURIComponent(s.workspace)}${path}`;
const peerPath = (s, path = "") => ws(s, `/peers/${encodeURIComponent(s.peer)}${path}`);

async function ensurePeer(s, id) {
  await must(s, "POST", ws(s, "/peers"), { id });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function status(s) {
  const health = await call(s, "GET", "/health");
  const lines = [
    `server     ${s.url}`,
    `api key    ${s.apiKey ? `…${s.apiKey.slice(-4)}` : "(none)"}`,
    `workspace  ${s.workspace}`,
    `peer       ${s.peer}`,
    `health     ${health.status === 200 ? "ok" : `FAILED (HTTP ${health.status})`}`,
  ];
  if (health.status === 200) {
    const auth = await call(s, "POST", `${ws(s, "/peers/list")}?size=1`, {});
    lines.push(`access     ${auth.status === 200 ? "accepted" : `REJECTED (HTTP ${auth.status})`}`);
  }
  return { json: { ...s, apiKey: s.apiKey ? "set" : null, health: health.status }, text: lines };
}

async function context(s, flags) {
  const q = new URLSearchParams({ max_conclusions: "40", include_most_frequent: "true" });
  if (str(flags.query)) q.set("search_query", flags.query.slice(0, 500));
  const res = await call(s, "GET", `${peerPath(s, "/context")}?${q}`);
  if (res.status === 404) return { json: null, text: [`Memory has nothing about ${s.peer} yet.`] };
  if (res.status !== 200) throw failure(res);
  const card = Array.isArray(res.json?.peer_card) ? res.json.peer_card : [];
  const representation = str(res.json?.representation) ?? "";
  if (!card.length && !representation) {
    return { json: res.json, text: [`Memory has nothing about ${s.peer} yet.`] };
  }
  const text = [`What Recall knows about ${s.peer} (may be incomplete or out of date):`];
  if (card.length) text.push("", "Peer card:", ...card.map((l) => `- ${l}`));
  if (representation) text.push("", "Facts:", representation);
  return { json: res.json, text };
}

async function ask(s, flags, args) {
  const query = args.join(" ").trim();
  if (!query) throw new RecallError('ask needs a question, e.g. ask "Where does the user live?"');
  const res = await call(s, "POST", peerPath(s, "/chat"), {
    query,
    reasoning_level: flags.level ?? "low",
  });
  // A workspace or person memory has never seen answers 404: there is nothing to ask yet.
  if (res.status === 404) return { json: null, text: [`Memory has nothing about ${s.peer} yet.`] };
  if (res.status !== 200) throw failure(res);
  return { json: res.json, text: [str(res.json?.content) ?? "Memory has no answer to that."] };
}

async function search(s, flags, args) {
  const query = args.join(" ").trim();
  if (!query) throw new RecallError('search needs a query, e.g. search "coffee"');
  const limit = Math.min(Math.max(Number(flags.limit) || 8, 1), 50);
  const facts = await call(s, "POST", ws(s, "/conclusions/query"), {
    query,
    top_k: limit,
    filters: { observer_id: s.peer, observed_id: s.peer },
  });
  const messages = await call(s, "POST", ws(s, "/search"), { query, limit });
  const factList = facts.status === 200 && Array.isArray(facts.json) ? facts.json : [];
  const messageList = messages.status === 200 && Array.isArray(messages.json) ? messages.json : [];
  for (const res of [facts, messages]) if (res.status === 401) throw failure(res);
  const text = [];
  text.push(factList.length ? "Facts:" : "Facts: none found.");
  for (const f of factList) text.push(`- [${f.id}] ${f.content}`);
  text.push("", messageList.length ? "Messages:" : "Messages: none found.");
  for (const m of messageList) {
    const when = typeof m.created_at === "string" ? m.created_at.slice(0, 10) : "";
    text.push(
      `- ${when} ${m.peer_id} (session ${m.session_id}): ${String(m.content).slice(0, 300)}`,
    );
  }
  return { json: { conclusions: factList, messages: messageList }, text };
}

async function remember(s, _flags, args) {
  const facts = args.map((a) => a.trim()).filter(Boolean);
  if (!facts.length)
    throw new RecallError('remember needs at least one fact, e.g. remember "Prefers tea"');
  await ensurePeer(s, s.peer);
  const created = await must(s, "POST", ws(s, "/conclusions"), {
    conclusions: facts.map((content) => ({ content, observer_id: s.peer, observed_id: s.peer })),
  });
  return {
    json: created,
    text: created.map((c) => `Saved [${c.id}] ${c.content}`),
  };
}

async function forget(s, _flags, args) {
  const id = args[0];
  if (!id) throw new RecallError("forget needs the id of a fact (search shows ids)");
  await must(s, "DELETE", ws(s, `/conclusions/${encodeURIComponent(id)}`));
  return { json: { deleted: id }, text: [`Deleted ${id}.`] };
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function record(s, flags) {
  const session = str(flags.session);
  if (!session) throw new RecallError("record needs --session ID (one stable id per conversation)");
  const assistant = safeId(flags["assistant-peer"], "assistant");
  let messages = [];
  if (str(flags.user)) messages.push({ role: "user", content: flags.user });
  if (str(flags.assistant)) messages.push({ role: "assistant", content: flags.assistant });
  if (!messages.length) {
    const input = await readStdin();
    if (input) {
      try {
        const parsed = JSON.parse(input);
        messages = Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
      } catch {
        throw new RecallError('stdin must be JSON: {"messages":[{"role":"user","content":"..."}]}');
      }
    }
  }
  messages = messages
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .map((m) => ({
      peer_id: m.peer_id ?? (m.role === "assistant" ? assistant : s.peer),
      content: m.content.length > MAX_CHARS ? m.content.slice(0, MAX_CHARS) : m.content,
    }));
  if (!messages.length) throw new RecallError("record needs --user and/or --assistant text");
  const sessionId = safeId(session, "session");
  await must(s, "POST", ws(s, "/sessions"), {
    id: sessionId,
    peers: {
      [s.peer]: { observe_me: true, observe_others: false },
      [assistant]: { observe_me: false, observe_others: false },
    },
  });
  const key = createHash("sha256")
    .update(JSON.stringify([s.workspace, sessionId, messages]))
    .digest("hex")
    .slice(0, 40);
  const stored = await must(
    s,
    "POST",
    ws(s, `/sessions/${encodeURIComponent(sessionId)}/messages`),
    { messages },
    { "idempotency-key": `skill-${key}` },
  );
  return {
    json: stored,
    text: [`Recorded ${stored.length} message(s) in session ${sessionId}.`],
  };
}

const COMMANDS = { status, context, ask, search, remember, forget, record };

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "api-key": { type: "string" },
      workspace: { type: "string" },
      peer: { type: "string" },
      "assistant-peer": { type: "string" },
      query: { type: "string" },
      level: { type: "string" },
      limit: { type: "string" },
      session: { type: "string" },
      user: { type: "string" },
      assistant: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [name, ...args] = positionals;
  if (flags.help || !name) {
    console.log(HELP);
    return name || flags.help ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command "${name}". Run with --help.`);
    return 2;
  }
  const s = settings(flags, env);
  const result = await command(s, flags, args);
  console.log(flags.json ? JSON.stringify(result.json, null, 2) : result.text.join("\n"));
  return name === "status" && result.json?.health !== 200 ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  const known = err instanceof RecallError || String(err?.code).startsWith("ERR_PARSE_ARGS");
  console.error(known ? `Error: ${err.message}` : err);
  process.exitCode = 1;
}
