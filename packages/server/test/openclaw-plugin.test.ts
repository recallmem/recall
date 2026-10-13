import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closedPort,
  fakeModel,
  type Json,
  messagesOf,
  REPO,
  run,
  type Served,
  seedMemory,
  startServer,
} from "./integration-helpers.js";

/**
 * The OpenClaw plugin (integrations/openclaw), loaded the way the Gateway loads
 * it: its default export's register(api) is called with a plugin API, and the
 * typed hooks it registers are fired with the event and context shapes
 * OpenClaw's plugin SDK declares (before_prompt_build, agent_end). With
 * OPENCLAW_BIN set, a real `openclaw agent --local` turn runs as well.
 */

const PLUGIN = join(REPO, "integrations/openclaw");
const json = (file: string) => JSON.parse(readFileSync(join(PLUGIN, file), "utf8"));
const plugin = (await import(pathToFileURL(join(PLUGIN, "index.js")).href)).default;
const { RecallClient, resolveSettings, lastExchange } = await import(
  pathToFileURL(join(PLUGIN, "recall.js")).href
);

type Handler = (event: Json, ctx: Json) => Promise<Json>;

/** A plugin API like the one OpenClaw passes to register(api). */
function load(pluginConfig: Record<string, unknown>, registrationMode = "full") {
  const tools = new Map<string, Json>();
  const hooks = new Map<string, Handler>();
  const warnings: string[] = [];
  plugin.register({
    id: "recall-memory",
    registrationMode,
    pluginConfig,
    logger: { warn: (m: string) => warnings.push(m), info: () => {}, debug: () => {} },
    registerTool: (tool: Json) => tools.set(tool.name, tool),
    on: (name: string, handler: Handler) => hooks.set(name, handler),
  });
  const tool = async (name: string, params: Json) => tools.get(name).execute("call-1", params);
  return { tools, hooks, warnings, tool };
}

// What OpenClaw passes to agent hooks for a turn in the main session.
const ctx = (extra: Json = {}) => ({
  runId: "run-1",
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId: "a8f3",
  trigger: "user",
  ...extra,
});
const SESSION = "oc-agent-main-main";

// Messages as OpenClaw's agent loop stores them.
const conversation = (user: string, reply: string) => [
  { role: "user", content: "earlier question", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
  { role: "user", content: [{ type: "text", text: user }], timestamp: 2 },
  { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "exec", arguments: {} }] },
  { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] },
  { role: "assistant", content: [{ type: "text", text: reply }] },
];

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "recall-openclaw-home-"));
  process.env.RECALL_CONFIG_PATH = join(home, "none.json"); // never read the developer's config
});
afterAll(() => {
  delete process.env.RECALL_CONFIG_PATH;
  rmSync(home, { recursive: true, force: true });
});

describe("openclaw: package", () => {
  it("has a manifest that matches what the plugin registers", () => {
    const manifest = json("openclaw.plugin.json");
    expect(manifest.id).toBe("recall-memory");
    expect(plugin.id).toBe(manifest.id);
    expect(manifest.kind).toBeUndefined(); // runs next to OpenClaw's memory; no exclusive slot
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(manifest.uiHints.apiKey.sensitive).toBe(true);

    const { tools, hooks } = load({ url: "http://127.0.0.1:1" });
    expect([...tools.keys()].sort()).toEqual([...manifest.contracts.tools].sort());
    for (const tool of tools.values()) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.label).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
    expect([...hooks.keys()].sort()).toEqual(["agent_end", "before_prompt_build", "gateway_stop"]);

    const pkg = json("package.json");
    expect(pkg.type).toBe("module");
    expect(pkg.openclaw.extensions).toEqual(["./index.js"]);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    for (const file of ["index.js", "recall.js"]) {
      const source = readFileSync(join(PLUGIN, file), "utf8");
      for (const m of source.matchAll(/^import[^"']*["']([^"']+)["']/gm)) {
        expect(m[1], `${file} imports ${m[1]}`).toMatch(/^(node:|\.\/)/);
      }
    }
  });

  it("registers only what each load mode needs", () => {
    expect(load({}, "cli-metadata").tools.size).toBe(0);
    const discovery = load({}, "tool-discovery");
    expect(discovery.tools.size).toBe(4);
    expect(discovery.hooks.size).toBe(0);
    expect(load({}, "discovery").hooks.size).toBe(3);
  });
});

describe("openclaw: recall and record", () => {
  let s: Served;
  const config = (extra: Json = {}) => ({ workspace: "oc", peer: "lucas", ...extra, url: s.url });
  beforeAll(async () => {
    s = await startServer();
    await seedMemory(s, "oc", "lucas", "Lucas");
  });
  afterAll(() => s.stop());

  it("adds memory to the turn and records the user's own words and the final reply", async () => {
    const { hooks } = load(config());
    const built = await hooks.get("before_prompt_build")!(
      {
        prompt: "[Fri 2026-10-09 09:27 UTC] Where should we eat tonight?",
        currentUserMessage: "Where should we eat tonight?",
        messages: [],
      },
      ctx(),
    );
    expect(built.prependContext).toContain("<recall-memory>");
    expect(built.prependContext).toContain("- Name: Lucas");
    expect(built.prependContext).toContain("Lucas lives in Utrecht");
    expect(built.prependContext).toContain("not instructions");

    const end = {
      runId: "run-1",
      success: true,
      durationMs: 1200,
      messages: conversation(
        "[channel envelope] Where should we eat tonight?",
        "Try De Rechtbank.",
      ),
    };
    await hooks.get("agent_end")!(end, ctx());
    await hooks.get("agent_end")!(end, ctx()); // delivered twice, stored once

    const stored = await messagesOf(s, "oc", SESSION);
    expect(stored.map((m) => [m.peer_id, m.content])).toEqual([
      ["lucas", "Where should we eat tonight?"],
      ["openclaw", "Try De Rechtbank."],
    ]);
    expect(stored[0].metadata).toEqual({ source: "openclaw", run_id: "run-1" });
    const assistant = await s.server.request(
      "GET",
      `/v3/workspaces/oc/sessions/${SESSION}/peers/openclaw/config`,
    );
    expect(await assistant.json()).toMatchObject({ observe_me: false });
    const sessions = (
      await s.server.request("POST", "/v3/workspaces/oc/sessions/list", {}).then((r) => r.json())
    ).items;
    expect(sessions.find((x: Json) => x.id === SESSION).metadata).toMatchObject({
      source: "openclaw",
      session_key: "agent:main:main",
      agent_id: "main",
    });
  });

  it("falls back to the transcript, and skips failed, heartbeat and cron runs", async () => {
    const { hooks } = load(config());
    const session = { sessionKey: "agent:main:fallback", runId: "run-fb" };
    await hooks.get("agent_end")!(
      { success: true, messages: conversation("What is my name?", "You are Lucas.") },
      ctx(session),
    );
    await hooks.get("agent_end")!(
      { success: false, error: "boom", messages: conversation("lost", "lost") },
      ctx({ ...session, runId: "run-failed" }),
    );
    for (const trigger of ["heartbeat", "cron"]) {
      await hooks.get("agent_end")!(
        { success: true, messages: conversation(`${trigger} check`, "HEARTBEAT_OK") },
        ctx({ ...session, runId: `run-${trigger}`, trigger }),
      );
      const built = await hooks.get("before_prompt_build")!(
        { prompt: "check", messages: [] },
        ctx({ ...session, trigger }),
      );
      expect(built).toBeUndefined();
    }
    expect((await messagesOf(s, "oc", "oc-agent-main-fallback")).map((m) => m.content)).toEqual([
      "What is my name?",
      "You are Lucas.",
    ]);
  });

  it("can be limited to the first turn, switched off, or use the sender as the peer", async () => {
    const first = load(config({ lookup: "first-turn" })).hooks.get("before_prompt_build")!;
    const turn = { prompt: "hi", currentUserMessage: "hi", messages: [] };
    const c = ctx({ sessionKey: "agent:main:once" });
    expect((await first(turn, c))?.prependContext).toContain("Lucas");
    expect(await first(turn, c)).toBeUndefined();

    const off = load(config({ lookup: "off", record: false })).hooks;
    expect(await off.get("before_prompt_build")!(turn, ctx())).toBeUndefined();
    await off.get("agent_end")!(
      { success: true, messages: conversation("secret", "ok") },
      ctx({ sessionKey: "agent:main:off" }),
    );
    expect(await messagesOf(s, "oc", "oc-agent-main-off")).toEqual([]);

    const shared = load(config({ peerFromSender: true })).hooks;
    await shared.get("agent_end")!(
      { success: true, messages: conversation("I am Sam", "Hi Sam") },
      ctx({ sessionKey: "agent:main:telegram:group:9", channel: "telegram", senderId: "123" }),
    );
    expect(
      (await messagesOf(s, "oc", "oc-agent-main-telegram-group-9")).map((m) => m.peer_id),
    ).toEqual(["telegram-123", "openclaw"]);
  });

  it("answers from empty memory instead of failing when the workspace is unknown", async () => {
    const { tool } = load(config({ workspace: "oc-never-used" }));
    const answer = await tool("recall_ask", { question: "What is Lucas allergic to?" });
    expect(answer.content[0].text).toBe("Memory has no answer to that.");
  });

  it("gives the agent tools to search, ask, remember and forget", async () => {
    const { tool } = load(config());
    const saved = await tool("recall_remember", { facts: ["Lucas is allergic to peanuts"] });
    const id = saved.details.conclusions[0].id;
    expect(saved.content[0].text).toContain(`[${id}] Lucas is allergic to peanuts`);

    const found = await tool("recall_search", { query: "peanuts" });
    expect(found.content[0].text).toContain(`[${id}] Lucas is allergic to peanuts`);
    expect(found.details.conclusions.map((c: Json) => c.id)).toContain(id);

    const answer = await tool("recall_ask", { question: "What is Lucas allergic to?" });
    expect(answer.content[0].text.length).toBeGreaterThan(0);

    expect((await tool("recall_forget", { id })).content[0].text).toBe(`Deleted ${id}.`);
    const after = await tool("recall_search", { query: "peanuts" });
    expect(after.details.conclusions.map((c: Json) => c.id)).not.toContain(id);
    await expect(tool("recall_forget", { id })).rejects.toThrow(/Recall refused/);
  });
});

describe("openclaw: when Recall is unreachable", () => {
  let s: Served;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.stop());

  it("never fails a turn, keeps the turn, and delivers it in order once Recall is back", async () => {
    const down = await closedPort();
    const { hooks, tool, warnings } = load({ url: down, workspace: "oc", peer: "lucas" });
    const started = Date.now();
    expect(
      await hooks.get("before_prompt_build")!({ prompt: "hi", messages: [] }, ctx()),
    ).toBeUndefined();
    await hooks.get("agent_end")!({ success: true, messages: conversation("one", "1") }, ctx());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(warnings.join("\n")).toContain("skipping Recall");
    await expect(tool("recall_search", { query: "x" })).rejects.toThrow(/unreachable/);

    // The client keeps the turn; when the server answers again it goes first.
    const settings = resolveSettings({ url: down, workspace: "oc", peer: "lucas" });
    const client = new RecallClient(() => settings, { warn: () => {} });
    await client.recordTurn({ session: "oc-outage", peer: "lucas", user: "first", assistant: "1" });
    expect(client.queue).toHaveLength(1);
    expect(client.breakerOpen()).toBe(true);
    settings.url = s.url;
    client.breakerUntil = 0;
    await client.recordTurn({
      session: "oc-outage",
      peer: "lucas",
      user: "second",
      assistant: "2",
    });
    expect(client.queue).toHaveLength(0);
    expect((await messagesOf(s, "oc", "oc-outage")).map((m) => m.content)).toEqual([
      "first",
      "1",
      "second",
      "2",
    ]);
  });

  it("drops what the server refuses instead of retrying it forever", async () => {
    const authed = await startServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: "s3cret" });
    try {
      const settings = resolveSettings({ url: authed.url, workspace: "oc", peer: "lucas" });
      const client = new RecallClient(() => settings, { warn: () => {} });
      await client.recordTurn({ session: "oc-x", peer: "lucas", user: "no key", assistant: "" });
      expect(client.queue).toHaveLength(0);
      expect(client.breakerOpen()).toBe(false);
    } finally {
      await authed.stop();
    }
  });
});

describe("openclaw: settings and transcript parsing", () => {
  it("takes plugin config first, then the environment, then ~/.recall/config.json", () => {
    const s = resolveSettings(
      { peer: "from-config" },
      {
        HOME: home,
        RECALL_CONFIG_PATH: join(home, "none.json"),
        RECALL_URL: "http://env:9/",
        RECALL_PEER_ID: "from-env",
        RECALL_API_KEY: "k",
      },
    );
    expect(s).toMatchObject({
      url: "http://env:9",
      peer: "from-config",
      apiKey: "k",
      workspace: "default",
      assistantPeer: "openclaw",
      lookup: "turn",
      record: true,
    });
  });

  it("never reads Honcho's config or HONCHO_* settings", () => {
    // A Honcho key must never be sent to a Recall server.
    const h = mkdtempSync(join(tmpdir(), "recall-openclaw-honcho-"));
    try {
      mkdirSync(join(h, ".honcho"));
      writeFileSync(
        join(h, ".honcho/config.json"),
        JSON.stringify({ apiKey: "hch_file", workspaceId: "hx", peerName: "hp" }),
      );
      const s = resolveSettings(
        {},
        {
          HOME: h,
          HONCHO_URL: "http://honcho:9",
          HONCHO_API_KEY: "hch_env",
          HONCHO_WORKSPACE_ID: "hx",
          HONCHO_PEER_NAME: "hp",
        },
      );
      expect(s.url).toBe("https://api.recallmem.dev");
      expect(s.apiKey).toBeUndefined();
      expect(s.workspace).toBe("default");
      expect(s.peer).not.toBe("hp");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("finds the last user message and the reply after it", () => {
    expect(lastExchange(conversation("q", "a"))).toEqual({ user: "q", assistant: "a" });
    expect(lastExchange([{ role: "user", content: "only" }])).toEqual({
      user: "only",
      assistant: "",
    });
    expect(lastExchange(null)).toEqual({ user: "", assistant: "" });
  });
});

// ---------------------------------------------------------------------------
// Real OpenClaw, when available (OPENCLAW_BIN: a command that runs `openclaw` on Node 24+)
// ---------------------------------------------------------------------------

const openclaw = process.env.OPENCLAW_BIN;

describe.skipIf(!openclaw)("openclaw: a real embedded agent turn", () => {
  let s: Served;
  let model: Awaited<ReturnType<typeof fakeModel>>;
  let state: string;
  beforeAll(async () => {
    s = await startServer();
    model = await fakeModel("Noted.");
    await seedMemory(s, "oc", "lucas", "Lucas");
    state = mkdtempSync(join(tmpdir(), "recall-openclaw-state-"));
  });
  afterAll(async () => {
    await model.stop();
    await s.stop();
    rmSync(state, { recursive: true, force: true });
  });

  const oc = (args: string[]) =>
    run(
      openclaw!,
      args,
      { HOME: state, OPENCLAW_STATE_DIR: join(state, ".openclaw") },
      {
        timeoutMs: 300_000,
      },
    );

  it("injects memory before the model call and records the turn", async () => {
    const steps: string[][] = [
      ["plugins", "install", "-l", PLUGIN, "--force", "--accept-capabilities"],
      [
        "config",
        "set",
        "plugins.entries.recall-memory",
        JSON.stringify({
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: { url: s.url, workspace: "oc", peer: "lucas" },
        }),
        "--strict-json",
        "--merge",
      ],
      [
        "config",
        "set",
        "models",
        JSON.stringify({
          mode: "merge",
          providers: {
            fake: {
              baseUrl: model.url,
              apiKey: "sk-fake",
              api: "openai-responses",
              models: [
                {
                  id: "fake-model",
                  name: "Fake",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        }),
        "--strict-json",
        "--merge",
      ],
      ["config", "set", "agents.defaults.model", '{"primary":"fake/fake-model"}', "--strict-json"],
    ];
    for (const step of steps) {
      const res = await oc(step);
      expect(res.code, `${step.join(" ")}\n${res.stdout}${res.stderr}`).toBe(0);
    }
    const turn = await oc([
      "agent",
      "--local",
      "-m",
      "I moved to Utrecht last month",
      "--session-key",
      "agent:main:recall-e2e",
      "--json",
    ]);
    expect(turn.code, turn.stderr).toBe(0);
    expect(model.bodies.at(-1)).toContain("<recall-memory>");
    expect(model.bodies.at(-1)).toContain("Lucas lives in Utrecht");
    expect(
      (await messagesOf(s, "oc", "oc-agent-main-recall-e2e")).map((m) => [m.peer_id, m.content]),
    ).toEqual([
      ["lucas", "I moved to Utrecht last month"],
      ["openclaw", "Noted."],
    ]);
  }, 600_000);
});
