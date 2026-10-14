import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Browser, createHostedServer } from "./hosted-helpers.js";
import {
  closedPort,
  type Json,
  messagesOf,
  REPO,
  run,
  type Served,
  startServer,
} from "./integration-helpers.js";

/**
 * The GitHub Action (integrations/github-action), run the way a runner runs it: `node index.mjs`
 * with the event payload in GITHUB_EVENT_PATH, inputs as INPUT_* variables and outputs written to
 * GITHUB_OUTPUT, against a real Recall server. GitHub's REST API (for comments) is a local stub.
 */

const ACTION = join(REPO, "integrations/github-action");
const ENTRY = join(ACTION, "index.mjs");
const action = await import(pathToFileURL(ENTRY).href);

let s: Served;
let github: Server;
let githubUrl: string;
const comments: { path: string; auth: string | null; body: Json }[] = [];
let dir: string;
let n = 0;

beforeAll(async () => {
  s = await startServer();
  github = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      comments.push({
        path: req.url ?? "",
        auth: req.headers.authorization ?? null,
        body: JSON.parse(body || "{}"),
      });
      res.writeHead(201, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", () => resolve()));
  githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), "recall-action-"));
});
afterAll(async () => {
  github.close();
  await s.stop();
  rmSync(dir, { recursive: true, force: true });
});

const repository = { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } };
const alice = { login: "alice", type: "User" };
const bob = { login: "Bob-B", type: "User" };
const pr = {
  number: 12,
  title: "Retry uploads",
  body: "Uploads time out on slow links. We retry three times with backoff instead of failing.",
  html_url: "https://github.com/acme/widgets/pull/12",
  user: alice,
  head: { ref: "retry" },
  base: { ref: "main" },
  updated_at: "2026-10-01T09:00:00Z",
};

/** Env for one run: the runner's variables, the event, and the inputs (`api-key` etc.). */
function envFor(event: string, payload: Json, inputs: Record<string, string>, base = s.url) {
  const file = join(dir, `event-${++n}.json`);
  writeFileSync(file, JSON.stringify({ repository, ...payload }));
  const output = join(dir, `output-${n}`);
  writeFileSync(output, "");
  const env: Record<string, string> = {
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: file,
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_ACTOR: "alice",
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(dir, `summary-${n}`),
    GITHUB_API_URL: githubUrl,
    "INPUT_API-KEY": "rk_test_secret_key",
    "INPUT_BASE-URL": base,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return { env, output };
}

/** GITHUB_OUTPUT's `name<<delimiter` blocks as an object. */
function outputsOf(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) out[m[1]!] = m[3]!;
  return out;
}

async function act(
  event: string,
  payload: Json,
  inputs: Record<string, string> = {},
  base?: string,
) {
  const { env, output } = envFor(event, payload, inputs, base);
  const r = await run(process.execPath, [ENTRY], env);
  return { ...r, outputs: outputsOf(output) };
}

const contents = async (session: string) =>
  (await messagesOf(s, "github", session)).map((m: Json) => [m.peer_id, m.content]);

describe("remember", () => {
  it("stores an opened pull request in its own session, under the repository's scope", async () => {
    const r = await act("pull_request", { action: "opened", pull_request: pr, sender: alice });
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({ remembered: "1", session: "acme-widgets-pr-12" });
    expect(await contents("acme-widgets-pr-12")).toEqual([
      ["gh-alice", `Opened pull request #12 "Retry uploads" (retry into main):\n\n${pr.body}`],
    ]);
    const [m] = await messagesOf(s, "github", "acme-widgets-pr-12");
    expect(m.metadata).toMatchObject({ source: "github", repo: "acme/widgets", url: pr.html_url });
    const scoped = await s.server.request(
      "POST",
      "/v3/workspaces/github/scopes/acme-widgets/sessions/list",
      {},
    );
    expect((await scoped.json()).items.map((x: Json) => x.id)).toContain("acme-widgets-pr-12");
    // The key is masked in the log and printed nowhere else.
    expect(r.stdout).toContain("::add-mask::rk_test_secret_key");
    expect(r.stdout.split("rk_test_secret_key").length).toBe(2);
  });

  it("stores a re-run of the same event once", async () => {
    const r = await act("pull_request", { action: "opened", pull_request: pr, sender: alice });
    expect(r.code).toBe(0);
    expect(await contents("acme-widgets-pr-12")).toHaveLength(1);
  });

  it("adds reviews and comments to the pull request's session, and leaves bots out", async () => {
    await act("pull_request_review", {
      action: "submitted",
      pull_request: pr,
      review: {
        state: "approved",
        body: "Backoff caps at 30s, good.",
        user: bob,
        submitted_at: "2026-10-01T10:00:00Z",
        html_url: `${pr.html_url}#review-1`,
      },
    });
    const bot = await act("issue_comment", {
      action: "created",
      issue: { number: 12, title: pr.title, html_url: pr.html_url, pull_request: {} },
      comment: {
        body: "Coverage 91%",
        user: { login: "codecov[bot]", type: "Bot" },
        created_at: "2026-10-01T10:05:00Z",
      },
    });
    expect(bot.outputs.remembered).toBe("0");
    await act("issue_comment", {
      action: "created",
      issue: { number: 12, title: pr.title, html_url: pr.html_url, pull_request: {} },
      comment: { body: "Shipping this in 2.4.", user: alice, created_at: "2026-10-01T10:10:00Z" },
    });
    await act("pull_request", {
      action: "closed",
      pull_request: { ...pr, merged: true, merged_by: bob, merged_at: "2026-10-01T11:00:00Z" },
      sender: bob,
    });
    expect(await contents("acme-widgets-pr-12")).toEqual([
      ["gh-alice", expect.stringMatching(/^Opened pull request #12/)],
      ["gh-bob-b", 'Approved pull request #12 "Retry uploads":\n\nBackoff caps at 30s, good.'],
      ["gh-alice", 'Commented on pull request #12 "Retry uploads":\n\nShipping this in 2.4.'],
      ["gh-bob-b", 'Merged pull request #12 "Retry uploads" into main.'],
    ]);
  });

  it("stores issues, pushed commits without merge commits, and a note from a manual run", async () => {
    await act("issues", {
      action: "opened",
      issue: {
        number: 31,
        title: "Uploads time out",
        body: "On hotel wifi every upload fails.",
        user: bob,
        html_url: "https://github.com/acme/widgets/issues/31",
        created_at: "2026-10-02T08:00:00Z",
      },
    });
    expect(await contents("acme-widgets-issue-31")).toEqual([
      ["gh-bob-b", 'Opened issue #31 "Uploads time out":\n\nOn hotel wifi every upload fails.'],
    ]);

    const push = await act("push", {
      ref: "refs/heads/main",
      compare: "https://github.com/acme/widgets/compare/a...b",
      commits: [
        {
          id: "abc1234def",
          message: "Cap upload backoff at 30s",
          author: { username: "alice" },
          timestamp: "2026-10-02T09:00:00Z",
        },
        {
          id: "def5678abc",
          message: "Merge pull request #12 from acme/retry",
          author: { username: "bob-b" },
        },
      ],
    });
    expect(push.outputs).toEqual({ remembered: "1", session: "acme-widgets-commits-main" });
    expect(await contents("acme-widgets-commits-main")).toEqual([
      ["gh-alice", "Committed abc1234 to main: Cap upload backoff at 30s"],
    ]);

    const note = await act("workflow_dispatch", {}, { text: "We support Node 22 and later only." });
    expect(note.outputs.session).toBe("acme-widgets-notes");
    expect(await contents("acme-widgets-notes")).toEqual([
      ["gh-alice", "We support Node 22 and later only."],
    ]);
  });

  it("passes over events with nothing to remember", async () => {
    const r = await act("pull_request", { action: "labeled", pull_request: pr });
    expect(r.code).toBe(0);
    expect(r.outputs).toEqual({ remembered: "0", session: "" });
    expect(r.stdout).toContain("Nothing to remember");
  });
});

describe("ask", () => {
  const issue = {
    number: 31,
    title: "Uploads time out",
    body: "On hotel wifi every upload fails.",
    user: bob,
    html_url: "https://github.com/acme/widgets/issues/31",
  };

  /** Runs in-process with Recall's chat answered by `answer`; everything else reaches the server. */
  async function ask(inputs: Record<string, string>, answer: Json) {
    const { env, output } = envFor(
      "issues",
      { action: "opened", issue },
      { mode: "ask", ...inputs },
    );
    const chats: Json[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      if (url.endsWith("/v3/workspaces/github/chat")) {
        chats.push(JSON.parse(String(init.body)));
        return Response.json(answer);
      }
      return fetch(url, init);
    };
    const outputs = await action.run(env, fetchImpl);
    return {
      outputs,
      chats,
      written: outputsOf(output),
      summary: readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"),
    };
  }

  it("asks the repository's memory what relates to a new issue, and comments the answer", async () => {
    const before = comments.length;
    const r = await ask(
      { "post-comment": "true", "github-token": "ghs_token" },
      {
        content: "#12 added retries with backoff for slow uploads.",
        abstained: false,
        confidence: 0.8,
      },
    );
    expect(r.chats).toHaveLength(1);
    expect(r.chats[0]).toMatchObject({ scope: "acme-widgets", reasoning_level: "low" });
    expect(r.chats[0].query).toContain('#31 "Uploads time out"');
    expect(r.chats[0].query).toContain("On hotel wifi every upload fails.");
    expect(r.written).toEqual({
      answer: "#12 added retries with backoff for slow uploads.",
      abstained: "false",
      confidence: "0.8",
    });
    expect(r.summary).toContain("#12 added retries");
    const posted = comments.slice(before);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      path: "/repos/acme/widgets/issues/31/comments",
      auth: "Bearer ghs_token",
    });
    expect(posted[0]!.body.body).toMatch(
      /^#12 added retries with backoff for slow uploads\.\n\n<sub>/,
    );
  });

  it("posts nothing when nothing relevant is known, and takes a question of its own", async () => {
    const before = comments.length;
    const r = await ask(
      {
        "post-comment": "true",
        "github-token": "ghs_token",
        question: "Why do we retry uploads?",
        "reasoning-level": "medium",
      },
      { content: "I don't know.", abstained: true, confidence: 0 },
    );
    expect(r.chats[0]).toMatchObject({
      query: "Why do we retry uploads?",
      reasoning_level: "medium",
    });
    expect(r.outputs.abstained).toBe(true);
    expect(comments.length).toBe(before);
  });

  it("answers from the real server, with an empty memory for a repository it has never seen", async () => {
    const r = await act(
      "issues",
      { action: "opened", issue },
      { mode: "ask", scope: "never-seen" },
    );
    expect(r.code).toBe(0);
    expect(r.outputs.abstained).toBe("true");
  });
});

describe("on the hosted service", () => {
  it("works with an account key from the dashboard", async () => {
    const hosted = await createHostedServer({ env: { RECALL_SIGNUP_ENABLED: "true" } });
    try {
      const b = new Browser(hosted.app, "198.51.100.60");
      await b.signIn(hosted, "maintainer@example.com");
      const { key } = await b.createKey({ name: "github" });
      const { env } = envFor(
        "pull_request",
        { action: "opened", pull_request: pr },
        {
          "api-key": key!,
          "base-url": "https://recall.test",
        },
      );
      const viaApp = async (url: string, init: RequestInit) =>
        hosted.app.request(url.replace("https://recall.test", ""), init);
      expect(await action.run(env, viaApp)).toEqual({
        remembered: 1,
        session: "acme-widgets-pr-12",
      });
      const auth = { authorization: `Bearer ${key}` };
      const listed = await hosted.api(
        "POST",
        "/v3/workspaces/github/scopes/acme-widgets/sessions/list",
        {},
        auth,
      );
      expect((await listed.json()).items.map((x: Json) => x.id)).toEqual(["acme-widgets-pr-12"]);
    } finally {
      await hosted.close();
    }
  });
});

describe("failures", () => {
  it("warns instead of failing the job when Recall cannot be reached, unless told to fail", async () => {
    const down = await closedPort();
    const soft = await act("pull_request", { action: "opened", pull_request: pr }, {}, down);
    expect(soft.code).toBe(0);
    expect(soft.stdout).toContain("::warning title=Recall::");
    const hard = await act(
      "pull_request",
      { action: "opened", pull_request: pr },
      { "fail-on-error": "true" },
      down,
    );
    expect(hard.code).toBe(1);
    expect(hard.stdout).toContain("::error title=Recall::");
  });

  it("skips a run without a key (a fork gets no secrets) but fails a broken setting", async () => {
    const { env } = envFor(
      "pull_request",
      { action: "opened", pull_request: pr },
      { "api-key": "" },
    );
    const noKey = await run(process.execPath, [ENTRY], env);
    expect(noKey.code).toBe(0);
    expect(noKey.stdout).toContain("No api-key");
    const bad = await act(
      "pull_request",
      { action: "opened", pull_request: pr },
      { mode: "forget" },
    );
    expect(bad.code).toBe(1);
    const plain = await act(
      "pull_request",
      { action: "opened", pull_request: pr },
      {},
      "http://recall.example",
    );
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain("https://");
  });

  it("has an action.yml that GitHub can read and list on the Marketplace", () => {
    // Invalid YAML hides the "Publish to GitHub Marketplace" option and breaks every workflow
    // that uses the action, so the file is parsed, not pattern-matched.
    const meta = parse(readFileSync(join(ACTION, "action.yml"), "utf8"));
    expect(meta.name).toBe("Recall repo memory");
    // The release form refuses a description of 125 characters or more.
    expect(meta.description.length).toBeLessThan(125);
    expect(meta.branding).toEqual({ icon: "database", color: "orange" });
    expect(meta.runs).toEqual({ using: "node24", main: "index.mjs" });
    for (const [name, spec] of Object.entries<Json>(meta.inputs))
      expect(typeof spec.description, name).toBe("string");
    for (const [name, spec] of Object.entries<Json>(meta.outputs))
      expect(typeof spec.description, name).toBe("string");
    const source = readFileSync(ENTRY, "utf8");
    const read = new Set(
      [...source.matchAll(/(?:input|flag)\(env, "([a-z-]+)"/g)].map((m) => m[1]!),
    );
    expect([...read].filter((name) => !(name in meta.inputs))).toEqual([]);
  });
});
