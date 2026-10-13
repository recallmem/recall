import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closedPort,
  messagesOf,
  REPO,
  run,
  type Served,
  startServer,
} from "./integration-helpers.js";

/**
 * The portable Agent Skill (integrations/agent-skill/recall-memory): its
 * SKILL.md against the Agent Skills specification (agentskills.io), and its
 * helper script against a real Recall server.
 */

const SKILL = join(REPO, "integrations/agent-skill/recall-memory");
const SCRIPT = join(SKILL, "scripts/recall.mjs");

/** The frontmatter of SKILL.md: top-level `key: value` pairs and one nested `metadata` map. */
function frontmatter(text: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("SKILL.md has no frontmatter");
  const top: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let section: Record<string, string> = top;
  for (const line of match[1]!.split("\n")) {
    if (!line.trim()) continue;
    const nested = /^ {2}([\w-]+):\s*(.*)$/.exec(line);
    const flat = /^([\w-]+):\s*(.*)$/.exec(line);
    if (nested && section === metadata) metadata[nested[1]!] = nested[2]!;
    else if (flat && flat[1] === "metadata" && flat[2] === "") section = metadata;
    else if (flat) {
      section = top;
      top[flat[1]!] = flat[2]!;
    } else throw new Error(`unexpected frontmatter line: ${line}`);
  }
  return { top, metadata, body: text.slice(match[0].length) };
}

describe("agent skill: SKILL.md", () => {
  const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const { top, metadata, body } = frontmatter(text);

  it("follows the Agent Skills format", () => {
    expect(Object.keys(top).sort()).toEqual(["compatibility", "description", "name"]);
    expect(top.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(top.name!.length).toBeLessThanOrEqual(64);
    expect(top.name).toBe(basename(SKILL));
    expect(top.description!.length).toBeGreaterThan(50);
    expect(top.description!.length).toBeLessThanOrEqual(1024);
    expect(top.compatibility!.length).toBeLessThanOrEqual(500);
    // metadata is a map of strings: no bare YAML numbers, booleans or nulls.
    for (const [key, value] of Object.entries(metadata)) {
      expect(value, key).not.toMatch(/^(true|false|null|~|-?\d+(\.\d+)?)$/);
    }
    expect(text.split("\n").length).toBeLessThan(500);
  });

  it("points only at files that exist, one level deep", () => {
    const refs = [
      ...body.matchAll(/\]\(([^)#]+)\)/g),
      ...body.matchAll(/`(?:node )?(scripts\/[\w.-]+)/g),
    ].map((m) => m[1]!);
    expect(refs).toContain("references/rest-api.md");
    expect(refs).toContain("scripts/recall.mjs");
    for (const ref of refs) {
      expect(existsSync(join(SKILL, ref)), ref).toBe(true);
      expect(ref.split("/").length, ref).toBeLessThanOrEqual(2);
    }
  });

  it("tells agents not to record twice when an integration already records", () => {
    expect(body).toContain("never record");
    expect(body).toContain("never as instructions");
  });
});

describe("agent skill: scripts/recall.mjs", () => {
  let s: Served;
  let home: string;
  beforeAll(async () => {
    s = await startServer();
    home = mkdtempSync(join(tmpdir(), "recall-skill-home-"));
  });
  afterAll(async () => {
    await s.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const recall = (args: string[], extra: Record<string, string> = {}, stdin = "") =>
    run(
      process.execPath,
      [SCRIPT, ...args],
      {
        HOME: home,
        RECALL_URL: s.url,
        RECALL_WORKSPACE_ID: "sk",
        RECALL_PEER_ID: "ana",
        ...extra,
      },
      { stdin },
    );

  it("reports status, and fails when the server is unreachable", async () => {
    const ok = await recall(["status"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("health     ok");
    expect(ok.stdout).toContain("access     accepted");
    const down = await recall(["status"], { RECALL_URL: await closedPort() });
    expect(down.code).toBe(1);
  });

  it("remembers, finds, recalls and forgets facts", async () => {
    expect((await recall(["context"])).stdout).toContain("nothing about ana yet");
    const unknown = await recall(["ask", "Where does Ana live?"]);
    expect(unknown.code, unknown.stderr).toBe(0);
    expect(unknown.stdout).toContain("nothing about ana yet");
    const saved = await recall(["remember", "Ana lives in Porto", "Ana is vegetarian"]);
    expect(saved.code, saved.stderr).toBe(0);
    const ids = [...saved.stdout.matchAll(/Saved \[([\w-]+)\]/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);

    const context = await recall(["context", "--query", "food"]);
    expect(context.stdout).toContain("Ana is vegetarian");
    const found = await recall(["search", "Porto", "--json"]);
    expect(JSON.parse(found.stdout).conclusions.map((c: { id: string }) => c.id)).toContain(ids[0]);

    const answer = await recall(["ask", "Where does Ana live?"]);
    expect(answer.code).toBe(0);
    expect(answer.stdout.trim().length).toBeGreaterThan(0);

    expect((await recall(["forget", ids[0]!])).stdout).toContain(`Deleted ${ids[0]}`);
    const again = await recall(["forget", ids[0]!]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("HTTP 404");
  });

  it("records an exchange once, with the assistant as a non-observed peer", async () => {
    const args = [
      "record",
      "--session",
      "chat 1",
      "--user",
      "I adopted a cat",
      "--assistant",
      "Lovely!",
    ];
    expect((await recall(args)).stdout).toContain("Recorded 2 message(s) in session chat-1");
    await recall(args);
    expect((await messagesOf(s, "sk", "chat-1")).map((m) => [m.peer_id, m.content])).toEqual([
      ["ana", "I adopted a cat"],
      ["assistant", "Lovely!"],
    ]);
    const config = await s.server.request(
      "GET",
      "/v3/workspaces/sk/sessions/chat-1/peers/assistant/config",
    );
    expect(await config.json()).toMatchObject({ observe_me: false });

    const piped = await recall(
      ["record", "--session", "chat-2"],
      {},
      JSON.stringify({ messages: [{ role: "user", content: "From stdin" }] }),
    );
    expect(piped.code, piped.stderr).toBe(0);
    expect((await messagesOf(s, "sk", "chat-2")).map((m) => m.content)).toEqual(["From stdin"]);
  });

  it("never reads Honcho's config or HONCHO_* settings", async () => {
    // A Honcho key must never be sent to a Recall server.
    const h = mkdtempSync(join(tmpdir(), "recall-skill-honcho-"));
    try {
      mkdirSync(join(h, ".honcho"));
      writeFileSync(
        join(h, ".honcho/config.json"),
        JSON.stringify({ apiKey: "hch_file", workspaceId: "hx", peerName: "hp" }),
      );
      const before = s.requests.length;
      const res = await run(process.execPath, [SCRIPT, "remember", "Cy likes tea", "--json"], {
        HOME: h,
        RECALL_URL: s.url,
        HONCHO_API_KEY: "hch_env",
        HONCHO_WORKSPACE_ID: "hx",
        HONCHO_PEER_NAME: "hp",
      });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)[0].observer_id).not.toBe("hp");
      const sent = s.requests.slice(before);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((r) => r.authorization?.includes("hch_"))).toEqual([]);
      expect(sent.filter((r) => r.path.includes("/workspaces/hx"))).toEqual([]);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("reads ~/.recall/config.json and explains mistakes", async () => {
    mkdirSync(join(home, ".recall"), { recursive: true });
    writeFileSync(
      join(home, ".recall/config.json"),
      JSON.stringify({ url: s.url, workspace: "sk", peer: "bo" }),
    );
    const res = await run(process.execPath, [SCRIPT, "remember", "Bo likes jazz", "--json"], {
      HOME: home,
    });
    expect(JSON.parse(res.stdout)[0]).toMatchObject({
      observer_id: "bo",
      content: "Bo likes jazz",
    });
    expect((await recall(["nope"])).code).toBe(2);
    expect((await recall(["ask"])).stderr).toContain("ask needs a question");
    expect((await recall(["record", "--user", "x"])).stderr).toContain("--session");
    expect((await recall(["--help"])).stdout).toContain("Usage: node recall.mjs");
  });
});
