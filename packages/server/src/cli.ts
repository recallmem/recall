#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createApi } from "./cli/client.js";
import { CliError, type CliIo, checkId, parse, UsageError } from "./cli/common.js";
import { configCommand, init } from "./cli/init.js";
import { reportError, wantsJson } from "./cli/output.js";
import { terminalPrompt } from "./cli/prompt.js";
import { runGroup } from "./cli/resources.js";
import { redactKey, resolveSettings } from "./cli/settings.js";
import { type Config, loadConfig } from "./config.js";
import { signToken } from "./http/auth.js";
import { VERSION } from "./version.js";

export type { CliIo } from "./cli/common.js";

/**
 * The `recall` command. Dependency-free (node:util parseArgs).
 *
 *   recall start    run the server (API + background worker)
 *   recall token    mint a JWT for the API, signed with RECALL_AUTH_SECRET
 *   recall doctor   show the resolved configuration and check a running server
 *   recall accounts create|list            manage hosted accounts (tenants)
 *   recall keys create|list|revoke         manage customer API keys
 *   recall init     save the server URL, key and defaults to ~/.recall/config.json
 *   recall config   show the settings the commands below would use
 *   recall workspace|peer|session|scope|message|conclusion|queue ...   look at and edit memory (see src/cli/)
 */

const defaultIo = (): CliIo => ({
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
  env: process.env,
  fetch: (...args) => fetch(...args),
  ...(process.stdin.isTTY && process.stderr.isTTY ? { prompt: terminalPrompt() } : {}),
});

const USAGE = `recall ${VERSION} - reasoning memory for AI agents

Usage: recall <command> [options]

Commands:
  start     Run the Recall server (API and background worker)
  token     Mint an API token (JWT) signed with RECALL_AUTH_SECRET
  doctor    Print the resolved configuration and check a running server
  accounts  Hosted mode: create or list customer accounts      (accounts create|list)
  keys      Hosted mode: create, list or revoke API keys        (keys create|list|revoke)

Using a server (set up once with "recall init"):
  init        Save the server URL, API key and default workspace/peer to ~/.recall/config.json
  config      Show the settings in effect and where each came from
  workspace   list | create | inspect | delete | chat | search | queue-status
  peer        list | create | inspect | card | chat | search | representation
              | get-metadata | set-metadata | dream | delete
  session     list | create | inspect | messages (view) | context | summaries | search
              | representation | peers | add-peers | remove-peers | get-metadata
              | set-metadata | upload | delete
  scope       list | create | inspect | sessions | status | add-sessions | remove-session
  message     list | create | get
  conclusion  list | search | get | derived | create | delete
  queue       status                        what is still being learned

These read RECALL_URL / RECALL_API_KEY / RECALL_WORKSPACE_ID / RECALL_PEER_ID, then
~/.recall/config.json. Every one takes --json.

Run "recall <command> --help" for a command's options.
Options: -h, --help   -v, --version`;

const START_USAGE = `Usage: recall start [options]

Runs the server. With no configuration it uses embedded Postgres in ./.recall and
an offline mock model, so it works with no keys and no Docker.

Options:
  -p, --port <n>          Port to listen on (default 8000)          [RECALL_PORT]
      --host <addr>       Address to bind (default 0.0.0.0)         [RECALL_HOST]
  -d, --data-dir <dir>    Where embedded Postgres keeps data; "memory" for none
                                                                    [RECALL_DATA_DIR]
      --database-url <u>  Use this Postgres instead of embedded     [RECALL_DATABASE_URL]
      --role <r>          all | api | worker (default all)          [RECALL_ROLE]
      --log-level <l>     fatal|error|warn|info|debug|trace|silent  [RECALL_LOG_LEVEL]

Everything else (provider keys, models, auth) is read from the environment;
run "recall doctor" to see what the server would use.`;

const TOKEN_USAGE = `Usage: recall token [options]

Prints a signed JWT. The server must run with RECALL_AUTH_ENABLED=true and the
same RECALL_AUTH_SECRET. Send it as "Authorization: Bearer <token>" (REST, MCP)
or as the SDK's apiKey.

Options:
      --admin               Full access to every workspace
  -w, --workspace <id>      Limit to one workspace
  -p, --peer <id>           Limit to one peer in that workspace
  -s, --session <id>        Limit to one session in that workspace
      --expires <when>      Expiry: 30m, 12h, 7d, 4w, a number of seconds, or an ISO date
                            (default: never)
      --secret <secret>     Signing secret (default: $RECALL_AUTH_SECRET)
      --json                Print {token, claims, expires_at} instead of the bare token

Use exactly one of --admin or --workspace (optionally with --peer / --session).`;

const DOCTOR_USAGE = `Usage: recall doctor [options]

Prints the configuration the server would start with (secrets are never shown):
database, provider keys, and the model each task routes to. With --url it also
checks the running server as a client would: /health, the API key, the
workspace and its background queue, and the peer (when one is set). Exits 1 if
a check fails.

Options:
      --url <url>           Server to check (default: $RECALL_URL; skipped if unset).
                            Hosted: https://api.recallmem.dev; your own: http://localhost:8000
      --api-key <key>       API key to check with (default: $RECALL_API_KEY, ~/.recall/config.json);
                            hosted keys come from https://app.recallmem.dev/keys
  -w, --workspace <id>      Workspace to check (default: $RECALL_WORKSPACE_ID, the config file,
                            "default"); a workspace you name must exist
  -p, --peer <id>           Peer to check (default: $RECALL_PEER_ID, the config file)
      --timeout <ms>        Timeout per request (default 5000)
      --json                Machine-readable output`;

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** `30m`, `12h`, `7d`, `4w`, plain seconds, or an ISO date -> epoch seconds. */
export function parseExpiry(value: string, now = Date.now()): number {
  const unit = value.match(/^(\d+)\s*([smhdw])$/i);
  if (unit) {
    const seconds = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }[unit[2]!.toLowerCase()]!;
    return Math.floor(now / 1000) + Number(unit[1]) * seconds;
  }
  if (/^\d+$/.test(value)) return Math.floor(now / 1000) + Number(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(
      `--expires "${value}" is not a duration (30m, 12h, 7d), a number of seconds, or an ISO date`,
    );
  }
  return Math.floor(date.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function start(args: string[], io: CliIo): Promise<number | null> {
  const { values } = parse(args, {
    port: { type: "string", short: "p" },
    host: { type: "string" },
    "data-dir": { type: "string", short: "d" },
    "database-url": { type: "string" },
    role: { type: "string" },
    "log-level": { type: "string" },
  });
  if (values.help) {
    io.out(START_USAGE);
    return 0;
  }
  const overrides: Record<string, string> = {};
  const set = (key: string, value: string | boolean | undefined) => {
    if (typeof value === "string") overrides[key] = value;
  };
  if (typeof values.port === "string") {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new UsageError(`--port must be an integer from 0 to 65535 (got "${values.port}")`);
    }
    overrides.RECALL_PORT = String(port);
  }
  set("RECALL_HOST", values.host);
  set("RECALL_DATA_DIR", values["data-dir"]);
  set("RECALL_DATABASE_URL", values["database-url"]);
  set("RECALL_ROLE", values.role);
  set("RECALL_LOG_LEVEL", values["log-level"]);

  const config = loadConfigOrExplain({ ...io.env, ...overrides });
  // Loaded on demand so `token` and `doctor` start fast.
  const { startRecall, stopOnSignals } = await import("./serve.js");
  const running = await startRecall(config);
  stopOnSignals(running);

  const shown = displayHost(config.server.host);
  if (running.port !== null) {
    const base = `http://${shown}:${running.port}`;
    io.out(`Recall ${VERSION} listening on ${base}`);
    io.out(`  api       ${base}/v3   (Honcho-compatible)`);
    io.out(`  mcp       ${base}/mcp`);
  } else {
    io.out(`Recall ${VERSION} worker running (no HTTP listener)`);
  }
  for (const line of summaryLines(config)) io.out(`  ${line}`);
  if (running.port !== null)
    io.out(`\nCheck it: recall doctor --url http://${shown}:${running.port}`);
  return null; // keep running until a signal
}

const displayHost = (host: string) => (host === "0.0.0.0" || host === "::" ? "localhost" : host);

function loadConfigOrExplain(env: Record<string, string | undefined>): Config {
  try {
    return loadConfig(env);
  } catch (err) {
    throw new UsageError(`Invalid configuration: ${configErrorText(err)}`);
  }
}

function configErrorText(err: unknown): string {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (Array.isArray(issues)) {
    return issues.map((i) => `${i.path.map(String).join(".") || "(env)"}: ${i.message}`).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Shared description of a configuration (start banner and doctor)
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { name: "anthropic", key: "ANTHROPIC_API_KEY" },
  { name: "openai", key: "OPENAI_API_KEY" },
  { name: "gemini", key: "GEMINI_API_KEY" },
  { name: "openrouter", key: "OPENROUTER_API_KEY" },
  { name: "groq", key: "GROQ_API_KEY" },
  { name: "deepseek", key: "DEEPSEEK_API_KEY" },
  { name: "compat", key: "RECALL_COMPAT_BASE_URL" },
] as const;

function providerPresence(config: Config): Record<string, boolean> {
  const env = config.env as unknown as Record<string, unknown>;
  return Object.fromEntries(PROVIDERS.map((p) => [p.name, Boolean(env[p.key])]));
}

/** Masks credentials in a connection string. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable url)";
  }
}

function databaseText(config: Config): string {
  if (config.database.kind === "postgres") return `Postgres ${redactUrl(config.database.url)}`;
  return config.database.dataDir
    ? `embedded Postgres (PGlite) in ${config.database.dataDir}`
    : "embedded Postgres (PGlite), in memory - data is lost on exit";
}

function summaryLines(config: Config): string[] {
  const present = providerPresence(config);
  const keyed = Object.keys(present).filter((p) => present[p]);
  return [
    `database  ${databaseText(config)}`,
    `models    ${keyed.length ? `keys for ${keyed.join(", ")}` : "offline mock (no provider key set)"}`,
    `auth      ${config.auth.enabled ? "enabled (bearer tokens required)" : "disabled (open access)"}`,
  ];
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

async function token(args: string[], io: CliIo): Promise<number> {
  const { values } = parse(args, {
    admin: { type: "boolean" },
    workspace: { type: "string", short: "w" },
    peer: { type: "string", short: "p" },
    session: { type: "string", short: "s" },
    expires: { type: "string" },
    secret: { type: "string" },
    json: { type: "boolean" },
  });
  if (values.help) {
    io.out(TOKEN_USAGE);
    return 0;
  }
  const secret = values.secret ?? io.env.RECALL_AUTH_SECRET;
  if (!secret) {
    throw new UsageError(
      "No signing secret: set RECALL_AUTH_SECRET (the same value the server runs with) or pass --secret",
    );
  }
  const workspace = checkId("--workspace", values.workspace);
  const peer = checkId("--peer", values.peer);
  const session = checkId("--session", values.session);
  if (values.admin) {
    if (workspace || peer || session) {
      throw new UsageError("--admin cannot be combined with --workspace, --peer or --session");
    }
  } else if (!workspace) {
    throw new UsageError(
      peer || session
        ? "--peer and --session need --workspace"
        : "Choose the token's scope: --admin, or --workspace <id> (optionally with --peer / --session)",
    );
  }
  const exp = values.expires ? parseExpiry(values.expires) : undefined;
  if (exp !== undefined && exp * 1000 <= Date.now()) {
    throw new UsageError("--expires is in the past");
  }

  const claims = {
    t: new Date().toISOString(),
    ...(exp === undefined ? {} : { exp }),
    ...(values.admin ? { ad: true } : {}),
    ...(workspace ? { w: workspace } : {}),
    ...(peer ? { p: peer } : {}),
    ...(session ? { s: session } : {}),
  };
  const jwt = signToken(claims, secret);
  io.out(
    values.json
      ? JSON.stringify({
          token: jwt,
          claims,
          expires_at: exp === undefined ? null : new Date(exp * 1000).toISOString(),
        })
      : jwt,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

type Level = "ok" | "warn" | "fail" | "skip";
interface Check {
  name: string;
  status: Level;
  detail: string;
}

/** Which env var a model reference like "openai/gpt-5-mini" needs, or null when none does. */
function providerOf(model: string): string | null {
  const provider = model.split("/")[0] ?? "";
  return PROVIDERS.some((p) => p.name === provider) ? provider : null;
}

async function ping(
  url: string,
  timeoutMs: number,
  io: CliIo,
): Promise<{ status: Level; detail: string }> {
  const target = `${url.replace(/\/+$/, "")}/health`;
  const started = Date.now();
  try {
    const res = await io.fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - started;
    if (!res.ok)
      return { status: "fail", detail: `${target} answered HTTP ${res.status} (${ms} ms)` };
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    if (body?.status !== "ok") {
      return {
        status: "warn",
        detail: `${target} answered 200 but not {"status":"ok"} (${ms} ms)`,
      };
    }
    return { status: "ok", detail: `${target} is healthy (${ms} ms)` };
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string; message?: string } };
    const why =
      e.name === "TimeoutError"
        ? `no answer within ${timeoutMs} ms`
        : (e.cause?.code ?? e.cause?.message ?? (err as Error).message);
    return { status: "fail", detail: `${target} unreachable: ${why}` };
  }
}

/**
 * The checks Honcho's `doctor` makes as a client: is there a key, does the server accept it, is the
 * workspace there and its background work healthy, does the peer exist. Read-only: nothing is created.
 */
async function clientChecks(
  io: CliIo,
  settings: ReturnType<typeof resolveSettings>,
  timeoutMs: number,
  add: (name: string, status: Level, detail: string) => void,
): Promise<void> {
  add(
    "credentials",
    "ok",
    settings.apiKey
      ? `API key ${redactKey(settings.apiKey)} from ${settings.sources.apiKey}`
      : "no API key (fine when the server runs without auth)",
  );
  const api = createApi(settings, io, timeoutMs);
  const ws = settings.workspace;
  const named = settings.sources.workspace !== "default";
  let workspaceOk = false;
  try {
    const q = await api.call("GET", api.ws("/queue/status"));
    add("API access", "ok", "the server accepted the request");
    add("workspace", "ok", `'${ws}' is reachable (${settings.sources.workspace})`);
    workspaceOk = true;
    const busy = Number(q.pending_work_units ?? 0) + Number(q.in_progress_work_units ?? 0);
    add(
      "queue",
      "ok",
      `${q.completed_work_units}/${q.total_work_units} work units done${busy ? `, ${busy} still pending or running` : ""}`,
    );
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const status = Number(err.details.status ?? 0);
    if (status === 401 || status === 403) {
      add(
        "API access",
        "fail",
        `the server rejected the credentials (HTTP ${status}): set RECALL_API_KEY, pass --api-key, or run "recall init"`,
      );
      return;
    }
    if (status === 404) {
      add("API access", "ok", "the server accepted the request");
      add(
        "workspace",
        named ? "fail" : "warn",
        `'${ws}' does not exist yet (${settings.sources.workspace}); the first write creates it`,
      );
    } else {
      add("API access", "fail", err.message);
      return;
    }
  }
  if (!settings.peer) return;
  if (!workspaceOk) {
    add(
      "peer",
      named ? "fail" : "warn",
      `'${settings.peer}' cannot exist yet: its workspace '${ws}' does not`,
    );
    return;
  }
  try {
    const found = await api.call("POST", api.ws("/peers/list"), {
      query: { size: 1 },
      body: { filters: { id: settings.peer } },
    });
    add(
      "peer",
      found.items?.length ? "ok" : "fail",
      found.items?.length
        ? `'${settings.peer}' exists (${settings.sources.peer})`
        : `'${settings.peer}' (${settings.sources.peer}) not found in workspace '${ws}'`,
    );
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    // A peer-scoped key cannot list peers; that is not a failure of the peer.
    add("peer", "skip", `could not list peers with this key (${err.message})`);
  }
}

async function doctor(args: string[], io: CliIo): Promise<number> {
  const { values } = parse(args, {
    url: { type: "string" },
    "api-key": { type: "string" },
    workspace: { type: "string", short: "w" },
    peer: { type: "string", short: "p" },
    timeout: { type: "string" },
    json: { type: "boolean" },
  });
  if (values.help) {
    io.out(DOCTOR_USAGE);
    return 0;
  }
  const timeout = values.timeout === undefined ? 5000 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new UsageError(
      `--timeout must be a positive number of milliseconds (got "${values.timeout}")`,
    );
  }
  const url = values.url ?? io.env.RECALL_URL;

  const checks: Check[] = [];
  const add = (name: string, status: Level, detail: string) =>
    checks.push({ name, status, detail });

  let config: Config | null = null;
  try {
    config = loadConfig(io.env);
    add("configuration", "ok", "environment parsed");
  } catch (err) {
    add("configuration", "fail", configErrorText(err));
  }

  const report: Record<string, unknown> = { version: VERSION };
  if (config) {
    const present = providerPresence(config);
    const anyKey = Object.values(present).some(Boolean);
    const models: Record<string, string> = { ...config.models, embedding: config.embedding.model };

    add(
      "database",
      config.database.kind === "pglite" && !config.database.dataDir ? "warn" : "ok",
      databaseText(config),
    );

    if (!anyKey) {
      add(
        "language models",
        "warn",
        "no provider key set: answers come from the offline mock, not a real model (set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...)",
      );
    } else {
      add(
        "language models",
        "ok",
        `keys for ${Object.keys(present)
          .filter((p) => present[p])
          .join(", ")}`,
      );
    }
    const unreachable = Object.entries(models).filter(([, m]) => {
      const provider = providerOf(m);
      return provider !== null && !present[provider];
    });
    if (unreachable.length) {
      add(
        "model routing",
        "fail",
        `no key for: ${unreachable.map(([task, m]) => `${task} -> ${m}`).join(", ")}`,
      );
    } else {
      add("model routing", "ok", "every routed model has a provider key (or is local/offline)");
    }

    if (config.auth.enabled) {
      add("auth", "ok", "enabled; bearer tokens required");
    } else {
      const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.server.host);
      add(
        "auth",
        loopback ? "ok" : "warn",
        loopback
          ? "disabled, listening on loopback only"
          : `disabled: anyone who can reach ${config.server.host}:${config.server.port} can read and write all memory (set RECALL_AUTH_ENABLED=true and RECALL_AUTH_SECRET)`,
      );
    }

    Object.assign(report, {
      database:
        config.database.kind === "postgres"
          ? { kind: "postgres", url: redactUrl(config.database.url) }
          : { kind: "pglite", data_dir: config.database.dataDir },
      listen: { host: config.server.host, port: config.server.port, role: config.role },
      auth: { enabled: config.auth.enabled },
      providers: present,
      models,
      embedding_dimensions: config.embedding.dimensions,
    });
  }

  if (url) {
    const result = await ping(url, timeout, io);
    add("server /health", result.status, result.detail);
    if (result.status !== "fail") {
      const settings = resolveSettings(io.env, {
        url,
        apiKey: values["api-key"],
        workspace: checkId("--workspace", values.workspace),
        peer: checkId("--peer", values.peer),
      });
      await clientChecks(io, settings, timeout, add);
    }
  } else {
    add("server /health", "skip", "no URL: pass --url or set RECALL_URL to ping a running server");
  }

  const failed = checks.some((c) => c.status === "fail");
  if (values.json) {
    io.out(JSON.stringify({ ...report, checks, ok: !failed }, null, 2));
    return failed ? 1 : 0;
  }

  io.out(`recall doctor (v${VERSION})\n`);
  if (config) {
    const p = report.providers as Record<string, boolean>;
    io.out("Providers");
    for (const prov of PROVIDERS) {
      io.out(`  ${prov.name.padEnd(11)} ${p[prov.name] ? "configured" : "-"}`);
    }
    io.out("\nModel routing (task -> provider/model)");
    const models = report.models as Record<string, string>;
    for (const [task, model] of Object.entries(models)) io.out(`  ${task.padEnd(13)} ${model}`);
    io.out(`  (embeddings: ${config.embedding.dimensions} dimensions)`);
    io.out(
      `\nServer config\n  listen      ${config.server.host}:${config.server.port} (role ${config.role})\n  database    ${databaseText(config)}\n  auth        ${config.auth.enabled ? "enabled" : "disabled"}`,
    );
  }
  io.out("\nChecks");
  const tag: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };
  for (const c of checks) io.out(`  [${tag[c.status]}] ${c.name}: ${c.detail}`);
  io.out(failed ? "\nSome checks failed." : "\nNo failures.");
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// accounts / keys (hosted mode control plane)
// ---------------------------------------------------------------------------

const TARGET_HELP = `Target (one of):
      --url <url>           Use the admin API of a running server    [RECALL_ADMIN_URL]
                            with $RECALL_ADMIN_TOKEN (or --admin-token)
      (default)             Open the database directly, configured like the server
                            ($RECALL_DATABASE_URL, or embedded Postgres in $RECALL_DATA_DIR)`;

const ACCOUNTS_USAGE = `Usage: recall accounts <create|list> [options]

  create --name <name> [--budget <usd>]   Create an account (prints its id and webhook secret)
  list                                    List accounts

Options:
      --name <name>         Account name (create)
      --budget <usd>        Monthly spend cap in USD (create; default: none)
      --json                Machine-readable output
      --admin-token <t>     Admin token for --url                    [RECALL_ADMIN_TOKEN]
${TARGET_HELP}`;

const KEYS_USAGE = `Usage: recall keys <create|list|revoke> [options]

  create --account <id> [scope] [options]  Create an API key; the key is printed once
  list --account <id>                      List an account's keys (never the secret)
  revoke <key_id>                          Revoke a key (takes effect within seconds)

Options:
  -a, --account <id>        Account id (create, list)
      --name <name>         Label for the key
  -w, --workspace <id>      Limit to one workspace (no scope = account-admin key)
  -p, --peer <id>           Limit to one peer in that workspace
  -s, --session <id>        Limit to one session in that workspace
      --expires <when>      30m, 12h, 7d, 4w, seconds, or an ISO date (default: never)
      --rate-limit <n>      Requests per minute for this key (default: server default)
      --test                Create a pk_test_ key instead of pk_live_
      --json                Machine-readable output
      --admin-token <t>     Admin token for --url                    [RECALL_ADMIN_TOKEN]
${TARGET_HELP}`;

type Json = Record<string, unknown>;

/** The operations `accounts`/`keys` need, over the admin API or straight on the database. */
interface ControlPlane {
  createAccount(body: { name: string; monthly_budget_usd: number | null }): Promise<Json>;
  listAccounts(): Promise<Json[]>;
  createKey(account: string, body: Json): Promise<Json>;
  listKeys(account: string): Promise<Json[]>;
  revokeKey(keyId: string): Promise<Json>;
  close(): Promise<void>;
}

function apiControlPlane(url: string, token: string, io: CliIo): ControlPlane {
  const base = `${url.replace(/\/+$/, "")}/admin/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await io.fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => null)) as Json | null;
    if (!res.ok) {
      const detail = typeof data?.detail === "string" ? data.detail : JSON.stringify(data);
      throw new Error(`${method} ${base}${path} answered HTTP ${res.status}: ${detail}`);
    }
    return data ?? {};
  };
  return {
    createAccount: (body) => call("POST", "/accounts", body),
    listAccounts: async () => (await call("GET", "/accounts")).items as Json[],
    createKey: (account, body) =>
      call("POST", `/accounts/${encodeURIComponent(account)}/keys`, body),
    listKeys: async (account) =>
      (await call("GET", `/accounts/${encodeURIComponent(account)}/keys`)).items as Json[],
    revokeKey: (keyId) => call("DELETE", `/keys/${encodeURIComponent(keyId)}`),
    close: async () => {},
  };
}

async function dbControlPlane(io: CliIo): Promise<ControlPlane> {
  const config = loadConfigOrExplain(io.env);
  const { openDatabase, migrate } = await import("./db/client.js");
  const accountsMod = await import("./core/accounts.js");
  const keysMod = await import("./core/apikeys.js");
  const database = await openDatabase(config);
  try {
    await migrate(database.db, config.embedding.dimensions);
  } catch (err) {
    await database.close();
    throw err;
  }
  const db = database.db;
  return {
    createAccount: async (body) =>
      accountsMod.createAccount(db, { name: body.name, monthlyBudgetUsd: body.monthly_budget_usd }),
    listAccounts: async () => accountsMod.listAccounts(db),
    createKey: async (account, body) => {
      const acct = await accountsMod.getAccount(db, account);
      const { key, record } = await keysMod.createApiKey(db, {
        accountId: acct.id,
        name: (body.name as string | null) ?? "",
        mode: body.mode as "live" | "test",
        workspace: body.workspace_id as string | null,
        peer: body.peer_id as string | null,
        session: body.session_id as string | null,
        rateLimitPerMin: body.rate_limit_per_min as number | null,
        expiresAt: body.expires_at ? new Date(body.expires_at as string) : null,
      });
      return { ...record, key };
    },
    listKeys: async (account) => {
      const acct = await accountsMod.getAccount(db, account);
      return keysMod.listApiKeys(db, acct.id);
    },
    revokeKey: async (keyId) => keysMod.revokeApiKey(db, keyId),
    close: () => database.close(),
  };
}

const TARGET_OPTIONS = {
  url: { type: "string" },
  "admin-token": { type: "string" },
  json: { type: "boolean" },
} as const;

async function controlPlane(
  values: { url?: string; "admin-token"?: string },
  io: CliIo,
): Promise<ControlPlane> {
  const url = values.url ?? io.env.RECALL_ADMIN_URL;
  if (!url) return dbControlPlane(io);
  const token = values["admin-token"] ?? io.env.RECALL_ADMIN_TOKEN;
  if (!token)
    throw new UsageError(
      "--url needs the admin token: set RECALL_ADMIN_TOKEN or pass --admin-token",
    );
  return apiControlPlane(url, token, io);
}

function subcommand(args: string[], allowed: string[], usage: string, io: CliIo) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    io.out(usage);
    return null;
  }
  if (!allowed.includes(sub))
    throw new UsageError(`unknown subcommand "${sub}" (use ${allowed.join(" | ")})`);
  return { sub, rest };
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "-" : String(v));

async function accounts(args: string[], io: CliIo): Promise<number> {
  const picked = subcommand(args, ["create", "list"], ACCOUNTS_USAGE, io);
  if (!picked) return args.length ? 0 : 2;
  const { values } = parse(picked.rest, {
    ...TARGET_OPTIONS,
    name: { type: "string" },
    budget: { type: "string" },
  });
  if (values.help) {
    io.out(ACCOUNTS_USAGE);
    return 0;
  }
  let budget: number | null = null;
  if (picked.sub === "create") {
    if (!values.name?.trim()) throw new UsageError("accounts create needs --name <name>");
    if (values.budget !== undefined) {
      budget = Number(values.budget);
      if (!Number.isFinite(budget) || budget < 0)
        throw new UsageError(`--budget must be a number of USD >= 0 (got "${values.budget}")`);
    }
  }
  const cp = await controlPlane(values, io);
  try {
    if (picked.sub === "create") {
      const a = await cp.createAccount({ name: values.name!.trim(), monthly_budget_usd: budget });
      if (values.json) io.out(JSON.stringify(a));
      else {
        io.out(`Created account ${a.id} (${a.name})`);
        io.out(
          `  monthly budget: ${a.monthly_budget_usd == null ? "none" : `$${a.monthly_budget_usd}`}`,
        );
        io.out(
          `  webhook secret: ${show(a.webhook_secret)}  (give this to the customer to verify webhooks)`,
        );
        io.out(`Next: recall keys create --account ${a.id}`);
      }
      return 0;
    }
    const list = await cp.listAccounts();
    if (values.json) io.out(JSON.stringify(list));
    else if (!list.length) io.out("No accounts.");
    else
      for (const a of list)
        io.out(
          `${a.id}\t${a.name}\tbudget=${a.monthly_budget_usd == null ? "none" : `$${a.monthly_budget_usd}`}\tcreated ${a.created_at}`,
        );
    return 0;
  } finally {
    await cp.close();
  }
}

async function keys(args: string[], io: CliIo): Promise<number> {
  const picked = subcommand(args, ["create", "list", "revoke"], KEYS_USAGE, io);
  if (!picked) return args.length ? 0 : 2;
  let positional: string | undefined;
  let rest = picked.rest;
  if (picked.sub === "revoke" && rest[0] && !rest[0].startsWith("-")) {
    positional = rest[0];
    rest = rest.slice(1);
  }
  const { values } = parse(rest, {
    ...TARGET_OPTIONS,
    account: { type: "string", short: "a" },
    key: { type: "string" },
    name: { type: "string" },
    workspace: { type: "string", short: "w" },
    peer: { type: "string", short: "p" },
    session: { type: "string", short: "s" },
    expires: { type: "string" },
    "rate-limit": { type: "string" },
    test: { type: "boolean" },
  });
  if (values.help) {
    io.out(KEYS_USAGE);
    return 0;
  }
  let body: Json = {};
  if (picked.sub === "create") {
    if (!values.account) throw new UsageError("keys create needs --account <id>");
    const workspace = checkId("--workspace", values.workspace);
    const peer = checkId("--peer", values.peer);
    const session = checkId("--session", values.session);
    if ((peer || session) && !workspace)
      throw new UsageError("--peer and --session need --workspace");
    const exp = values.expires ? parseExpiry(values.expires) : undefined;
    if (exp !== undefined && exp * 1000 <= Date.now())
      throw new UsageError("--expires is in the past");
    let rate: number | null = null;
    if (values["rate-limit"] !== undefined) {
      rate = Number(values["rate-limit"]);
      if (!Number.isInteger(rate) || rate < 1)
        throw new UsageError(
          `--rate-limit must be a whole number >= 1 (got "${values["rate-limit"]}")`,
        );
    }
    body = {
      name: values.name ?? null,
      mode: values.test ? "test" : "live",
      workspace_id: workspace ?? null,
      peer_id: peer ?? null,
      session_id: session ?? null,
      rate_limit_per_min: rate,
      expires_at: exp === undefined ? null : new Date(exp * 1000).toISOString(),
    };
  } else if (picked.sub === "list") {
    if (!values.account) throw new UsageError("keys list needs --account <id>");
  } else {
    positional ??= values.key;
    if (!positional)
      throw new UsageError("keys revoke needs the key id: recall keys revoke <key_id>");
  }

  const cp = await controlPlane(values, io);
  try {
    if (picked.sub === "create") {
      const k = await cp.createKey(values.account!, body);
      if (values.json) io.out(JSON.stringify(k));
      else {
        io.out(String(k.key));
        io.err(
          `Created ${k.mode} key ${k.id} for account ${k.account_id}${k.admin ? " (account admin)" : ""}. It is shown only once: store it now.`,
        );
      }
      return 0;
    }
    if (picked.sub === "list") {
      const list = await cp.listKeys(values.account!);
      if (values.json) io.out(JSON.stringify(list));
      else if (!list.length) io.out("No keys.");
      else
        for (const k of list) {
          const scope = (k.scope ?? {}) as Json;
          const state = k.revoked_at
            ? "revoked"
            : k.expires_at && Date.parse(String(k.expires_at)) <= Date.now()
              ? "expired"
              : "active";
          io.out(
            `${k.id}\t${k.prefix}…\t${state}\t${k.admin ? "admin" : `w=${show(scope.workspace_id)} p=${show(scope.peer_id)} s=${show(scope.session_id)}`}\tname=${show(k.name)}\tlast used ${show(k.last_used_at)}`,
          );
        }
      return 0;
    }
    const k = await cp.revokeKey(positional!);
    if (values.json) io.out(JSON.stringify(k));
    else io.out(`Revoked ${k.id} (${k.prefix}…) at ${k.revoked_at}`);
    return 0;
  } finally {
    await cp.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: string[], io: CliIo) => Promise<number | null>> = {
  start,
  token,
  doctor,
  accounts,
  keys,
  init,
  config: configCommand,
  workspace: (args, io) => runGroup("workspace", args, io),
  peer: (args, io) => runGroup("peer", args, io),
  session: (args, io) => runGroup("session", args, io),
  conclusion: (args, io) => runGroup("conclusion", args, io),
  scope: (args, io) => runGroup("scope", args, io),
  message: (args, io) => runGroup("message", args, io),
  queue: (args, io) => runGroup("queue", args, io),
};

/** Runs the CLI. Resolves to the exit code, or null when the command keeps running (`start`). */
export async function run(argv: string[], io: CliIo = defaultIo()): Promise<number | null> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    io.out(VERSION);
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    io.err(`recall: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  try {
    return await handler(rest, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`recall ${command}: ${err.message}\nRun "recall ${command} --help" for usage.`);
      return 2;
    }
    if (err instanceof CliError) {
      reportError(io, command, err, wantsJson(rest.includes("--json"), io.env));
      return 1;
    }
    io.err(`recall ${command}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = await run(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
}
