// Recall repo memory: a GitHub Action that gives a repository long-term memory in Recall
// (https://recallmem.dev). MIT licence. No dependencies: Node 24's fetch and the runner's files.
//
//   remember  stores what the triggering event says (a pull request, review, comment, issue,
//             discussion, release or push) as messages in a Recall session for that thread,
//             grouped under one scope per repository, so Recall learns what was decided and why.
//   ask       answers a question from that memory; on a new issue or pull request it can ask for
//             related history itself and post the answer as a comment.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Longest text kept from one body (the API takes 25,000 characters a message). */
const MAX_CHARS = 20_000;
/** Most of an issue or pull request quoted in the question about its history. */
const QUESTION_CHARS = 1_500;
const TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = "https://api.recallmem.dev";

// ---------------------------------------------------------------------------- runner plumbing

/** An input as the runner passes it (`INPUT_<NAME>`, upper case), trimmed; `fallback` when empty. */
export function input(env, name, fallback = "") {
  const v = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

const flag = (env, name, fallback) => {
  const v = input(env, name, String(fallback)).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
};

/** Workflow command data: `%`, CR and LF escaped. */
const escapeData = (s) =>
  String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function setOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [name, value] of Object.entries(outputs)) {
    const text = String(value ?? "");
    const delimiter = `recall_${randomBytes(12).toString("hex")}`;
    appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
  }
}

function summary(env, markdown) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// ---------------------------------------------------------------------------- events to messages

/** A Recall id part: letters, digits, `_` and `-` only. */
export const idPart = (s, max = 100) =>
  String(s)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "x";

/** The peer a GitHub account speaks as. */
export const peerOf = (login) => `gh-${idPart(login).toLowerCase()}`;

const isBot = (user) => !user?.login || user.type === "Bot" || /\[bot\]$/.test(user.login);

const clip = (text, max = MAX_CHARS) => {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const withBody = (head, body) => (clip(body) ? `${head}:\n\n${clip(body)}` : `${head}.`);

/**
 * What an event says, as messages for one thread: `{ thread, title, url, number, messages }`, or
 * null for an event (or action) with nothing to remember. `thread` names the session within the
 * repository: `pr-12`, `issue-7`, `discussion-3`, `commits-main` or `releases`.
 */
export function fromEvent(event, p, opts = {}) {
  const repo = p?.repository?.full_name ?? "";
  const msg = (user, content, at, url) =>
    !user?.login || (!opts.includeBots && isBot(user))
      ? null
      : {
          peer_id: peerOf(user.login),
          content,
          ...(at ? { created_at: at } : {}),
          metadata: { source: "github", repo, event, ...(url ? { url } : {}) },
        };
  const thread = (name, title, url, number, messages) => {
    const kept = messages.filter(Boolean);
    return kept.length ? { thread: name, title, url, number, messages: kept } : null;
  };
  const a = p?.action;

  switch (event) {
    case "pull_request":
    case "pull_request_target": {
      const pr = p.pull_request;
      if (!pr) return null;
      const name = `pull request #${pr.number} "${pr.title}"`;
      const at = (t) => thread(`pr-${pr.number}`, pr.title, pr.html_url, pr.number, t);
      if (a === "opened" || a === "reopened" || a === "ready_for_review") {
        const verb = a === "reopened" ? "Reopened" : "Opened";
        const branches =
          pr.head?.ref && pr.base?.ref ? ` (${pr.head.ref} into ${pr.base.ref})` : "";
        return at([
          msg(pr.user, withBody(`${verb} ${name}${branches}`, pr.body), pr.updated_at, pr.html_url),
        ]);
      }
      if (a === "closed") {
        if (pr.merged)
          return at([
            msg(
              pr.merged_by ?? p.sender,
              `Merged ${name} into ${pr.base?.ref ?? "the base branch"}.`,
              pr.merged_at,
              pr.html_url,
            ),
          ]);
        return at([msg(p.sender, `Closed ${name} without merging.`, pr.closed_at, pr.html_url)]);
      }
      return null;
    }
    case "pull_request_review": {
      const pr = p.pull_request;
      const r = p.review;
      if (!pr || !r || a !== "submitted") return null;
      const name = `pull request #${pr.number} "${pr.title}"`;
      const state = String(r.state ?? "").toLowerCase();
      const head =
        state === "approved"
          ? `Approved ${name}`
          : state === "changes_requested"
            ? `Requested changes on ${name}`
            : `Reviewed ${name}`;
      // A plain "commented" review without text only wraps inline comments, which come on their own.
      if (state !== "approved" && state !== "changes_requested" && !clip(r.body)) return null;
      return thread(`pr-${pr.number}`, pr.title, pr.html_url, pr.number, [
        msg(r.user, withBody(head, r.body), r.submitted_at, r.html_url),
      ]);
    }
    case "pull_request_review_comment": {
      const pr = p.pull_request;
      const c = p.comment;
      if (!pr || !c || a !== "created") return null;
      const where = c.path ? ` on ${c.path}` : "";
      return thread(`pr-${pr.number}`, pr.title, pr.html_url, pr.number, [
        msg(
          c.user,
          withBody(`Commented${where} in pull request #${pr.number} "${pr.title}"`, c.body),
          c.created_at,
          c.html_url,
        ),
      ]);
    }
    case "issues": {
      const i = p.issue;
      if (!i) return null;
      const name = `issue #${i.number} "${i.title}"`;
      const at = (t) => thread(`issue-${i.number}`, i.title, i.html_url, i.number, t);
      if (a === "opened")
        return at([msg(i.user, withBody(`Opened ${name}`, i.body), i.created_at, i.html_url)]);
      if (a === "reopened")
        return at([msg(p.sender, `Reopened ${name}.`, i.updated_at, i.html_url)]);
      if (a === "closed") {
        const why = i.state_reason === "not_planned" ? "not planned" : "completed";
        return at([msg(p.sender, `Closed ${name} as ${why}.`, i.closed_at, i.html_url)]);
      }
      return null;
    }
    case "issue_comment": {
      const i = p.issue;
      const c = p.comment;
      if (!i || !c || a !== "created") return null;
      const pr = !!i.pull_request;
      const kind = pr ? "pull request" : "issue";
      return thread(`${pr ? "pr" : "issue"}-${i.number}`, i.title, i.html_url, i.number, [
        msg(
          c.user,
          withBody(`Commented on ${kind} #${i.number} "${i.title}"`, c.body),
          c.created_at,
          c.html_url,
        ),
      ]);
    }
    case "discussion": {
      const d = p.discussion;
      if (!d || a !== "created") return null;
      const category = d.category?.name ? ` in ${d.category.name}` : "";
      return thread(`discussion-${d.number}`, d.title, d.html_url, d.number, [
        msg(
          d.user,
          withBody(`Started discussion #${d.number} "${d.title}"${category}`, d.body),
          d.created_at,
          d.html_url,
        ),
      ]);
    }
    case "discussion_comment": {
      const d = p.discussion;
      const c = p.comment;
      if (!d || !c || a !== "created") return null;
      return thread(`discussion-${d.number}`, d.title, d.html_url, d.number, [
        msg(
          c.user,
          withBody(`Commented on discussion #${d.number} "${d.title}"`, c.body),
          c.created_at,
          c.html_url,
        ),
      ]);
    }
    case "push": {
      if (p.deleted || !String(p.ref ?? "").startsWith("refs/heads/")) return null;
      const branch = p.ref.slice("refs/heads/".length);
      const commits = (p.commits ?? []).filter(
        (c) =>
          c.distinct !== false &&
          !/^Merge (pull request|branch|remote-tracking branch) /.test(c.message ?? ""),
      );
      return thread(
        `commits-${idPart(branch, 60)}`,
        `Commits to ${branch}`,
        p.compare,
        null,
        commits.map((c) =>
          msg(
            c.author?.username ? { login: c.author.username } : null,
            `Committed ${String(c.id ?? "").slice(0, 7)} to ${branch}: ${clip(c.message)}`,
            c.timestamp,
            c.url,
          ),
        ),
      );
    }
    case "release": {
      const r = p.release;
      if (!r || a !== "published") return null;
      const name = r.name && r.name !== r.tag_name ? ` "${r.name}"` : "";
      return thread("releases", "Releases", r.html_url, null, [
        msg(
          r.author,
          withBody(`Published release ${r.tag_name}${name}`, r.body),
          r.published_at,
          r.html_url,
        ),
      ]);
    }
    default:
      return null;
  }
}

/** The issue or pull request an event is about: `{ kind, number, title, body }`, or null. */
export function subjectOf(p) {
  const pr = p?.pull_request;
  if (pr) return { kind: "pull request", number: pr.number, title: pr.title, body: pr.body ?? "" };
  const i = p?.issue;
  if (i)
    return {
      kind: i.pull_request ? "pull request" : "issue",
      number: i.number,
      title: i.title,
      body: i.body ?? "",
    };
  return null;
}

/** The question asked when `ask` has none: what earlier work relates to this issue or pull request. */
export function historyQuestion(repo, s) {
  const body = clip(s.body, QUESTION_CHARS);
  return (
    `A ${s.kind} was opened in ${repo}: #${s.number} "${s.title}".${body ? `\n\n${body}` : ""}\n\n` +
    "Which earlier issues, pull requests, reviews or decisions in this repository are relevant to it? " +
    "Name each by its number with one line on why it matters. If nothing relevant is known, say so."
  );
}

// ---------------------------------------------------------------------------- Recall and GitHub

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** A setting that cannot work: always fails the step, whatever `fail-on-error` says. */
class ConfigError extends Error {}

async function call(cfg, method, path, body, headers = {}) {
  const res = await cfg.fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      "user-agent": "recall-memory-action/1",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const detail = typeof json?.detail === "string" ? json.detail : text.slice(0, 300);
    throw new HttpError(
      `Recall answered ${res.status} to ${method} ${path}: ${detail}`,
      res.status,
    );
  }
  return json;
}

const seg = encodeURIComponent;

async function remember(cfg, found) {
  const ws = seg(cfg.workspace);
  const session = idPart(`${cfg.scope}-${found.thread}`, 200);
  await call(cfg, "POST", "/v3/workspaces", { id: cfg.workspace });
  await call(cfg, "POST", `/v3/workspaces/${ws}/sessions`, {
    id: session,
    scopes: [cfg.scope],
    metadata: {
      source: "github",
      repo: cfg.repo,
      title: clip(found.title, 300),
      ...(found.url ? { url: found.url } : {}),
    },
  });
  // The same event delivered again (a re-run) is stored once.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        cfg.repo,
        session,
        found.messages.map((m) => [m.peer_id, m.content, m.created_at]),
      ]),
    )
    .digest("hex");
  const stored = await call(
    cfg,
    "POST",
    `/v3/workspaces/${ws}/sessions/${seg(session)}/messages`,
    { messages: found.messages },
    { "idempotency-key": `github-action-${key.slice(0, 48)}` },
  );
  return { session, count: Array.isArray(stored) ? stored.length : found.messages.length };
}

async function ask(cfg, question, level) {
  try {
    const r = await call(cfg, "POST", `/v3/workspaces/${seg(cfg.workspace)}/chat`, {
      query: question,
      scope: cfg.scope,
      reasoning_level: level,
    });
    return {
      answer: String(r?.content ?? ""),
      abstained: r?.abstained === true || !String(r?.content ?? "").trim(),
      confidence: r?.confidence ?? "",
    };
  } catch (err) {
    // Nothing remembered for this repository yet (no workspace or scope): an empty memory.
    if (err instanceof HttpError && err.status === 404)
      return { answer: "", abstained: true, confidence: "" };
    throw err;
  }
}

async function comment(cfg, number, text) {
  const res = await cfg.fetch(`${cfg.githubApi}/repos/${cfg.repo}/issues/${number}/comments`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${cfg.githubToken}`,
      "content-type": "application/json",
      "user-agent": "recall-memory-action/1",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok)
    throw new HttpError(
      `GitHub answered ${res.status} when commenting on #${number} (does the job have issues: write and pull-requests: write?)`,
      res.status,
    );
}

// ---------------------------------------------------------------------------- the action

/**
 * Runs the action with the runner's environment. Returns the outputs it set; throws on a failure
 * the caller reports (an error, or a warning when `fail-on-error` is off).
 */
export async function run(env = process.env, fetchImpl = globalThis.fetch) {
  const apiKey = input(env, "api-key");
  // Workflows started from a fork get no secrets: that is a skip, not a broken setting.
  if (!apiKey)
    throw new Error(
      "No api-key: set it from a secret (create a key at https://app.recallmem.dev/keys). Runs from forks get no secrets.",
    );
  const baseUrl = input(env, "base-url", DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl))
    throw new ConfigError("base-url must be an https:// address");
  const repo = env.GITHUB_REPOSITORY ?? "";
  const mode = input(env, "mode", "remember").toLowerCase();
  if (mode !== "remember" && mode !== "ask")
    throw new ConfigError(`mode must be remember or ask, not ${mode}`);
  const cfg = {
    apiKey,
    baseUrl,
    repo,
    workspace: idPart(input(env, "workspace", "github")),
    scope: idPart(input(env, "scope", repo.replace("/", "-") || "repository"), 500),
    githubApi: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    githubToken: input(env, "github-token"),
    fetch: fetchImpl,
  };
  const event = env.GITHUB_EVENT_NAME ?? "";
  let payload = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    } catch {}
  }

  if (mode === "remember") {
    const text = input(env, "text");
    const found = text
      ? {
          thread: idPart(input(env, "thread", "notes"), 100),
          title: "Notes",
          url: null,
          number: null,
          messages: [
            {
              peer_id: input(env, "peer")
                ? idPart(input(env, "peer"))
                : peerOf(env.GITHUB_ACTOR ?? "github"),
              content: clip(text),
              metadata: { source: "github", repo, event },
            },
          ],
        }
      : fromEvent(event, payload, { includeBots: flag(env, "include-bots", false) });
    if (!found) {
      console.log(
        `Nothing to remember from this ${event || "run"}${payload.action ? ` (${payload.action})` : ""}.`,
      );
      const outputs = { remembered: 0, session: "" };
      setOutputs(env, outputs);
      return outputs;
    }
    const r = await remember(cfg, found);
    console.log(
      `Remembered ${r.count} message${r.count === 1 ? "" : "s"} in ${cfg.workspace}/${r.session} (scope ${cfg.scope}).`,
    );
    const outputs = { remembered: r.count, session: r.session };
    setOutputs(env, outputs);
    return outputs;
  }

  // ask
  const subject = subjectOf(payload);
  const question = input(env, "question") || (subject ? historyQuestion(repo, subject) : "");
  if (!question)
    throw new ConfigError(
      "question is required in ask mode (or run on an issue or pull request event)",
    );
  const level = input(env, "reasoning-level", "low").toLowerCase();
  const r = await ask(cfg, question, level);
  const outputs = { answer: r.answer, abstained: r.abstained, confidence: r.confidence };
  setOutputs(env, outputs);
  console.log(r.abstained ? "Recall has nothing relevant yet." : r.answer);
  summary(
    env,
    `### Recall\n\n> ${question.split("\n")[0]}\n\n${r.abstained ? "_Nothing relevant remembered yet._" : r.answer}`,
  );
  if (flag(env, "post-comment", false) && subject && !r.abstained) {
    if (!cfg.githubToken) throw new ConfigError("post-comment needs github-token");
    await comment(
      cfg,
      subject.number,
      `${r.answer}\n\n<sub>From this repository's memory in [Recall](https://recallmem.dev), via [recall-memory-action](https://github.com/recallmem/memory-action).</sub>`,
    );
    console.log(`Commented on #${subject.number}.`);
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const key = input(env, "api-key");
  if (key) console.log(`::add-mask::${key}`);
  run(env).catch((err) => {
    const message = escapeData(err?.message ?? String(err));
    if (err instanceof ConfigError || flag(env, "fail-on-error", false)) {
      console.log(`::error title=Recall::${message}`);
      process.exitCode = 1;
    } else {
      console.log(`::warning title=Recall::${message}`);
    }
  });
}
