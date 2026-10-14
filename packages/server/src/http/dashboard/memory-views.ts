import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { formatUsd } from "../../billing/ledger.js";
import { type ChatLevel, LEVELS } from "../../recall/prompts.js";
import type { ConclusionRow } from "../../recall/search.js";
import type {
  AskOutcome,
  CardSource,
  Checklist,
  ContextParams,
  ContextResult,
  FactQuery,
  FactsView,
  MessageRef,
  PeerListItem,
  PeerView,
  QueueView,
  SessionListItem,
  SessionView,
  TranscriptMessage,
  WebhookView,
  WsStats,
} from "./explorer.js";
import { dashPath } from "./paths.js";

/**
 * Templates for the memory explorer and the playground (hono/html escapes every
 * interpolation). Pages work without JavaScript; <base>/static/app.js only adds
 * copy buttons and submits pickers on change.
 */

type H = HtmlEscapedString | Promise<HtmlEscapedString>;
type Q = Record<string, string | number | null | undefined>;

const csrfField = (token: string) => html`<input type="hidden" name="_csrf" value="${token}" />`;

// ---------------------------------------------------------------------------
// Small helpers

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const stamp = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

/** "4m ago", "3h ago", "2d ago", else the date. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return iso.slice(0, 10);
}

const enc = encodeURIComponent;
export const wsHref = (ws: string) => dashPath(`/memory/${enc(ws)}`);
export const peerHref = (ws: string, peer: string) => `${wsHref(ws)}/peers/${enc(peer)}`;
export const sessionHref = (ws: string, s: string) => `${wsHref(ws)}/sessions/${enc(s)}`;
export const messageHref = (ws: string, s: string, id: string) =>
  `${sessionHref(ws, s)}?at=${enc(id)}#m-${enc(id)}`;

/** Path plus the non-empty query parameters. */
export function withQuery(path: string, q: Q, hash = ""): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== null && v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return `${path}${s ? `?${s}` : ""}${hash}`;
}

/** A stable colour per peer name (FNV-1a), so a peer looks the same on every page. */
const tone = (name: string) => {
  let h = 0x811c9dc5;
  for (const ch of name) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  return h % 6;
};
const initial = (name: string) => [...name.replace(/^scope\./, "")][0]?.toUpperCase() ?? "?";
const avatar = (name: string) =>
  html`<span class="avatar tone-${tone(name)}" aria-hidden="true">${initial(name)}</span>`;

const shortId = (id: string) => id.slice(0, 7);

/** A peer-card line's text; "PREFIX: Label: value" and "Label: value" lines get a muted label. */
function cardText(line: string): H {
  const m = line.match(/^(?:[A-Z][A-Z_ ]{1,20}:\s+)?([^:]{1,32}):\s+(.+)$/);
  return m ? html`<span class="card-key">${m[1]}</span><span>${m[2]}</span>` : html`${line}`;
}
function cardLine(line: string): H {
  return html`<li>${cardText(line)}</li>`;
}

/** Facts listed under a card line that start ticked for deletion: all of them when this few. */
const CARD_SOURCES_PRECHECK = 5;

/**
 * One line of the peer's own card with the facts it rests on, and (owners and admins) a form
 * that removes the line and deletes the ticked facts, so the line does not come back from them.
 */
function cardLineWithSources(
  ws: string,
  peer: string,
  src: CardSource,
  edit: MemoryEdit | null,
): H {
  const n = src.facts.length;
  const label = src.isName ? "the name" : n ? plural(n, "fact") : "no stored fact";
  const precheck = n <= CARD_SOURCES_PRECHECK;
  const list = html`<ul class="card-src-list">${src.facts.map(
    (f) =>
      html`<li>${
        edit
          ? html`<label><input type="checkbox" name="fact_${f.id}" value="1"${precheck ? html` checked` : ""} /> <span>${f.content}</span></label>`
          : html`<span>${f.content}</span>`
      } <a class="faint small" href="${factHref(ws, { id: f.id, observed: peer, observer: peer })}">since ${day(f.at)}</a></li>`,
  )}</ul>`;
  const why = src.isName
    ? html`<p class="hint">This line is ${peer}'s name, which every fact mentions, so no single fact is listed.</p>`
    : n
      ? html`<p class="hint">The facts in ${peer}'s own memory that name this value${n >= 20 ? " (the 20 newest)" : ""}.</p>`
      : html`<p class="hint">No current fact names this value: it came straight from a conversation, or its facts were deleted.</p>`;
  const form = edit
    ? html`<form method="post" action="${peerHref(ws, peer)}/card/remove">${csrfField(edit.csrf)}
    <input type="hidden" name="entry" value="${src.entry}" />
    ${n ? list : ""}
    <p class="hint">${
      n
        ? html`Removes this line from the card and deletes the ticked facts for good. Answers stop using them at once, and the line comes back only if ${peer} says it again.${precheck ? "" : " Tick the facts to delete."}`
        : "Removes this line from the card."
    }</p>
    <div class="buttons"><button class="danger small">${n ? "Remove line and delete ticked facts" : "Remove line"}</button></div>
  </form>`
    : n
      ? list
      : "";
  return html`<li class="card-row"><span class="card-line">${cardText(src.entry)}</span><details class="card-src"><summary>From ${label}</summary>${why}${form}</details></li>`;
}
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function crumbs(parts: [string, string | null][]): H {
  return html`<nav class="crumbs" aria-label="Breadcrumb">${parts.map(
    ([label, href], i) =>
      html`${i ? html`<span class="sep">/</span>` : ""}${
        href
          ? html`<a href="${href}">${label}</a>`
          : html`<span aria-current="page">${label}</span>`
      }`,
  )}</nav>`;
}

function pager(
  page: number,
  pages: number,
  href: (page: number) => string,
  labels: [string, string] = ["Newer", "Older"],
): H {
  if (pages <= 1) return html``;
  const link = (p: number, label: string, rel: string) =>
    p >= 1 && p <= pages
      ? html`<a class="button ghost small" rel="${rel}" href="${href(p)}">${label}</a>`
      : html`<span class="button ghost small disabled" aria-disabled="true">${label}</span>`;
  return html`<nav class="pager" aria-label="Pages">${link(page - 1, `← ${labels[0]}`, "prev")}<span>Page ${page} of ${pages}</span>${link(page + 1, `${labels[1]} →`, "next")}</nav>`;
}

// Pixel-art icons (shape-rendering crispEdges, drawn in whole units), like the site's sprites.
const ICON_STACK = html`<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor"><rect x="5" y="2" width="6" height="3"/><rect x="3" y="6" width="10" height="3"/><rect x="1" y="10" width="14" height="3"/></svg>`;
const ICON_SPARK = html`<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor"><rect x="7" y="1" width="2" height="14"/><rect x="1" y="7" width="14" height="2"/><rect x="4" y="4" width="2" height="2"/><rect x="10" y="4" width="2" height="2"/><rect x="4" y="10" width="2" height="2"/><rect x="10" y="10" width="2" height="2"/></svg>`;
const ICON_CHECK = html`<svg viewBox="0 0 12 10" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor"><path d="M1 5h2v2H1zM3 7h2v2H3zM5 5h2v2H5zM7 3h2v2H7zM9 1h2v2H9z"/></svg>`;

/** A segmented pixel progress bar: a track and a fill drawn as dashed lines (see .meter in the stylesheet). */
const meter = (width: number, pct: number): H =>
  html`<svg class="meter" width="${width}" height="10" aria-hidden="true" shape-rendering="crispEdges"><line class="track" x1="0" x2="100%" y1="5" y2="5"/><line class="fill" x1="0" x2="${pct}%" y1="5" y2="5"/></svg>`;

/** A labelled code block; app.js adds a copy button to its header. Keyboard users can scroll it. */
export function codeBlock(label: string, code: string): H {
  return html`<div class="code-block"><div class="code-head"><span>${label}</span></div><pre class="code" data-copy tabindex="0">${code}</pre></div>`;
}

// ---------------------------------------------------------------------------
// Getting started (empty states and the overview checklist)

function snippetMessages(base: string) {
  return `curl -X POST ${base}/v3/workspaces/my-app/sessions/first-chat/messages \\
  -H "Authorization: Bearer $RECALL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages": [
        {"peer_id": "alice", "content": "I just moved to Utrecht and I cycle to work."},
        {"peer_id": "assistant", "content": "Welcome to Utrecht! How is the commute?"}
      ]}'`;
}

function snippetAsk(base: string) {
  return `curl -X POST ${base}/v3/workspaces/my-app/peers/alice/chat \\
  -H "Authorization: Bearer $RECALL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "Where does alice live?"}'`;
}

/**
 * The three calls from nothing to an answer, with snippets for this deployment.
 * With `done`, steps tick themselves off from the account's data.
 */
export function gettingStarted(base: string, done: Checklist | null): H {
  const step = (
    i: number,
    ok: boolean | null | undefined,
    title: string,
    body: H,
    snippet: string | null,
    action: H = html``,
  ) => html`<li class="step${ok ? " done" : ""}" data-step="${i}" data-done="${ok ? "true" : "false"}">
  <span class="step-n">${ok ? ICON_CHECK : i}</span>
  <div class="step-body">
    <h3>${title}${ok ? html` <span class="badge current">Done</span>` : ""}</h3>
    ${body}
    ${ok ? "" : action}
    ${snippet && !ok ? codeBlock("Shell", snippet) : ""}
  </div>
</li>`;
  return html`<ol class="steps">
  ${step(
    1,
    done?.key,
    "Create an API key",
    html`<p>Keys authenticate your agent: point your client at <code>${base}</code>.</p>`,
    "export RECALL_API_KEY=pk_live_…",
    html`<a class="button small-cta" href="${dashPath("/keys")}">Create a key</a>`,
  )}
  ${step(
    2,
    done?.messages,
    "Send messages",
    html`<p>Post a conversation. The workspace, session and peers are created on first use; Recall reasons over the messages in the background.</p>`,
    snippetMessages(base),
  )}
  ${step(
    3,
    done?.asked,
    "Ask a question",
    html`<p>Ask what Recall learned about a peer${done && !done.facts ? html` once its first facts appear in <a href="${dashPath("/memory")}">Memory</a>` : ""}. Or try it in the <a href="${dashPath("/playground")}">Playground</a>.</p>`,
    snippetAsk(base),
  )}
</ol>`;
}

export function checklistCard(base: string, c: Checklist): H {
  const steps = [c.key, c.messages, c.asked];
  const doneCount = steps.filter(Boolean).length;
  if (doneCount === steps.length) {
    return html`<section class="setup complete" data-checklist="complete"><span class="dot"></span><p><strong>You're set up.</strong> Keys, messages and questions are all flowing. ${
      c.facts
        ? html`See what Recall learned in <a href="${dashPath("/memory")}">Memory</a>.`
        : html`Facts appear in <a href="${dashPath("/memory")}">Memory</a> as background reasoning completes.`
    }</p></section>`;
  }
  return html`<section class="setup" data-checklist="${doneCount}/${steps.length}">
  <div class="setup-head">
    <div><p class="eyebrow">Getting started</p><h2>From zero to a remembered fact</h2></div>
    <div class="progress"><span>${doneCount} of ${steps.length} done</span>${meter(140, (doneCount / steps.length) * 100)}</div>
  </div>
  ${gettingStarted(base, c)}
</section>`;
}

// ---------------------------------------------------------------------------
// Memory: workspaces

export function memoryIndexPage(d: {
  csrf: string;
  canCreate: boolean;
  base: string;
  list: { items: WsStats[]; page: number; pages: number; total: number };
  name?: string;
}): H {
  const create = d.canCreate
    ? html`<form method="post" action="${dashPath("/memory")}" class="inline-form" aria-label="Create a workspace">
  ${csrfField(d.csrf)}
  <label class="sr" for="new-ws">Workspace id</label>
  <input id="new-ws" name="name" required maxlength="100" pattern="[A-Za-z0-9_\\-]+" placeholder="new-workspace" value="${d.name ?? ""}" />
  <button class="secondary">Create workspace</button>
</form>`
    : "";
  return html`<header class="page-head">
  <div><p class="eyebrow">Memory</p><h1>Workspaces</h1>
  <p class="lede">Everything Recall stored and learned for this account: peers, sessions, the facts it concluded and how they changed.</p></div>
  ${d.list.total ? create : ""}
</header>
${
  d.list.items.length
    ? html`<div class="ws-grid">${d.list.items.map(
        (w) => html`<a class="ws-card" href="${wsHref(w.name)}">
  <span class="ws-card-top"><span class="ws-icon">${ICON_STACK}</span><span class="ws-name">${w.name}</span><span class="go" aria-hidden="true">→</span></span>
  <dl class="mini-stats">
    <div><dt>Peers</dt><dd>${n(w.peers)}</dd></div>
    <div><dt>Sessions</dt><dd>${n(w.sessions)}</dd></div>
    <div><dt>Messages</dt><dd>${n(w.messages)}</dd></div>
    <div><dt>Facts</dt><dd>${n(w.facts)}</dd></div>
  </dl>
  <span class="ws-foot">Active ${ago(w.lastActivity)} · created ${day(w.createdAt)}</span>
</a>`,
      )}</div>
${pager(d.list.page, d.list.pages, (p) => withQuery(dashPath("/memory"), { page: p }), ["Previous", "Next"])}`
    : html`<section class="empty">
  <span class="empty-mark">${ICON_STACK}</span>
  <h2>No memory yet</h2>
  <p>Recall builds memory from the messages your agent sends. Three calls and you can watch it learn.</p>
  ${gettingStarted(d.base, null)}
  ${d.canCreate ? html`<div class="empty-alt"><span>Prefer to start with an empty workspace?</span>${create}</div>` : ""}
</section>`
}`;
}

const KIND_LABELS: Record<string, string> = {
  reason: "Learning",
  summarize: "Summary",
  dream: "Night shift",
};

/** What owners and admins can do from a workspace page (null for members). */
export interface WorkspaceActions {
  csrf: string;
  /** The night shift (dreams) is enabled on this server. */
  dreams: boolean;
}

function queueStrip(ws: string, q: QueueView, actions: WorkspaceActions | null): H {
  const busy = q.pending + q.running > 0;
  const base = wsHref(ws);
  const failed = q.failures;
  const retriable = failed.filter((f) => f.retriesLeft > 0).length;
  return html`<section class="status" data-queue="${busy ? "busy" : "idle"}" aria-label="Background work">
  <span class="dot${busy ? " busy" : ""}"></span>
  ${
    busy
      ? html`<span><strong>Learning in progress</strong>: ${plural(q.pending, "unit")} pending, ${n(q.running)} running</span>${
          q.bySession.length
            ? html`<span class="status-sub">${q.bySession
                .slice(0, 4)
                .map(
                  (s, i) =>
                    html`${i ? ", " : ""}<span class="ident">${s.session}</span> (${n(s.pending + s.running)})`,
                )}${q.bySession.length > 4 ? ` and ${q.bySession.length - 4} more` : ""}</span>`
            : ""
        }`
      : html`<span><strong>Up to date</strong>: no background work pending</span>`
  }
  <span class="status-sub">${plural(q.completed, "unit")} processed</span>
</section>
${
  failed.length
    ? html`<section class="status failed" data-failed="${failed.length}" aria-label="Failed background work">
  <span class="dot"></span>
  <span><strong>${plural(failed.length, "unit")} of background work failed</strong>: some messages were not learned from, or a summary or night shift did not finish. Nothing is lost: retrying runs the work again, and learning is charged only when it succeeds.</span>
  ${
    actions && retriable
      ? html`<div class="status-actions"><form method="post" action="${base}/queue/retry">${csrfField(actions.csrf)}<button class="secondary small">Retry failed work</button></form></div>`
      : ""
  }
  <details class="failures"><summary>What failed</summary><ul>${failed.map(
    (f) =>
      html`<li><strong>${KIND_LABELS[f.kind] ?? f.kind}</strong>${f.session ? html` in <span class="ident">${f.session}</span>` : ""}: ${f.reason}${f.at ? html` · <span class="faint">${stamp(f.at)}</span>` : ""}${
        f.retriesLeft ? "" : html` · <span class="faint">no retries left; contact support</span>`
      }</li>`,
  )}</ul></details>
</section>`
    : ""
}
${
  actions?.dreams
    ? html`<div class="work-actions"><form method="post" action="${base}/night-shift">${csrfField(actions.csrf)}<button class="secondary small">Run the night shift now</button></form><span>Merges duplicate facts, retires facts that stopped being true and refreshes peer cards. It also runs by itself after a conversation goes quiet; included in the price.</span></div>`
    : ""
}`;
}

/** The webhooks tab of a workspace. */
export interface WebhooksTab {
  csrf: string;
  canManage: boolean;
  /** Webhooks are on for this server (RECALL_WEBHOOKS): off, nothing is delivered. */
  enabled: boolean;
  endpoints: WebhookView[];
  max: number;
  /** The URL typed into the form, kept when it is sent back with an error. */
  url?: string;
  /** A test event was just queued for this many endpoints. */
  tested?: number | null;
}

const DELIVERY: Record<string, [string, string]> = {
  done: ["Delivered", "current"],
  failed: ["Failed", "contradiction"],
  pending: ["Sending", "warn"],
  running: ["Sending", "warn"],
};

function webhooksTab(ws: string, w: WebhooksTab): H {
  const base = `${wsHref(ws)}/webhooks`;
  const list = w.endpoints.length
    ? html`<ul class="wh-list">${w.endpoints.map((e) => {
        const [label, tone] = e.last ? (DELIVERY[e.last.status] ?? [e.last.status, ""]) : ["", ""];
        return html`<li class="wh" data-endpoint="${e.id}">
  <span class="wh-url">${e.url}</span>
  ${
    e.last
      ? html`<span class="badge ${tone}" title="${e.last.error ?? ""}">${label}: ${e.last.type}</span>`
      : html`<span class="badge">No deliveries yet</span>`
  }
  <span class="wh-meta">Added ${day(e.createdAt)}${e.last?.at ? html` · last delivery ${ago(e.last.at)}` : ""}${e.last?.error && e.last.status === "failed" ? html` · ${e.last.error}` : ""}</span>
  ${
    w.canManage
      ? html`<details><summary>Delete</summary><form method="post" action="${base}/${enc(e.id)}/delete">${csrfField(w.csrf)}<input type="hidden" name="confirm" value="1" /><p class="hint">Stops deliveries to this URL at once. Events queued for it are dropped.</p><button class="danger small">Delete endpoint</button></form></details>`
      : ""
  }
</li>`;
      })}</ul>`
    : html`<p class="empty-inline">No endpoints yet. Recall POSTs <code>queue.empty</code> when this workspace's background work is done, and <code>test.event</code> when you send a test.</p>`;
  return html`<section class="panel" id="webhooks">
  ${w.enabled ? "" : html`<p class="caution">Webhooks are turned off on this server: endpoints can be listed, but nothing is delivered.</p>`}
  <div class="panel-head"><h2>Endpoints</h2><span class="muted small">${n(w.endpoints.length)} of ${n(w.max)} · deliveries are retried with backoff</span></div>
  ${
    w.tested != null
      ? html`<div class="flash" role="status"><p>Test event queued for ${plural(w.tested, "endpoint")}. Its delivery shows here within seconds; reload to see it.</p></div>`
      : ""
  }
  ${list}
  ${
    w.canManage
      ? html`<div class="buttons wh-actions">${
          w.endpoints.length
            ? html`<form method="post" action="${base}/test">${csrfField(w.csrf)}<button class="secondary">Send a test event</button></form>`
            : ""
        }</div>
  <form method="post" action="${base}" class="inline-form wide add-endpoint" aria-label="Add a webhook endpoint">
    ${csrfField(w.csrf)}
    <label class="sr" for="wh-url">Endpoint URL</label>
    <input id="wh-url" name="url" type="url" required maxlength="2048" placeholder="https://example.com/hooks/recall" value="${w.url ?? ""}" />
    <button>Add endpoint</button>
  </form>
  <p class="hint">Public https URLs only: private and local addresses are refused. Each delivery is a POST with a JSON body.</p>`
      : html`<p class="muted small">Owners and admins can add and delete endpoints.</p>`
  }
</section>`;
}

export function workspacePage(d: {
  ws: WsStats;
  tab: "peers" | "sessions" | "webhooks";
  queue: QueueView;
  actions: WorkspaceActions | null;
  /** Webhook endpoints, counted for the tab. */
  webhookCount: number;
  peers?: { items: PeerListItem[]; page: number; pages: number; total: number };
  sessions?: { items: SessionListItem[]; page: number; pages: number; total: number };
  webhooks?: WebhooksTab;
  /** A peer was just forgotten (from its page). */
  forgotten?: { peer: string; messages: number; facts: number; sessions: number } | null;
  /** Rendered under the tabs (the webhooks tab's signing secret). */
  extra?: H;
}): H {
  const w = d.ws;
  const base = wsHref(w.name);
  const tab = (id: typeof d.tab, href: string, label: string, count: number) =>
    html`<a href="${href}"${d.tab === id ? html` aria-current="page"` : ""}>${label} <span class="count">${n(count)}</span></a>`;
  const tabs = html`<nav class="tabs" aria-label="Workspace">
  ${tab("peers", base, "Peers", w.peers)}
  ${tab("sessions", `${base}/sessions`, "Sessions", w.sessions)}
  ${tab("webhooks", `${base}/webhooks`, "Webhooks", d.webhookCount)}
</nav>`;
  let body: H = html``;
  if (d.tab === "peers" && d.peers) {
    const p = d.peers;
    body = p.items.length
      ? html`<div class="scroll" tabindex="0" role="region" aria-label="Peers"><table class="list">
<thead><tr><th>Peer</th><th class="num">Facts</th><th class="num">Messages</th><th class="num">Sessions</th><th>Last message</th><th>Created</th></tr></thead>
<tbody>${p.items.map(
          (r) =>
            html`<tr><td><a class="who" href="${peerHref(w.name, r.name)}">${avatar(r.name)}<span class="ident">${r.name}</span></a></td><td class="num">${n(r.facts)}</td><td class="num">${n(r.messages)}</td><td class="num">${n(r.sessions)}</td><td class="faint">${ago(r.lastMessageAt)}</td><td class="faint">${day(r.createdAt)}</td></tr>`,
        )}</tbody></table></div>
${pager(p.page, p.pages, (x) => withQuery(base, { page: x }))}`
      : html`<p class="empty-inline">No peers yet. Peers appear when messages name them as <code>peer_id</code>.</p>`;
  } else if (d.tab === "sessions" && d.sessions) {
    const s = d.sessions;
    body = s.items.length
      ? html`<div class="scroll" tabindex="0" role="region" aria-label="Sessions"><table class="list">
<thead><tr><th>Session</th><th>Peers</th><th class="num">Messages</th><th>Last message</th><th>Created</th></tr></thead>
<tbody>${s.items.map(
          (r) =>
            html`<tr><td><a class="table-link ident" href="${sessionHref(w.name, r.name)}">${r.name}</a></td><td>${peerStack(r.peers)}</td><td class="num">${n(r.messages)}</td><td class="faint">${ago(r.lastMessageAt)}</td><td class="faint">${day(r.createdAt)}</td></tr>`,
        )}</tbody></table></div>
${pager(s.page, s.pages, (x) => withQuery(`${base}/sessions`, { page: x }))}`
      : html`<p class="empty-inline">No sessions yet. Post messages to <code>/v3/workspaces/${w.name}/sessions/{id}/messages</code> to start one.</p>`;
  } else if (d.tab === "webhooks" && d.webhooks) {
    body = webhooksTab(w.name, d.webhooks);
  }
  const f = d.forgotten;
  return html`${crumbs([
    ["Memory", dashPath("/memory")],
    [w.name, null],
  ])}
<header class="page-head">
  <div><p class="eyebrow">Workspace</p><h1 class="ident">${w.name}</h1>
  <p class="meta"><span>Created ${day(w.createdAt)}</span><span>Active ${ago(w.lastActivity)}</span></p></div>
  <div class="head-actions"><a class="button ghost" href="${withQuery(dashPath("/playground"), { ws: w.name })}">${ICON_SPARK} Open in Playground</a></div>
</header>
${
  f
    ? html`<div class="flash" role="status"><p class="eyebrow">Forgotten</p><p><span class="ident">${f.peer}</span> is gone from this workspace: ${plural(f.messages, "message")} and ${plural(f.facts, "fact")} deleted${
        f.sessions
          ? html`; summaries of ${plural(f.sessions, "session")} are being rebuilt without them`
          : ""
      }.</p></div>`
    : ""
}
<div class="stats compact">
  <div class="stat"><span class="label">Peers</span><span class="value">${n(w.peers)}</span></div>
  <div class="stat"><span class="label">Sessions</span><span class="value">${n(w.sessions)}</span></div>
  <div class="stat"><span class="label">Messages</span><span class="value">${n(w.messages)}</span></div>
  <div class="stat"><span class="label">Facts</span><span class="value">${n(w.facts)}</span><span class="sub">${plural(w.superseded, "superseded fact")} kept as history</span></div>
</div>
${queueStrip(w.name, d.queue, d.actions)}
${tabs}
${body}
${d.extra ?? ""}`;
}

function peerStack(peers: string[]): H {
  if (!peers.length) return html`<span class="faint">—</span>`;
  const shown = peers.slice(0, 4);
  return html`<span class="stack" title="${peers.join(", ")}">${shown.map(avatar)}</span> <span class="stack-names">${clip(peers.join(", "), 48)}</span>`;
}

// ---------------------------------------------------------------------------
// Peer

const LEVEL_TONE: Record<string, string> = {
  explicit: "",
  deductive: " inferred",
  inductive: " inferred",
  contradiction: " contradiction",
};

/** Link to a fact on its peer page, in the view that lists it. */
const factHref = (ws: string, f: { id: string; observed: string; observer: string }) =>
  withQuery(peerHref(ws, f.observed), { state: "all", observer: f.observer }, `#f-${f.id}`);

/** Owners and admins edit memory from the peer page: the form token travels with each form. */
export interface MemoryEdit {
  csrf: string;
}

/** Correct (current facts) and delete, each behind a disclosure: the second click is the action. */
function factActions(ws: string, peer: string, c: ConclusionRow, e: MemoryEdit): H {
  const base = `${peerHref(ws, peer)}/facts/${enc(c.id)}`;
  return html`<div class="fact-actions">
  ${
    c.validTo == null
      ? html`<details><summary>Correct</summary><form method="post" action="${base}/correct">${csrfField(e.csrf)}
      <label for="fix-${c.id}">Corrected fact</label>
      <textarea id="fix-${c.id}" name="content" required maxlength="2000" rows="2">${c.content}</textarea>
      <p class="hint">The current text is kept as history, superseded today, and answers use the correction from now on.</p>
      <div class="buttons"><button class="small">Save correction</button></div></form></details>`
      : ""
  }
  <details><summary>Delete</summary><form method="post" action="${base}/delete">${csrfField(e.csrf)}<input type="hidden" name="confirm" value="1" />
    <p class="hint">Deletes this fact for good${c.validTo == null ? "" : " (it is only history now)"}. Answers stop using it at once; it cannot be undone.</p>
    <div class="buttons"><button class="danger small">Delete permanently</button></div></form></details>
</div>`;
}

function factItem(
  ws: string,
  peer: string,
  c: ConclusionRow,
  refs: Pick<FactsView, "messages" | "related">,
  showObserver: boolean,
  edit: MemoryEdit | null = null,
): H {
  const superseded = c.validTo != null;
  const from = c.validFrom ?? c.createdAt;
  const replacement = c.supersededBy ? refs.related.get(c.supersededBy) : undefined;
  const premises = c.sourceIds
    .map((id) => refs.related.get(id))
    .filter((r): r is ConclusionRow => !!r);
  const link = (r: ConclusionRow) =>
    factHref(ws, { id: r.id, observed: r.observedName, observer: r.observerName });
  return html`<li class="fact ${superseded ? "is-superseded" : "is-current"}" id="f-${c.id}" data-state="${superseded ? "superseded" : "current"}">
  <div class="fact-top">
    <p class="fact-text">${c.content}</p>
    <span class="fact-badges">${
      superseded
        ? html`<span class="badge superseded">Superseded</span>`
        : html`<span class="badge current">Current</span>`
    }<span class="badge${LEVEL_TONE[c.level] ?? ""}">${c.level}</span></span>
  </div>
  <div class="fact-meta">
    <span class="validity" title="${superseded ? "Valid from / to" : "Valid from"}">${
      superseded
        ? html`${day(from.toISOString())} → ${day(c.validTo!.toISOString())}`
        : html`since ${day(from.toISOString())}`
    }</span>
    ${
      showObserver
        ? html`<span>${c.observerName === peer ? "self-observed" : html`seen by <a href="${peerHref(ws, c.observerName)}">${c.observerName}</a>`}</span>`
        : ""
    }
    ${c.sessionName ? html`<span>in <a href="${sessionHref(ws, c.sessionName)}">${c.sessionName}</a></span>` : ""}
    ${c.timesDerived > 1 ? html`<span title="Derived again from later messages">reinforced ${c.timesDerived}×</span>` : ""}
    ${
      c.messageIds.length
        ? html`<span class="from">from ${c.messageIds.map((id) => {
            const ref = refs.messages.get(id);
            return ref
              ? html`<a class="ref" href="${messageHref(ws, ref.session, id)}" title="${ref.peer}: ${clip(ref.content, 200)}">${shortId(id)}</a>`
              : html`<span class="ref" title="Message no longer stored">${shortId(id)}</span>`;
          })}</span>`
        : ""
    }
  </div>
  ${
    premises.length || c.supersededBy
      ? html`<div class="refs">${
          premises.length
            ? html`<span>Based on</span>${premises.map(
                (p) =>
                  html`<a class="ref" href="${link(p)}" title="${p.content}">“${clip(p.content, 48)}”</a>`,
              )}`
            : ""
        }${
          c.supersededBy
            ? html`<span>Replaced by</span>${
                replacement
                  ? html`<a class="ref replaced" href="${link(replacement)}">“${clip(replacement.content, 72)}”</a>`
                  : html`<span class="ref">${shortId(c.supersededBy)}</span>`
              }`
            : ""
        }</div>`
      : ""
  }
  ${edit ? factActions(ws, peer, c, edit) : ""}
</li>`;
}

export interface AskForm {
  csrf: string;
  nonce: string;
  action: string;
  /** Hidden fields (workspace and peer on the playground page). */
  hidden: Record<string, string>;
  peer: string;
  /** Peers whose view of `peer` can answer (first is the peer itself). */
  observers: string[];
  query: string;
  level: ChatLevel;
  perspective: string | null;
  /** Price per level in micros, or null when this account is not billed. */
  prices: Record<string, number> | null;
}

const LEVEL_ORDER: ChatLevel[] = ["minimal", "low", "medium", "high", "max"];

export function levelHow(level: ChatLevel): string {
  const p = LEVELS[level];
  return p.rounds === 0
    ? `one model call over up to ${p.facts} facts`
    : `up to ${p.rounds} rounds of memory search, then an answer`;
}

export function askForm(f: AskForm): H {
  const price = (l: ChatLevel) => (f.prices?.[l] ? ` · ${formatUsd(f.prices[l]!)}` : "");
  return html`<form method="post" action="${f.action}" class="ask-form">
  ${csrfField(f.csrf)}
  <input type="hidden" name="nonce" value="${f.nonce}" />
  ${Object.entries(f.hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
  <label for="ask-q">Question about <span class="ident">${f.peer}</span></label>
  <textarea id="ask-q" name="query" required maxlength="10000" rows="3" placeholder="What does ${f.peer} care about right now?">${f.query}</textarea>
  <div class="ask-row">
    <div class="field">
      <label for="ask-level">Reasoning level</label>
      <select id="ask-level" name="level">${LEVEL_ORDER.map(
        (l) =>
          html`<option value="${l}"${l === f.level ? html` selected` : ""}>${l}${price(l)}</option>`,
      )}</select>
    </div>
    ${
      f.observers.length > 1
        ? html`<div class="field">
      <label for="ask-view">Answer from</label>
      <select id="ask-view" name="perspective">${f.observers.map(
        (o, i) =>
          html`<option value="${o}"${(f.perspective ?? f.peer) === o ? html` selected` : ""}>${i === 0 ? `${o} (own memory)` : `${o}'s view`}</option>`,
      )}</select>
    </div>`
        : ""
    }
  </div>
  <button class="wide" data-busy="Thinking...">${ICON_SPARK} Ask</button>
  <p class="hint">${
    f.prices
      ? html`Each question is billed as one query at the chosen level, at the price shown, exactly like <code>POST …/peers/{id}/chat</code>. Spend caps apply.`
      : html`Each question runs one query at the chosen level, exactly like <code>POST …/peers/{id}/chat</code>, and counts toward your monthly budget.`
  }</p>
</form>`;
}

function confidenceMeter(v: number): H {
  const pct = Math.round(v * 100);
  const toneClass = v >= 0.7 ? "high" : v >= 0.4 ? "mid" : "low";
  return html`<span class="confidence ${toneClass}"><span class="label">Confidence</span>${meter(96, pct)}<strong>${pct}%</strong></span>`;
}

export function answerPanel(ws: string, o: AskOutcome, prices: Record<string, number> | null): H {
  const head = html`<p class="answer-q"><span class="eyebrow">You asked · ${o.input.level}${
    o.input.perspective ? ` · ${o.input.perspective}'s view` : ""
  }</span><span class="q">${o.input.query}</span></p>`;
  if (o.error) {
    const credit = o.error.status === 402;
    return html`<section class="answer failed" id="answer" data-status="${o.error.status}">
  ${head}
  <p class="error" role="alert">${o.error.message}${
    credit
      ? html` · <a href="${dashPath("/billing")}">Add credits</a> or <a href="${dashPath("/settings")}">raise the monthly budget</a>.`
      : ""
  }</p>
  <p class="hint">Nothing was charged for this question.</p>
</section>`;
  }
  const r = o.result!;
  const ev = r.evidence;
  const cited = new Set(r.citations);
  const evFacts = ev?.conclusions ?? [];
  const evMsgs = ev?.messages ?? [];
  const factLink = (id: string, observed: string, observer: string) =>
    factHref(ws, { id, observed, observer });
  const factRow = (c: {
    id: string;
    content: string;
    level: string;
    observed_id: string;
    observer_id: string;
  }) => {
    const full = o.facts.get(c.id);
    const superseded = full?.validTo != null;
    return html`<li class="${cited.has(c.id) ? "cited" : ""}" data-fact="${c.id}">
  <a class="ev-text" href="${factLink(c.id, c.observed_id, c.observer_id)}">${c.content}</a>
  <span class="ev-meta">${cited.has(c.id) ? html`<span class="badge warn">Cited</span>` : ""}${
    superseded
      ? html`<span class="badge superseded">Superseded ${day(full!.validTo!.toISOString())}</span>`
      : html`<span class="badge current">Current</span>`
  }<span class="badge${LEVEL_TONE[c.level] ?? ""}">${c.level}</span>${
    full ? html`<span>since ${day((full.validFrom ?? full.createdAt).toISOString())}</span>` : ""
  }${c.observer_id !== c.observed_id ? html`<span>seen by ${c.observer_id}</span>` : ""}</span>
</li>`;
  };
  const msgRow = (m: {
    id: string;
    session_id: string;
    peer_id: string;
    created_at: string | null;
  }) => {
    const ref: MessageRef | undefined = o.messages.get(m.id);
    return html`<li data-message="${m.id}"><span class="ev-who">${avatar(m.peer_id)}<span>${m.peer_id}</span></span>
  <a class="ev-text" href="${messageHref(ws, m.session_id, m.id)}">${ref ? clip(ref.content, 280) : `Message ${shortId(m.id)}`}</a>
  <span class="ev-meta"><span>${m.session_id}</span><span>${stamp(m.created_at)}</span></span></li>`;
  };
  const citedFacts = evFacts.filter((c) => cited.has(c.id));
  const price = prices?.[o.input.level];
  return html`<section class="answer${r.abstained ? " abstained" : ""}" id="answer" data-abstained="${r.abstained ? "true" : "false"}">
  ${head}
  <div class="answer-text">${r.content ?? ""}</div>
  <div class="answer-meta">
    ${confidenceMeter(r.confidence)}
    ${
      r.abstained
        ? html`<span class="badge warn" title="Recall did not find support for an answer in memory">Abstained</span>`
        : html`<span class="badge current">Answered from memory</span>`
    }
    <span>${plural(r.citations.length, "citation")}</span>
    <span>${price ? html`1 ${o.input.level} query · ${formatUsd(price)}` : html`1 ${o.input.level} query`}</span>
    <span class="faint">${r.cache === "hit" ? "cached answer" : `${plural(r.usage.calls, "model call")} · ${n(r.usage.inputTokens + r.usage.outputTokens)} tokens`}</span>
  </div>
  ${citedFacts.length ? html`<div class="evidence"><h3>Citations</h3><ul class="ev-list">${citedFacts.map(factRow)}</ul></div>` : ""}
  ${
    evFacts.length || evMsgs.length || ev?.tool_calls.length
      ? html`<details class="evidence"${citedFacts.length ? "" : " open"}>
    <summary>Evidence: ${plural(evFacts.length, "fact")}, ${plural(evMsgs.length, "message")}${ev?.tool_calls.length ? `, ${plural(ev.tool_calls.length, "search", "searches")}` : ""}</summary>
    ${evFacts.length ? html`<h3>Facts read</h3><ul class="ev-list">${evFacts.map(factRow)}</ul>` : ""}
    ${evMsgs.length ? html`<h3>Messages read</h3><ul class="ev-list msgs">${evMsgs.map(msgRow)}</ul>` : ""}
    ${
      ev?.tool_calls.length
        ? html`<h3>Memory searches</h3><ul class="ev-list">${ev.tool_calls.map(
            (t) =>
              html`<li><code>${t.tool_name}</code> <span class="faint">${JSON.stringify(t.tool_input)}</span></li>`,
          )}</ul>`
        : ""
    }
  </details>`
      : html`<p class="hint">No facts or messages matched this question.</p>`
  }
</section>`;
}

/** What an edit on the peer page just did, shown once after its redirect. */
export type PeerFlash =
  | { kind: "fact_deleted"; text: string; observer: string }
  | { kind: "fact_corrected"; before: string; after: string }
  | { kind: "fact_added"; text: string; observer: string }
  | { kind: "card_saved"; entries: number }
  | { kind: "card_line_removed"; entry: string; facts: number };

function peerFlash(peer: string, f: PeerFlash): H {
  const whose = (observer: string) =>
    observer === peer ? html`${peer}'s own memory` : html`${observer}'s view of ${peer}`;
  switch (f.kind) {
    case "fact_deleted":
      return html`<div class="flash" role="status"><p class="eyebrow">Deleted</p><p>Removed from ${whose(f.observer)} for good:</p><blockquote class="gone">${f.text}</blockquote><p class="hint">Answers stop using it right away.</p></div>`;
    case "fact_corrected":
      return html`<div class="flash" role="status"><p class="eyebrow">Corrected</p><blockquote class="gone">${f.before}</blockquote><blockquote>${f.after}</blockquote><p class="hint">The old text stays under All as history, superseded today.</p></div>`;
    case "fact_added":
      return html`<div class="flash" role="status"><p class="eyebrow">Added</p><p>Saved to ${whose(f.observer)}:</p><blockquote>${f.text}</blockquote></div>`;
    case "card_line_removed":
      return html`<div class="flash" role="status"><p class="eyebrow">Removed from the card</p><blockquote class="gone">${f.entry}</blockquote><p class="hint">${f.facts ? `${plural(f.facts, "fact")} behind it deleted for good. ` : ""}Answers stop using ${f.facts ? "them" : "it"} right away.</p></div>`;
    case "card_saved":
      return html`<div class="flash" role="status"><p class="eyebrow">Peer card saved</p><p>${plural(f.entries, "entry", "entries")}. Recall keeps the card up to date as it learns; your edits are its starting point.</p></div>`;
  }
}

export function peerPage(d: {
  ws: string;
  peer: PeerView;
  fq: FactQuery;
  facts: FactsView;
  sessions: { items: SessionListItem[]; total: number };
  ask: AskForm;
  outcome: AskOutcome | null;
  prices: Record<string, number> | null;
  /** Owners and admins: editing controls. */
  edit?: MemoryEdit | null;
  flash?: PeerFlash | null;
}): H {
  const p = d.peer;
  const f = d.facts;
  const edit = d.edit && !p.isScope ? d.edit : null;
  const here = peerHref(d.ws, p.name);
  const q = (over: Q) =>
    withQuery(here, {
      state: d.fq.state === "current" ? null : d.fq.state,
      q: d.fq.q,
      observer: d.fq.observer ?? "*",
      ...over,
    });
  const count = (v: { current: number; superseded: number }) =>
    d.fq.state === "current" ? v.current : v.current + v.superseded;
  const views =
    p.views.length > 1 || (p.views.length === 1 && p.views[0]!.observer !== p.name)
      ? html`<div class="segmented views" role="group" aria-label="Whose view">${p.views.map(
          (v) =>
            html`<a href="${q({ observer: v.observer, page: null })}#facts"${d.fq.observer === v.observer ? html` aria-current="true"` : ""}>${avatar(v.observer)}${v.observer === p.name ? "Own memory" : `${v.observer}'s view`} <span class="count">${n(count(v))}</span></a>`,
        )}<a href="${q({ observer: "*", page: null })}#facts"${d.fq.observer === null ? html` aria-current="true"` : ""}>Everyone <span class="count">${n(count(p.totals))}</span></a></div>`
      : "";
  const filters = html`<div class="filters">
  <div class="segmented" role="group" aria-label="Which facts">
    <a href="${q({ state: null, page: null })}#facts"${d.fq.state === "current" ? html` aria-current="true"` : ""}>Current <span class="count">${n(f.counts.current)}</span></a>
    <a href="${q({ state: "all", page: null })}#facts"${d.fq.state === "all" ? html` aria-current="true"` : ""}>All <span class="count">${n(f.counts.current + f.counts.superseded)}</span></a>
  </div>
  <form method="get" action="${here}#facts" class="filter-form" role="search">
    ${d.fq.state === "all" ? html`<input type="hidden" name="state" value="all" />` : ""}
    <input type="hidden" name="observer" value="${d.fq.observer ?? "*"}" />
    <label class="sr" for="fq">Filter facts</label>
    <input id="fq" type="search" name="q" value="${d.fq.q}" placeholder="Filter facts by text…" maxlength="200" />
    <button class="secondary">Filter</button>
  </form>
</div>`;
  // New facts go into the view being looked at (the peer's own memory unless another is open).
  const into = d.fq.observer && d.fq.observer !== p.name ? d.fq.observer : p.name;
  const addFact = edit
    ? html`<details class="add-fact"><summary>Add a fact</summary>
  <form method="post" action="${here}/facts">${csrfField(edit.csrf)}
    <label for="new-fact">Fact about <span class="ident">${p.name}</span></label>
    <textarea id="new-fact" name="content" required maxlength="2000" rows="2" placeholder="${p.name} prefers email over phone calls."></textarea>
    ${
      p.observers.length
        ? html`<div class="ask-row"><div class="field"><label for="new-fact-view">Into</label>
    <select id="new-fact-view" name="observer">${[p.name, ...p.observers].map(
      (o) =>
        html`<option value="${o}"${o === into ? html` selected` : ""}>${o === p.name ? `${o}'s own memory` : `${o}'s view`}</option>`,
    )}</select></div></div>`
        : html`<input type="hidden" name="observer" value="${p.name}" />`
    }
    <p class="hint">Saved as an explicit fact, dated today. Recall uses it in answers at once and keeps it in step with what it learns later.</p>
    <div class="buttons"><button class="small">Add fact</button></div>
  </form></details>`
    : "";
  const factList = f.items.length
    ? html`<ol class="facts">${f.items.map((c) => factItem(d.ws, p.name, c, f, d.fq.observer === null, edit))}</ol>
${pager(f.page, f.pages, (x) => `${q({ page: x })}#facts`)}`
    : html`<p class="empty-inline">${
        d.fq.q
          ? "No facts match this filter."
          : f.counts.superseded && d.fq.state === "current"
            ? "No current facts in this view; see All for history."
            : p.totals.current + p.totals.superseded
              ? "No facts in this view."
              : html`No facts yet. Recall concludes facts from ${p.name}'s messages in the background; they appear here within a minute or two of being sent.`
      }</p>`;
  const card = html`<section class="card peer-card">
  <h2>Peer card</h2>
  ${
    p.card?.length
      ? html`<ul class="card-list">${p.card.map((line, i) => {
          const src = p.cardSources[i];
          return src && src.entry === line
            ? cardLineWithSources(d.ws, p.name, src, edit)
            : cardLine(line);
        })}</ul>`
      : html`<p class="muted small">No card yet. Recall keeps a short card of stable facts (name, home, work…) as it learns them.</p>`
  }
  ${
    edit
      ? html`<details class="card-edit"><summary>Edit card</summary>
  <form method="post" action="${here}/card">${csrfField(edit.csrf)}
    <label for="card-text">One entry per line</label>
    <textarea id="card-text" name="card" rows="8" maxlength="60000" spellcheck="false">${(p.card ?? []).join("\n")}</textarea>
    <p class="hint">For example <code>ATTRIBUTE: Home: Utrecht</code>. Empty lines are dropped; save an empty card to clear it.</p>
    <div class="buttons"><button class="small">Save card</button></div>
  </form></details>`
      : ""
  }
  ${p.otherCards.map(
    (o) =>
      html`<details class="other-card"><summary>How ${o.observer} sees ${p.name}</summary><ul class="card-list">${o.card.map(cardLine)}</ul></details>`,
  )}
</section>`;
  const sessions = html`<section class="card late">
  <h2>Sessions <span class="count">${n(d.sessions.total)}</span></h2>
  ${
    d.sessions.items.length
      ? html`<ul class="link-list">${d.sessions.items.map(
          (s) =>
            html`<li>${
              s.active
                ? html`<a class="ident" href="${sessionHref(d.ws, s.name)}">${s.name}</a>`
                : html`<span class="ident faint" title="Being deleted">${s.name}</span>`
            }<span class="sub">${plural(s.messages, "message")} · ${ago(s.lastMessageAt)}</span></li>`,
        )}</ul>${d.sessions.total > d.sessions.items.length ? html`<p class="hint">Showing the ${d.sessions.items.length} newest.</p>` : ""}`
      : html`<p class="muted small">Not in any session.</p>`
  }
</section>`;
  const forget = edit
    ? html`<section class="card danger-zone late" id="forget">
  <h2>Forget ${p.name}</h2>
  <p class="small">Deletes ${p.name}, every message ${p.name} sent and everything Recall concluded from or about ${p.name}. For a person who asks to be forgotten.</p>
  <a class="button danger small" href="${here}/forget">Forget ${p.name}…</a>
</section>`
    : "";
  return html`${crumbs([
    ["Memory", dashPath("/memory")],
    [d.ws, wsHref(d.ws)],
    ["Peers", wsHref(d.ws)],
    [p.name, null],
  ])}
<header class="page-head">
  <div class="who-head">${avatar(p.name)}<div><p class="eyebrow">Peer${p.isScope ? " · scope" : ""}</p><h1 class="ident">${p.name}</h1>
  <p class="meta"><span>${plural(p.totals.current, "current fact")}</span><span>${n(p.totals.superseded)} superseded</span><span>${plural(p.messages, "message")}</span><span>${
    p.lastMessageAt ? `last spoke ${ago(p.lastMessageAt)}` : `created ${day(p.createdAt)}`
  }</span></p></div></div>
</header>
<div class="layout">
  <div class="side">
    ${card}
    <section class="card ask-card late" id="ask"><h2>Ask about ${p.name}</h2>${askForm(d.ask)}</section>
    ${sessions}
    ${forget}
  </div>
  <div class="main">
    ${d.flash ? peerFlash(p.name, d.flash) : ""}
    ${d.outcome ? answerPanel(d.ws, d.outcome, d.prices) : ""}
    <section class="panel" id="facts">
      <div class="panel-head"><h2>Facts</h2><span class="muted small">What Recall concluded about ${p.name}. Superseded facts stay as history, with when they held.</span></div>
      ${views}
      ${filters}
      ${addFact}
      ${factList}
    </section>
  </div>
</div>`;
}

/** The step before a peer is forgotten: what goes, and the peer's id typed to confirm. */
export function forgetPeerPage(d: { csrf: string; ws: string; peer: PeerView }): H {
  const p = d.peer;
  const here = peerHref(d.ws, p.name);
  return html`${crumbs([
    ["Memory", dashPath("/memory")],
    [d.ws, wsHref(d.ws)],
    ["Peers", wsHref(d.ws)],
    [p.name, here],
    ["Forget", null],
  ])}
<section class="card confirm danger-zone">
  <p class="eyebrow">Right to be forgotten</p>
  <h1>Forget <span class="ident">${p.name}</span>?</h1>
  <p>This deletes the peer and everything learned from and about it, in this workspace. It cannot be undone.</p>
  <dl class="facts-dl">
    <dt>Messages</dt><dd>${plural(p.messages, "message")} ${p.name} sent</dd>
    <dt>Facts</dt><dd>${plural(p.totals.current + p.totals.superseded, "fact")} about ${p.name}, and what ${p.name} concluded about others</dd>
    <dt>Peer cards</dt><dd>${p.name}'s card and the cards others keep of ${p.name}</dd>
    <dt>Summaries</dt><dd>rebuilt for the sessions ${p.name} spoke in, without ${p.name}'s messages</dd>
  </dl>
  <p class="hint">Facts about other peers that merely mention ${p.name} are kept; review them on those peers' pages.</p>
  <form method="post" action="${here}/forget">
    ${csrfField(d.csrf)}
    <input type="hidden" name="confirm" value="1" />
    <label for="confirm-text">Type the peer id <strong class="ident">${p.name}</strong> to confirm</label>
    <input id="confirm-text" name="confirm_text" required autocomplete="off" autocapitalize="off" spellcheck="false" />
    <div class="buttons"><button class="danger">Forget ${p.name}</button><a class="button ghost" href="${here}">Cancel</a></div>
  </form>
</section>`;
}

// ---------------------------------------------------------------------------
// Session

function chat(ws: string, items: TranscriptMessage[]): H {
  return html`<ol class="chat">${items.map((m, i) => {
    const cont = i > 0 && items[i - 1]!.peer === m.peer;
    return html`<li class="msg${cont ? " cont" : ""}" id="m-${m.id}">
  ${avatar(m.peer)}
  <div class="msg-body">
    <div class="msg-head"><a class="msg-peer" href="${peerHref(ws, m.peer)}">${m.peer}</a><time datetime="${m.createdAt ?? ""}">${stamp(m.createdAt)}</time><a class="msg-id" href="#m-${m.id}" title="Message id">${shortId(m.id)}</a></div>
    <div class="bubble" title="${stamp(m.createdAt)} · ${plural(m.tokens, "token")}">${m.content}</div>
  </div>
</li>`;
  })}</ol>`;
}

function contextPanel(
  ws: string,
  s: SessionView,
  p: ContextParams,
  r: { result: ContextResult | null; error: string | null },
): H {
  const query = withQuery(`/v3/workspaces/${enc(ws)}/sessions/${enc(s.name)}/context`, {
    tokens: p.tokens,
    peer_target: p.peerTarget,
    summary: p.summary ? null : "false",
  });
  if (r.error || !r.result)
    return html`<section class="panel context" id="context"><div class="panel-head"><h2>Context preview</h2><code class="faint">GET ${query}</code></div><p class="error" role="alert">${r.error ?? "No context"}</p></section>`;
  const c = r.result;
  const msgTokens = c.messages.reduce((a, m) => a + m.token_count, 0);
  return html`<section class="panel context" id="context">
  <div class="panel-head"><h2>Context preview</h2><code class="faint ctx-call">GET ${query}</code></div>
  <div class="chips">
    <span class="chip">${plural(c.messages.length, "message")} · ${n(msgTokens)} tokens</span>
    <span class="chip">summary: ${c.summary ? c.summary.summary_type.replace("honcho_chat_summary_", "") : "none"}</span>
    ${p.peerTarget ? html`<span class="chip">representation of ${p.peerTarget}</span>` : ""}
    <span class="chip">budget ${n(p.tokens)} tokens</span>
  </div>
  <div class="ctx-grid">
    ${c.summary ? html`<div class="ctx-block"><h3>Summary</h3><p>${c.summary.content}</p></div>` : ""}
    ${
      c.peer_representation != null
        ? html`<div class="ctx-block"><h3>Peer representation</h3>${
            c.peer_representation
              ? html`<pre class="plain">${c.peer_representation}</pre>`
              : html`<p class="muted small">Nothing concluded about ${p.peerTarget} yet.</p>`
          }</div>`
        : ""
    }
    ${c.peer_card?.length ? html`<div class="ctx-block"><h3>Peer card</h3><ul class="card-list">${c.peer_card.map(cardLine)}</ul></div>` : ""}
  </div>
  <h3 class="ctx-h">Messages in the window (oldest first)</h3>
  ${
    c.messages.length
      ? html`<ol class="ctx-msgs">${c.messages.map(
          (m) =>
            html`<li><span class="ident">${m.peer_id}</span><span class="ctx-text">${clip(m.content, 220)}</span><span class="faint">${n(m.token_count)}t</span></li>`,
        )}</ol>`
      : html`<p class="muted small">No messages fit in this budget.</p>`
  }
  <details class="raw"><summary>Raw JSON response</summary>${codeBlock("JSON", JSON.stringify(c, null, 2))}</details>
</section>`;
}

export function sessionPage(d: {
  ws: string;
  s: SessionView;
  transcript: { items: TranscriptMessage[]; page: number; pages: number; total: number };
  ctxParams: ContextParams;
  ctxResult: { result: ContextResult | null; error: string | null } | null;
}): H {
  const s = d.s;
  const here = sessionHref(d.ws, s.name);
  const t = d.transcript;
  const sum = s.summaries;
  const shown = sum.long ?? sum.short;
  const first = (t.page - 1) * 30 + 1;
  return html`${crumbs([
    ["Memory", dashPath("/memory")],
    [d.ws, wsHref(d.ws)],
    ["Sessions", `${wsHref(d.ws)}/sessions`],
    [s.name, null],
  ])}
<header class="page-head">
  <div><p class="eyebrow">Session</p><h1 class="ident">${s.name}</h1>
  <p class="meta"><span>${plural(s.messages, "message")}</span><span>${plural(s.peers.length, "peer")}</span><span>Created ${day(s.createdAt)}</span></p></div>
  <div class="head-actions"><a class="button ghost" href="#context-form">Preview context</a></div>
</header>
<div class="layout">
  <div class="side">
    <section class="card"><h2>Peers</h2>${
      s.peers.length
        ? html`<ul class="link-list">${s.peers.map(
            (p) =>
              html`<li><a class="who" href="${peerHref(d.ws, p)}">${avatar(p)}<span class="ident">${p}</span></a></li>`,
          )}</ul>`
        : html`<p class="muted small">No active members.</p>`
    }</section>
    <section class="card summary-card${shown ? "" : " late"}"><h2>Summary</h2>${
      shown
        ? html`<p class="summary-text">${shown.content}</p><p class="hint">${shown.kind === "long" ? "Long" : "Short"} summary through message ${shortId(shown.lastMessageId)} · ${plural(shown.tokenCount, "token")}</p>${
            sum.long && sum.short
              ? html`<details><summary>Short summary</summary><p class="summary-text">${sum.short.content}</p></details>`
              : ""
          }`
        : html`<p class="muted small">No summary yet. Recall writes one as the session grows.</p>`
    }</section>
    <section class="card late" id="context-form"><h2>Context preview</h2>
      <p class="muted small">Renders what <code>GET …/sessions/${s.name}/context</code> returns for your agent's next prompt. Free: no model calls.</p>
      <form method="get" action="${here}#context">
        <input type="hidden" name="preview" value="1" />
        ${t.page !== t.pages ? html`<input type="hidden" name="page" value="${t.page}" />` : ""}
        <label for="ctx-tokens">Token budget</label>
        <input id="ctx-tokens" name="tokens" type="number" min="1" max="100000" step="1" value="${d.ctxParams.tokens}" />
        <label for="ctx-peer">Peer target (adds representation and card)</label>
        <select id="ctx-peer" name="peer_target"><option value="">None</option>${s.peers.map(
          (p) =>
            html`<option value="${p}"${d.ctxParams.peerTarget === p ? html` selected` : ""}>${p}</option>`,
        )}</select>
        <label class="check"><input type="checkbox" name="summary" value="1"${d.ctxParams.summary ? html` checked` : ""} /> Include the summary</label>
        <button class="secondary">Preview context</button>
      </form>
    </section>
  </div>
  <div class="main">
    <section class="panel transcript" id="messages">
      <div class="panel-head"><h2>Messages</h2><span class="muted small">${
        t.total ? `${n(first)}–${n(first + t.items.length - 1)} of ${n(t.total)}, oldest first` : ""
      }</span></div>
      ${pager(t.page, t.pages, (x) => `${withQuery(here, { page: x })}#messages`, ["Earlier", "Later"])}
      ${t.items.length ? html`<div class="chat-wrap">${chat(d.ws, t.items)}</div>` : html`<p class="empty-inline">No messages in this session yet.</p>`}
      ${t.items.length > 8 ? pager(t.page, t.pages, (x) => `${withQuery(here, { page: x })}#messages`, ["Earlier", "Later"]) : ""}
    </section>
  </div>
</div>
${d.ctxResult ? contextPanel(d.ws, s, d.ctxParams, d.ctxResult) : ""}`;
}

// ---------------------------------------------------------------------------
// Playground

export function playgroundPage(d: {
  base: string;
  workspaces: string[];
  ws: string | null;
  peers: string[];
  peer: string | null;
  ask: AskForm | null;
  outcome: AskOutcome | null;
  prices: Record<string, number> | null;
}): H {
  const intro = html`<header class="page-head">
  <div><p class="eyebrow">Playground</p><h1>Ask Recall</h1>
  <p class="lede">Ask what Recall knows about a peer and see the evidence behind the answer. It runs the same engine, billing and spend caps as <code>POST /v3/workspaces/{ws}/peers/{peer}/chat</code>.</p></div>
</header>`;
  if (!d.workspaces.length)
    return html`${intro}<section class="empty"><span class="empty-mark">${ICON_SPARK}</span><h2>Nothing to ask about yet</h2><p>The playground answers from memory. Send a few messages first:</p>${gettingStarted(d.base, null)}</section>`;
  const picker = html`<form method="get" action="${dashPath("/playground")}" class="picker">
  <div class="field"><label for="pg-ws">Workspace</label><select id="pg-ws" name="ws" data-autosubmit>${d.workspaces.map(
    (w) => html`<option value="${w}"${w === d.ws ? html` selected` : ""}>${w}</option>`,
  )}</select></div>
  <div class="field"><label for="pg-peer">Peer</label>${
    d.peers.length
      ? html`<select id="pg-peer" name="peer" data-autosubmit>${d.peers.map(
          (p) => html`<option value="${p}"${p === d.peer ? html` selected` : ""}>${p}</option>`,
        )}</select>`
      : html`<select id="pg-peer" name="peer" disabled><option>No peers in this workspace</option></select>`
  }</div>
  <button class="secondary" data-nojs>Load</button>
</form>`;
  const levels = html`<section class="card levels late"><h2>Reasoning levels</h2><ul class="level-list">${LEVEL_ORDER.map(
    (l) =>
      html`<li><span class="level-name">${l}</span><span class="level-price">${d.prices?.[l] ? formatUsd(d.prices[l]!) : ""}</span><span class="level-how">${levelHow(l)}</span></li>`,
  )}</ul><p class="hint">${d.prices ? "Prices are per question." : ""} Higher levels search more and cost more; <code>low</code> is the API default.</p></section>`;
  return html`${intro}
<div class="layout">
  <div class="side">${levels}</div>
  <div class="main">
    <section class="card">${picker}${
      d.ask
        ? html`<div class="divider"></div>${askForm(d.ask)}${
            d.ws && d.peer
              ? html`<p class="hint"><a href="${peerHref(d.ws, d.peer)}">See everything Recall knows about ${d.peer} →</a></p>`
              : ""
          }`
        : html`<p class="muted">Pick a peer to ask about.</p>`
    }</section>
    ${d.outcome && d.ws ? answerPanel(d.ws, d.outcome, d.prices) : ""}
  </div>
</div>`;
}
