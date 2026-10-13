import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./common.js";

/**
 * Where the command line gets its connection settings.
 *
 * Precedence per setting: flag, then environment (`RECALL_*`), then
 * `~/.recall/config.json`, then a default. Other services' variables and
 * config files are never read: their API keys must not reach a Recall server.
 */

/** Recall's hosted API. Self-hosters set `RECALL_URL=http://localhost:8000` (or `recall init --url`). */
export const DEFAULT_URL = "https://api.recallmem.dev";
/** Where hosted users sign up and create API keys. */
export const DASHBOARD_URL = "https://app.recallmem.dev";
export const KEYS_URL = `${DASHBOARD_URL}/keys`;
export const DEFAULT_WORKSPACE = "default";

/** True for Recall's hosted service (recallmem.dev and its subdomains), where keys come from the dashboard. */
export function isHostedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "recallmem.dev" || host.endsWith(".recallmem.dev");
  } catch {
    return false;
  }
}

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;

export interface FileSettings {
  url?: string;
  apiKey?: string;
  workspace?: string;
  peer?: string;
}

export interface Settings {
  url: string;
  apiKey: string | undefined;
  workspace: string;
  peer: string | undefined;
  session: string | undefined;
  /** The file the file-level values came from, if any. */
  configPath: string | null;
  /** Where each value came from, e.g. `env RECALL_URL` or `file ~/.recall/config.json`. */
  sources: Record<"url" | "apiKey" | "workspace" | "peer" | "session", string>;
}

const home = (env: Env) => env.HOME || env.USERPROFILE || homedir();

export function recallConfigPath(env: Env): string {
  if (env.RECALL_CONFIG_PATH) return env.RECALL_CONFIG_PATH;
  return join(env.RECALL_CONFIG_DIR || join(home(env), ".recall"), "config.json");
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** A `${VAR}` placeholder in a config value reads that environment variable. */
function expand(value: string | undefined, env: Env): string | undefined {
  const m = value?.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return m ? str(env[m[1]!]) : value;
}

/** The file's settings: `url`, `apiKey`, `workspace` and `peer`. */
export function normalizeFile(data: Obj, env: Env): FileSettings {
  return {
    url: str(data.url),
    apiKey: expand(str(data.apiKey), env),
    workspace: str(data.workspace),
    peer: str(data.peer),
  };
}

function readJson(path: string): Obj | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("not an object");
  return parsed as Obj;
}

/** The config file in effect, or null; a broken one is an error. */
export function loadConfigFile(env: Env): { path: string; settings: FileSettings } | null {
  const own = recallConfigPath(env);
  try {
    const data = readJson(own);
    if (data) return { path: own, settings: normalizeFile(data, env) };
  } catch (err) {
    throw new CliError(
      "INVALID_CONFIG",
      `${own} could not be read: ${(err as Error).message}. Fix or delete it, or run "recall init".`,
      { path: own },
    );
  }
  return null;
}

export interface SettingFlags {
  url?: string;
  apiKey?: string;
  workspace?: string;
  peer?: string;
  session?: string;
}

const ENV_NAMES = {
  url: ["RECALL_URL", "RECALL_BASE_URL"],
  apiKey: ["RECALL_API_KEY"],
  workspace: ["RECALL_WORKSPACE_ID", "RECALL_WORKSPACE"],
  peer: ["RECALL_PEER_ID", "RECALL_PEER_NAME"],
  session: ["RECALL_SESSION_ID"],
} as const;

const FLAG_NAMES = {
  url: "--url",
  apiKey: "--api-key",
  workspace: "--workspace",
  peer: "--peer",
  session: "--session",
} as const;

const tilde = (path: string, env: Env) => {
  const h = home(env);
  return path.startsWith(h) ? `~${path.slice(h.length)}` : path;
};

export function resolveSettings(env: Env, flags: SettingFlags = {}): Settings {
  const file = loadConfigFile(env);
  const fromFile: FileSettings = file?.settings ?? {};
  const sources = {} as Settings["sources"];

  const pick = (key: keyof typeof ENV_NAMES, fallback?: string): string | undefined => {
    const flag = str(flags[key]);
    if (flag) {
      sources[key] = `flag ${FLAG_NAMES[key]}`;
      return flag;
    }
    for (const name of ENV_NAMES[key]) {
      const v = str(env[name]);
      if (v) {
        sources[key] = `env ${name}`;
        return v;
      }
    }
    const fromConfig = key === "session" ? undefined : fromFile[key];
    if (fromConfig && file) {
      sources[key] = `file ${tilde(file.path, env)}`;
      return fromConfig;
    }
    sources[key] = fallback === undefined ? "unset" : "default";
    return fallback;
  };

  const url = pick("url", DEFAULT_URL)!;
  return {
    url: url.replace(/\/+$/, ""),
    apiKey: pick("apiKey"),
    workspace: pick("workspace", DEFAULT_WORKSPACE)!,
    peer: pick("peer"),
    session: pick("session"),
    configPath: file?.path ?? null,
    sources,
  };
}

/** `pk_live_abcd…wxyz` -> `pk_live_…wxyz`: enough to tell keys apart, never enough to use one. */
export function redactKey(key: string | undefined): string | null {
  if (!key) return null;
  const prefix = key.match(/^[a-z]{2}_(?:live|test)_/)?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}

/**
 * Writes `~/.recall/config.json` (or `$RECALL_CONFIG_PATH`) atomically with mode 600, keeping
 * any other keys already in the file. Returns the path.
 */
export function saveConfigFile(env: Env, patch: FileSettings): string {
  const path = recallConfigPath(env);
  let existing: Obj = {};
  try {
    existing = readJson(path) ?? {};
  } catch {
    throw new CliError(
      "INVALID_CONFIG",
      `${path} exists but is not valid JSON; fix or delete it first.`,
      { path },
    );
  }
  const next: Obj = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}
