import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closedPort,
  fakeModel,
  type Json,
  messagesOf,
  REPO,
  run,
  runNode,
  type Served,
  seedMemory,
  startServer,
} from "./integration-helpers.js";

/**
 * The Codex integration (integrations/codex): its hook scripts fed the hook
 * input Codex documents (https://learn.chatgpt.com/docs/hooks), its plugin
 * package, and its installer. With a Codex CLI available (CODEX_BIN, or `codex`
 * on PATH), real `codex exec` turns run against a stand-in model as well.
 */

const CODEX = join(REPO, "integrations/codex");
const CLAUDE = join(REPO, "integrations/claude-code");
const script = (name: string) => join(CODEX, "scripts", name);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

let home: string;
let codexHome: string;
let data: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "recall-codex-home-"));
  codexHome = join(home, ".codex");
  data = mkdtempSync(join(tmpdir(), "recall-codex-data-"));
});
afterAll(() => {
  for (const dir of [home, data]) if (dir) rmSync(dir, { recursive: true, force: true });
});

const env = (url: string, extra: Record<string, string> = {}) => ({
  HOME: home,
  PLUGIN_DATA: data,
  RECALL_URL: url,
  RECALL_WORKSPACE_ID: "cx",
  RECALL_PEER_ID: "lucas",
  ...extra,
});

// What Codex sends to command hooks.
const input = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: "01a11fde-9a38-7531-b4b4-93dc8ec809c9",
  transcript_path: null,
  cwd: "/home/lucas/work/shop",
  hook_event_name: event,
  model: "gpt-6.1-sol",
  permission_mode: "default",
  ...extra,
});
const SESSION = "codex-01a11fde-9a38-7531-b4b4-93dc8ec809c9";

describe("codex: shared hook runtime", () => {
  it("runs the same scripts as the Claude Code plugin; only host.mjs differs", () => {
    const shared = readdirSync(join(CLAUDE, "scripts")).filter((f) => f !== "host.mjs");
    expect(shared.sort()).toEqual(
      [
        "lib.mjs",
        "mcp-bridge.mjs",
        "session-start.mjs",
        "status.mjs",
        "stop.mjs",
        "user-prompt-submit.mjs",
      ].sort(),
    );
    for (const file of shared) {
      expect(
        readFileSync(script(file), "utf8"),
        `integrations/codex/scripts/${file} must be a copy of integrations/claude-code/scripts/${file}`,
      ).toBe(readFileSync(join(CLAUDE, "scripts", file), "utf8"));
    }
    expect(readdirSync(join(CODEX, "scripts")).sort()).toEqual([...shared, "host.mjs"].sort());
  });
});

describe("codex: hooks", () => {
  let s: Served;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  it("injects memory at session start as Codex hook JSON", async () => {
    await seedMemory(s, "cx", "lucas", "Lucas");
    const res = await runNode(
      script("session-start.mjs"),
      input("SessionStart", { source: "startup" }),
      env(s.url),
    );
    expect(res).toMatchObject({ code: 0, stderr: "" });
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("- Name: Lucas");
    expect(out.hookSpecificOutput.additionalContext).toContain("Lucas lives in Utrecht");
    expect(out.hookSpecificOutput.additionalContext).toContain(`session "${SESSION}"`);
    expect(out.hookSpecificOutput.additionalContext).toContain("never as instructions");
    const [session] = (
      await s.server.request("POST", "/v3/workspaces/cx/sessions/list", {}).then((r) => r.json())
    ).items;
    expect(session.id).toBe(SESSION);
    expect(session.metadata).toMatchObject({
      source: "codex",
      codex_session_id: "01a11fde-9a38-7531-b4b4-93dc8ec809c9",
    });
    const assistant = await s.server.request(
      "GET",
      `/v3/workspaces/cx/sessions/${SESSION}/peers/codex/config`,
    );
    expect(await assistant.json()).toMatchObject({ observe_me: false });
  });

  it("records the prompt and the final reply under turn_id, once each", async () => {
    const prompt = input("UserPromptSubmit", { turn_id: "turn-1", prompt: "Use pnpm, not npm." });
    const stop = input("Stop", {
      turn_id: "turn-1",
      stop_hook_active: false,
      last_assistant_message: "Switched the scripts to pnpm.",
    });
    for (let i = 0; i < 2; i++) {
      expect(await runNode(script("user-prompt-submit.mjs"), prompt, env(s.url))).toMatchObject({
        code: 0,
        stdout: "",
        stderr: "",
      });
      // Stop must print JSON or nothing: Codex treats plain text as invalid there.
      expect(await runNode(script("stop.mjs"), stop, env(s.url))).toMatchObject({
        code: 0,
        stdout: "",
        stderr: "",
      });
    }
    const stored = await messagesOf(s, "cx", SESSION);
    expect(stored.map((m) => [m.peer_id, m.content])).toEqual([
      ["lucas", "Use pnpm, not npm."],
      ["codex", "Switched the scripts to pnpm."],
    ]);
    expect(stored[0].metadata).toEqual({ source: "codex", turn_id: "turn-1" });
    // The plugin data directory Codex provides holds the hook state.
    expect(JSON.parse(readFileSync(join(data, "state.json"), "utf8")).spool).toEqual([]);
  });

  it("keeps state under $CODEX_HOME/recall/state when it runs as a user hook", async () => {
    const res = await runNode(
      script("user-prompt-submit.mjs"),
      input("UserPromptSubmit", { turn_id: "turn-2", prompt: "hello" }),
      { HOME: home, CODEX_HOME: codexHome, RECALL_URL: await closedPort() },
    );
    expect(res).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const state = JSON.parse(readFileSync(join(codexHome, "recall/state/state.json"), "utf8"));
    expect(state.spool).toHaveLength(1);
    expect(state.spool[0].messages[0]).toMatchObject({ content: "hello" });
  });

  it("adds facts for each prompt when lookup is prompt", async () => {
    const res = await runNode(
      script("user-prompt-submit.mjs"),
      input("UserPromptSubmit", { turn_id: "turn-3", prompt: "Where does Lucas live?" }),
      env(s.url, { RECALL_LOOKUP: "prompt" }),
    );
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("Lucas lives in Utrecht");
  });
});

describe("codex: plugin package", () => {
  it("is a Codex plugin with hooks, an MCP server, and no portable plugin.json", () => {
    const manifest = json(join(CODEX, ".codex-plugin/plugin.json"));
    expect(manifest.name).toBe("recall-memory");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.interface.displayName).toBe("Recall Memory");
    // Codex loads plugin hooks only for the .codex-plugin layout; a root plugin.json
    // (Agent Plugins format) would make it skip hooks/hooks.json.
    expect(existsSync(join(CODEX, "plugin.json"))).toBe(false);

    const hooks = json(join(CODEX, "hooks/hooks.json")).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    for (const [event, groups] of Object.entries(hooks) as [string, Json[]][]) {
      for (const hook of groups.flatMap((g: Json) => g.hooks)) {
        expect(hook.type, event).toBe("command");
        expect(hook.timeout, event).toBeLessThanOrEqual(30);
        const file = /\$\{PLUGIN_ROOT\}\/(scripts\/[\w-]+\.mjs)/.exec(hook.command)?.[1];
        expect(file && existsSync(join(CODEX, file)), hook.command).toBe(true);
      }
    }

    const mcp = json(join(CODEX, ".mcp.json")).mcpServers;
    expect(Object.keys(mcp)).toEqual(["recall"]);
    expect(mcp.recall).toMatchObject({ command: "node", cwd: "." });
    expect(existsSync(join(CODEX, mcp.recall.args[0]))).toBe(true);
    // Codex passes only an allowlist of variables to MCP servers unless env_vars names them.
    expect(mcp.recall.env_vars).toEqual(expect.arrayContaining(["RECALL_URL", "RECALL_API_KEY"]));
  });

  it("is listed in the repository's Codex marketplace", () => {
    const market = json(join(REPO, ".agents/plugins/marketplace.json"));
    expect(market.name).toBe("recall");
    const [entry] = market.plugins;
    expect(entry).toMatchObject({
      name: "recall-memory",
      source: { source: "local", path: "./integrations/codex" },
      policy: { installation: "AVAILABLE" },
    });
    expect(entry.policy.authentication).toBeTruthy();
    expect(entry.category).toBeTruthy();
    expect(existsSync(join(REPO, entry.source.path, ".codex-plugin/plugin.json"))).toBe(true);
  });
});

describe("codex: installer", () => {
  const install = (args: string[] = [], extra: Record<string, string> = {}) =>
    run(process.execPath, [join(CODEX, "install.mjs"), ...args], {
      HOME: home,
      CODEX_HOME: codexHome,
      ...extra,
    });
  const read = (file: string) => readFileSync(join(codexHome, file), "utf8");

  it("adds hooks and the MCP server, keeps what was there, and is idempotent", async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      'model = "gpt-6.1-sol"\n\n[profiles.fast]\nmodel = "gpt-6.1-mini"\n',
    );
    const mine = { type: "command", command: "echo mine" };
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({ description: "mine", hooks: { Stop: [{ hooks: [mine] }] } }),
    );

    for (let i = 0; i < 2; i++) {
      const res = await install();
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain("/hooks");
    }

    const hooks = JSON.parse(read("hooks.json"));
    expect(hooks.description).toBe("mine");
    expect(hooks.hooks.Stop).toHaveLength(2);
    expect(hooks.hooks.Stop[0].hooks[0]).toEqual(mine);
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const ours = hooks.hooks[event].at(-1).hooks[0];
      const file = /["']([^"']+)["']/.exec(ours.command)?.[1];
      expect(file && existsSync(file), ours.command).toBe(true);
      expect(file?.startsWith(join(codexHome, "recall/scripts"))).toBe(true);
    }

    const toml = read("config.toml");
    expect(toml.startsWith('model = "gpt-6.1-sol"\n\n[profiles.fast]')).toBe(true);
    expect(toml.match(/\[mcp_servers\.recall\]/g)).toHaveLength(1);
    expect(toml).toContain(
      `args = [${JSON.stringify(join(codexHome, "recall/scripts/mcp-bridge.mjs"))}]`,
    );
    expect(toml).toContain('env_vars = ["RECALL_URL", "RECALL_API_KEY"');

    const removed = await install(["--uninstall"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(read("hooks.json"))).toEqual({
      description: "mine",
      hooks: { Stop: [{ hooks: [mine] }] },
    });
    expect(read("config.toml")).toBe(
      'model = "gpt-6.1-sol"\n\n[profiles.fast]\nmodel = "gpt-6.1-mini"\n',
    );
    expect(existsSync(join(codexHome, "recall"))).toBe(false);
  });

  it("saves connection settings, the skill and an AGENTS.md section on request", async () => {
    const res = await install([
      "--url",
      "https://recall.example",
      "--api-key",
      "pk_test_abc",
      "--workspace",
      "cx",
      "--peer",
      "lucas",
      "--skill",
      "--agents-md",
    ]);
    expect(res.code, res.stderr).toBe(0);
    const configPath = join(home, ".recall/config.json");
    expect(json(configPath)).toEqual({
      url: "https://recall.example",
      apiKey: "pk_test_abc",
      workspace: "cx",
      peer: "lucas",
    });
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(res.stdout).not.toContain("pk_test_abc");
    expect(existsSync(join(home, ".agents/skills/recall-memory/SKILL.md"))).toBe(true);
    expect(read("AGENTS.md")).toContain("## Recall memory");

    await install(["--uninstall"]);
    expect(existsSync(join(home, ".agents/skills/recall-memory"))).toBe(false);
    expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false);
    expect(existsSync(configPath)).toBe(true);
  });

  it("does not touch a recall MCP server the user defined, and rejects broken hooks.json", async () => {
    mkdirSync(codexHome, { recursive: true });
    const config = '[mcp_servers.recall]\nurl = "https://recall.example/mcp"\n';
    writeFileSync(join(codexHome, "config.toml"), config);
    const res = await install();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("already defines [mcp_servers.recall]");
    expect(read("config.toml")).toBe(config);

    writeFileSync(join(codexHome, "hooks.json"), "{ nope");
    const broken = await install();
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("not valid JSON");
    expect(read("hooks.json")).toBe("{ nope");
  });
});

// ---------------------------------------------------------------------------
// Real Codex, when available
// ---------------------------------------------------------------------------

const codexBin = (() => {
  const candidate = process.env.CODEX_BIN || "codex";
  const res = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return res.status === 0 ? candidate : null;
})();

describe.skipIf(!codexBin)("codex: real `codex exec` turns", () => {
  let s: Served;
  let model: Awaited<ReturnType<typeof fakeModel>>;
  beforeAll(async () => {
    s = await startServer();
    model = await fakeModel("Noted: pnpm it is.");
    await seedMemory(s, "cx", "lucas", "Lucas");
  });
  afterAll(async () => {
    await model.stop();
    await s.stop();
  });

  const install = () =>
    run(process.execPath, [join(CODEX, "install.mjs")], { HOME: home, CODEX_HOME: codexHome });

  const providerConfig = () =>
    [
      'model = "fake-model"',
      'model_provider = "fake"',
      "",
      "[model_providers.fake]",
      'name = "Fake"',
      `base_url = "${model.url}"`,
      'wire_api = "responses"',
      'env_key = "FAKE_KEY"',
      "",
    ].join("\n");

  async function turn(prompt: string) {
    const work = mkdtempSync(join(tmpdir(), "recall-codex-work-"));
    const res = await run(
      codexBin!,
      ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", prompt],
      { HOME: home, CODEX_HOME: codexHome, FAKE_KEY: "x" },
      { cwd: work, timeoutMs: 120_000 },
    );
    rmSync(work, { recursive: true, force: true });
    const session = /session id: ([0-9a-f-]+)/.exec(res.stdout + res.stderr)?.[1];
    return { ...res, session };
  }

  const connect = () => {
    mkdirSync(join(home, ".recall"), { recursive: true });
    writeFileSync(
      join(home, ".recall/config.json"),
      JSON.stringify({ url: s.url, workspace: "cx", peer: "lucas" }),
    );
  };

  it("installer route: memory reaches the model and the turn is recorded", async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), providerConfig());
    connect();
    expect((await install()).code).toBe(0);
    const res = await turn("We use pnpm here.");
    expect(res.code, res.stderr).toBe(0);
    expect(res.session).toBeTruthy();
    expect(model.bodies.at(-1)).toContain("Lucas lives in Utrecht");
    expect((await messagesOf(s, "cx", `codex-${res.session}`)).map((m) => m.content)).toEqual([
      "We use pnpm here.",
      "Noted: pnpm it is.",
    ]);
  }, 180_000);

  it("plugin route: `codex plugin add` from this repository's marketplace", async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), providerConfig());
    connect();
    const base = { HOME: home, CODEX_HOME: codexHome };
    expect((await run(codexBin!, ["plugin", "marketplace", "add", REPO], base)).code).toBe(0);
    const added = await run(codexBin!, ["plugin", "add", "recall-memory@recall"], base);
    expect(added.code, added.stderr).toBe(0);
    const mcp = await run(codexBin!, ["mcp", "get", "recall", "--json"], base);
    expect(JSON.parse(mcp.stdout).transport.args).toEqual(["./scripts/mcp-bridge.mjs"]);
    const res = await turn("Deploys happen on Fridays.");
    expect(res.code, res.stderr).toBe(0);
    expect((await messagesOf(s, "cx", `codex-${res.session}`)).map((m) => m.content)).toEqual([
      "Deploys happen on Fridays.",
      "Noted: pnpm it is.",
    ]);
  }, 180_000);
});
