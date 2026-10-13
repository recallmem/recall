#!/usr/bin/env node
// Sets Recall up for Codex without the plugin system: copies the hook scripts to
// $CODEX_HOME/recall, adds three hooks to $CODEX_HOME/hooks.json and the Recall
// MCP server to $CODEX_HOME/config.toml. Running it again updates in place;
// --uninstall takes everything out again. Node 18+, no dependencies.
//
//   node integrations/codex/install.mjs [--url URL --api-key KEY --workspace ID --peer ID]
//   node integrations/codex/install.mjs --uninstall

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = [
  "host.mjs",
  "lib.mjs",
  "session-start.mjs",
  "user-prompt-submit.mjs",
  "stop.mjs",
  "mcp-bridge.mjs",
  "status.mjs",
];
const HOOKS = [
  ["SessionStart", "session-start.mjs", 10, "Recalling memory"],
  ["UserPromptSubmit", "user-prompt-submit.mjs", 8, null],
  ["Stop", "stop.mjs", 10, null],
];
/** Environment variables Codex forwards to the MCP bridge (it forwards only a short allowlist by default). */
const MCP_ENV_VARS = [
  "RECALL_URL",
  "RECALL_API_KEY",
  "RECALL_WORKSPACE_ID",
  "RECALL_PEER_ID",
  "RECALL_MCP_PROFILE",
  "RECALL_CONFIG_PATH",
  "RECALL_MCP_TIMEOUT_MS",
];
const BEGIN = "# >>> recall-memory (managed by the Recall Codex installer; --uninstall removes it)";
const END = "# <<< recall-memory";
const MD_BEGIN = "<!-- >>> recall-memory (managed by the Recall Codex installer) -->";
const MD_END = "<!-- <<< recall-memory -->";
const SKILL_MARKER = ".installed-by-recall-codex";

const USAGE = `Usage: node install.mjs [options]

Installs Recall memory for Codex: hooks that recall and record, and the MCP tools.

  --url URL           Recall server URL     \\
  --api-key KEY       API key                } saved to ~/.recall/config.json
  --workspace ID      workspace             /  (skip them to keep what is there)
  --peer ID           your peer id         /
  --codex-home DIR    Codex config directory (default: $CODEX_HOME or ~/.codex)
  --no-hooks          do not install the hooks
  --no-mcp            do not add the MCP server
  --skill             also install the recall-memory Agent Skill into ~/.agents/skills
  --agents-md         also add a short Recall section to $CODEX_HOME/AGENTS.md
  --uninstall         remove everything this installer added
  -h, --help          show this help`;

// ---------------------------------------------------------------------------
// Small file helpers
// ---------------------------------------------------------------------------

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

function writeAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, path);
}

/** A managed block between marker lines: replaced, appended or removed (block = null). */
function withBlock(text, begin, end, block) {
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim() === begin);
  const stop = start >= 0 ? lines.findIndex((l, i) => i > start && l.trim() === end) : -1;
  let kept = lines;
  let at = lines.length;
  if (start >= 0 && stop > start) {
    kept = [...lines.slice(0, start), ...lines.slice(stop + 1)];
    at = start;
  }
  if (block === null) {
    const rest = kept.join("\n").replace(/\n{2,}$/, "\n");
    return rest.trim() === "" ? "" : rest;
  }
  const before = kept.slice(0, at).join("\n").replace(/\s+$/, "");
  const after = kept.slice(at).join("\n").replace(/^\s+/, "");
  return [before, [begin, block, end].join("\n"), after].filter(Boolean).join("\n\n") + "\n";
}

const tomlString = (s) => JSON.stringify(s); // a JSON string is a valid TOML basic string

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * `node <path>` quoted for the shell that runs hooks: single quotes on POSIX, so `$`, backticks
 * and `"` in the path are never expanded; plain double quotes on Windows, where cmd has no
 * single quotes and Windows paths must stay as they are.
 */
function hookCommand(scriptsDir, file) {
  const path = join(scriptsDir, file);
  if (process.platform === "win32") return `node "${path}"`;
  return `node '${path.replaceAll("'", "'\\''")}'`;
}

/** Our hook groups are recognised by the scripts directory in their command. */
const isOurs = (group, scriptsDir) =>
  Array.isArray(group?.hooks) &&
  group.hooks.some((h) => typeof h?.command === "string" && h.command.includes(scriptsDir));

function updateHooks(path, scriptsDir, install) {
  const text = read(path);
  let doc = { hooks: {} };
  if (text?.trim()) {
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new Error(`${path} is not valid JSON (${err.message}); fix it and run again`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(`${path} must contain a JSON object`);
    }
  }
  const hooks = doc.hooks && typeof doc.hooks === "object" ? doc.hooks : {};
  for (const event of Object.keys(hooks)) {
    if (Array.isArray(hooks[event])) {
      hooks[event] = hooks[event].filter((g) => !isOurs(g, scriptsDir));
      if (hooks[event].length === 0) delete hooks[event];
    }
  }
  if (install) {
    for (const [event, file, timeout, statusMessage] of HOOKS) {
      const handler = { type: "command", command: hookCommand(scriptsDir, file), timeout };
      if (statusMessage) handler.statusMessage = statusMessage;
      hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), { hooks: [handler] }];
    }
  }
  doc.hooks = hooks;
  const empty = Object.keys(hooks).length === 0 && Object.keys(doc).length === 1;
  if (empty && !install) {
    if (text !== null) rmSync(path);
    return;
  }
  writeAtomic(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function mcpBlock(scriptsDir) {
  return [
    "[mcp_servers.recall]",
    'command = "node"',
    `args = [${tomlString(join(scriptsDir, "mcp-bridge.mjs"))}]`,
    `env_vars = [${MCP_ENV_VARS.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 150",
  ].join("\n");
}

/** Returns a warning when the MCP server could not be added. */
function updateConfigToml(path, scriptsDir, install) {
  const text = read(path) ?? "";
  const withoutOurs = withBlock(text, BEGIN, END, null);
  if (!install) {
    if (text !== withoutOurs) writeAtomic(path, withoutOurs);
    return null;
  }
  if (/^\s*\[\s*mcp_servers\s*\.\s*"?recall"?\s*\]/m.test(withoutOurs)) {
    return `${path} already defines [mcp_servers.recall]; left it as it is`;
  }
  if (/^\s*mcp_servers\s*=/m.test(withoutOurs)) {
    return `${path} sets mcp_servers inline; add the recall server yourself (see the README)`;
  }
  writeAtomic(path, withBlock(text, BEGIN, END, mcpBlock(scriptsDir)));
  return null;
}

/** Merges the given connection settings into ~/.recall/config.json (mode 600). */
function saveRecallConfig(env, values) {
  const path =
    env.RECALL_CONFIG_PATH ||
    join(env.RECALL_CONFIG_DIR || join(env.HOME || homedir(), ".recall"), "config.json");
  let current = {};
  const text = read(path);
  if (text?.trim()) {
    try {
      current = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON; fix it or pass no connection flags`);
    }
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) next[key] = value;
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  chmodSync(path, 0o600);
  return path;
}

const AGENTS_MD = `## Recall memory

Recall keeps long-term memory about the user across Codex sessions. Its MCP tools are
available as the \`recall\` server: \`chat\` answers questions about the user from memory,
\`search\` finds the facts and messages behind an answer, \`create_conclusions\` saves a
fact the user stated outright, and \`delete_conclusion\` removes one that is wrong.
Use them when earlier sessions would help (preferences, past decisions, ongoing work)
and when the user asks you to remember or forget something. The Recall hooks already
record this conversation, so do not record messages yourself.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function run(argv = process.argv.slice(2), env = process.env, out = console.log) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      "api-key": { type: "string" },
      workspace: { type: "string" },
      peer: { type: "string" },
      "codex-home": { type: "string" },
      "no-hooks": { type: "boolean" },
      "no-mcp": { type: "boolean" },
      skill: { type: "boolean" },
      "agents-md": { type: "boolean" },
      uninstall: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    out(USAGE);
    return 0;
  }

  const home = env.HOME || env.USERPROFILE || homedir();
  const codexHome = resolve(values["codex-home"] || env.CODEX_HOME || join(home, ".codex"));
  const target = join(codexHome, "recall");
  const scriptsDir = join(target, "scripts");
  const hooksPath = join(codexHome, "hooks.json");
  const configPath = join(codexHome, "config.toml");
  const agentsPath = join(codexHome, "AGENTS.md");
  const skillTarget = join(home, ".agents", "skills", "recall-memory");
  const install = !values.uninstall;
  const done = [];
  const warnings = [];

  if (!install) {
    updateHooks(hooksPath, scriptsDir, false);
    updateConfigToml(configPath, scriptsDir, false);
    const agents = read(agentsPath);
    if (agents !== null) {
      const next = withBlock(agents, MD_BEGIN, MD_END, null);
      if (next === "") rmSync(agentsPath);
      else if (next !== agents) writeAtomic(agentsPath, next);
    }
    if (existsSync(join(skillTarget, SKILL_MARKER))) rmSync(skillTarget, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    out(`Removed Recall from ${codexHome}. Your ~/.recall/config.json was left as it is.`);
    return 0;
  }

  const connection = {
    url: values.url,
    apiKey: values["api-key"],
    workspace: values.workspace,
    peer: values.peer,
  };
  if (Object.values(connection).some((v) => v !== undefined)) {
    done.push(`saved connection settings to ${saveRecallConfig(env, connection)}`);
  }

  mkdirSync(scriptsDir, { recursive: true });
  for (const file of SCRIPTS) cpSync(join(HERE, "scripts", file), join(scriptsDir, file));
  done.push(`copied the hook scripts to ${scriptsDir}`);

  updateHooks(hooksPath, scriptsDir, !values["no-hooks"]);
  if (!values["no-hooks"])
    done.push(`added the SessionStart, UserPromptSubmit and Stop hooks to ${hooksPath}`);

  const mcpWarning = updateConfigToml(configPath, scriptsDir, !values["no-mcp"]);
  if (mcpWarning) warnings.push(mcpWarning);
  else if (!values["no-mcp"]) done.push(`added the recall MCP server to ${configPath}`);

  if (values.skill) {
    const source = resolve(HERE, "..", "agent-skill", "recall-memory");
    if (!existsSync(join(source, "SKILL.md"))) {
      warnings.push(`no skill found at ${source}; run the installer from a full checkout`);
    } else {
      rmSync(skillTarget, { recursive: true, force: true });
      cpSync(source, skillTarget, { recursive: true });
      writeFileSync(join(skillTarget, SKILL_MARKER), "");
      done.push(`installed the recall-memory skill to ${skillTarget}`);
    }
  }
  if (values["agents-md"]) {
    writeAtomic(agentsPath, withBlock(read(agentsPath), MD_BEGIN, MD_END, AGENTS_MD));
    done.push(`added a Recall section to ${agentsPath}`);
  }

  const config = read(configPath) ?? "";
  if (/\[plugins\."recall-memory@/.test(config) && !values["no-hooks"]) {
    warnings.push(
      "the recall-memory Codex plugin is also installed; use one or the other, or every turn is handled twice",
    );
  }

  out(["Recall is set up for Codex:", ...done.map((d) => `  - ${d}`)].join("\n"));
  for (const w of warnings) out(`Warning: ${w}`);
  out(
    [
      "",
      "Next:",
      "  1. Start Codex and run /hooks: trust the three Recall hooks (Codex skips new hooks until you do).",
      "  2. Run /mcp in Codex to see the recall tools.",
      `  3. Check the connection: node "${join(scriptsDir, "status.mjs")}"`,
    ].join("\n"),
  );
  return 0;
}

// Run when executed directly (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
