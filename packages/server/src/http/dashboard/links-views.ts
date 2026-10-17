import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { LinkSignups } from "../../core/funnel.js";
import {
  LINK_MEDIA,
  LINK_PAGES,
  LINK_SOURCES,
  linkUrl,
  MEDIUM_OF,
  type UtmLink,
} from "../../core/links.js";
import { consoleHead, consoleTabs } from "./console-views.js";
import { dashPath } from "./paths.js";
import { csrfField, table } from "./views.js";

/**
 * The console's Links page (console.ts): a form that makes a tagged link to a page of the site,
 * and the live links with what each brought in. app.js previews the link while the form is
 * filled in and adds copy buttons; without it the made link is shown on its own after saving.
 */

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

const n = (v: number) => v.toLocaleString("en-US");
const day = (d: Date) => d.toISOString().slice(0, 10);
/** A note that is a web address becomes a link; anything else stays text. */
const noteOf = (note: string) =>
  /^https?:\/\/\S+$/.test(note)
    ? html`<a href="${note}" rel="noopener noreferrer" target="_blank">${note}</a>`
    : note;

const copyButton = (text: string) =>
  html`<button type="button" class="copy-btn" data-copy-text="${text}" hidden>Copy</button>`;

export interface LinksPage {
  csrf: string;
  siteUrl: string | null;
  links: UtmLink[];
  /** Visitors per link from Umami (null: Umami did not answer); absent when Umami is off. */
  visitors: Map<string, number | null> | null;
  signups: Map<string, LinkSignups>;
  /** The link just made, shown on top. */
  made: UtmLink | null;
}

function maker(siteUrl: string, csrf: string): H {
  return html`<form method="post" action="${dashPath("/admin/links")}" class="card link-maker" data-utm-form data-site="${siteUrl}" data-media="${JSON.stringify(MEDIUM_OF)}">
${csrfField(csrf)}
<div class="link-fields">
  <div class="field"><label for="l-path">Page</label><select id="l-path" name="path">${LINK_PAGES.map(
    (p) => html`<option value="${p.path}">${p.label} (${p.path})</option>`,
  )}</select></div>
  <div class="field"><label for="l-custom">Or another page <span class="faint">(optional)</span></label><input id="l-custom" name="custom_path" maxlength="220" placeholder="/guides/langchain" /></div>
  <div class="field"><label for="l-source">Where you post it</label><input id="l-source" name="source" list="l-sources" required maxlength="60" placeholder="reddit" autocomplete="off" /><datalist id="l-sources">${LINK_SOURCES.map((s) => html`<option value="${s}"></option>`)}</datalist></div>
  <div class="field"><label for="l-medium">Medium</label><select id="l-medium" name="medium"><option value="">From the source</option>${LINK_MEDIA.map(
    (m) => html`<option value="${m}">${m}</option>`,
  )}</select></div>
  <div class="field"><label for="l-campaign">Campaign</label><input id="l-campaign" name="campaign" required maxlength="60" placeholder="localllama-launch" autocomplete="off" /></div>
  <div class="field"><label for="l-content">Content <span class="faint">(optional)</span></label><input id="l-content" name="content" maxlength="60" placeholder="first-comment" autocomplete="off" /></div>
  <div class="field wide"><label for="l-note">Note <span class="faint">(optional, only you see it)</span></label><input id="l-note" name="note" maxlength="300" placeholder="Where it went, such as the thread's address" /></div>
</div>
<p class="utm-preview" data-utm-preview hidden><span class="utm-label">Your link</span><code></code></p>
<div class="buttons"><button>Make link</button></div>
<p class="hint">One campaign per post or thread, so each gets its own numbers. Tags become lower case, with dashes for spaces. Medium follows the source unless you pick one: reddit, x and linkedin are social; hn, discord and github are community; a newsletter is email.</p>
</form>`;
}

function linkRows(d: LinksPage, site: string): H[] {
  return d.links.map((l) => {
    const url = linkUrl(site, l);
    const v = d.visitors ? d.visitors.get(l.id) : undefined;
    const s = d.signups.get(l.id) ?? { signups: 0, apiCalls: 0 };
    const tags = [l.source, l.medium, ...(l.content ? [l.content] : [])];
    return html`<tr${d.made?.id === l.id ? html` class="fresh"` : ""}>
<td class="link-cell" data-label="Link"><strong>${l.campaign}</strong> <span class="link-tags">${tags.map((t) => html`<span class="tag">${t}</span>`)}</span>
<span class="link-url"><code>${url}</code>${copyButton(url)}</span>
<span class="link-meta">${l.path}${l.note ? html` · ${noteOf(l.note)}` : ""}</span></td>
<td data-label="Made">${day(l.createdAt)}</td>
<td class="num" data-label="Visitors">${v === undefined ? html`<span class="faint">–</span>` : v === null ? html`<span class="faint" title="Umami did not answer for this link">?</span>` : n(v)}</td>
<td class="num" data-label="Sign-ups">${n(s.signups)}</td>
<td class="num" data-label="First API call">${n(s.apiCalls)}</td>
<td class="actions"><form method="post" action="${dashPath(`/admin/links/${encodeURIComponent(l.id)}/archive`)}" class="inline">${csrfField(d.csrf)}<button class="secondary small" title="Hide it here; the link keeps working where you posted it">Archive</button></form></td>
</tr>`;
  });
}

export function linksPage(d: LinksPage): H {
  const site = d.siteUrl;
  return html`${consoleHead("Links", "Tagged links for the places you post. Each one carries a UTM source, medium and campaign, so the Traffic page and the numbers below can tell which post brought people in.")}
${consoleTabs("links")}
${
  !site
    ? html`<div class="card"><p><strong>The site's address is not known.</strong></p><p class="muted">Set <code>RECALL_SITE_URL</code> (or <code>RECALL_PUBLIC_URL</code>) on this server to make links.</p></div>`
    : html`${
        d.made
          ? html`<section class="card made-link" aria-label="New link"><p class="eyebrow">Link ready</p><h2>${d.made.campaign}</h2><pre data-copy>${linkUrl(site, d.made)}</pre><p class="hint">Paste it where you post. Its visitors and sign-ups show in the list below.</p></section>`
          : ""
      }${maker(site, d.csrf)}
<h2>Your links</h2>
${table(
  ["Link", "Made", "Visitors", "Sign-ups", "First API call", ""],
  linkRows(d, site),
  "No links yet. Make one above for your next post.",
  { label: "Your links", stack: true },
)}
<p class="muted small">Visitors: since the link was made, from Umami by the link's tags${d.visitors ? "" : " (Umami is not configured on this server)"}. Sign-ups: self-serve accounts made since then with the link's source and campaign (links that share both share these counts; test accounts left out). First API call: of those, the accounts whose API key or connected app was used.</p>`
}`;
}
