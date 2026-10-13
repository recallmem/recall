import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { dashPath } from "./paths.js";
import { csrfField } from "./views.js";

/**
 * The OAuth consent screen and its error page, in the dashboard's style
 * (rendered inside views.page). Everything interpolated is escaped by hono/html.
 */

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface ConsentData {
  csrf: string;
  /** Rendering time bound to this session and request (routes/oauth.ts consentToken). */
  consent: string;
  email: string;
  client: { id: string; name: string; kind: "registered" | "metadata_document" };
  redirectHost: string;
  /** The app receives the code on this computer (localhost): any local program could pose as it. */
  loopback: boolean;
  /** The authorization request's parameters, carried through the form unchanged. */
  params: Record<string, string>;
  accounts: { id: string; name: string; role: string }[];
  account: { id: string; name: string };
  /** Existing workspaces of the chosen account. */
  workspaces: string[];
  defaultWorkspace: string;
}

const hidden = (params: Record<string, string>) =>
  Object.entries(params).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`);

const SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Armenian",
  "Georgian",
  "Cherokee",
  "Hebrew",
  "Arabic",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
].map((name) => ({ name, re: new RegExp(`\\p{Script=${name}}`, "u") }));

/**
 * Why a client's name may imitate another app's, or null. Names are chosen by
 * whoever registers the client: "Сlaude" with a Cyrillic С looks like "Claude".
 * Anything outside printable ASCII is pointed out, and a name that mixes
 * alphabets more strongly so.
 */
export function clientNameWarning(name: string): string | null {
  if (/^[\x20-\x7e]*$/.test(name)) return null;
  const scripts = SCRIPTS.filter((s) => s.re.test(name)).map((s) => s.name);
  // Latin mixed with another script is the classic look-alike ("Сlaude" with a Cyrillic С).
  return scripts.length > 1 && scripts.includes("Latin")
    ? `This name mixes alphabets (${scripts.join(", ")}): letters that look alike can imitate another app's name.`
    : "This name has characters outside plain ASCII: some letters look like others, so check that this is the app you are connecting.";
}

function clientLine(d: ConsentData): H {
  if (d.client.kind === "metadata_document") {
    let host = d.client.id;
    try {
      host = new URL(d.client.id).host;
    } catch {}
    return html`<strong><bdi>${d.client.name}</bdi></strong> <span class="muted small">described by <code>${host}</code></span>`;
  }
  return html`<strong><bdi>${d.client.name || "An unnamed app"}</bdi></strong> <span class="badge warn" title="The app chose this name when it registered; Recall cannot check it">name not verified</span>`;
}

export function consentPage(d: ConsentData): H {
  const others = d.workspaces.filter((w) => w !== d.defaultWorkspace);
  const nameWarning = clientNameWarning(d.client.name);
  return html`<section class="card narrow consent">
  <h1>Connect an app</h1>
  <p class="lede">${clientLine(d)} wants to use your Recall memory.</p>
  ${nameWarning ? html`<p class="caution" role="alert" data-name-warning>${nameWarning}</p>` : ""}
  <dl>
    <dt>Sends you back to</dt><dd><code>${d.redirectHost}</code></dd>
    <dt>Signed in as</dt><dd>${d.email}</dd>
    <dt>Account</dt><dd>${d.account.name}</dd>
  </dl>
  ${
    d.loopback
      ? html`<p class="caution" role="alert">This app receives the answer on your own computer (<code>${d.redirectHost}</code>). Any program on this device could pose as it: continue only if you just started connecting from an app on this computer.</p>`
      : ""
  }
  <p>If you allow it, the app can, in the workspaces you choose:</p>
  <ul>
    <li>search and read memory: conclusions, peer cards, session context and messages;</li>
    <li>record messages and conclusions, and delete conclusions (its full toolset can also manage peers, sessions and workspaces);</li>
    <li>ask questions about your peers. Questions and background reasoning are billed to this account.</li>
  </ul>
  <p class="muted small">It never sees your API keys, billing or settings. Access lasts until you revoke it under API keys, Connected apps.</p>
  ${
    d.accounts.length > 1
      ? html`<form method="get" action="/oauth/authorize" class="switch">
    ${hidden(d.params)}
    <label for="account-pick">Connect to account</label>
    <select id="account-pick" name="account" data-autosubmit>${d.accounts.map(
      (a) =>
        html`<option value="${a.id}"${a.id === d.account.id ? html` selected` : ""}>${a.name} (${a.role})</option>`,
    )}</select>
    <button class="secondary small" data-nojs>Switch</button>
  </form>`
      : ""
  }
  <form method="post" action="/oauth/authorize">
    ${csrfField(d.csrf)}
    <input type="hidden" name="consent" value="${d.consent}" />
    ${hidden(d.params)}
    <input type="hidden" name="account" value="${d.account.id}" />
    <label for="default-workspace">Default workspace <span class="faint">(used when a tool names none)</span></label>
    <input id="default-workspace" name="default_workspace" required maxlength="512" pattern="[A-Za-z0-9_\\-]+" list="workspace-list" value="${d.defaultWorkspace}" />
    <datalist id="workspace-list">${d.workspaces.map((w) => html`<option value="${w}"></option>`)}</datalist>
    <fieldset>
      <legend>Workspaces it may use</legend>
      <label class="check"><input type="radio" name="access" value="selected" checked /> The default workspace${others.length ? " and the ones checked here" : " only"}</label>
      ${others.map(
        (w, i) =>
          html`<label class="check indent"><input type="checkbox" name="ws_${i}" value="${w}" /> ${w}</label>`,
      )}
      <label class="check"><input type="radio" name="access" value="all" /> Every workspace of ${d.account.name}, including new ones</label>
    </fieldset>
    <label for="default-peer">Default peer <span class="faint">(optional: who "I" am in this memory, e.g. your name)</span></label>
    <input id="default-peer" name="default_peer" maxlength="512" pattern="[A-Za-z0-9_\\-]+" autocomplete="off" />
    <label class="check"><input type="checkbox" name="auto_remember" value="1" checked /> Remember automatically <span class="faint">(the app saves lasting facts you share, such as preferences, plans and people, without being asked; turn it off any time under Connected apps)</span></label>
    <div class="buttons">
      <button name="decision" value="allow" data-consent>Allow</button>
      <button name="decision" value="deny" class="secondary">Deny</button>
    </div>
  </form>
</section>`;
}

/**
 * An authorization request that cannot go on. With `back`, the user may return
 * the error to the app themselves: errors are never redirected automatically
 * before the user has acted, because anyone can register a client, so its
 * redirect URI is not trusted (RFC 9700 4.11.2, no open redirector).
 */
export function authorizeErrorPage(message: string, back?: { href: string; host: string }): H {
  return html`<section class="card narrow">
  <h1>Can't connect this app</h1>
  <p>${message}</p>
  <p class="muted small">Nothing was shared. Go back to the app and try connecting again; if this keeps happening, the app's sign-in setup is not compatible with Recall.</p>
  ${
    back
      ? html`<p><a class="button ghost" href="${back.href}" rel="noreferrer">Return to ${back.host}</a></p>`
      : html`<p><a class="button ghost" href="${dashPath("/")}">Open the dashboard</a></p>`
  }
</section>`;
}
