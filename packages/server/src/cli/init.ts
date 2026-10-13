import { chmodSync, existsSync } from "node:fs";
import { createApi } from "./client.js";
import { CliError, type CliIo, checkId, intOption, parse, UsageError } from "./common.js";
import { keyValues, reportError, wantsJson } from "./output.js";
import {
  DEFAULT_URL,
  DEFAULT_WORKSPACE,
  isHostedUrl,
  KEYS_URL,
  redactKey,
  resolveSettings,
  saveConfigFile,
} from "./settings.js";

export const INIT_USAGE = `Usage: recall init [options]

Saves how to reach Recall to ~/.recall/config.json (mode 600) so every other
command, and the Claude Code plugin, find it without flags. On a terminal it asks
for anything not given; otherwise flags and environment variables are used as-is.
It checks the server and the key first, and writes nothing if the check fails.

Options:
      --url <url>           Server base URL (default ${DEFAULT_URL}, the hosted service;
                            your own server: http://localhost:8000)             [RECALL_URL]
      --api-key <key>       API key, e.g. pk_live_... Hosted: create one at ${KEYS_URL}.
                            Leave out for a server of your own without auth    [RECALL_API_KEY]
  -w, --workspace <id>      Default workspace (default "${DEFAULT_WORKSPACE}")   [RECALL_WORKSPACE_ID]
  -p, --peer <id>           Default peer: you, as the server knows you         [RECALL_PEER_ID]
      --no-check            Skip the connection check
      --force               Write the file even if the check fails
      --timeout <ms>        Check timeout (default 10000)
      --json                Machine-readable output`;

export const CONFIG_USAGE = `Usage: recall config [options]

Shows the settings other commands would use and where each came from. The API key
is never printed in full.

Options:
      --url <url>  --api-key <key>  -w <workspace>  -p <peer>  -s <session>
                            Show the result of overriding these
      --json                Machine-readable output`;

export async function init(args: string[], io: CliIo): Promise<number> {
  const { values } = parse(args, {
    url: { type: "string" },
    "api-key": { type: "string" },
    workspace: { type: "string", short: "w" },
    peer: { type: "string", short: "p" },
    "no-check": { type: "boolean" },
    force: { type: "boolean" },
    timeout: { type: "string" },
    json: { type: "boolean" },
  });
  if (values.help) {
    io.out(INIT_USAGE);
    return 0;
  }
  const json = wantsJson(values.json, io.env);
  const timeout = intOption("--timeout", values.timeout, 10_000, 1, 600_000);
  const current = resolveSettings(io.env, {
    url: values.url,
    apiKey: values["api-key"],
    workspace: checkId("--workspace", values.workspace),
    peer: checkId("--peer", values.peer),
  });
  let url = current.url;
  let apiKey = current.apiKey;
  let workspace = current.workspace;
  let peer = current.peer;

  if (io.prompt && !json) {
    const ask = async (label: string, def: string | undefined, secret = false) => {
      const shown = secret ? (def ? `${redactKey(def)}` : "") : (def ?? "");
      const answer = await io.prompt!(`${label}${shown ? ` [${shown}]` : ""}: `, { secret });
      return answer || def;
    };
    if (!values.url) url = (await ask("Server URL", url))!;
    if (!values["api-key"]) {
      const label = isHostedUrl(url)
        ? `API key (create one at ${KEYS_URL})`
        : "API key (blank for none)";
      apiKey = await ask(label, apiKey, true);
    }
    if (!values.workspace) workspace = (await ask("Default workspace", workspace))!;
    if (!values.peer) peer = await ask("Your peer id (blank to skip)", peer);
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new UsageError(`--url must be an http(s) URL (got "${url}")`);
  }
  checkId("workspace", workspace);
  checkId("peer", peer);
  url = url.replace(/\/+$/, "");

  const checks: { check: string; ok: boolean; detail: string }[] = [];
  if (!values["no-check"]) {
    const api = createApi(
      { ...current, url, apiKey, workspace, sources: current.sources },
      io,
      timeout,
    );
    try {
      await api.call("GET", "/health");
      checks.push({ check: "server", ok: true, detail: `${url} is healthy` });
      await api.call("POST", api.ws("/peers/list"), { query: { size: 1 }, body: {} });
      checks.push({
        check: "credentials",
        ok: true,
        detail: apiKey ? "the key is accepted" : "the server accepts requests without a key",
      });
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      checks.push({
        check: checks.length === 0 ? "server" : "credentials",
        ok: false,
        detail: err.message,
      });
    }
  }
  const failed = checks.find((c) => !c.ok);
  if (failed && !values.force) {
    const err = new CliError(
      "CHECK_FAILED",
      `${failed.detail} Nothing was written; fix that, or use --force to write anyway.`,
      { checks },
    );
    reportError(io, "init", err, json);
    return 1;
  }

  const path = saveConfigFile(io.env, { url, apiKey, workspace, peer });
  if (existsSync(path)) chmodSync(path, 0o600);
  if (json) {
    io.out(
      JSON.stringify(
        { path, url, workspace, peer: peer ?? null, api_key: redactKey(apiKey), checks },
        null,
        2,
      ),
    );
  } else {
    for (const c of checks) io.out(`${c.ok ? "ok  " : "FAIL"} ${c.check}: ${c.detail}`);
    io.out(`Wrote ${path} (mode 600)`);
    io.out(
      keyValues([
        ["url", url],
        ["api key", redactKey(apiKey) ?? "(none)"],
        ["workspace", workspace],
        ["peer", peer ?? "(none)"],
      ]),
    );
    if (!apiKey && isHostedUrl(url)) {
      io.out(
        `\nNo API key yet: the hosted service needs one. Create it at ${KEYS_URL}, then run "recall init --api-key <key>".`,
      );
    }
    io.out('\nTry: recall peer list     (or "recall doctor --url ' + url + '")');
  }
  return 0;
}

export async function configCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parse(args, {
    url: { type: "string" },
    "api-key": { type: "string" },
    workspace: { type: "string", short: "w" },
    peer: { type: "string", short: "p" },
    session: { type: "string", short: "s" },
    json: { type: "boolean" },
  });
  if (values.help) {
    io.out(CONFIG_USAGE);
    return 0;
  }
  const s = resolveSettings(io.env, {
    url: values.url,
    apiKey: values["api-key"],
    workspace: checkId("--workspace", values.workspace),
    peer: checkId("--peer", values.peer),
    session: checkId("--session", values.session),
  });
  const shown = {
    url: s.url,
    api_key: redactKey(s.apiKey),
    workspace: s.workspace,
    peer: s.peer ?? null,
    session: s.session ?? null,
    config_path: s.configPath,
    sources: s.sources,
  };
  if (wantsJson(values.json, io.env)) {
    io.out(JSON.stringify(shown, null, 2));
    return 0;
  }
  io.out(
    keyValues([
      ["url", `${s.url}  (${s.sources.url})`],
      ["api key", `${shown.api_key ?? "(none)"}  (${s.sources.apiKey})`],
      ["workspace", `${s.workspace}  (${s.sources.workspace})`],
      ["peer", `${s.peer ?? "(none)"}  (${s.sources.peer})`],
      ["session", `${s.session ?? "(none)"}  (${s.sources.session})`],
      ["config file", s.configPath ?? "(none found)"],
    ]),
  );
  return 0;
}
