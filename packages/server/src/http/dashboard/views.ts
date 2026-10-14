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

/** Sidebar sections: [href, label, icon]; the icons are CSS masks keyed by data-i (app-css.ts). */
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
  github_connected: 'GitHub connected. You can now sign in with "Continue with GitHub".',
  github_disconnected: "GitHub disconnected. Sign in with an email link from now on.",
  github_taken:
    "That GitHub account is already connected to another Recall sign-in. Disconnect it there first.",
  github_cancelled: "Connecting GitHub was cancelled; nothing changed.",
  github_failed: "Connecting GitHub did not work; nothing changed. Try again.",
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
    /** Where "Continue with GitHub" starts; absent when GitHub sign-in is off. */
    github?: string | null;
  },
): H {
  return html`<section class="card narrow">
  <h1>${opts.signup ? "Sign in or create an account" : "Sign in"}</h1>
  ${
    opts.next
      ? html`<p>Sign in to connect an app to your Recall memory. ${opts.github ? "Afterwards you come back here to approve it." : "The link in the email brings you back to approve it."}</p>`
      : ""
  }
  ${
    opts.github
      ? html`<a class="button wide" href="${opts.github}">Continue with GitHub</a>
  <p class="muted small center or">or get a sign-in link by email, no password needed</p>`
      : html`<p class="muted">We email you a sign-in link. No password needed.</p>`
  }
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

export function verifyPage(
  csrf: string,
  token: string,
  legal?: LegalLinks | null,
  who?: { email: string; current: string | null },
): H {
  return html`<section class="card narrow">
  <h1>Continue to Recall</h1>
  ${
    who
      ? html`<p>This link signs you in as <b>${who.email}</b>.${
          who.current && who.current !== who.email
            ? html` You are signed in as <b>${who.current}</b> now: continuing signs you out of that account.`
            : ""
        } If you did not ask for this link, close this page.</p>`
      : ""
  }
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

/**
 * Turning off onboarding emails from the link in them: "ask" shows the button (a GET changes
 * nothing, so link scanners cannot unsubscribe anyone), "done" confirms, "invalid" is a bad link.
 */
export function unsubscribePage(state: "ask" | "done" | "invalid", token = ""): H {
  const others =
    "Sign-in links, receipts, billing notices and the spend alerts you chose in Settings still arrive.";
  if (state === "invalid")
    return html`<section class="card narrow">
  <h1>This link does not work</h1>
  <p>Copy the whole link from the email, or write to <a href="mailto:support@recallmem.dev">support@recallmem.dev</a> and we will turn the emails off for you.</p>
</section>`;
  if (state === "done")
    return html`<section class="card narrow">
  <h1>You are unsubscribed</h1>
  <p>We will not send this account any more getting-started emails.</p>
  <p class="muted">${others}</p>
</section>`;
  return html`<section class="card narrow">
  <h1>Stop getting-started emails?</h1>
  <p>After sign-up we send at most two emails to help you start with Recall: a welcome, and one reminder if the account is still unused after two days.</p>
  <form method="post" action="${dashPath("/unsubscribe")}">
    <input type="hidden" name="t" value="${token}" />
    <button>Unsubscribe</button>
  </form>
  <p class="muted">${others}</p>
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
  store: "Storage",
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

/** What a charge kind is billed by: message tokens for learning, tokens stored, questions for chat. */
export const unitsText = (kind: string, units: number) =>
  kind === "ingest"
    ? `${n(units)} message ${units === 1 ? "token" : "tokens"}`
    : kind === "store"
      ? `${n(units)} ${units === 1 ? "token" : "tokens"} stored`
      : `${n(units)} ${units === 1 ? "question" : "questions"}`;

const KIND_ORDER = ["ingest", "store", ...CHAT_LEVELS.map((l) => `chat_${l}`)];
/** Learning first, then storage, then chat from minimal to max. */
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
  /** Welcome credit held back by the day's cap, granted automatically on a later day. */
  pendingCreditMicros: number | null;
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

/** The welcome credit that is still on its way (the day's free credit for new accounts ran out). */
export function pendingCreditNote(micros: number, blocked: boolean): H {
  return html`<p class="notice" role="status">Your ${formatUsd(micros)} of free credit is on its way. Today's free credit for new accounts ran out, so yours is added automatically, usually within a day.${
    blocked
      ? html` Until then chat answers 402 and background learning waits (nothing is dropped). In a hurry? <a href="${dashPath("/billing")}">Add credits</a>.`
      : ""
  }</p>`;
}

export function overviewPage(d: OverviewData): H {
  const totalCharges = d.charges.reduce((s, c) => s + c.micros, 0);
  const setUp = d.checklist.key && d.checklist.messages && d.checklist.asked;
  const left =
    d.billing && d.balanceMicros != null ? runway(d.balanceMicros, d.burnPerDayMicros) : null;
  return html`<header class="page-head"><div><h1>Overview</h1></div>
<div class="head-actions"><a class="button ghost" href="${dashPath("/memory")}">Explore memory</a><a class="button" href="${dashPath("/playground")}">Open Playground</a></div></header>
${
  d.pendingCreditMicros
    ? pendingCreditNote(d.pendingCreditMicros, d.blocked === "credit")
    : d.blocked === "credit"
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
        html`<tr><td>${taskLabel(c.kind)}</td><td class="num" data-label="Billed units">${unitsText(c.kind, c.kind.startsWith("chat_") ? c.count : c.tokens)}</td><td class="num" data-label="Charged">${formatUsd(c.micros)}</td></tr>`,
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
      ? html`Learning is charged per message token (each message counts as at least ${n(d.minTokens)} tokens), storage per token kept without learning (messages no reasoning call reads, facts you add yourself), and chat per question, by reasoning level; a charge given back when no answer came is not counted. Context, search, summaries and the night shift are included. Prices are on <a href="${dashPath("/billing")}">Billing</a>.`
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
  /** Welcome credit held back by the day's cap, granted automatically on a later day. */
  pendingCreditMicros: number | null;
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
    storePerMTokMicros: number;
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
  return e.amount_micros > 0 &&
    (e.kind === "ingest" || e.kind === "store" || e.kind.startsWith("chat_"))
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
${d.pendingCreditMicros ? pendingCreditNote(d.pendingCreditMicros, false) : ""}
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
    html`<tr><td class="wrap">Storing without learning<span class="cell-sub">messages no reasoning call reads, and facts you add yourself${d.prices.ingestMinTokens ? `; each counts as at least ${d.prices.ingestMinTokens} tokens` : ""}</span></td><td class="num">${formatUsd(d.prices.storePerMTokMicros, { exact: true })} per 1M tokens</td></tr>`,
    ...Object.entries(d.prices.chatMicros).map(
      ([level, m]) =>
        html`<tr><td>Chat · ${level}</td><td class="num">${formatUsd(m, { exact: true })} per query</td></tr>`,
    ),
    html`<tr><td>Context, search, summaries, night shift</td><td class="num">included</td></tr>`,
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
  /** The signed-in person's address. */
  email: string;
  /** "Continue with GitHub" is on (and this is not an operator): the GitHub account tied, if any. */
  github: { connected: { login: string } | null } | null;
}

function signInCard(d: SettingsData): H {
  const g = d.github;
  return html`<section class="card" id="signin">
<h2>Sign-in</h2>
<p>You sign in as <b>${d.email}</b>, with a link emailed to that address${g?.connected ? " or with GitHub" : ""}.</p>
${
  g
    ? g.connected
      ? html`<p>GitHub: connected${g.connected.login ? html` as <b>@${g.connected.login}</b>` : ""}. "Continue with GitHub" signs you in as this person.</p>
<form method="post" action="${dashPath("/settings/github/disconnect")}">${csrfField(d.csrf)}<button class="secondary">Disconnect GitHub</button></form>`
      : html`<p class="muted">Connect your GitHub account to sign in with "Continue with GitHub" as well.</p>
<form method="post" action="${dashPath("/settings/github")}">${csrfField(d.csrf)}<button>Connect GitHub</button></form>`
    : ""
}
</section>`;
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
${signInCard(d)}
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
