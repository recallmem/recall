import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { formatUsd, type LedgerEntryOut } from "../../billing/ledger.js";
import type { TopupStatus } from "../../billing/withdrawal.js";
import type { AccountOut } from "../../core/accounts.js";
import type { ApiKeyOut } from "../../core/apikeys.js";
import type { AccountSummary, ConsoleOverview, MemberRow, TaskUsage } from "../../core/operator.js";
import { dashPath } from "./paths.js";
import {
  ACTIONS,
  csrfField,
  notice as dashNotice,
  LEDGER_LABELS,
  ledgerLabel,
  table,
  taskLabel,
} from "./views.js";

/**
 * Operator console templates (see console.ts). Server-rendered with the
 * dashboard's own stylesheet and components (stats, tables, cards, badges);
 * no inline styles or scripts.
 */

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

export const notice = dashNotice;

const n = (v: number) => v.toLocaleString("en-US");
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");
const day = (iso: string) => iso.slice(0, 10);

/** Micro-USD as dollars, in the dashboard's one money format (`formatUsd`). */
const money = (micros: number): string => formatUsd(micros);

/** Gross margin cell: billed less provider cost, with the share of billed. */
function margin(billed: number, cost: number): H {
  const m = billed - cost;
  const pct = billed > 0 ? ` (${Math.round((m / billed) * 100)}%)` : "";
  return html`<td class="num ${m < 0 ? "neg" : "pos"}">${money(m)}${pct}</td>`;
}

function age(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

const accountHref = (id: string) => dashPath(`/admin/accounts/${encodeURIComponent(id)}`);

function status(a: { suspendedAt: string | null; billed: boolean }): H {
  if (a.suspendedAt) return html`<span class="badge contradiction">suspended</span>`;
  return a.billed
    ? html`<span class="badge current">billed</span>`
    : html`<span class="badge">unbilled (operator)</span>`;
}

function tabs(active: "overview" | "accounts"): H {
  return html`<nav class="tabs" aria-label="Console">
  <a href="${dashPath("/admin")}"${active === "overview" ? html` aria-current="page"` : ""}>Overview</a>
  <a href="${dashPath("/admin/accounts")}"${active === "accounts" ? html` aria-current="page"` : ""}>Accounts</a>
</nav>`;
}

const head = (title: string, lede: string) =>
  html`<header class="page-head"><div><p class="eyebrow">Operator console</p><h1>${title}</h1>
<p class="lede">${lede}</p></div></header>`;

// ---------------------------------------------------------------------------
// Overview

export function overviewPage(d: ConsoleOverview & { billing: boolean }): H {
  const w = d.welcome;
  const capped = w.capMicros > 0 && w.todayMicros >= w.capMicros;
  return html`${head("Overview", "Sign-ups, money, model cost and the job queue. Days are UTC.")}
${tabs("overview")}
<div class="stats compact">
  <div class="stat"><span class="label">Accounts</span><span class="value">${n(d.accounts.total)}</span><span class="sub">${n(d.accounts.suspended)} suspended</span></div>
  <div class="stat"><span class="label">New, 24 h</span><span class="value">${n(d.accounts.last24h)}</span></div>
  <div class="stat"><span class="label">New, 7 d</span><span class="value">${n(d.accounts.last7d)}</span></div>
  <div class="stat"><span class="label">New, 30 d</span><span class="value">${n(d.accounts.last30d)}</span></div>
  <div class="stat"><span class="label">Welcome credit today</span><span class="value">${money(w.todayMicros)}</span><span class="sub">${
    w.capMicros > 0 ? `of ${money(w.capMicros)} daily cap` : "no daily cap"
  } · ${n(w.todayGrants)} grants${capped ? " · cap reached" : ""}</span></div>
</div>
<h2>Money</h2>
${d.billing ? "" : html`<p class="muted">Billing is not enabled on this server: there are no top-ups or charges.</p>`}
${table(
  [
    "Window",
    "Top-ups",
    "Billed usage",
    "Provider cost (billed accounts)",
    "Gross margin",
    "Provider cost (all)",
    "Of which estimated",
  ],
  d.windows.map(
    (x) =>
      html`<tr><td>Last ${x.days} days</td><td class="num">${money(x.topupsMicros)}</td><td class="num">${money(x.billedMicros)}</td><td class="num">${money(x.costBilledMicros)}</td>${margin(x.billedMicros, x.costBilledMicros)}<td class="num">${money(x.costAllMicros)}</td><td class="num">${money(x.costEstimatedMicros)}</td></tr>`,
  ),
)}
<p class="muted small">Top-ups are credit bought (top-ups and auto top-ups, less refunds; tax excluded). Billed usage is what billed accounts were charged for ingest and chat, whether paid from bought, welcome or granted credit. Gross margin is billed usage less the provider cost of those accounts' model calls; "all" adds unbilled operator accounts. Provider cost is what OpenRouter reported per call (on BYOK calls its fee plus the upstream provider's charge); "estimated" is the part priced at list price instead: direct providers, embeddings, and BYOK calls that reported no upstream charge.</p>
<h2>Last 14 days</h2>
${table(
  ["Day (UTC)", "Sign-ups", "Top-ups", "Billed", "Provider cost (all)"],
  d.days.map(
    (r) =>
      html`<tr><td>${r.day}</td><td class="num">${n(r.signups)}</td><td class="num">${money(r.topupsMicros)}</td><td class="num">${money(r.billedMicros)}</td><td class="num">${money(r.costMicros)}</td></tr>`,
  ),
)}
<h2>Job queue</h2>
${table(
  ["Job type", "Pending", "Due now", "Running", "Failed (30 d)", "Oldest pending"],
  d.queue.map(
    (q) =>
      html`<tr><td><code>${q.kind}</code></td><td class="num">${n(q.pending)}</td><td class="num">${n(q.due)}</td><td class="num">${n(q.running)}</td><td class="num${q.failed ? " neg" : ""}">${n(q.failed)}</td><td class="num">${age(q.oldestPendingS)}</td></tr>`,
  ),
  "The queue is empty.",
)}
<p class="muted small">Pending jobs that are not yet due are scheduled for later (debounced reasoning, retries, or accounts out of credit).</p>`;
}

// ---------------------------------------------------------------------------
// Accounts

export function accountsPage(d: {
  q: string;
  paged: boolean;
  items: AccountSummary[];
  next: string | null;
}): H {
  const listHref = (after: string | null) => {
    const p = new URLSearchParams();
    if (d.q) p.set("q", d.q);
    if (after) p.set("after", after);
    const qs = p.toString();
    return dashPath(`/admin/accounts${qs ? `?${qs}` : ""}`);
  };
  return html`${head("Accounts", "Newest first, 50 a page. Money columns cover the last 30 days.")}
${tabs("accounts")}
<div class="filters">
  <form method="get" action="${dashPath("/admin/accounts")}" class="filter-form" role="search">
    <label class="sr" for="q">Search accounts</label>
    <input id="q" type="search" name="q" value="${d.q}" placeholder="Account id, name or member email" maxlength="200" />
    <button class="secondary">Search</button>
  </form>
  ${d.q ? html`<a class="button ghost small" href="${dashPath("/admin/accounts")}">Clear</a>` : ""}
</div>
${table(
  [
    "Name",
    "Owner",
    "Created",
    "Status",
    "Balance",
    "Billed 30 d",
    "Provider cost 30 d",
    "Margin",
    "Last activity",
  ],
  d.items.map(
    (a) =>
      html`<tr><td><a class="table-link" href="${accountHref(a.id)}"><bdi>${a.name}</bdi></a><br /><code class="small">${a.id}</code></td>
<td>${a.ownerEmail ?? "—"}</td><td>${day(a.createdAt)}</td><td>${status(a)}</td>
<td class="num">${a.balanceMicros == null ? "—" : money(a.balanceMicros)}</td>
<td class="num">${money(a.billed30Micros)}</td><td class="num">${money(a.cost30Micros)}</td>${margin(a.billed30Micros, a.cost30Micros)}
<td>${when(a.lastActivity)}</td></tr>`,
  ),
  d.q ? "No account matches this search." : "No accounts yet.",
)}
${
  d.paged || d.next
    ? html`<nav class="pager" aria-label="Pages">${
        d.paged
          ? html`<a class="button ghost small" href="${listHref(null)}">← Newest</a>`
          : html`<span class="button ghost small disabled" aria-disabled="true">← Newest</span>`
      }${
        d.next
          ? html`<a class="button ghost small" rel="next" href="${listHref(d.next)}">Older →</a>`
          : html`<span class="button ghost small disabled" aria-disabled="true">Older →</span>`
      }</nav>`
    : ""
}`;
}

// ---------------------------------------------------------------------------
// One account

export interface AccountPageData {
  csrf: string;
  account: AccountOut;
  summary: AccountSummary;
  balanceMicros: number | null;
  members: MemberRow[];
  keys: ApiKeyOut[];
  usage: TaskUsage[];
  charges: { kind: string; count: number; micros: number }[];
  ledger: LedgerEntryOut[];
  /** Each top-up with what is left of it, for consumer withdrawals. */
  topups: TopupStatus[];
  /** Billing is on: credit can be granted. */
  canGrant: boolean;
  /** Idempotency key of the grant form (a re-posted form grants nothing more). */
  grantNonce: string;
}

const scopeOf = (k: ApiKeyOut) =>
  k.admin
    ? "account"
    : [
        k.scope.workspace_id,
        k.scope.peer_id && `peer ${k.scope.peer_id}`,
        k.scope.session_id && `session ${k.scope.session_id}`,
      ]
        .filter(Boolean)
        .join(" · ");

/** A ledger entry's note: the operator's note and who granted it, or what it paid for. */
function entryNote(e: LedgerEntryOut): string {
  const d = e.detail as Record<string, unknown>;
  const parts = [d.note, d.by && `by ${d.by}`, d.charge && `charge ${d.charge}`].filter(
    (x): x is string => typeof x === "string" && x !== "",
  );
  return parts.join(" · ");
}

export function accountPage(d: AccountPageData): H {
  const a = d.account;
  const s = d.summary;
  const action = (path: string) => dashPath(`/admin/accounts/${encodeURIComponent(a.id)}${path}`);
  const usageCost = d.usage.reduce((t, u) => t + u.costMicros, 0);
  const charged = d.charges.reduce((t, c) => t + c.micros, 0);
  return html`<nav class="crumbs" aria-label="Breadcrumb"><a href="${dashPath("/admin")}">Console</a><span class="sep">/</span><a href="${dashPath("/admin/accounts")}">Accounts</a><span class="sep">/</span><span aria-current="page"><bdi>${a.name}</bdi></span></nav>
<header class="page-head"><div><p class="eyebrow">Account</p><h1><bdi>${a.name}</bdi></h1>
<p class="meta"><span><code>${a.id}</code></span><span>Created ${when(a.created_at)}</span><span>${status(s)}</span></p></div>
${
  s.stripeCustomerId
    ? html`<div class="head-actions"><a class="button ghost" href="https://dashboard.stripe.com/customers/${encodeURIComponent(s.stripeCustomerId)}" rel="noopener noreferrer" target="_blank">Stripe customer</a></div>`
    : ""
}</header>
${
  a.suspended_at
    ? html`<p class="error" role="alert">Suspended since ${when(a.suspended_at)} UTC: ${a.suspended_reason ?? "no reason given"}</p>`
    : ""
}
<div class="stats compact">
  <div class="stat"><span class="label">Balance</span><span class="value">${d.balanceMicros == null ? "—" : money(d.balanceMicros)}</span>${s.billed ? "" : html`<span class="sub">not billed</span>`}</div>
  <div class="stat"><span class="label">Billed, 30 d</span><span class="value">${money(s.billed30Micros)}</span></div>
  <div class="stat"><span class="label">Provider cost, 30 d</span><span class="value">${money(s.cost30Micros)}</span></div>
  <div class="stat"><span class="label">Margin, 30 d</span><span class="value">${money(s.billed30Micros - s.cost30Micros)}</span></div>
  <div class="stat"><span class="label">Last activity</span><span class="value">${s.lastActivity ? day(s.lastActivity) : "never"}</span>${s.lastActivity ? html`<span class="sub">${when(s.lastActivity)} UTC</span>` : ""}</div>
</div>
<h2>Members</h2>
${table(
  ["Email", "Role", "Joined", "Last sign-in"],
  d.members.map(
    (m) =>
      html`<tr><td>${m.email}</td><td><span class="chip">${m.role}</span></td><td>${day(m.joinedAt)}</td><td>${when(m.lastLoginAt)}</td></tr>`,
  ),
  "No members (an operator-created account nobody has signed in to).",
)}
<h2>API keys</h2>
${table(
  ["Name", "Key", "Scope", "Created", "Last used", ACTIONS],
  d.keys.map(
    (k) => html`<tr${k.revoked_at ? html` class="revoked"` : ""}>
<td>${k.name || "—"}</td><td><code>${k.prefix}…</code>${k.mode === "test" ? html` <span class="chip">test</span>` : ""}</td>
<td>${scopeOf(k)}</td><td>${when(k.created_at)}</td><td>${when(k.last_used_at)}</td>
<td>${
      k.revoked_at
        ? html`revoked ${when(k.revoked_at)}`
        : html`<form method="post" action="${action(`/keys/${encodeURIComponent(k.id)}/revoke`)}" class="inline-form">${csrfField(d.csrf)}<label class="check"><input type="checkbox" name="confirm" value="1" required /> confirm</label><button class="danger small">Revoke</button></form>`
    }</td></tr>`,
  ),
  "No API keys.",
)}
<h2>Usage, last 30 days</h2>
<h3>Model calls by task (provider cost)</h3>
${table(
  ["Task", "Calls", "Input tokens", "Output tokens", "Provider cost"],
  [
    ...d.usage.map(
      (u) =>
        html`<tr><td><code>${u.task}</code></td><td class="num">${n(u.calls)}</td><td class="num">${n(u.inputTokens)}</td><td class="num">${n(u.outputTokens)}</td><td class="num">${money(u.costMicros)}</td></tr>`,
    ),
    ...(d.usage.length
      ? [
          html`<tr><td><strong>Total</strong></td><td class="num">${n(d.usage.reduce((t, u) => t + u.calls, 0))}</td><td></td><td></td><td class="num"><strong>${money(usageCost)}</strong></td></tr>`,
        ]
      : []),
  ],
  "No model calls in the last 30 days.",
)}
<h3>Billed by kind</h3>
${table(
  ["Kind", "Count", "Billed"],
  [
    ...d.charges.map(
      (c) =>
        html`<tr><td>${taskLabel(c.kind)}</td><td class="num">${n(c.count)}</td><td class="num">${money(c.micros)}</td></tr>`,
    ),
    ...(d.charges.length
      ? [
          html`<tr><td><strong>Total</strong></td><td class="num">${n(d.charges.reduce((t, c) => t + c.count, 0))}</td><td class="num"><strong>${money(charged)}</strong></td></tr>`,
        ]
      : []),
  ],
  s.billed ? "Nothing billed in the last 30 days." : "Not billed: operator accounts are free.",
)}
<h2 id="withdrawals">Top-ups and withdrawals</h2>
${
  d.topups.length
    ? html`<p class="muted small">A consumer may withdraw from a top-up within 14 days. Usage counts first against free credit, then against top-ups in the order they were bought (terms 9). Refund the share shown of that top-up's charge in Stripe, VAT included; the credit follows on its own.</p>
${table(
  [
    "Bought",
    "Kind",
    "Credit",
    "Refunded",
    "Unused now",
    "Refund share",
    "Withdrawal until",
    "Payment",
  ],
  d.topups.map(
    (t) =>
      html`<tr><td>${when(t.at)}</td><td>${LEDGER_LABELS[t.kind] ?? t.kind}</td><td class="num">${money(t.creditMicros)}</td><td class="num">${money(t.refundedMicros)}</td><td class="num">${money(t.unusedMicros)}</td><td class="num">${(t.refundShare * 100).toFixed(1)}%</td><td>${t.withdrawUntil}</td><td>${
        t.paymentIntent
          ? html`<a href="https://dashboard.stripe.com/payments/${encodeURIComponent(t.paymentIntent)}" rel="noopener noreferrer" target="_blank"><code>${t.paymentIntent}</code></a>`
          : "—"
      }</td></tr>`,
  ),
)}`
    : html`<p class="muted">No top-ups.</p>`
}
<h2>Credit ledger (latest 50)</h2>
${table(
  ["Date", "Entry", "Amount", "Balance", "Note"],
  d.ledger.map(
    (e) =>
      html`<tr><td>${when(e.created_at)}</td><td>${ledgerLabel(e)}</td><td class="num ${e.amount_micros < 0 ? "neg" : "pos"}">${money(e.amount_micros)}</td><td class="num">${money(e.balance_after_micros)}</td><td>${entryNote(e)}</td></tr>`,
  ),
  "No ledger entries.",
)}
<section class="card">
<h2>Grant credit</h2>
${
  d.canGrant
    ? html`<p class="muted">Adds to the balance (negative corrects it) and makes the account billed. The entry records your note and email; posting this form again grants nothing more.</p>
<form method="post" action="${action("/credits")}">
  ${csrfField(d.csrf)}
  <input type="hidden" name="nonce" value="${d.grantNonce}" />
  <label for="amount_usd">Amount (USD)</label>
  <input id="amount_usd" name="amount_usd" type="number" step="0.01" min="-1000000" max="1000000" required />
  <label for="note">Note</label>
  <input id="note" name="note" maxlength="500" placeholder="why (shown in the ledger)" />
  <label class="check"><input type="checkbox" name="confirm" value="1" required /> Grant this credit to <bdi>${a.name}</bdi></label>
  <button>Grant credit</button>
</form>`
    : html`<p class="muted">Billing is not enabled on this server.</p>`
}
</section>
${
  a.suspended_at
    ? html`<section class="card">
<h2>Lift the suspension</h2>
<p>The account's API keys, connected apps and dashboard sessions work again at once.</p>
<form method="post" action="${action("/unsuspend")}">
  ${csrfField(d.csrf)}
  <label class="check"><input type="checkbox" name="confirm" value="1" required /> Unsuspend <bdi>${a.name}</bdi></label>
  <button>Unsuspend</button>
</form>
</section>`
    : html`<section class="card danger-zone">
<h2>Suspend account</h2>
<p>Refuses its API keys, connected apps (OAuth) and dashboard sessions with 403 at once. Jobs already queued still finish; nothing is deleted.</p>
<form method="post" action="${action("/suspend")}">
  ${csrfField(d.csrf)}
  <label for="reason">Reason (kept for operators only)</label>
  <input id="reason" name="reason" required maxlength="500" placeholder="e.g. credit farming with throwaway addresses" />
  <label for="confirm-id">Type the account id <code>${a.id}</code> to confirm</label>
  <input id="confirm-id" name="confirm" required autocomplete="off" />
  <button class="danger">Suspend account</button>
</form>
</section>`
}`;
}
