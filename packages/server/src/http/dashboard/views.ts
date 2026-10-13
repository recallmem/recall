import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Invoice } from "../../billing/index.js";
import { CHAT_LEVELS, formatUsd, type LedgerLine } from "../../billing/ledger.js";
import type { ApiKeyOut } from "../../core/apikeys.js";
import type { GrantOut } from "../../core/oauth.js";
import { type LegalLinks, TERMS_VERSION } from "../../lib/legal.js";
import { dayChart, shortDay } from "./chart.js";
import type { Checklist, DailySeries, UsageDay, UsageReport } from "./explorer.js";
import { LOGO } from "./logo.js";
import { checklistCard, codeBlock } from "./memory-views.js";
import { NIGHT_SCENE, NIGHT_SKY } from "./night.js";
import { dashPath } from "./paths.js";
import type { DashState } from "./session.js";

/**
 * Server-rendered dashboard pages (hono/html escapes every interpolation).
 * Everything works without JavaScript; one small stylesheet at <base>/static/app.css
 * and an optional script at <base>/static/app.js (copy buttons, auto-submitting
 * pickers). The memory explorer and playground templates are in memory-views.ts.
 */

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Sidebar sections: [href, label, icon]; the icons are CSS masks keyed by data-i (STYLESHEET). */
const NAV_GROUPS = [
  [
    "Build",
    [
      ["/", "Overview", "home"],
      ["/memory", "Memory", "memory"],
      ["/playground", "Playground", "chat"],
    ],
  ],
  [
    "Account",
    [
      ["/keys", "API keys", "key"],
      ["/usage", "Usage", "usage"],
      ["/billing", "Billing", "card"],
      ["/settings", "Settings", "sliders"],
    ],
  ],
] as const;
/** Shown to operators only (RECALL_OPERATOR_EMAILS). */
const OPERATOR_NAV = ["Operator", [["/admin", "Console", "shield"]]] as const;

const NOTICES: Record<string, string> = {
  key_revoked: "API key revoked. Requests with it get 401 within seconds.",
  secret_rotated:
    "Webhook signing secret rotated. Deliveries are signed with the new secret from now on: update your verifier.",
  alerts_saved: "Email alerts saved.",
  webhook_added: "Webhook endpoint added. Send a test to check it.",
  webhook_deleted: "Webhook endpoint deleted.",
  night_shift: "Night shift queued. Facts and peer cards update within a few minutes.",
  night_shift_none: "Nothing for the night shift yet: no peer has facts in this workspace.",
  retried: "Failed work queued again. It runs within a minute; reload to see how it went.",
  retried_none:
    "Nothing was queued again: the failed work has used its retries. Contact support if it keeps failing.",
  app_revoked: "App disconnected. Its tokens stop working within seconds.",
  app_updated: "Saved. The app picks up the change in its next conversation.",
  budget_saved: "Monthly budget saved.",
  name_saved: "Account name saved.",
  autotopup_saved: "Auto top-up settings saved.",
  checkout_success: "Payment received. Your credits appear as soon as Stripe confirms it.",
  checkout_cancelled: "Checkout cancelled; nothing was charged.",
  signed_out: "You are signed out.",
  deleted: "Your account and all its data have been deleted.",
  credit_granted: "Credit granted.",
  credit_duplicate: "That grant was already applied; nothing changed.",
  account_suspended: "Account suspended. Its keys, connected apps and sessions are refused now.",
  account_unsuspended: "Suspension lifted. The account works again.",
};

export const notice = (code: string | undefined) => (code ? NOTICES[code] : undefined);

export const csrfField = (token: string) =>
  html`<input type="hidden" name="_csrf" value="${token}" />`;

export function page(opts: {
  title: string;
  dash?: DashState | null;
  legal?: LegalLinks | null;
  /** The marketing site's home ("/", or the public host's when the dashboard has its own). */
  site?: string;
  active?: string;
  notice?: string;
  error?: string;
  body: H;
}): H {
  const { dash } = opts;
  const site = opts.site ?? "/";
  const content = html`<main id="main">
${opts.notice ? html`<p class="notice" role="status">${opts.notice}</p>` : ""}
${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
${opts.body}
</main>
${
  opts.legal
    ? html`<footer class="legal"><a href="${opts.legal.terms}">Terms</a> · <a href="${opts.legal.privacy}">Privacy</a> · <a href="${opts.legal.dpa}">DPA</a> · <a href="${opts.legal.security}">Security</a> · <a href="${opts.legal.support}">Support</a></footer>`
    : ""
}`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="same-origin" />
<meta name="theme-color" content="#0c0b0a" />
<title>${opts.title} · Recall</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preload" href="/fonts/geist-sans.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/pixelify-sans.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="${dashPath("/static/app.css")}" />
<script src="${dashPath("/static/app.js")}" defer></script>
</head>
${
  dash
    ? html`<body class="app">
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<aside class="sidebar">
  <div class="side-top">
    <a class="brand" href="${dashPath("/")}">${LOGO}Recall</a>
    <span class="acct-chip" title="${dash.email}"><span class="avatar tone-0" aria-hidden="true">${initial(dash.accountName)}</span><bdi>${dash.accountName}</bdi></span>
  </div>
  <nav class="side-nav" id="side-nav" aria-label="Dashboard">${(
    dash.operator ? [...NAV_GROUPS, OPERATOR_NAV] : NAV_GROUPS
  ).map(
    ([group, items]) =>
      html`<p class="nav-group">${group}</p>${items.map(
        ([href, label, icon]) =>
          html`<a href="${dashPath(href)}" data-i="${icon}"${opts.active === href ? html` aria-current="page"` : ""}>${label}</a>`,
      )}`,
  )}</nav>
  <div class="side-foot">
    <a class="side-link docs-link" data-i="docs" href="${site}docs">Docs</a>
    <p class="me"><span class="me-name"><bdi>${dash.email}</bdi></span><span class="me-role">${dash.role}</span></p>
    <form method="post" action="${dashPath("/logout")}" class="inline">${csrfField(dash.csrf)}<button class="link side-link" data-i="out">Sign out</button></form>
  </div>
</aside>
<div class="main-col">
${content}
</div>
</div>
</body>`
    : html`<body class="signed-out">
<div class="night" aria-hidden="true"><div class="night-sky">${NIGHT_SKY}</div><div class="night-scene">${NIGHT_SCENE}</div></div>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="${site}">${LOGO}Recall</a>
  <a class="top-link" href="${site}docs">Docs</a>
</header>
${content}
</body>`
}
</html>`;
}

/** The first letter of a name, for its avatar square. */
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";

// ---------------------------------------------------------------------------
// Signed-out pages

/** Shown next to every button that signs in or creates an account; continuing records acceptance. */
const termsNotice = (legal: LegalLinks | null | undefined, action: string) =>
  legal
    ? html`<p class="muted small terms">By ${action}, you agree to the <a href="${legal.terms}" target="_blank" rel="noopener">Terms of Service</a> and the <a href="${legal.dpa}" target="_blank" rel="noopener">Data Processing Agreement</a> (version ${TERMS_VERSION}) and confirm that you have read the <a href="${legal.privacy}" target="_blank" rel="noopener">Privacy Policy</a>.</p>`
    : "";

export function loginPage(
  csrf: string,
  opts: {
    signup: boolean;
    email?: string;
    next?: string | null;
    site?: string;
    /** A password sign-in exists for app-directory reviewers. */
    reviewer?: boolean;
    legal?: LegalLinks | null;
  },
): H {
  return html`<section class="card narrow">
  <h1>${opts.signup ? "Sign in or create an account" : "Sign in"}</h1>
  ${opts.next ? html`<p>Sign in to connect an app to your Recall memory. The link in the email brings you back to approve it.</p>` : ""}
  <p class="muted">We email you a sign-in link. No password needed.</p>
  <form method="post" action="${dashPath("/login")}">
    ${csrfField(csrf)}
    ${opts.next ? html`<input type="hidden" name="next" value="${opts.next}" />` : ""}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@company.com" value="${opts.email ?? ""}" />
    <button class="wide">Email me a link</button>
  </form>
  ${termsNotice(opts.legal, "signing in or creating an account")}
  ${opts.signup ? html`<p class="muted small center">New accounts start with free credit. <a href="${opts.site ?? "/"}">What is Recall?</a></p>` : ""}
  ${opts.reviewer ? html`<p class="muted small center"><a href="${dashPath(`/login/password${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ""}`)}">App directory reviewer? Sign in with a password</a></p>` : ""}
</section>`;
}

/** Password sign-in, only for the configured app-directory reviewer. */
export function passwordLoginPage(
  csrf: string,
  opts: { next?: string | null; email?: string; legal?: LegalLinks | null },
): H {
  return html`<section class="card narrow">
  <h1>Reviewer sign-in</h1>
  <p class="muted">For app-directory reviewers. Everyone else signs in with an <a href="${dashPath(`/login${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ""}`)}">email link</a>.</p>
  <form method="post" action="${dashPath("/login/password")}">
    ${csrfField(csrf)}
    ${opts.next ? html`<input type="hidden" name="next" value="${opts.next}" />` : ""}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required maxlength="254" value="${opts.email ?? ""}" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200" />
    <button class="wide">Sign in</button>
  </form>
  ${termsNotice(opts.legal, "signing in")}
</section>`;
}

export function checkEmailPage(): H {
  return html`<section class="card narrow">
  <h1>Check your email</h1>
  <p>If that address can sign in, a link is on its way. It works once and expires in 15 minutes.</p>
  <p><a href="${dashPath("/login")}">Use a different address</a></p>
</section>`;
}

export function verifyPage(csrf: string, token: string, legal?: LegalLinks | null): H {
  return html`<section class="card narrow">
  <h1>Continue to Recall</h1>
  <form method="post" action="${dashPath("/auth/verify")}">
    ${csrfField(csrf)}
    <input type="hidden" name="token" value="${token}" />
    <button>Sign in</button>
  </form>
  ${termsNotice(legal, "continuing")}
</section>`;
}

/** All a suspended account's members see (403): the reason stays with the operator. */
export function suspendedPage(csrf: string): H {
  return html`<section class="card narrow">
  <h1>Account suspended</h1>
  <p>This account is suspended. Contact <a href="mailto:support@recallmem.dev">support@recallmem.dev</a>.</p>
  <p class="muted">Until then its API keys and connected apps are refused. Your data is kept, and owners and admins can still download it.</p>
  <div class="buttons"><form method="post" action="${dashPath("/settings/export")}">${csrfField(csrf)}<button class="secondary">Download your data</button></form>
  <form method="post" action="${dashPath("/logout")}">${csrfField(csrf)}<button class="secondary">Sign out</button></form></div>
</section>`;
}

export function linkInvalidPage(): H {
  return html`<section class="card narrow">
  <h1>That link has expired</h1>
  <p>Sign-in links work once and expire after 15 minutes.</p>
  <p><a class="button" href="${dashPath("/login")}">Get a new link</a></p>
</section>`;
}

// ---------------------------------------------------------------------------
// Helpers

const n = (v: number) => v.toLocaleString("en-US");
const date = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");
/** Dollars (a float) in the dashboard's one money format (see `formatUsd`). */
export const usd = (v: number) => formatUsd(Math.round(v * 1_000_000));

/** Labels for model tasks and charge kinds, the same on every page. */
export const TASK_LABELS: Record<string, string> = {
  ingest: "Learning (ingest)",
  reasoner: "Learning",
  summary: "Summaries",
  card: "Peer cards",
  dream: "Night shift",
  embedding: "Embeddings",
  chat_minimal: "Chat · minimal",
  chat_low: "Chat · low",
  chat_medium: "Chat · medium",
  chat_high: "Chat · high",
  chat_max: "Chat · max",
};
export const taskLabel = (task: string) =>
  TASK_LABELS[task] ?? task.replace(/^chat_/, "Chat · ").replace(/_/g, " ");

/** What a charge kind is billed by: message tokens for learning, questions for chat. */
export const unitsText = (kind: string, units: number) =>
  kind === "ingest"
    ? `${n(units)} message ${units === 1 ? "token" : "tokens"}`
    : `${n(units)} ${units === 1 ? "question" : "questions"}`;

const KIND_ORDER = ["ingest", ...CHAT_LEVELS.map((l) => `chat_${l}`)];
/** Learning first, then chat from minimal to max. */
const byKind = (a: { kind: string }, b: { kind: string }) =>
  (KIND_ORDER.indexOf(a.kind) + 1 || 99) - (KIND_ORDER.indexOf(b.kind) + 1 || 99);

/** A header for a column of buttons: read as "Actions" by screen readers, not shown. */
export const ACTIONS = "\u0000actions";

/**
 * A table in a scroll container that keyboard users can reach and scroll (`label` names it for
 * screen readers). A header of `ACTIONS` is read as "Actions" but not shown. With `stack`, rows
 * become cards on narrow screens, each cell showing its column's name (`data-label`). With
 * `pinFirst`, the first column stays in view while the table scrolls sideways.
 */
export function table(
  headers: string[],
  body: H[],
  empty: string | H = "Nothing yet.",
  opts: { label?: string; stack?: boolean; pinFirst?: boolean } = {},
): H {
  if (!body.length) return html`<p class="muted">${empty}</p>`;
  const label = opts.label ?? headers.filter((h) => h !== ACTIONS).join(", ");
  const cls = [opts.stack ? "stack" : "", opts.pinFirst ? "pin-first" : ""].filter(Boolean);
  return html`<div class="scroll" tabindex="0" role="region" aria-label="${label}"><table${cls.length ? html` class="${cls.join(" ")}"` : ""}>
<thead><tr>${headers.map((h) => (h === ACTIONS ? html`<th><span class="sr">Actions</span></th>` : html`<th>${h}</th>`))}</tr></thead>
<tbody>${body}</tbody>
</table></div>`;
}

/** Previous and next page links; `href(page)` builds a page's URL. */
export function pager(page: number, pages: number, href: (page: number) => string): H {
  if (pages <= 1) return html``;
  const link = (p: number, label: string, rel: string) =>
    p >= 1 && p <= pages
      ? html`<a class="button ghost small" rel="${rel}" href="${href(p)}">${label}</a>`
      : html`<span class="button ghost small disabled" aria-disabled="true">${label}</span>`;
  return html`<nav class="pager" aria-label="Pages">${link(page - 1, "← Newer", "prev")}<span>Page ${page} of ${pages}</span>${link(page + 1, "Older →", "next")}</nav>`;
}

/**
 * The step between a destructive button and its action: a page that says what will happen, with
 * the real button (posting `confirm=1`) and a way back. Works without JavaScript. With `type`, the
 * user also types a word (a peer's id, "rotate") before anything happens.
 */
export function confirmPage(d: {
  csrf: string;
  eyebrow?: string;
  title: string;
  lede: H | string;
  details?: H;
  action: string;
  button: string;
  cancel: string;
  hidden?: Record<string, string>;
  type?: { label: H | string; value: string };
}): H {
  return html`<section class="card confirm danger-zone">
  ${d.eyebrow ? html`<p class="eyebrow">${d.eyebrow}</p>` : ""}
  <h1>${d.title}</h1>
  <p>${d.lede}</p>
  ${d.details ?? ""}
  <form method="post" action="${d.action}">
    ${csrfField(d.csrf)}
    <input type="hidden" name="confirm" value="1" />
    ${Object.entries(d.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
    ${
      d.type
        ? html`<label for="confirm-text">${d.type.label}</label>
    <input id="confirm-text" name="confirm_text" required autocomplete="off" autocapitalize="off" spellcheck="false" />`
        : ""
    }
    <div class="buttons"><button class="danger">${d.button}</button><a class="button ghost" href="${d.cancel}">Cancel</a></div>
  </form>
</section>`;
}

/** Inside the layout: what an unknown dashboard page, workspace, peer or session answers (404). */
export function notFoundPage(d: { signedIn: boolean; detail?: string | null }): H {
  // Signed out, the page's own backdrop already is the night scene with the elephant.
  return html`<section class="lost${d.signedIn ? "" : " bare"}">
  ${d.signedIn ? html`<div class="lost-scene" aria-hidden="true"><div class="night framed"><div class="night-sky">${NIGHT_SKY}</div><div class="night-scene">${NIGHT_SCENE}</div></div></div>` : ""}
  <div class="lost-text">
    <p class="eyebrow">404 · not found</p>
    <h1>${d.detail ? `${d.detail.replace(/\.$/, "")}` : "This page does not exist"}</h1>
    <p class="muted">${
      d.detail
        ? "It may have been deleted, or it belongs to another account. The elephant looked everywhere."
        : "The link may be old or mistyped. The elephant looked everywhere."
    }</p>
    <div class="buttons">${
      d.signedIn
        ? html`<a class="button" href="${dashPath("/")}">Back to Overview</a><a class="button ghost" href="${dashPath("/memory")}">Browse memory</a>`
        : html`<a class="button" href="${dashPath("/login")}">Sign in</a>`
    }</div>
  </div>
</section>`;
}

/** Any other refused request (403, 422, …) as a page with a heading and a way back. */
export function errorPage(d: { status: number; back: string | null; signedIn: boolean }): H {
  const title =
    d.status === 403
      ? "Not allowed"
      : d.status === 401
        ? "Sign in first"
        : d.status >= 500
          ? "Something went wrong"
          : "That did not work";
  return html`<section class="card narrow-ish">
  <h1>${title}</h1>
  <p class="muted">${d.status >= 500 ? "Nothing was changed. Try again in a minute." : "Nothing was changed."}</p>
  <div class="buttons">${d.back ? html`<a class="button" href="${d.back}">Go back</a>` : ""}<a class="button ghost" href="${dashPath(d.signedIn ? "/" : "/login")}">${d.signedIn ? "Overview" : "Sign in"}</a></div>
</section>`;
}

// ---------------------------------------------------------------------------
// Overview

export interface OverviewData {
  billing: boolean;
  /**
   * A hosted account the operator set up, not billed: its usage is free, and its spend would be
   * our provider cost, which customers (and directory reviewers) are not shown.
   */
  unbilledHosted?: boolean;
  balanceMicros: number | null;
  blocked: "budget" | "credit" | null;
  /** This month's charges by kind, with their units (billed accounts). */
  charges: { kind: string; count: number; micros: number; tokens: number }[];
  budget: { monthly_budget_usd: number | null; month_to_date_usd: number; resets_at: string };
  /** Average usage charges per day over the last two weeks (billed accounts), for the runway. */
  burnPerDayMicros: number | null;
  checklist: Checklist;
  activity: DailySeries;
  connect: ConnectInfo;
}

/** Where a client connects, for the onboarding snippets (absolute URLs). */
export interface ConnectInfo {
  /** The API's base URL. */
  base: string;
  /** The MCP endpoint. */
  mcp: string;
  /** The API keys page, for the setup prompt. */
  keysUrl: string;
  /** The public site (docs, llms.txt), ending in "/". */
  site: string;
  /** The selected tab (`?connect=`), one of CONNECT_TABS. */
  tab: string;
}

export const CONNECT_TABS = [
  ["curl", "curl"],
  ["ts", "TypeScript"],
  ["py", "Python"],
  ["mcp", "MCP"],
  ["claude-code", "Claude Code"],
] as const;

/** The prompt a coding agent gets from "Copy setup prompt": it installs Recall in a project. */
export function setupPrompt(c: Pick<ConnectInfo, "base" | "keysUrl" | "site">): string {
  return `Add long-term memory to this project with Recall (${c.site}), so the app remembers each user across conversations.

1. Install the SDK for this project's language: \`npm install @recall-memory/sdk\` (TypeScript) or \`pip install recall-mem\` (Python, imported as \`recall_memory\`).
2. Read the key from the RECALL_API_KEY environment variable and the API's address from RECALL_URL (${c.base}); never hard-code the key. Add both to the example env file and tell me to create a key at ${c.keysUrl}.
3. Store every user and assistant message in a Recall session, with one stable peer id per person, and put the session's context into the prompt before each reply.
4. Follow the quickstart at ${c.site}docs#quickstart and the SDK docs at ${c.site}docs#sdks. ${c.site}llms.txt links the rest of the docs.`;
}

function connectSnippet(tab: string, c: ConnectInfo): { label: string; code: string; note: H } {
  const keys = html`<a href="${dashPath("/keys")}">API keys</a>`;
  switch (tab) {
    case "ts":
      return {
        label: "TypeScript",
        code: `// npm install @recall-memory/sdk
// .env: RECALL_URL=${c.base}  RECALL_API_KEY=pk_live_...
import { Recall } from "@recall-memory/sdk";

const recall = new Recall({ workspaceId: "my-app" });
const alice = recall.peer("alice");
const session = recall.session("s1");
await session.addMessages([alice.message("I moved to Utrecht.")]);

// Learning runs in the background; a moment later:
console.log(await alice.chat("Where does Alice live?"));`,
        note: html`The SDK reads <code>RECALL_URL</code> and <code>RECALL_API_KEY</code> from the environment. Create the key under ${keys}.`,
      };
    case "py":
      return {
        label: "Python",
        code: `# pip install recall-mem
# .env: RECALL_URL=${c.base}  RECALL_API_KEY=pk_live_...
from recall_memory import Recall

recall = Recall(workspace_id="my-app")
alice = recall.peer("alice")
session = recall.session("s1")
session.add_messages([alice.message("I moved to Utrecht.")])

# Learning runs in the background; a moment later:
print(alice.chat("Where does Alice live?"))`,
        note: html`The SDK reads <code>RECALL_URL</code> and <code>RECALL_API_KEY</code> from the environment. Create the key under ${keys}.`,
      };
    case "mcp":
      return {
        label: "MCP client config",
        code: `{
  "mcpServers": {
    "recall": {
      "type": "http",
      "url": "${c.mcp}"
    }
  }
}`,
        note: html`For Claude.ai, ChatGPT, Cursor or any MCP client: add <code>${c.mcp}</code> as a connector or MCP server and sign in when it asks. Apps you approve are listed under ${keys}, Connected apps.`,
      };
    case "claude-code":
      return {
        label: "Claude Code",
        code: `/plugin marketplace add recallmem/recall-plugin
/plugin install recall-memory@recall

# paste an API key when asked, then check it:
/recall-memory:status

# or connect the MCP server only (no automatic recall):
claude mcp add --transport http recall ${c.mcp}`,
        note: html`The plugin recalls what it knows about you at the start of each session and records every turn. Create its key under ${keys}.`,
      };
    default:
      return {
        label: "Shell",
        code: `export RECALL_API_KEY=pk_live_...

# 1. send a conversation turn
curl ${c.base}/v3/workspaces/my-app/sessions/s1/messages \\
  -H "Authorization: Bearer $RECALL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"peer_id":"alice","content":"I moved to Utrecht."}]}'

# 2. ask about the person
curl ${c.base}/v3/workspaces/my-app/peers/alice/chat \\
  -H "Authorization: Bearer $RECALL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"Where does Alice live?"}'`,
        note: html`Workspaces, sessions and peers are created on first use. Create the key under ${keys}.`,
      };
  }
}

/**
 * Ways to connect, one tab each. The tabs are links (`?connect=`), so they work without
 * JavaScript; app.js switches panels in place. Every panel is in the page, the others hidden.
 */
export function connectPanel(c: ConnectInfo): H {
  const active = CONNECT_TABS.some(([id]) => id === c.tab) ? c.tab : "curl";
  const prompt = setupPrompt(c);
  return html`<section class="panel connect" id="connect" data-tabs>
  <div class="panel-head"><h2>Connect your app</h2>
    <button type="button" class="secondary small copy-text" data-copy-text="setup-prompt" data-done="Copied: paste it into your coding agent" hidden>Copy setup prompt</button>
  </div>
  <nav class="segmented connect-tabs" aria-label="How to connect">${CONNECT_TABS.map(
    ([id, label]) =>
      html`<a href="${dashPath(`/?connect=${id}`)}#connect" data-tab="${id}"${id === active ? html` aria-current="true"` : ""}>${label}</a>`,
  )}</nav>
  ${CONNECT_TABS.map(([id]) => {
    const s = connectSnippet(id, c);
    return html`<div class="tab-panel" data-panel="${id}"${id === active ? "" : html` hidden`}>
    ${codeBlock(s.label, s.code)}
    <p class="hint">${s.note}</p>
  </div>`;
  })}
  <details class="setup-prompt"><summary>Setup prompt for a coding agent (Claude Code, Codex, Cursor)</summary>
    <p class="hint">Paste it into your agent: it installs the SDK, wires in the key and stores each conversation.</p>
    <pre class="code prompt" id="setup-prompt" data-copy tabindex="0">${prompt}</pre>
  </details>
</section>`;
}

/** Messages and questions per day: two single-series charts (never one chart with two axes). */
function activityCharts(a: DailySeries): H {
  const rows = a.days
    .map((day, i) => ({ day, m: a.messages[i] ?? 0, q: a.questions[i] ?? 0 }))
    .filter((r) => r.m || r.q)
    .reverse();
  const qLabel = a.questionsExact ? "Questions answered" : "Chat model calls";
  return html`<div class="charts">
  ${dayChart({
    title: "Messages",
    days: a.days,
    values: a.messages,
    unit: ["message", "messages"],
    tone: "amber",
    note: "by message time",
  })}
  ${dayChart({
    title: qLabel,
    days: a.days,
    values: a.questions,
    unit: a.questionsExact ? ["question", "questions"] : ["call", "calls"],
    tone: "sky",
    note: a.questionsExact ? "one billed query each" : "from model usage",
  })}
</div>
${
  rows.length
    ? html`<details class="chart-table"><summary>Show as table</summary>${table(
        ["Day (UTC)", "Messages", qLabel],
        rows.map(
          (r) =>
            html`<tr><td>${r.day}</td><td class="num">${n(r.m)}</td><td class="num">${n(r.q)}</td></tr>`,
        ),
        "",
        { label: "Activity by day" },
      )}</details>`
    : ""
}`;
}

/** "Nov 1" from an ISO time. */
const monthDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Roughly how long the credit lasts at the recent pace of charges. */
export function runway(balanceMicros: number, perDayMicros: number | null): string | null {
  if (balanceMicros <= 0) return null;
  if (!perDayMicros || perDayMicros <= 0) return "No charges in the last 14 days";
  const days = Math.floor(balanceMicros / perDayMicros);
  if (days > 365) return "More than a year at your recent pace";
  if (days < 1) return "Less than a day at your recent pace";
  return `About ${days} ${days === 1 ? "day" : "days"} of credit at your recent pace`;
}

function budgetStat(b: OverviewData["budget"]): H {
  if (b.monthly_budget_usd == null)
    return html`<div class="stat"><span class="label">Monthly budget</span><span class="value">No limit</span><span class="sub">Set a cap to pause spending at a monthly amount.</span><a href="${dashPath("/settings#budget")}">Set a budget</a></div>`;
  const cap = b.monthly_budget_usd;
  const pct = cap > 0 ? Math.min(100, (b.month_to_date_usd / cap) * 100) : 100;
  const shown = cap > 0 ? Math.floor((b.month_to_date_usd / cap) * 100) : 100;
  const tone = pct >= 100 ? " over" : pct >= 80 ? " warn" : "";
  return html`<div class="stat"><span class="label">Monthly budget</span><span class="value">${usd(cap)}</span>
  <span class="budget-bar${tone}" role="img" aria-label="${shown}% of the monthly budget used"><svg class="meter" width="100%" height="10" aria-hidden="true" shape-rendering="crispEdges"><line class="track" x1="0" x2="100%" y1="5" y2="5"/><line class="fill" x1="0" x2="${pct.toFixed(1)}%" y1="5" y2="5"/></svg></span>
  <span class="sub">${usd(b.month_to_date_usd)} used (${shown}%) · resets ${monthDay(b.resets_at)}</span>
  <a href="${dashPath("/settings#budget")}">Change</a></div>`;
}

export function overviewPage(d: OverviewData): H {
  const totalCharges = d.charges.reduce((s, c) => s + c.micros, 0);
  const setUp = d.checklist.key && d.checklist.messages && d.checklist.asked;
  const left =
    d.billing && d.balanceMicros != null ? runway(d.balanceMicros, d.burnPerDayMicros) : null;
  return html`<header class="page-head"><div><h1>Overview</h1></div>
<div class="head-actions"><a class="button ghost" href="${dashPath("/memory")}">Explore memory</a><a class="button" href="${dashPath("/playground")}">Open Playground</a></div></header>
${
  d.blocked === "credit"
    ? html`<p class="error">Out of credit: chat answers 402 and background learning is paused (nothing is dropped). <a href="${dashPath("/billing")}">Add credits</a></p>`
    : d.blocked === "budget"
      ? html`<p class="error">Your monthly budget is reached: chat answers 402 and background learning is paused until ${date(d.budget.resets_at)} UTC or until you <a href="${dashPath("/settings#budget")}">raise the budget</a>.</p>`
      : ""
}
${checklistCard(d.connect.base, d.checklist)}
<div class="stats">
  ${
    d.billing && d.balanceMicros != null
      ? html`<div class="stat"><span class="label">Credit balance</span><span class="value">${balance(d.balanceMicros)}</span>${left ? html`<span class="sub">${left}</span>` : ""}<a href="${dashPath("/billing")}">Add credits</a></div>`
      : ""
  }
  ${
    d.billing
      ? html`<div class="stat"><span class="label">Charged this month</span><span class="value">${formatUsd(totalCharges)}</span><a href="${dashPath("/usage")}">Usage by day</a></div>`
      : d.unbilledHosted
        ? html`<div class="stat"><span class="label">Billing</span><span class="value">Not billed</span><span class="sub">Set up by the operator: usage is free.</span><a href="${dashPath("/usage")}">Usage by day</a></div>`
        : html`<div class="stat"><span class="label">Spend this month</span><span class="value">${usd(d.budget.month_to_date_usd)}</span><a href="${dashPath("/usage")}">Usage by day</a></div>`
  }
  ${d.unbilledHosted ? "" : budgetStat(d.budget)}
</div>
${setUp ? "" : connectPanel(d.connect)}
<h2>Activity</h2>
${activityCharts(d.activity)}
${
  d.billing
    ? html`<h2>Charges this month by task</h2>
${table(
  ["Task", "Billed units", "Charged"],
  d.charges
    .filter((c) => c.count || c.micros)
    .sort(byKind)
    .map(
      (c) =>
        html`<tr><td>${taskLabel(c.kind)}</td><td class="num" data-label="Billed units">${unitsText(c.kind, c.kind === "ingest" ? c.tokens : c.count)}</td><td class="num" data-label="Charged">${formatUsd(c.micros)}</td></tr>`,
    ),
  "No charges this month.",
  { label: "Charges this month by task", stack: true },
)}`
    : ""
}
${setUp ? connectPanel(d.connect) : ""}`;
}

// ---------------------------------------------------------------------------
// API keys

/** Apps connected through OAuth (MCP connectors), with their reach and a Revoke button. */
function connectedApps(csrf: string, apps: GrantOut[], mcpUrl: string, canManage: boolean): H {
  const reach = (a: GrantOut) =>
    a.workspaces === null ? "all workspaces" : a.workspaces.join(", ");
  return html`<h2 id="connected-apps">Connected apps</h2>
<p class="muted">Apps you approved by signing in from them (MCP connectors in Claude, ChatGPT, editors). Each works with the reach shown until you revoke it; revoking signs the app out within seconds. With "Remember automatically" on, the app saves lasting facts you share (preferences, plans, people) without being asked.</p>
<div class="mcp-url">${codeBlock("MCP endpoint", mcpUrl)}
<p class="hint">Add this URL as a custom connector in Claude.ai or ChatGPT, or as an MCP server in your editor, and sign in when it asks. The app appears here once you approve it.</p></div>
${table(
  ["App", "Reach", "Remember automatically", "Last used", ...(canManage ? [ACTIONS] : [])],
  apps.map(
    (a) => html`<tr>
<td data-label="App" class="wrap"><bdi>${a.client_name}</bdi> <span class="chip" title="${a.client_id}">${a.redirect_host}</span><span class="cell-sub">approved by ${a.approved_by}, ${day(a.created_at)}</span></td>
<td data-label="Reach" class="wrap">${reach(a)}<span class="cell-sub">default ${a.default_workspace}${a.default_peer ? html` · peer ${a.default_peer}` : ""}</span></td>
<td data-label="Remember automatically">${
      canManage
        ? html`<form method="post" action="${dashPath(`/connected-apps/${a.id}/auto-remember`)}" class="inline">${csrfField(csrf)}<input type="hidden" name="on" value="${a.auto_remember ? "0" : "1"}" /><span class="chip">${a.auto_remember ? "On" : "Off"}</span> <button class="link small">${a.auto_remember ? "Turn off" : "Turn on"}</button></form>`
        : html`<span class="chip">${a.auto_remember ? "On" : "Off"}</span>`
    }</td>
<td data-label="Last used">${date(a.last_used_at)}</td>
${canManage ? html`<td class="actions"><a class="button danger small" href="${dashPath(`/connected-apps/${a.id}/revoke`)}">Revoke</a></td>` : ""}</tr>`,
  ),
  "No apps connected yet.",
  { label: "Connected apps", stack: true },
)}`;
}

/** What a key may reach, in words. */
export const keyScope = (k: ApiKeyOut) =>
  k.admin
    ? "account (all workspaces)"
    : [
        k.scope.workspace_id,
        k.scope.peer_id && `peer ${k.scope.peer_id}`,
        k.scope.session_id && `session ${k.scope.session_id}`,
      ]
        .filter(Boolean)
        .join(" · ");

export const EXPIRY_CHOICES = [
  ["", "Never"],
  ["7", "In 7 days"],
  ["30", "In 30 days"],
  ["90", "In 90 days"],
  ["365", "In a year"],
] as const;

/** The create-key form's values, kept when the server sends the form back with an error. */
export interface KeyForm {
  name?: string;
  mode?: string;
  workspace_id?: string;
  peer_id?: string;
  session_id?: string;
  expires_in?: string;
  rate_limit_per_min?: string;
}

export interface KeysData {
  csrf: string;
  keys: ApiKeyOut[];
  /** The key just created (from the flash): shown once. */
  created?: { key: string; name: string; workspace: string | null } | null;
  /** OAuth on: the account's connected apps (null when OAuth is off). */
  apps?: GrantOut[] | null;
  /** Owners and admins create and revoke keys; members only see them. */
  canManage: boolean;
  /** The account's workspaces, for the scope picker. */
  workspaces: string[];
  /** The rate limit a key gets when it sets none (0: no limit). */
  defaultRateLimit: number;
  base: string;
  mcpUrl: string;
  form?: KeyForm;
}

function newKeyCard(c: NonNullable<KeysData["created"]>, base: string): H {
  const env = [
    `RECALL_URL=${base}`,
    `RECALL_API_KEY=${c.key}`,
    ...(c.workspace ? [`RECALL_WORKSPACE_ID=${c.workspace}`] : []),
  ].join("\n");
  return html`<section class="card reveal" id="new-key" aria-labelledby="new-key-h">
<h2 id="new-key-h">Your new key${c.name ? html`: <bdi>${c.name}</bdi>` : ""}</h2>
<p>Copy it now: it is shown only once, and reloading this page will not show it again. Only a hash is stored.</p>
<pre class="secret" data-copy tabindex="0">${c.key}</pre>
${codeBlock(".env", env)}
<p class="hint">The SDKs read these variables: <code>new Recall()</code> in TypeScript (<code>npm install @recall-memory/sdk</code>) or <code>Recall()</code> in Python (<code>pip install recall-mem</code>). More ways to connect are on the <a href="${dashPath("/?connect=curl")}#connect">Overview</a>.</p>
</section>`;
}

function createKeyForm(d: KeysData): H {
  const f = d.form ?? {};
  const rate = d.defaultRateLimit;
  return html`<section class="card" id="create-key">
<h2>Create a key</h2>
<form method="post" action="${dashPath("/keys")}">
  ${csrfField(d.csrf)}
  <label for="name">Name</label>
  <input id="name" name="name" maxlength="200" placeholder="production agent" value="${f.name ?? ""}" />
  <label for="mode">Label</label>
  <select id="mode" name="mode" aria-describedby="mode-help"><option value="live"${f.mode === "test" ? "" : html` selected`}>live</option><option value="test"${f.mode === "test" ? html` selected` : ""}>test</option></select>
  <p class="hint" id="mode-help">A <code>pk_test_</code> key is only a label that helps you tell keys apart: it reaches the same data and is billed exactly like a live key. Use a separate workspace for test data.</p>
  <fieldset>
    <legend>Scope</legend>
    <label for="workspace_id">Workspace</label>
    <select id="workspace_id" name="workspace_id"><option value="">Whole account (every workspace)</option>${d.workspaces.map(
      (w) => html`<option value="${w}"${f.workspace_id === w ? html` selected` : ""}>${w}</option>`,
    )}</select>
    <label for="peer_id">Peer <span class="faint">(optional)</span></label>
    <input id="peer_id" name="peer_id" maxlength="100" pattern="[A-Za-z0-9_\\-]+" autocomplete="off" spellcheck="false" value="${f.peer_id ?? ""}" aria-describedby="scope-help" />
    <label for="session_id">Session <span class="faint">(optional)</span></label>
    <input id="session_id" name="session_id" maxlength="100" pattern="[A-Za-z0-9_\\-]+" autocomplete="off" spellcheck="false" value="${f.session_id ?? ""}" aria-describedby="scope-help" />
    <p class="hint" id="scope-help">A peer or session must already exist in the chosen workspace. A key scoped to a peer reads and writes only that peer's memory.</p>
  </fieldset>
  <div class="field-row">
    <div class="field"><label for="expires_in">Expires</label>
    <select id="expires_in" name="expires_in">${EXPIRY_CHOICES.map(
      ([v, label]) =>
        html`<option value="${v}"${(f.expires_in ?? "") === v ? html` selected` : ""}>${label}</option>`,
    )}</select></div>
    <div class="field"><label for="rate_limit_per_min">Requests per minute</label>
    <input id="rate_limit_per_min" name="rate_limit_per_min" type="number" min="1" ${rate > 0 ? html`max="${rate}"` : ""} step="1" inputmode="numeric" placeholder="${rate > 0 ? `default ${n(rate)}` : "no limit"}" value="${f.rate_limit_per_min ?? ""}" /></div>
  </div>
  <p class="hint">Leave the rate empty for the default${rate > 0 ? ` (${n(rate)} a minute)` : ""}; a key can only be given a lower limit.</p>
  <button>Create key</button>
</form>
</section>`;
}

export function keysPage(d: KeysData): H {
  const now = Date.now();
  const limits = (k: ApiKeyOut) => {
    const expired = k.expires_at != null && new Date(k.expires_at).getTime() <= now;
    return html`${
      k.expires_at
        ? expired
          ? html`<span class="badge contradiction">expired ${day(k.expires_at)}</span>`
          : html`expires ${day(k.expires_at)}`
        : "never expires"
    }<span class="cell-sub">${k.rate_limit_per_min ? `${n(k.rate_limit_per_min)}/min` : "default rate"}</span>`;
  };
  return html`<header class="page-head"><div><h1>API keys</h1>
<p class="lede">Keys authenticate your agents against <code>${d.base}</code>. Each is shown once, when you create it.</p></div>
${d.canManage ? html`<div class="head-actions"><a class="button" href="#create-key">Create a key</a></div>` : ""}</header>
${d.created ? newKeyCard(d.created, d.base) : ""}
${table(
  ["Name", "Key", "Scope", "Expiry and rate", "Last used", ...(d.canManage ? [ACTIONS] : [])],
  d.keys.map(
    (k) => html`<tr${k.revoked_at ? html` class="revoked"` : ""}>
<td data-label="Name" class="wrap"><bdi>${k.name || "—"}</bdi>${k.mode === "test" ? html` <span class="chip" title="A label only: same data and billing as a live key">test</span>` : ""}</td>
<td data-label="Key"><code>${k.prefix}…</code></td>
<td data-label="Scope" class="wrap">${keyScope(k)}</td>
<td data-label="Expiry and rate">${limits(k)}</td>
<td data-label="Last used">${date(k.last_used_at)}<span class="cell-sub">created ${day(k.created_at)}</span></td>
${
  d.canManage
    ? html`<td class="actions">${
        k.revoked_at
          ? html`<span class="faint">revoked ${day(k.revoked_at)}</span>`
          : html`<a class="button danger small" href="${dashPath(`/keys/${k.id}/revoke`)}" aria-label="Revoke ${k.name || k.prefix}">Revoke</a>`
      }</td>`
    : ""
}</tr>`,
  ),
  "No keys yet.",
  { label: "API keys", stack: true },
)}
${d.canManage ? createKeyForm(d) : html`<p class="muted small">Owners and admins can create and revoke keys.</p>`}
${d.apps ? connectedApps(d.csrf, d.apps, d.mcpUrl, d.canManage) : ""}`;
}

/** The confirmation before a key is revoked. */
export function revokeKeyPage(csrf: string, k: ApiKeyOut): H {
  return confirmPage({
    csrf,
    eyebrow: "API keys",
    title: `Revoke ${k.name ? `“${k.name}”` : "this key"}?`,
    lede: "Every request with this key gets 401 within seconds, and keys minted from it (POST /v3/keys) stop working too. This cannot be undone: an app that uses it needs a new key.",
    details: html`<dl class="facts-dl"><dt>Key</dt><dd><code>${k.prefix}…</code>${k.mode === "test" ? " (test)" : ""}</dd><dt>Scope</dt><dd>${keyScope(k)}</dd><dt>Last used</dt><dd>${date(k.last_used_at)}</dd></dl>`,
    action: dashPath(`/keys/${k.id}/revoke`),
    button: "Revoke key",
    cancel: dashPath("/keys"),
  });
}

/** The confirmation before a connected app is signed out. */
export function revokeAppPage(csrf: string, a: GrantOut): H {
  return confirmPage({
    csrf,
    eyebrow: "Connected apps",
    title: `Disconnect ${a.client_name}?`,
    lede: "The app is signed out within seconds and its tokens stop working. To use it again, add the connector and approve it once more.",
    details: html`<dl class="facts-dl"><dt>App</dt><dd><bdi>${a.client_name}</bdi> <span class="chip">${a.redirect_host}</span></dd><dt>Reach</dt><dd>${a.workspaces === null ? "all workspaces" : a.workspaces.join(", ")}</dd><dt>Last used</dt><dd>${date(a.last_used_at)}</dd></dl>`,
    action: dashPath(`/connected-apps/${a.id}/revoke`),
    button: "Disconnect app",
    cancel: dashPath("/keys#connected-apps"),
  });
}

// ---------------------------------------------------------------------------
// Usage

/**
 * What the account bought in the last 30 days: message tokens learned and questions answered per
 * level, next to what each was charged (billed accounts). Model calls and model tokens are not
 * shown: they are Recall's cost, not what the account pays for.
 */
export function usagePage(d: UsageReport & { minTokens: number }): H {
  const by = new Map(d.days.map((r) => [r.day, r]));
  const series = (f: (r: UsageDay) => number) =>
    d.range.map((day) => (by.has(day) ? f(by.get(day)!) : 0));
  const total = d.lines.reduce((t, l) => t + (l.micros ?? 0), 0);
  const billed = d.billed;
  return html`<header class="page-head"><div><h1>Usage</h1>
<p class="lede">Last 30 days, UTC. What Recall learned and answered for this account${billed ? ", and what it was charged" : ""}.</p></div></header>
<div class="charts">
  ${
    billed
      ? dayChart({
          title: "Charged",
          days: d.range,
          values: series((r) => r.micros ?? 0),
          unit: ["charged", "charged"],
          tone: "amber",
          format: (m) => formatUsd(Math.round(m)),
          note: "learning and questions",
        })
      : dayChart({
          title: "Tokens learned",
          days: d.range,
          values: series((r) => r.tokens),
          unit: ["message token", "message tokens"],
          tone: "amber",
          note: "messages learned from",
        })
  }
  ${dayChart({
    title: billed ? "Questions answered" : "Questions",
    days: d.range,
    values: series((r) => r.questions),
    unit: ["question", "questions"],
    tone: "sky",
    note: billed ? "every level" : "approximate",
  })}
</div>
<h2>${billed ? "Charges, last 30 days" : "Last 30 days"}</h2>
${table(
  billed ? ["Task", "Billed units", "Charged"] : ["Task", "Units"],
  [
    ...d.lines.map(
      (l) =>
        html`<tr><td>${taskLabel(l.kind)}</td><td class="num" data-label="${billed ? "Billed units" : "Units"}">${unitsText(l.kind, l.units)}</td>${
          billed ? html`<td class="num" data-label="Charged">${formatUsd(l.micros ?? 0)}</td>` : ""
        }</tr>`,
    ),
    ...(billed && d.lines.length
      ? [
          html`<tr class="total"><td><strong>Total</strong></td><td class="num" colspan="2" data-label="Charged"><strong>${formatUsd(total)}</strong></td></tr>`,
        ]
      : []),
  ],
  "Nothing learned or answered in the last 30 days.",
  // Rows become cards on narrow screens: units and amounts do not fit side by side at 390px.
  { label: billed ? "Charges, last 30 days" : "Usage, last 30 days", stack: true },
)}
<h2>By day</h2>
${table(
  ["Day", "Tokens learned", "Questions", ...(billed ? ["Charged"] : [])],
  d.days.map(
    (r) =>
      html`<tr><td><time datetime="${r.day}">${shortDay(r.day)}</time></td><td class="num">${n(r.tokens)}</td><td class="num">${n(r.questions)}</td>${
        billed ? html`<td class="num">${formatUsd(r.micros ?? 0)}</td>` : ""
      }</tr>`,
  ),
  "No usage in the last 30 days.",
  { label: "Usage by day", pinFirst: true },
)}
<p class="muted small">${
    billed
      ? html`Learning is charged per message token (each message counts as at least ${n(d.minTokens)} tokens) and chat per question, by reasoning level; a charge given back when no answer came is not counted. Context, search, storage, summaries and the night shift are included. Prices are on <a href="${dashPath("/billing")}">Billing</a>.`
      : html`This account is not billed. Tokens learned are those of the messages Recall learned from. Questions are an estimate: answers from the cache are left out, and an answer at high or max may count more than once.`
  } Machine-readable: <code>GET /v3/usage</code> with an account API key.</p>`;
}

// ---------------------------------------------------------------------------
// Billing

export interface BillingData {
  csrf: string;
  /** This account is billed (it has a credit balance). */
  enabled: boolean;
  /** Billing is on for the server; an account without a balance is then an operator-made, unbilled one. */
  serverBilling: boolean;
  /** Stripe Tax is on: amounts are credit, tax is added at checkout. */
  taxed: boolean;
  balanceMicros: number;
  amounts: number[];
  minMicros: number;
  maxMicros: number;
  hasCard: boolean;
  auto: {
    enabled: boolean;
    thresholdMicros: number;
    amountMicros: number;
    failures: number;
    lastError: string | null;
    /** Switching it on needs the consent box (legal pages set, no consent under these terms). */
    needsConsent: boolean;
  };
  /** The operator's Terms of Service, when legal pages are configured. */
  termsUrl: string | null;
  prices: {
    ingestPerMTokMicros: number;
    ingestMinTokens: number;
    chatMicros: Record<string, number>;
  };
  ledger: { items: LedgerLine[]; page: number; pages: number; total: number };
  invoices: Invoice[] | null;
}

export const LEDGER_LABELS: Record<string, string> = {
  ...TASK_LABELS,
  signup_credit: "Welcome credit",
  topup: "Top-up",
  auto_topup: "Auto top-up",
  grant: "Credit grant",
  refund: "Refund",
};

/** A ledger entry's label; a usage kind with a positive amount is a charge given back. */
export const ledgerLabel = (e: { kind: string; amount_micros: number }) => {
  const label = LEDGER_LABELS[e.kind] ?? e.kind;
  return e.amount_micros > 0 && (e.kind === "ingest" || e.kind.startsWith("chat_"))
    ? `${label} (returned)`
    : label;
};

const dollars = (micros: number) => (micros / 1_000_000).toFixed(2);
/** A balance in whole cents, rounded down so it never shows more than is there. */
const balance = (micros: number) =>
  micros > 0 && micros < 10_000 ? "<$0.01" : formatUsd(Math.floor(micros / 10_000) * 10_000);
/** An invoice total in its own currency ("€25.00", "$10.00"). */
const invoiceTotal = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};

function creditHistory(l: BillingData["ledger"]): H {
  const row = (e: LedgerLine) => {
    const grouped = e.day !== null;
    return html`<tr${grouped ? html` class="grouped"` : ""}><td data-label="Date">${grouped ? html`${e.day} <span class="faint">UTC</span>` : date(e.created_at)}</td><td data-label="Entry" class="wrap">${ledgerLabel(e)}${
      grouped
        ? html`<span class="cell-sub">${n(e.entries)} ${e.entries === 1 ? "batch" : "batches"} of messages, added up for the day</span>`
        : ""
    }</td><td data-label="Amount" class="num ${e.amount_micros < 0 ? "neg" : "pos"}">${formatUsd(e.amount_micros, { exact: !grouped })}</td><td data-label="Balance" class="num">${formatUsd(e.balance_after_micros)}</td></tr>`;
  };
  return html`<section class="panel" id="credit-history">
<div class="panel-head"><h2>Credit history</h2><span class="muted small">Newest first. Learning charges are added up per day; every other entry is listed on its own.</span></div>
${table(["Date", "Entry", "Amount", "Balance"], l.items.map(row), "No credit activity yet.", {
  label: "Credit history",
  stack: true,
})}
${pager(l.page, l.pages, (p) => `${dashPath(p > 1 ? `/billing?ledger_page=${p}` : "/billing")}#credit-history`)}
</section>`;
}

export function billingPage(d: BillingData): H {
  if (!d.enabled)
    return html`<h1>Billing</h1><p class="muted">${
      d.serverBilling
        ? "This account is not billed: it was set up by the operator, so its usage is free and has no credit limit. Accounts created by signing up use prepaid credit."
        : "Billing is not enabled on this server."
    }</p>`;
  return html`<h1>Billing</h1>
<div class="stats"><div class="stat"><span class="label">Credit balance</span><span class="value">${balance(d.balanceMicros)}</span><a href="${dashPath("/settings#alerts")}">Email alerts</a></div></div>
<section class="card">
<h2>Buy credits</h2>
<form method="post" action="${dashPath("/billing/checkout")}" class="buttons">
  ${csrfField(d.csrf)}
  ${d.amounts.map((a) => html`<button name="amount_usd" value="${dollars(a)}">${formatUsd(a)}</button>`)}
</form>
<form method="post" action="${dashPath("/billing/checkout")}" class="row">
  ${csrfField(d.csrf)}
  <label for="custom">Other amount (USD)</label>
  <input id="custom" name="amount_usd" type="number" min="${dollars(d.minMicros)}" max="${dollars(d.maxMicros)}" step="1" required />
  <button>Continue to checkout</button>
</form>
<p class="muted small">Payments are handled by Stripe.${d.taxed ? " Amounts are credit; VAT or sales tax is added at checkout where it applies, and you can add your VAT number there." : ""} Credit is in US dollars; Checkout charges the euro amount at the European Central Bank's daily rate, or your own currency where Stripe offers it, and takes cards, iDEAL, Bancontact and other local methods. A card is saved with Stripe for auto top-up and only charged automatically if you turn it on.</p>
</section>
<section class="card">
<h2>Auto top-up</h2>
${
  d.auto.lastError
    ? html`<p class="error">Last auto top-up failed${d.auto.failures ? html` (${d.auto.failures}×)` : ""}: ${d.auto.lastError}</p>`
    : ""
}
${d.hasCard ? "" : html`<p class="muted">Buy credits once to save a card, then turn this on.</p>`}
<form method="post" action="${dashPath("/billing/auto-topup")}">
  ${csrfField(d.csrf)}
  <label class="check"><input type="checkbox" name="enabled" value="1"${d.auto.enabled ? html` checked` : ""}${d.hasCard ? "" : html` disabled`} /> Top up automatically</label>
  <label for="threshold">When the balance drops below (USD)</label>
  <input id="threshold" name="threshold_usd" type="number" min="0" step="1" value="${dollars(d.auto.thresholdMicros)}" />
  <label for="amount">Add (USD)</label>
  <input id="amount" name="amount_usd" type="number" min="${dollars(d.minMicros)}" max="${dollars(d.maxMicros)}" step="1" value="${dollars(d.auto.amountMicros)}" />
  ${
    d.auto.needsConsent && d.termsUrl
      ? html`<label class="check"><input type="checkbox" name="consent" value="1"${d.hasCard ? "" : html` disabled`} /> I agree that each automatic top-up is a purchase under the <a href="${d.termsUrl}" target="_blank" rel="noopener">Terms of Service</a> and ask Recall to make it available immediately. If I am a consumer, I keep my 14-day right of withdrawal for credit I have not used.</label>`
      : ""
  }
  <button>Save</button>
</form>
</section>
<section class="card">
<h2>Payment methods and invoices</h2>
<form method="post" action="${dashPath("/billing/portal")}">${csrfField(d.csrf)}<button>Open the Stripe customer portal</button></form>
${
  d.invoices === null
    ? html`<p class="muted small">Invoices are unavailable right now.</p>`
    : table(
        ["Invoice", "Date", "Total", "Status", ACTIONS],
        d.invoices.map(
          (i) =>
            html`<tr><td data-label="Invoice">${i.number ?? i.id}</td><td data-label="Date">${date(i.created)}</td><td data-label="Total" class="num">${invoiceTotal(i.total_cents, i.currency)}</td><td data-label="Status">${i.status ?? ""}</td><td class="actions">${
              i.url
                ? html`<a href="${i.url}" rel="noopener noreferrer" target="_blank">View</a>`
                : ""
            }</td></tr>`,
        ),
        "No invoices yet.",
        { label: "Invoices", stack: true },
      )
}
</section>
<h2>Prices</h2>
${table(
  ["Item", "Price"],
  [
    html`<tr><td class="wrap">Learning from messages${d.prices.ingestMinTokens ? html`<span class="cell-sub">a message counts as at least ${d.prices.ingestMinTokens} tokens</span>` : ""}</td><td class="num">${formatUsd(d.prices.ingestPerMTokMicros, { exact: true })} per 1M tokens</td></tr>`,
    ...Object.entries(d.prices.chatMicros).map(
      ([level, m]) =>
        html`<tr><td>Chat · ${level}</td><td class="num">${formatUsd(m, { exact: true })} per query</td></tr>`,
    ),
    html`<tr><td>Context, search, storage, summaries, night shift</td><td class="num">included</td></tr>`,
  ],
  "",
  { label: "Prices" },
)}
${creditHistory(d.ledger)}`;
}

// ---------------------------------------------------------------------------
// Settings

/** The account's email alerts, as the settings form shows them. */
export interface AlertSettingsView {
  lowBalance: boolean;
  lowBalanceThresholdMicros: number;
  budget80: boolean;
  budget100: boolean;
  outOfCredit: boolean;
}

export interface SettingsData {
  csrf: string;
  name: string;
  accountId: string;
  owner: boolean;
  /** Owners and admins change settings; members see them. */
  canManage: boolean;
  budgetUsd: number | null;
  webhookSecret: string | null;
  /** The secret was just rotated: show it open. */
  secretRotated: boolean;
  members: { email: string; role: string }[];
  alerts: AlertSettingsView;
  /** Prepaid credit: the balance alerts apply. */
  billed: boolean;
  autoTopup: boolean;
}

function alertsCard(d: SettingsData): H {
  const a = d.alerts;
  const off = d.canManage ? "" : html` disabled`;
  const owners = d.members.filter((m) => m.role === "owner").map((m) => m.email);
  const check = (name: string, on: boolean, label: H | string, help?: H | string) =>
    html`<label class="check"><input type="checkbox" name="${name}" value="1"${on ? html` checked` : ""}${off} /> ${label}${help ? html`<span class="check-help">${help}</span>` : ""}</label>`;
  return html`<section class="card" id="alerts">
<h2>Email alerts</h2>
<p class="muted">Sent to the account's owners (${owners.join(", ") || "none"}), once each time a line is crossed: a budget alert at most once a month, a balance alert again only after the balance has recovered.</p>
<form method="post" action="${dashPath("/settings/alerts")}">
  ${csrfField(d.csrf)}
  ${
    d.billed
      ? html`${check(
          "low_balance",
          a.lowBalance,
          "Low balance",
          d.autoTopup
            ? "Skipped while auto top-up is on; you hear from us if a top-up fails."
            : "When the credit balance drops below the amount below.",
        )}
  <div class="indent"><label for="low-threshold">Low balance below (USD)</label>
  <input id="low-threshold" name="low_balance_usd" type="number" min="0.01" max="100000" step="0.01" value="${dollars(a.lowBalanceThresholdMicros)}"${off} /></div>
  ${check("out_of_credit", a.outOfCredit, "Out of credit", "Chat answers 402 and learning pauses until you add credit.")}`
      : ""
  }
  ${check("budget_80", a.budget80, "80% of the monthly budget used")}
  ${check("budget_100", a.budget100, "Monthly budget reached", "Chat answers 402 and learning pauses until the month ends or you raise the budget.")}
  ${d.budgetUsd == null ? html`<p class="hint">Budget alerts start once you set a monthly budget above.</p>` : ""}
  ${d.canManage ? html`<button>Save alerts</button>` : ""}
</form>
</section>`;
}

/** The webhook signing secret: reveal and rotate (the rotation asks first). */
export function webhookSecretCard(d: {
  secret: string | null;
  rotated: boolean;
  canManage: boolean;
  rotateHref: string;
  more?: H;
}): H {
  return html`<section class="card" id="webhook-secret">
<h2>Webhook signing secret</h2>
<p class="muted">Every delivery carries <code>X-Recall-Signature</code>: the HMAC-SHA256 of the request body with this secret, in hex. One secret signs the webhooks of every workspace in this account.${d.more ? html` ${d.more}` : ""}</p>
${
  d.secret
    ? html`<details${d.rotated ? html` open` : ""}><summary>${d.rotated ? "New secret: update your verifier now" : "Reveal the secret"}</summary><pre class="secret" data-copy tabindex="0">${d.secret}</pre></details>`
    : d.canManage
      ? ""
      : html`<p class="muted small">Owners and admins can see and rotate the secret.</p>`
}
${d.canManage ? html`<p><a class="button secondary" href="${d.rotateHref}">Rotate secret…</a></p>` : ""}
</section>`;
}

/** Asks before the signing secret changes; `next` names the page to return to. */
export function rotateSecretPage(csrf: string, next: string, cancel: string): H {
  return confirmPage({
    csrf,
    eyebrow: "Webhooks",
    title: "Rotate the webhook signing secret?",
    lede: "Deliveries are signed with the new secret immediately, and the old one stops working: until you update your verifier, it will reject every webhook from every workspace in this account.",
    action: dashPath("/settings/rotate-webhook-secret"),
    hidden: { next },
    button: "Rotate secret",
    cancel,
    type: { label: html`Type <strong>rotate</strong> to confirm`, value: "rotate" },
  });
}

export function settingsPage(d: SettingsData): H {
  const off = d.canManage ? "" : html` disabled`;
  return html`<h1>Settings</h1>
<section class="card">
<h2>Account</h2>
<p class="muted small">ID <code>${d.accountId}</code></p>
<form method="post" action="${dashPath("/settings/name")}" class="row">
  ${csrfField(d.csrf)}
  <label for="acct-name">Name</label>
  <input id="acct-name" name="name" required maxlength="200" value="${d.name}"${off} />
  ${d.canManage ? html`<button>Save</button>` : ""}
</form>
<h3>Members</h3>
<ul>${d.members.map((m) => html`<li>${m.email} <span class="chip">${m.role}</span></li>`)}</ul>
</section>
<section class="card" id="budget">
<h2>Monthly budget</h2>
<p class="muted">Chat answers 402 and background learning pauses (nothing is dropped) once this month's charges reach the cap. Leave empty for no cap.</p>
<form method="post" action="${dashPath("/settings/budget")}" class="row">
  ${csrfField(d.csrf)}
  <label for="budget-usd">Cap (USD)</label>
  <input id="budget-usd" name="monthly_budget_usd" type="number" min="0" step="0.01" value="${d.budgetUsd ?? ""}"${off} />
  ${d.canManage ? html`<button>Save</button>` : ""}
</form>
</section>
${alertsCard(d)}
${webhookSecretCard({
  secret: d.webhookSecret,
  rotated: d.secretRotated,
  canManage: d.canManage,
  rotateHref: dashPath("/settings/rotate-webhook-secret"),
  more: html`Endpoints are set per workspace: open a workspace under <a href="${dashPath("/memory")}">Memory</a>, then Webhooks.`,
})}
<section class="card">
<h2>Your data</h2>
<p>Download everything this account stores (workspaces, peers, sessions, messages, conclusions, summaries, keys, usage and credit history) as JSON.</p>
<form method="post" action="${dashPath("/settings/export")}">${csrfField(d.csrf)}<button>Export all data</button></form>
</section>
${
  d.owner
    ? html`<section class="card danger-zone">
<h2>Delete account</h2>
<p>Permanently deletes this account and all its data, revokes every API key and signs everyone out. Remaining credit is forfeited. This cannot be undone.</p>
<form method="post" action="${dashPath("/settings/delete")}">
  ${csrfField(d.csrf)}
  <label for="confirm">Type the account name <strong>${d.name}</strong> to confirm</label>
  <input id="confirm" name="confirm" required autocomplete="off" />
  <button class="danger">Delete account and data</button>
</form>
</section>`
    : ""
}`;
}

// ---------------------------------------------------------------------------

/** 16-pixel sidebar icons, drawn on the same grid as the logo and used as CSS masks so they take the link's colour. */
const ICONS: Record<string, string> = {
  home: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z",
  memory:
    "M4 1h8v1h2v3h-2v1H4V5H2V2h2zM2 7h2v1h8V7h2v3h-2v1H4v-1H2zM2 12h2v1h8v-1h2v2h-2v1H4v-1H2z",
  chat: "M2 2h12v9H8v1H7v1H6v1H5v-3H2zM4 6h2v2H4zM7 6h2v2H7zM10 6h2v2h-2z",
  key: "M1 5h8v6H1zM3 7h2v2H3zM9 7h6v2H9zM11 9h2v2h-2zM14 9h1v3h-1z",
  usage: "M2 9h3v5H2zM7 5h3v9H7zM12 2h3v12h-3zM1 14h14v1H1z",
  card: "M1 3h14v10H1zM1 5h14v2H1zM3 9h4v2H3z",
  sliders:
    "M1 2h3v2H1zM4 1h3v4H4zM7 2h8v2H7zM1 7h7v2H1zM8 6h3v4H8zM11 7h4v2h-4zM1 12h2v2H1zM3 11h3v4H3zM6 12h9v2H6z",
  shield:
    "M2 1h12v7h-1v2h-1v1h-1v1h-1v1h-1v1H7v-1H6v-1H5v-1H4v-1H3V8H2zM4 3h8v4h-1v2h-1v1h-1v1H7v-1H6V9H5V7H4z",
  docs: "M3 1h7v1h1v1h1v1h1v11H3zM5 6h6v1H5zM5 9h6v1H5zM5 12h4v1H5z",
  out: "M2 2h7v3H7V4H4v8h3v-1h2v3H2zM8 7h3V5h1v1h1v1h1v2h-1v1h-1v1h-1V9H8z",
};
const ICON_CSS = Object.entries(ICONS)
  .map(
    ([name, d]) =>
      `[data-i=${name}]{--i:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill-rule='evenodd' d='${d}'/%3E%3C/svg%3E")}`,
  )
  .join("\n");

export const STYLESHEET = `
/* Recall dashboard: the public site's polished 8-bit look. Geist for reading, a pixel display face for titles and big numbers, amber phosphor and hard shadows. Tokens match /site.css. */
@font-face{font-family:"Silkscreen";src:url(/fonts/silkscreen-700.woff2) format("woff2");font-weight:700;font-display:swap}
@font-face{font-family:"Silkscreen";src:url(/fonts/silkscreen-400.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Pixelify Sans";src:url(/fonts/pixelify-sans.woff2) format("woff2");font-weight:400 700;font-display:swap}
/* titles and big numbers: Pixelify Sans letters with Departure Mono digits, $, % and capital C (Pixelify's 5 reads as an S and its C as an O); the second face comes last so it wins for its range */
@font-face{font-family:"Recall Display";src:url(/fonts/pixelify-sans.woff2) format("woff2");font-weight:400 700;font-display:swap}
@font-face{font-family:"Recall Display";src:url(/fonts/departure-mono.woff2) format("woff2");font-weight:400 700;font-display:swap;unicode-range:U+0024-0025,U+0030-0039,U+0043}
@font-face{font-family:"Departure Mono";src:url(/fonts/departure-mono.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Geist";src:url(/fonts/geist-sans.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/fonts/geist-mono.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{--bg:#0c0b0a;--bg-2:#12100d;--panel:#171410;--panel-2:#1e1a14;--well:#070605;--line:#2b261d;--line-2:#3d3528;--ctl:#7d7565;--fg:#f4efe4;--muted:#bdb5a5;--faint:#9a917f;--amber:#ffb000;--amber-2:#ffcb4d;--amber-dim:#7a5300;--ink:#120d02;--green:#4dff9a;--red:#ff5f56;--cyan:#5fd7ff;--pixel:"Silkscreen","Pixelify Sans",monospace;--pix2:"Recall Display","Pixelify Sans",monospace;--mono:"Departure Mono","Geist Mono",ui-monospace,monospace;--sans:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--code:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--hard:4px 4px 0 #000;--lift:6px 6px 0 #000,6px 6px 0 2px var(--amber-dim);--side:244px;color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none !important}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:14px/1.6 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
/* faint CRT scanlines over everything; they never catch the pointer and drop out for high contrast */
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:100;background:repeating-linear-gradient(180deg,rgba(0,0,0,.12) 0,rgba(0,0,0,.12) 1px,transparent 1px,transparent 3px);opacity:.16}
body.signed-out{position:relative;isolation:isolate;background:var(--bg)}
/* ---- signed-out backdrop: the landing page's night sky and elephant (night.ts) ---- */
.night{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.night-sky{position:absolute;inset:0}.night-sky svg,.night-scene svg{display:block;width:100%;height:100%}
.night-scene{position:absolute;left:0;right:0;bottom:0;height:clamp(150px,32vh,360px)}
.night .tw{animation:night-twinkle 3.6s steps(1) infinite}.night .tw1{animation-delay:-1.2s;animation-duration:4.4s}.night .tw2{animation-delay:-2.5s;animation-duration:2.8s}
@keyframes night-twinkle{0%,100%{opacity:1}50%{opacity:.25}}
.night .blink{animation:night-twinkle 2.2s steps(1) infinite}.night .beacon{animation:night-beacon 1.6s steps(1) infinite}
@keyframes night-beacon{0%,100%{opacity:1}30%{opacity:0}}
.night .walker{animation:night-walk 42s linear -15s infinite}@keyframes night-walk{from{transform:translateX(-190px)}to{transform:translateX(190px)}}
.night .ef0{animation:night-f0 .7s steps(1) infinite}.night .ef1{opacity:0;animation:night-f1 .7s steps(1) infinite}
@keyframes night-f0{0%{opacity:1}50%{opacity:0}}@keyframes night-f1{0%{opacity:0}50%{opacity:1}}
.night .orb{animation:night-twinkle 1.4s steps(1) infinite}
.night .mem{animation:night-rise 9s steps(30) infinite}.night .mem1{animation-duration:11s;animation-delay:-3s}.night .mem2{animation-duration:8s;animation-delay:-6s}.night .mem3{animation-duration:12s;animation-delay:-1s}.night .mem4{animation-duration:10s;animation-delay:-8s}.night .mem5{animation-duration:7s;animation-delay:-4s}
@keyframes night-rise{0%{transform:translateY(0);opacity:0}12%{opacity:1}80%{opacity:.7}100%{transform:translateY(-46px);opacity:0}}
body.signed-out footer.legal{position:relative;text-shadow:1px 1px 0 #000}
a{color:var(--amber);text-underline-offset:3px}
a:hover{color:var(--amber-2)}
::selection{background:var(--amber);color:var(--ink)}
:focus-visible{outline:3px solid var(--amber);outline-offset:2px}
code,pre{font-variant-ligatures:none;font-feature-settings:"calt" 0,"liga" 0}
.skip{position:absolute;left:12px;top:-80px;z-index:200;padding:10px 14px;background:var(--amber);color:var(--ink);font:600 14px var(--sans);text-decoration:none}
.skip:focus{top:12px;color:var(--ink)}
.brand{display:flex;align-items:center;gap:10px;font:700 18px var(--pixel);letter-spacing:.04em;text-decoration:none;color:var(--fg)}
.brand:hover{color:var(--amber)}
.brand svg{width:auto;height:25px}
/* ---- signed-in shell: sidebar and content column ---- */
.shell{display:grid;grid-template-columns:var(--side) minmax(0,1fr);min-height:100vh;background:linear-gradient(90deg,var(--bg-2) calc(var(--side) - 2px),var(--line) calc(var(--side) - 2px) var(--side),transparent var(--side)) no-repeat}
.sidebar{position:sticky;top:0;display:flex;flex-direction:column;height:100vh;overflow-y:auto;padding:20px 14px 16px}
.side-top{display:flex;flex-direction:column;gap:18px;padding:0 6px}
.acct-chip{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;background:var(--panel);border:2px solid var(--line-2);box-shadow:3px 3px 0 #000;font:600 14px var(--sans);color:var(--fg)}
.acct-chip bdi{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acct-chip .avatar{width:24px;height:24px;font-size:14px;box-shadow:none}
.side-nav{display:flex;flex-direction:column;gap:2px;margin:10px 0 0}
.nav-group{margin:18px 10px 6px;font:12px var(--mono);letter-spacing:.02em;color:var(--faint)}
.side-nav a,.side-link{display:flex;align-items:center;gap:11px;padding:8px 10px;color:var(--muted);font:500 14px/1.3 var(--sans);text-decoration:none}
.side-nav a:hover,.side-link:hover{background:var(--panel);color:var(--fg)}
.side-nav a[aria-current]{background:var(--panel-2);color:var(--fg);box-shadow:inset 3px 0 0 var(--amber)}
.side-nav a[aria-current]::before{background:var(--amber)}
[data-i]::before{content:"";flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:var(--i) center/16px 16px no-repeat;mask:var(--i) center/16px 16px no-repeat}
.side-foot{display:flex;flex-direction:column;gap:2px;margin-top:auto;padding-top:14px;border-top:2px solid var(--line)}
.me{display:flex;flex-direction:column;margin:6px 10px 6px;font-size:12.5px;line-height:1.45;color:var(--faint)}
.me-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.me-role{font:12px var(--mono)}
button.link.side-link{width:100%;justify-content:flex-start;min-height:0;margin:0;padding:8px 10px;border:0;background:none;color:var(--muted);font:500 14px/1.3 var(--sans);box-shadow:none}
button.link.side-link:hover{background:var(--panel);color:var(--fg)}
.main-col{display:flex;flex-direction:column;min-width:0;min-height:100vh}
main{width:100%;max-width:1180px;margin:0 auto;padding:40px 44px 72px}
.main-col main{flex:1}
footer.legal{padding:18px 28px 28px;font-size:12.5px;color:var(--faint);text-align:center}footer.legal a{color:var(--muted)}
.terms{margin-top:14px}
/* ---- signed-out header ---- */
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:1180px;margin:0 auto;padding:0 28px;min-height:68px}
.top-link{color:var(--muted);font:500 14px var(--sans);text-decoration:none}.top-link:hover{color:var(--fg)}
/* ---- headings ---- */
h1{margin:.2rem 0 .8rem;font:700 30px/1.15 var(--pix2);font-synthesis:none;letter-spacing:0;text-shadow:3px 3px 0 #000}
h1.ident{font:700 28px/1.2 var(--pix2);overflow-wrap:anywhere}
h2{display:flex;align-items:center;gap:10px;margin:2.6rem 0 1rem;font:600 17px/1.3 var(--sans);letter-spacing:-.005em}
h2::before{content:"";flex:none;width:8px;height:8px;background:var(--amber);box-shadow:2px 2px 0 #000}
h3{margin:1.2rem 0 .4rem;font:600 15px/1.35 var(--sans)}
.eyebrow{display:block;margin:0 0 6px;font:12.5px var(--mono);letter-spacing:.02em;color:var(--amber)}
.lede{margin:0;max-width:64ch;font-size:15px;color:var(--muted)}
.muted{color:var(--muted)}.faint{color:var(--faint)}.small{font-size:13px}.center{text-align:center}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ident{font-family:var(--code);overflow-wrap:anywhere}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px 24px;margin:0 0 28px}
.page-head h1{margin:.1rem 0 .5rem}
.meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;font-size:13.5px;color:var(--muted)}
.meta span+span::before{content:"";display:inline-block;width:4px;height:4px;margin:0 12px 3px -9px;background:var(--faint)}
.head-actions{display:flex;flex-wrap:wrap;gap:12px}.head-actions .button{margin:0}
.who-head{display:flex;align-items:flex-start;gap:16px}.who-head>.avatar{width:52px;height:52px;margin-top:4px;font-size:26px;box-shadow:3px 3px 0 #000}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0 0 16px;font-size:13px;color:var(--faint)}
.crumbs a{color:var(--muted);text-decoration:none}.crumbs a:hover{color:var(--amber)}.crumbs .sep{color:var(--faint)}.crumbs [aria-current]{color:var(--fg)}
/* ---- cards, stats, notices ---- */
.card{--pad:22px;margin:18px 0;padding:var(--pad);background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard)}
.card>h2:first-child{gap:9px;margin:calc(var(--pad)*-1) calc(var(--pad)*-1) var(--pad);padding:11px 16px;background:var(--panel-2);border-bottom:2px solid var(--line-2);font:600 14px/1.4 var(--sans);color:var(--fg)}
.card>h2:first-child::before{width:6px;height:6px;box-shadow:none}
.card>h2:first-child+p{margin-top:0}.card>p:last-child{margin-bottom:0}
.narrow{--pad:34px;max-width:440px;margin:7vh auto 0;border-color:var(--amber);box-shadow:var(--lift)}
.narrow h1{margin-top:0;font-size:26px}
.reveal{border-color:var(--amber);box-shadow:var(--lift)}
.danger-zone{border-color:rgba(255,95,86,.55)}.danger-zone>h2:first-child{color:var(--red);border-bottom-color:rgba(255,95,86,.55)}.danger-zone>h2:first-child::before{background:var(--red)}
.notice,.error{margin:0 0 22px;padding:12px 16px;border:2px solid var(--green);background:rgba(77,255,154,.06);box-shadow:var(--hard);font-size:14px}
.notice::before,.error::before{content:"OK";display:inline-block;margin-right:12px;padding:1px 8px;background:var(--green);color:var(--ink);font:700 11px/1.6 var(--pixel);letter-spacing:.08em;vertical-align:1px}
.error{border-color:var(--red);background:rgba(255,95,86,.07)}.error::before{content:"ERROR";background:var(--red)}
.stats .stat:only-child{max-width:360px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin:0 0 8px}
.stat{display:flex;flex-direction:column;gap:6px;padding:18px 20px;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard)}
.stat .label{font:500 13px var(--sans);color:var(--muted)}
.stat .value,.chart-total,.mini-stats dd{font-synthesis:none;text-shadow:.05em 0 0 currentColor,3px 3px 0 #000}
.stat .value{font:700 30px/1.2 var(--pix2);color:var(--amber);overflow-wrap:anywhere}
.stat a{font-size:13px}
.stat .sub{font-size:12.5px;color:var(--faint)}
.stats.compact{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}.stats.compact .stat{padding:14px 16px}.stats.compact .stat .value{font-size:24px}
.panel{margin:0 0 30px}
.panel-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin:0 0 14px}
.panel-head h2{margin:0}
.divider{height:2px;margin:20px 0 6px;background:repeating-linear-gradient(90deg,var(--line-2) 0 4px,transparent 4px 8px)}
.hint{margin:12px 0 0;font-size:13px;color:var(--faint)}.hint a{color:var(--muted)}
.empty-inline{margin:0;padding:20px;border:2px dashed var(--line-2);background:var(--bg-2);color:var(--muted)}
/* ---- tables ---- */
.scroll{overflow-x:auto;margin:0 0 6px;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard)}
table{width:100%;border-collapse:collapse}
th,td{padding:11px 16px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
tr:last-child td{border-bottom:0}
th{background:var(--panel-2);border-bottom:2px solid var(--line-2);font:500 12.5px var(--sans);color:var(--faint)}
td{font-size:14px}
th.num{text-align:right}
/* a header lines up with its column when the column holds numbers */
table:has(tbody>tr:first-child>td.num:nth-child(2)) th:nth-child(2){text-align:right}
table:has(tbody>tr:first-child>td.num:nth-child(3)) th:nth-child(3){text-align:right}
table:has(tbody>tr:first-child>td.num:nth-child(4)) th:nth-child(4){text-align:right}
table:has(tbody>tr:first-child>td.num:nth-child(5)) th:nth-child(5){text-align:right}
table:has(tbody>tr:first-child>td.num:nth-child(6)) th:nth-child(6){text-align:right}
table:has(tbody>tr:first-child>td.num:nth-child(7)) th:nth-child(7){text-align:right}
td.num{text-align:right;font:13.5px var(--code);font-variant-numeric:tabular-nums;color:var(--fg)}
td.num.neg{color:var(--red)}td.num.pos{color:var(--green)}
tbody tr:hover td{background:var(--panel-2)}
/* the first column (a day, a name) stays in view while a wide table scrolls sideways */
table.pin-first th:first-child,table.pin-first td:first-child{position:sticky;left:0;z-index:1;background:var(--panel)}
table.pin-first th:first-child{background:var(--panel-2)}
table.pin-first tbody tr:hover td:first-child{background:var(--panel-2)}
tr.revoked td{color:var(--faint)}
table.list td{padding-top:10px;padding-bottom:10px}
.table-link{color:var(--fg);text-decoration:none}.table-link:hover{color:var(--amber)}
.scroll :focus-visible{outline-offset:-3px}
.card .scroll{margin-top:20px;box-shadow:none}
.card>ul:not([class]){margin:0;padding:0;list-style:none}.card>ul:not([class]) li{position:relative;padding:6px 0 6px 18px}.card>ul:not([class]) li::before{content:"";position:absolute;left:2px;top:15px;width:6px;height:6px;background:var(--amber)}.buttons+form{margin-top:20px}
/* ---- forms and buttons ---- */
label{display:block;margin:16px 0 6px;font:500 13.5px/1.4 var(--sans);color:var(--muted)}
label strong{color:var(--fg)}
/* the box sits in the gutter so a label with a link in it still wraps as one paragraph */
label.check{position:relative;display:block;min-height:20px;padding-left:32px;font-weight:400;color:var(--fg);cursor:pointer}
label.check>input{position:absolute;left:0;top:0}
input,select,textarea{width:100%;max-width:460px;height:42px;padding:0 12px;border:2px solid var(--ctl);border-radius:0;background:var(--well);color:var(--fg);font:14px var(--sans)}
textarea{display:block;max-width:none;height:auto;min-height:96px;padding:10px 12px;line-height:1.55;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:hover,select:hover,textarea:hover{border-color:var(--muted)}
input:focus-visible,select:focus-visible,textarea:focus-visible{border-color:var(--amber);outline-offset:0}
input:disabled,select:disabled{opacity:.55}
select{appearance:none;-webkit-appearance:none;padding-right:36px;background:var(--well) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 5' shape-rendering='crispEdges'%3E%3Cpath fill='%23ffb000' d='M0 0h10v1H0zM1 1h8v1H1zM2 2h6v1H2zM3 3h4v1H3zM4 4h2v1H4z'/%3E%3C/svg%3E") no-repeat right 12px center/10px 5px}
option{background:var(--bg-2);color:var(--fg)}
input[type=checkbox],input[type=radio]{appearance:none;-webkit-appearance:none;flex:none;width:20px;height:20px;padding:0;cursor:pointer}
input[type=checkbox]:checked,input[type=radio]:checked{background:var(--amber);box-shadow:inset 0 0 0 3px var(--well)}
input[type=radio]:checked{box-shadow:inset 0 0 0 5px var(--well)}
input[type=checkbox]:disabled,input[type=radio]:disabled{cursor:not-allowed}
fieldset{max-width:500px;margin:18px 0;padding:4px 16px 16px;border:2px solid var(--line-2)}
legend{padding:0 8px;font:500 13.5px var(--sans);color:var(--muted)}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:10px;max-width:100%;min-height:42px;margin-top:16px;padding:6px 18px;line-height:1.25;text-align:center;border:2px solid var(--amber);border-radius:0;background:var(--amber);color:var(--ink);font:600 14px var(--sans);text-decoration:none;cursor:pointer;box-shadow:4px 4px 0 #000,4px 4px 0 2px var(--amber-dim);transition:transform .08s steps(2)}
button:hover,.button:hover{background:var(--amber-2);border-color:var(--amber-2);color:var(--ink);transform:translate(-2px,-2px);box-shadow:var(--lift)}
button:active,.button:active{transform:translate(2px,2px)}
button svg,.button svg{width:16px;height:16px;flex:none}
button.wide{width:100%;max-width:460px;min-height:46px}
button.small,.button.small{min-height:32px;margin:0;padding:3px 12px;font-size:13px}
.small-cta{margin-top:12px}
.button.ghost,button.secondary{border-color:var(--fg);background:transparent;color:var(--fg);box-shadow:4px 4px 0 #000}
.button.ghost:hover,button.secondary:hover{border-color:var(--amber);background:var(--panel-2);color:var(--amber);box-shadow:6px 6px 0 #000}
button.danger{border-color:var(--red);background:transparent;color:var(--red);box-shadow:4px 4px 0 #000}
button.danger:hover{border-color:var(--red);background:var(--red);color:var(--ink);box-shadow:6px 6px 0 #000}
button.link{min-height:0;margin:0;padding:6px 10px;border-color:transparent;background:none;color:var(--muted);font:500 13.5px var(--sans);box-shadow:none}
button.link:hover{border-color:transparent;background:var(--panel-2);color:var(--fg);transform:none;box-shadow:none}
.button.disabled{opacity:.4;pointer-events:none}
button[disabled]{opacity:.7;cursor:progress}
form.inline{display:inline;margin:0}
form+p,form+.scroll{margin-top:22px}
.side-foot form.inline{display:block}
.buttons{display:flex;flex-wrap:wrap;gap:14px}.buttons button{margin:0}
.row{display:flex;flex-wrap:wrap;align-items:end;gap:10px}.row label{width:100%}.row input{flex:1;min-width:140px}.row button{margin:0}
.inline-form{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.inline-form input{width:230px}.inline-form button{margin:0}
.copy-btn{min-height:28px;margin:0;padding:2px 10px;white-space:nowrap;border:2px solid var(--line-2);background:transparent;color:var(--muted);font:500 12.5px var(--sans);box-shadow:none}
.copy-btn:hover{border-color:var(--amber);background:var(--amber);color:var(--ink);transform:none;box-shadow:none}
/* ---- code ---- */
pre{margin:0;padding:14px 16px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;background:var(--well);border:2px solid var(--line-2);box-shadow:var(--hard);font:13px/1.7 var(--code);color:#ddd6c8}
code{overflow-wrap:anywhere;padding:1px 5px;background:#1d1913;border:1px solid var(--line-2);font:.9em var(--code);color:#f4ecda}
pre code,.code-head code{padding:0;border:0;background:none;font-size:inherit}
.secret{border-color:var(--amber);background:rgba(255,176,0,.06);color:var(--amber-2);font-size:14px}
.code-block{margin:14px 0 0;background:var(--well);border:2px solid var(--line-2);box-shadow:var(--hard)}
.code-head{display:flex;align-items:center;justify-content:space-between;min-height:38px;padding:0 6px 0 14px;background:var(--panel-2);border-bottom:2px solid var(--line-2);font:12.5px var(--mono);color:var(--muted)}
.code-head>span:first-child::before{content:"";display:inline-block;width:6px;height:6px;margin:0 9px 2px 0;background:var(--amber)}
.code-block pre{border:0;box-shadow:none;background:none}
pre.code{white-space:pre;word-break:normal}
pre.plain{padding:0;border:0;background:none;box-shadow:none;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;font:13px/1.6 var(--code);color:#ddd6c8}
.copyable{position:relative}.copyable pre{padding-right:68px}.copyable>.copy-btn{position:absolute;top:8px;right:8px}
.raw{margin-top:16px}.raw pre{max-height:420px;overflow:auto}
details summary{display:flex;align-items:baseline;gap:10px;cursor:pointer;list-style:none;color:var(--muted)}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"+";flex:none;width:12px;color:var(--amber);font:700 14px var(--pixel)}
details[open]>summary::before{content:"−"}
details summary:hover{color:var(--fg)}
/* ---- badges, chips, counts, avatars ---- */
.chip,.badge{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:1px 8px;border:1px solid var(--line-2);background:var(--bg-2);font:12px/1.4 var(--sans);color:var(--muted);white-space:nowrap}
.badge{font:12px/1.5 var(--mono)}
.badge.current{border-color:rgba(77,255,154,.5);color:var(--green)}
.badge.current::before{content:"";width:6px;height:6px;background:var(--green)}
.badge.superseded{border-style:dashed;color:var(--faint)}
.badge.inferred{border-color:rgba(95,215,255,.5);color:var(--cyan)}
.badge.contradiction{border-color:rgba(255,95,86,.55);color:var(--red)}
.badge.warn{border-color:rgba(255,176,0,.55);color:var(--amber)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}
.count{display:inline-block;padding:0 6px;background:var(--line-2);font:12px/1.6 var(--code);color:var(--fg)}
.avatar{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;font:700 16px/1 var(--pixel);text-transform:uppercase;color:var(--ink);box-shadow:2px 2px 0 #000}
.tone-0{background:var(--amber)}.tone-1{background:var(--cyan)}.tone-2{background:var(--green)}.tone-3{background:#ff8f5a}.tone-4{background:var(--red)}.tone-5{background:var(--fg)}
.who{display:inline-flex;align-items:center;gap:10px;color:var(--fg);text-decoration:none}
.who:hover,.who:hover .ident{color:var(--amber)}
span.stack{display:inline-flex;vertical-align:middle}.stack .avatar{width:22px;height:22px;margin-left:-6px;font-size:12px;box-shadow:0 0 0 2px var(--panel)}.stack .avatar:first-child{margin-left:0}
.stack-names{margin-left:6px;font-size:13px;color:var(--muted)}
/* ---- tabs, segmented controls, filters ---- */
.tabs,.segmented{display:flex;width:max-content;max-width:100%;overflow-x:auto;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard)}
.tabs{margin:30px 0 20px}
.tabs a,.segmented a{display:flex;align-items:center;gap:10px;padding:9px 16px;border-right:2px solid var(--line-2);color:var(--muted);font:500 13.5px var(--sans);text-decoration:none;white-space:nowrap}
.tabs a:last-child,.segmented a:last-child{border-right:0}
.tabs a:hover,.segmented a:hover{background:var(--panel-2);color:var(--fg)}
.tabs a[aria-current],.segmented a[aria-current]{background:var(--amber);color:var(--ink)}
.tabs a[aria-current] .count,.segmented a[aria-current] .count{background:var(--ink);color:var(--amber)}
.tabs :focus-visible,.segmented :focus-visible{outline-offset:-5px}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin:0 0 18px}
.segmented.views{margin:0 0 14px}.segmented.views .avatar{width:18px;height:18px;font-size:9px;box-shadow:none}
.filter-form{display:flex;flex-wrap:wrap;flex:1;gap:10px;min-width:240px}
.filter-form input{flex:1;min-width:150px;max-width:none}.filter-form button{margin:0}
/* ---- workspaces ---- */
.ws-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:20px}
.ws-card{display:flex;flex-direction:column;gap:18px;padding:20px 22px;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard);color:var(--fg);text-decoration:none;transition:transform .08s steps(2)}
.ws-card:hover{transform:translate(-2px,-2px);border-color:var(--amber);box-shadow:var(--lift);color:var(--fg)}
.ws-card-top{display:flex;align-items:center;gap:12px;min-width:0}
.ws-icon{display:grid;place-items:center;flex:none;width:36px;height:36px;background:var(--well);border:2px solid var(--line-2);color:var(--amber)}.ws-icon svg{width:18px;height:18px}
.ws-name{font:600 15px var(--code);overflow-wrap:anywhere}
.ws-card .go{margin-left:auto;color:var(--faint)}.ws-card:hover .go{color:var(--amber)}
.mini-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0}
.mini-stats dt{font:500 12.5px var(--sans);color:var(--faint)}
.mini-stats dd{margin:2px 0 0;font:700 22px/1.2 var(--pix2);color:var(--amber);text-shadow:.05em 0 0 currentColor,2px 2px 0 #000}
.ws-foot{padding-top:14px;border-top:1px solid var(--line);font-size:12.5px;color:var(--faint)}
.status{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin:18px 0 0;padding:10px 14px;background:var(--bg-2);border:2px solid var(--line-2);font-size:13.5px;color:var(--muted)}
.status strong{font-weight:500;color:var(--fg)}.status-sub{font-size:12.5px;color:var(--faint)}.status>.status-sub:last-child{margin-left:auto}
.status>.dot+span{flex:1 1 200px}
.dot{flex:none;width:10px;height:10px;background:var(--green)}
.dot.busy{background:var(--amber);animation:blink 1s steps(1) 4}
@keyframes blink{50%{opacity:0}}
/* ---- two-column layout ---- */
.layout{display:grid;gap:24px;grid-template-columns:minmax(0,1fr);align-items:start}
.layout>.side>.card:first-child,.layout>.main>:first-child{margin-top:0}
.side .card{--pad:18px;margin:0 0 20px}
@media (min-width:1180px){.layout{grid-template-columns:minmax(0,1fr) 340px;grid-template-areas:"main side"}.layout>.main{grid-area:main}.layout>.side{grid-area:side;position:sticky;top:24px}}
@media (max-width:1179px){.layout>.side{display:contents}.layout>.side>.card{margin:0}.layout>.main{order:1}.layout>.side>.late{order:2}.meta span+span::before{display:none}}
/* ---- facts ---- */
.facts{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;margin:0;padding:0;list-style:none}
.fact{position:relative;padding:14px 16px 14px 24px;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard);scroll-margin-top:24px}
.fact::before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--green)}
.fact.is-superseded{border-style:dashed;background:var(--bg-2);box-shadow:none}
.fact.is-superseded::before{background:var(--line-2)}
.fact:target{border-color:var(--amber);background:#1d1608;box-shadow:4px 4px 0 #000,4px 4px 0 2px var(--amber-dim)}
.fact-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px 16px}
.fact-text{margin:0;font-size:15px;line-height:1.55}
.is-superseded .fact-text{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--red);text-decoration-thickness:2px}
.fact-badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;flex:none}
.fact-meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12.5px;color:var(--faint)}
.fact-meta a{color:var(--muted)}
.validity{font:12px var(--code);color:var(--muted)}
.refs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;font-size:12.5px;color:var(--faint)}
.refs>span:not(.ref){margin-left:4px}.refs>span:first-child{margin-left:0}
.ref{display:inline-block;max-width:100%;padding:1px 7px;border:1px solid var(--line-2);background:var(--bg-2);font:12px var(--code);color:var(--muted);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a.ref:hover{border-color:var(--amber);color:var(--amber)}
.ref.replaced{color:var(--green);border-color:var(--green)}
.fact-meta .from{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px}
@media (max-width:560px){.fact-top{flex-direction:column}.fact-badges{justify-content:flex-start}}
/* peer card, link lists */
.card-list{margin:0;padding:0;list-style:none}
.card-list li{position:relative;padding:8px 0 8px 18px;border-bottom:1px solid var(--line);font-size:14px}
.card-list li::before{content:"";position:absolute;left:2px;top:17px;width:6px;height:6px;background:var(--amber)}
.card-list li:last-child{border-bottom:0}
.card-key{display:block;font:500 12.5px var(--sans);color:var(--faint)}
.other-card{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.link-list{margin:0;padding:0;list-style:none}
.link-list li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:14px}
.link-list li:last-child{border-bottom:0}.link-list .sub{font-size:12.5px;color:var(--faint)}
.link-list a.ident{color:var(--fg);text-decoration:none}.link-list a.ident:hover{color:var(--amber)}
/* ---- ask and answer ---- */
.ask-form label{margin-top:0}
.ask-form textarea{margin-bottom:4px}
.ask-row{display:flex;flex-wrap:wrap;gap:0 12px}.ask-row .field{flex:1;min-width:180px}.side .ask-row .field{flex-basis:100%}.ask-row label{margin-top:12px}.ask-row select{max-width:none}
.ask-form button.wide{max-width:none}
.picker{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px}.picker .field{flex:1;min-width:160px}.picker label{margin-top:0}.picker select{max-width:none}.picker button{margin:0}
.answer{margin:0 0 28px;padding:22px 24px;background:#1b1507;border:2px solid var(--amber);box-shadow:var(--lift)}
.answer.abstained{border-color:var(--line-2);background:var(--panel);box-shadow:var(--hard)}
.answer.failed{border-color:var(--red);background:var(--panel);box-shadow:var(--hard)}
.answer-q{display:flex;flex-direction:column;gap:4px;margin:0 0 14px}.answer-q .q{font-size:14px;color:var(--muted)}
.answer-text{font-size:16px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
.answer-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;margin-top:18px;padding-top:14px;border-top:2px dashed var(--line-2);font-size:13px;color:var(--muted)}
.confidence{display:inline-flex;align-items:center;gap:10px}.confidence .label{color:var(--faint)}.confidence strong{font:700 16px var(--pix2);color:var(--fg)}
.meter{flex:none}.meter line{stroke-width:10;stroke-dasharray:6 2}
.meter .track{stroke:var(--line-2)}.meter .fill{stroke:var(--green)}
.confidence.mid .fill{stroke:var(--amber)}.confidence.low .fill{stroke:var(--red)}
.progress{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted)}.progress .meter .fill{stroke:var(--amber)}
.evidence{margin-top:16px}
.evidence h3,.ctx-h,.ctx-block h3{margin:18px 0 10px;font:12.5px var(--mono);letter-spacing:.02em;color:var(--faint)}
details.evidence>summary{margin-top:4px}
.ev-list{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin:0;padding:0;list-style:none}
.ev-list li{display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:var(--bg-2);border:1px solid var(--line-2);font-size:14px}
.ev-list li.cited{border-color:var(--amber);background:#1d1608}
.ev-text{color:var(--fg);text-decoration:none}.ev-text:hover{color:var(--amber)}
.ev-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12.5px;color:var(--faint)}
.ev-who{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}.ev-who .avatar{width:20px;height:20px;font-size:12px;box-shadow:none}
/* ---- transcript ---- */
.chat-wrap{padding:12px;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard)}
.chat{margin:0;padding:0;list-style:none}
.msg{display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;padding:8px 10px;scroll-margin-top:24px}
.msg.cont{padding-top:0}
.msg>.avatar{width:34px;height:34px;font-size:18px}
.msg.cont>.avatar{visibility:hidden;height:0}
.msg:target{background:#1d1608;outline:2px solid var(--amber);outline-offset:-2px}
.msg-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;margin:1px 0 6px}
.msg.cont .msg-head{display:none}
.msg-peer{color:var(--fg);font-weight:600;text-decoration:none}.msg-peer:hover{color:var(--amber)}
.msg-head time{font-size:12px;color:var(--faint)}
.msg-id{margin-left:auto;font:12px var(--code);color:var(--faint);text-decoration:none}.msg-id:hover{color:var(--amber)}
.bubble{display:inline-block;max-width:100%;padding:9px 13px;background:var(--panel-2);border:1px solid var(--line-2);box-shadow:3px 3px 0 #000;font-size:14.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.pager{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 0;font-size:13px;color:var(--faint)}.pager .button{margin:0}
.summary-text{margin:0;font-size:14px;line-height:1.6}
/* ---- context preview, reasoning levels ---- */
.context{padding:22px 24px;background:var(--bg-2);border:2px solid var(--line-2);box-shadow:var(--hard)}
.ctx-call{font-size:12.5px;overflow-wrap:anywhere}
.ctx-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));align-items:start}
.ctx-block{padding:2px 16px 14px;background:var(--panel);border:1px solid var(--line-2)}.ctx-block p{margin:0;font-size:14px}
.ctx-msgs{margin:0;padding:0;list-style:none;background:var(--panel);border:1px solid var(--line-2);font-size:13.5px}
.ctx-msgs li{display:grid;grid-template-columns:110px minmax(0,1fr) auto;gap:12px;padding:8px 14px;border-bottom:1px solid var(--line)}.ctx-msgs li:last-child{border-bottom:0}
.ctx-msgs .ident{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}.ctx-text{overflow-wrap:anywhere}
.level-list{margin:0;padding:0;list-style:none}
.level-list li{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:10px 0;border-bottom:1px solid var(--line)}.level-list li:last-child{border-bottom:0}
.level-name{font:600 14px var(--sans)}.level-price{text-align:right;font:13px var(--code);color:var(--amber)}.level-how{grid-column:1/-1;font-size:13px;color:var(--faint)}
/* ---- empty states and getting started ---- */
.empty{padding:44px 28px 36px;background:var(--bg-2);border:2px dashed var(--line-2);text-align:center}
.empty h2{display:block;margin:18px 0 8px;font-size:18px}.empty h2::before{display:none}
.empty>p{max-width:540px;margin:0 auto;color:var(--muted)}
.empty-mark{display:inline-grid;place-items:center;width:52px;height:52px;background:var(--well);border:2px solid var(--amber);color:var(--amber);box-shadow:var(--hard)}.empty-mark svg{width:26px;height:26px}
.empty-alt{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px 14px;margin-top:24px;font-size:13.5px;color:var(--muted)}
.steps{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;max-width:800px;margin:26px auto 0;padding:0;list-style:none;text-align:left}
.step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:14px;padding:16px 18px;background:var(--panel);border:2px solid var(--line-2)}
.step-n{display:grid;place-items:center;width:32px;height:32px;border:2px solid var(--amber);font:700 14px var(--pixel);color:var(--amber)}
.step-n svg{width:16px;height:14px}
.step.done{border-style:dashed;background:transparent}.step.done .step-n{background:var(--green);border-color:var(--green);color:var(--ink)}.step.done h3{color:var(--muted)}
.step h3{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:2px 0 6px}
.step p{margin:0;font-size:14px;color:var(--muted)}.step.done p{display:none}
.step .code-block{margin-top:14px}
.setup{margin:0 0 30px;padding:24px;background:var(--panel);border:2px solid var(--amber);box-shadow:var(--lift)}
.setup .steps{max-width:none;margin:18px 0 0}.setup .step{background:var(--bg-2)}.setup .step.done{background:transparent}
.setup-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 20px}.setup-head h2{margin:.4rem 0 0;font-size:18px}.setup-head h2::before{display:none}
.setup.complete{display:flex;align-items:center;gap:14px;padding:13px 18px;border-color:rgba(77,255,154,.6);box-shadow:var(--hard)}.setup.complete p{margin:0;font-size:14px;color:var(--muted)}.setup.complete strong{font-weight:600;color:var(--fg)}
/* ---- charts ---- */
.charts{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin:0 0 14px}
.chart{margin:0;padding:0 20px 6px;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard)}
.chart figcaption{display:block}
.chart-title{display:flex;align-items:center;gap:9px;margin:0 -20px 16px;padding:11px 16px;background:var(--panel-2);border-bottom:2px solid var(--line-2);font:600 14px/1.4 var(--sans);color:var(--fg)}
.chart-title::before{content:"";flex:none;width:6px;height:6px;background:var(--amber)}
.tone-sky .chart-title::before{background:var(--cyan)}.tone-mint .chart-title::before{background:var(--green)}
.chart-total{margin-right:12px;font:700 30px/1.2 var(--pix2);color:var(--amber)}
.tone-sky .chart-total{color:var(--cyan)}.tone-mint .chart-total{color:var(--green)}
.chart-note{font-size:12.5px;color:var(--faint)}
.chart-svg{display:block;margin-top:8px;overflow:visible}
.chart .grid{stroke:var(--line-2);stroke-width:1;stroke-dasharray:2 2}
.chart .axis{stroke:var(--ctl);stroke-width:2}
.chart .bar{fill:var(--amber)}.tone-sky .bar{fill:var(--cyan)}.tone-mint .bar{fill:var(--green)}
.chart .slit{fill:#000;opacity:.34}
.chart .hit{fill:transparent}.chart .day:hover .hit{fill:rgba(255,255,255,.05)}.chart .day:hover .bar{fill:var(--fg)}
.chart .tick{fill:var(--faint);font:11.5px var(--sans);paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:miter}
.chart .empty-note{fill:var(--faint);font:12.5px var(--sans)}
.chart-table{margin:16px 0 0}.chart-table .scroll{margin-top:12px}
/* ---- OAuth consent ---- */
.consent{max-width:620px}
.consent .lede{margin:0 0 18px}
.consent dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 18px;margin:0 0 18px}
.consent dt{padding-top:1px;font:500 13px var(--sans);color:var(--faint)}
.consent dd{margin:0;overflow-wrap:anywhere}
.consent ul{margin:0 0 12px;padding-left:20px}
.consent fieldset{max-width:none}
.consent .switch{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin:0 0 6px}.consent .switch label{width:100%}.consent .switch select{flex:1}.consent .switch button{margin:0}
.consent .indent{margin-left:30px}
.caution{margin:0 0 20px;padding:12px 16px;border:2px solid var(--amber);background:rgba(255,176,0,.06);box-shadow:var(--hard);font-size:14px}
.caution::before{content:"CAUTION";display:inline-block;margin-right:12px;padding:1px 8px;background:var(--amber);color:var(--ink);font:700 11px/1.6 var(--pixel);letter-spacing:.08em;vertical-align:1px}
/* ---- table cells that wrap, sub-lines, row actions ---- */
td.wrap{min-width:150px;white-space:normal;overflow-wrap:anywhere}
.cell-sub{display:block;margin-top:2px;font-size:12.5px;line-height:1.45;color:var(--faint);white-space:normal}
td.actions{width:1%;text-align:right}
td.actions .button{margin:0}
tr.grouped td{background:rgba(255,255,255,.012)}
.scroll:focus-visible{outline:3px solid var(--amber);outline-offset:2px}
a.button.danger,.button.danger{border-color:var(--red);background:transparent;color:var(--red);box-shadow:4px 4px 0 #000}
a.button.danger:hover,.button.danger:hover{border-color:var(--red);background:var(--red);color:var(--ink);box-shadow:6px 6px 0 #000}
a.button.secondary{border-color:var(--fg);background:transparent;color:var(--fg);box-shadow:4px 4px 0 #000}
a.button.secondary:hover{border-color:var(--amber);background:var(--panel-2);color:var(--amber)}
.button.small.danger,.button.small.secondary{box-shadow:3px 3px 0 #000}
/* ---- confirmation pages, errors, 404 ---- */
.confirm{max-width:640px;margin:4vh 0 0}
.confirm h1{margin-top:0;font-size:26px}
.confirm>p:not(.eyebrow){max-width:60ch}
.confirm .buttons{margin-top:22px;align-items:center}.confirm .buttons .button,.confirm .buttons button{margin:0}
.facts-dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 18px;margin:18px 0 6px;padding:14px 16px;background:var(--bg-2);border:1px solid var(--line-2)}
.facts-dl dt{font:500 13px var(--sans);color:var(--faint)}.facts-dl dd{margin:0;overflow-wrap:anywhere}
.narrow-ish{max-width:560px;margin:6vh auto 0}.narrow-ish h1{margin-top:0}
.lost{display:grid;grid-template-columns:minmax(0,1fr);gap:26px;max-width:860px;margin:2vh auto 0}
.lost-scene{position:relative;height:230px;overflow:hidden;background:var(--bg);border:2px solid var(--line-2);box-shadow:var(--hard)}
.night.framed{position:absolute;inset:0;z-index:0}
.night.framed .night-scene{height:100%}
.lost-text h1{margin:.2rem 0 .6rem}
.lost-text .buttons{margin-top:18px}.lost-text .buttons .button{margin:0}
.lost.bare{max-width:520px;margin-top:8vh;padding:30px;background:var(--panel);border:2px solid var(--amber);box-shadow:var(--lift)}
/* ---- onboarding: connect tabs, setup prompt, budget bar ---- */
.connect{margin-top:30px}
.connect-tabs{margin:0 0 4px}
.connect .code-block{margin-top:12px}
.connect .copy-text{margin:0}
pre.prompt{white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;font-size:12.5px}
.setup-prompt{margin-top:16px}.setup-prompt>summary{font-size:13.5px}.setup-prompt .hint{margin:10px 0}
.budget-bar{display:block;margin:4px 0 2px}.budget-bar .meter{display:block;overflow:visible}
.budget-bar .fill{stroke:var(--green)}.budget-bar.warn .fill{stroke:var(--amber)}.budget-bar.over .fill{stroke:var(--red)}
.mcp-url{margin:0 0 18px}.mcp-url .hint{margin-top:8px}
/* ---- forms: field rows, help under checkboxes ---- */
.field-row{display:flex;flex-wrap:wrap;gap:0 16px;max-width:500px}.field-row .field{flex:1 1 200px}
.check-help{display:block;margin-top:2px;font-size:12.5px;color:var(--faint)}
.indent{margin-left:32px}
p.hint+button,.hint+.buttons{margin-top:14px}
/* ---- one-time results (flash) ---- */
.flash{margin:0 0 22px;padding:14px 16px;border:2px solid var(--green);background:rgba(77,255,154,.05);box-shadow:var(--hard)}
.flash p{margin:0}.flash p+p,.flash p+blockquote,.flash blockquote+p{margin-top:8px}
.flash blockquote{margin:8px 0 0;padding:8px 12px;border-left:4px solid var(--line-2);background:var(--bg-2);color:var(--muted);overflow-wrap:anywhere}
.flash blockquote.gone{text-decoration:line-through;text-decoration-color:var(--red)}
.flash .eyebrow{color:var(--green)}
/* ---- editing memory ---- */
.fact-actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px 14px;margin-top:10px;padding-top:8px;border-top:1px dashed var(--line-2)}
.fact-actions details>summary{font-size:13px}
.fact-actions details[open]{flex-basis:100%}
.fact-actions form{margin-top:10px}
.fact-actions textarea{min-height:72px}
.fact-actions .buttons{gap:10px}.fact-actions .buttons button{margin:0}
.add-fact{margin:0 0 16px;padding:14px 16px;background:var(--bg-2);border:2px dashed var(--line-2)}
.add-fact>summary{color:var(--amber);font-weight:500}
.add-fact form{margin-top:6px}
.add-fact .ask-row{margin-bottom:6px}
.card-edit{margin-top:14px}.card-edit textarea{min-height:140px;font:13px/1.6 var(--code)}
.danger-zone .hint{margin-bottom:10px}
.danger-zone input{max-width:none}
/* ---- background work: failures and actions ---- */
.status.failed{border-color:rgba(255,95,86,.55);background:rgba(255,95,86,.05)}
.status.failed .dot{background:var(--red)}
.status-actions{display:flex;flex-wrap:wrap;gap:10px;margin-left:auto}.status-actions form{margin:0}.status-actions button{margin:0}
.failures{margin:10px 0 0}.failures summary{font-size:13px}
.failures ul{margin:10px 0 0;padding:0;list-style:none}
.failures li{padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px}.failures li:last-child{border-bottom:0}
.failures code{font-size:12px}
.work-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:12px 0 0;font-size:13px;color:var(--faint)}.work-actions form{margin:0}.work-actions button{margin:0}
/* ---- webhooks ---- */
.wh-list{display:grid;gap:12px;margin:0;padding:0;list-style:none}
.wh{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:14px 16px;background:var(--panel);border:2px solid var(--line-2);box-shadow:var(--hard)}
.wh-url{flex:1 1 260px;min-width:0;font:13.5px var(--code);overflow-wrap:anywhere}
.wh-meta{flex-basis:100%;font-size:12.5px;color:var(--faint)}
.wh .badge{white-space:normal}
.wh details{flex-basis:100%}.wh details form{margin-top:8px}.wh details button{margin:0}
.inline-form.wide input{flex:1;width:auto;min-width:220px;max-width:none}
/* ---- small screens and user preferences ---- */
@media (max-width:900px){
.shell{display:block;background:none}
.sidebar{position:static;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"top foot" "nav nav";align-items:center;gap:10px 12px;height:auto;padding:12px 16px 0;overflow:visible;border-right:0;border-bottom:2px solid var(--line)}
.side-top{grid-area:top;flex-direction:row;align-items:center;gap:14px;padding:0;min-width:0}
.acct-chip{padding:4px 8px;box-shadow:none;font-size:13px;min-width:0}
/* the nav scrolls sideways; a fade at the edge says there is more (app.js moves it as you scroll) */
.side-nav{grid-area:nav;flex-direction:row;gap:0;margin:0 -16px;padding:0 10px;overflow-x:auto;scrollbar-width:none;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 56px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 56px),transparent)}
.side-nav::after{content:"";flex:none;width:40px}
.side-nav.scrolled{-webkit-mask-image:linear-gradient(90deg,transparent,#000 40px,#000 calc(100% - 56px),transparent);mask-image:linear-gradient(90deg,transparent,#000 40px,#000 calc(100% - 56px),transparent)}
.side-nav.at-end{-webkit-mask-image:linear-gradient(90deg,transparent,#000 40px);mask-image:linear-gradient(90deg,transparent,#000 40px)}
.side-nav.fits{-webkit-mask-image:none;mask-image:none}
.side-nav::-webkit-scrollbar{display:none}
.nav-group,.side-nav [data-i]::before,.side-foot [data-i]::before{display:none}
.side-nav a{padding:12px 10px 13px;white-space:nowrap}
.side-nav a:hover{background:none}
.side-nav a[aria-current]{background:none;box-shadow:inset 0 -3px 0 var(--amber)}
.side-foot{grid-area:foot;flex-direction:row;align-items:center;gap:0;margin:0;padding:0;border-top:0}
.me{display:none}
.side-foot>.side-link{padding:6px 8px}
.side-foot form.inline{display:inline}
button.link.side-link{width:auto;padding:6px 8px}
main{padding:28px 22px 56px}
}
/* tables of records become cards: one per row, each value with its column's name */
@media (max-width:760px){
table.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:100%}
table.stack tr{padding:10px 14px 12px;border-bottom:2px solid var(--line-2)}
table.stack tr:last-child{border-bottom:0}
table.stack td{display:grid;grid-template-columns:minmax(92px,32%) minmax(0,1fr);gap:10px;align-items:baseline;padding:5px 0;border:0;text-align:left;white-space:normal;overflow-wrap:anywhere}
table.stack td::before{content:attr(data-label);font:500 12.5px var(--sans);color:var(--faint)}
table.stack td.num{text-align:left}
table.stack td.actions{display:flex;justify-content:flex-start;width:100%;padding-top:10px}
table.stack td.actions::before{content:none}
table.stack td:not([data-label]):not(.actions){display:block}
table.stack td:not([data-label]):not(.actions)::before{content:none}
tbody tr:hover td{background:none}
.lost-scene{height:170px}
}
@media (max-width:560px){main{padding:22px 16px 56px}.top{padding:0 16px}.acct-chip{display:none}h1{font-size:25px}h1.ident{font-size:24px}.card{--pad:16px}.narrow{--pad:22px}.answer,.setup,.context{padding:16px}.who-head>.avatar{width:44px;height:44px;font-size:18px}th,td{padding:10px 12px}.ctx-msgs li{grid-template-columns:80px minmax(0,1fr)}.ctx-msgs li>.faint{display:none}.status>.status-sub:last-child{margin-left:0}.msg-id{display:none}.empty{padding:28px 14px 22px}.step{padding:14px;grid-template-columns:minmax(0,1fr)}.step-n{display:none}.narrow h1{font-size:22px}.charts{grid-template-columns:minmax(0,1fr)}.tabs a,.segmented a{padding:9px 12px}.segmented.views{flex-direction:column;width:100%}.segmented.views a{border-right:0;border-bottom:2px solid var(--line-2)}.segmented.views a:last-child{border-bottom:0}.page-head{margin-bottom:20px}.ws-grid{grid-template-columns:minmax(0,1fr)}.stat .value{font-size:26px}.indent{margin-left:0}.confirm h1{font-size:22px}.lost.bare{padding:20px}.status-actions{margin-left:0}.connect .panel-head{align-items:flex-start}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none !important;transition:none !important}button:hover,.button:hover,button:active,.button:active,.ws-card:hover{transform:none !important}}
@media (prefers-contrast:more),(forced-colors:active){body::after{display:none}}
@media (forced-colors:active){[data-i]::before{display:none}}
${ICON_CSS}
`;

/**
 * Optional progressive enhancement (served at <base>/static/app.js; CSP allows
 * only same-origin scripts): copy buttons on snippets, pickers that submit on
 * change, a busy state on the Ask button, and the consent screen's guard on
 * "Allow". Every page works without it (the consent screen then relies on the
 * server's minimum time between showing the page and accepting "Allow").
 */
export const SCRIPT = `"use strict";
(function () {
  document.querySelectorAll("pre[data-copy]").forEach(function (pre) {
    var head = pre.parentNode.querySelector(".code-head");
    var wrap = head;
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "copyable";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
    }
    var b = document.createElement("button");
    b.type = "button";
    b.className = "copy-btn";
    b.textContent = "Copy";
    b.addEventListener("click", function () {
      var done = function (label) {
        b.textContent = label;
        setTimeout(function () { b.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(pre.textContent || "").then(function () { done("Copied"); }, function () { done("Select & copy"); });
      else done("Select & copy");
    });
    wrap.appendChild(b);
  });
  document.querySelectorAll("select[data-autosubmit]").forEach(function (sel) {
    sel.addEventListener("change", function () {
      if (sel.name === "ws") {
        var peer = sel.form.querySelector("select[name=peer]");
        if (peer) peer.disabled = true;
      }
      sel.form.submit();
    });
  });
  document.querySelectorAll("[data-nojs]").forEach(function (el) { el.hidden = true; });
  // Buttons that copy another element's text (the setup prompt) need this script: shown by it.
  document.querySelectorAll("button[data-copy-text]").forEach(function (b) {
    var src = document.getElementById(b.getAttribute("data-copy-text"));
    if (!src || !navigator.clipboard) return;
    var label = b.textContent;
    b.hidden = false;
    b.addEventListener("click", function () {
      navigator.clipboard.writeText(src.textContent || "").then(function () {
        b.textContent = b.getAttribute("data-done") || "Copied";
        setTimeout(function () { b.textContent = label; }, 2400);
      }, function () { b.textContent = "Select and copy it below"; });
    });
  });
  // Tabs that are links (?connect=...) switch in place, keeping the URL in step.
  document.querySelectorAll("[data-tabs]").forEach(function (box) {
    box.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[data-tab]") : null;
      if (!a || !box.contains(a)) return;
      e.preventDefault();
      var id = a.getAttribute("data-tab");
      box.querySelectorAll("a[data-tab]").forEach(function (t) {
        if (t === a) t.setAttribute("aria-current", "true");
        else t.removeAttribute("aria-current");
      });
      box.querySelectorAll("[data-panel]").forEach(function (p) {
        p.hidden = p.getAttribute("data-panel") !== id;
      });
      if (window.history && history.replaceState) history.replaceState(null, "", a.getAttribute("href"));
    });
  });
  // On phones the nav scrolls sideways: bring the current page into view and fade only the
  // edges that hide links.
  var nav = document.getElementById("side-nav");
  if (nav) {
    var fade = function () {
      var max = nav.scrollWidth - nav.clientWidth;
      nav.classList.toggle("fits", max <= 1);
      nav.classList.toggle("scrolled", nav.scrollLeft > 4);
      nav.classList.toggle("at-end", max > 1 && nav.scrollLeft >= max - 4);
    };
    var cur = nav.querySelector("[aria-current]");
    if (cur && nav.scrollWidth > nav.clientWidth) {
      var r = cur.getBoundingClientRect();
      var n = nav.getBoundingClientRect();
      nav.scrollLeft += r.left - n.left - (nav.clientWidth - r.width) / 2;
    }
    nav.addEventListener("scroll", fade, { passive: true });
    window.addEventListener("resize", fade);
    fade();
  }
  document.querySelectorAll("form").forEach(function (form) {
    form.addEventListener("submit", function () {
      var b = form.querySelector("button[data-busy]");
      if (!b) return;
      b.dataset.label = b.innerHTML;
      b.textContent = b.dataset.busy;
      b.disabled = true;
    });
  });
  window.addEventListener("pageshow", function () {
    document.querySelectorAll("button[data-busy][disabled]").forEach(function (b) {
      b.disabled = false;
      if (b.dataset.label) b.innerHTML = b.dataset.label;
    });
  });
  // Consent buttons (OAuth "Allow") against double-click-jacking: disabled until this page has
  // been visible and focused for 500 ms (and a second has passed since it was requested) and
  // the user has moved the pointer or pressed a key here since. Losing focus starts over.
  var guarded = document.querySelectorAll("button[data-consent]");
  if (guarded.length) {
    var timer = null;
    var settled = false;
    var used = false;
    var update = function () {
      guarded.forEach(function (b) { b.disabled = !(settled && used); });
    };
    var arm = function () {
      clearTimeout(timer);
      settled = false;
      used = false;
      update();
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      timer = setTimeout(function () {
        settled = true;
        update();
      }, Math.max(500, 1200 - performance.now()));
    };
    var interact = function () {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      used = true;
      update();
    };
    ["pointermove", "mousemove", "keydown"].forEach(function (type) {
      document.addEventListener(type, interact, true);
    });
    window.addEventListener("focus", arm);
    window.addEventListener("blur", arm);
    window.addEventListener("pageshow", arm);
    document.addEventListener("visibilitychange", arm);
    arm();
  }
})();
`;
