/**
 * Recall's transactional email layout: the site's 8-bit look (amber on near-black, pixel header,
 * hard-shadow button) built from tables and inline styles, since email clients ignore stylesheets
 * and web fonts. The header and divider are images served from the site (`public/email/`).
 */

export interface EmailContent {
  /** Hidden preview line shown next to the subject in the inbox. */
  preheader: string;
  heading: string;
  /** Paragraphs, plain text (escaped here). */
  paragraphs: string[];
  button?: { label: string; url: string };
  /** Small print under the button, plain text. */
  footnote?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MONO = "'Courier New',Courier,ui-monospace,Menlo,Consolas,monospace";
const BG = "#0c0b0a";
const CARD = "#14110d";
const AMBER = "#ffb000";
const TEXT = "#efe9dc";
const MUTED = "#a39a88";

/** Renders the email. `siteUrl` is where the header images are served, e.g. https://recallmem.dev. */
export function renderEmail(siteUrl: string, c: EmailContent): { html: string; text: string } {
  const site = siteUrl.replace(/\/+$/, "");
  const p = (t: string) =>
    `<p style="margin:0 0 16px;font-family:${MONO};font-size:15px;line-height:1.6;color:${TEXT};">${esc(t)}</p>`;
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>
<td bgcolor="${AMBER}" style="background:${AMBER};border-right:5px solid #7a5300;border-bottom:5px solid #7a5300;">
<a href="${esc(c.button.url)}" style="display:inline-block;padding:14px 26px;font-family:${MONO};font-size:15px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#120d02;text-decoration:none;">${esc(c.button.label)} &#9658;</a>
</td></tr></table>
<p style="margin:0 0 20px;font-family:${MONO};font-size:12px;line-height:1.5;color:${MUTED};word-break:break-all;">Or paste this link into your browser:<br><a href="${esc(c.button.url)}" style="color:${AMBER};">${esc(c.button.url)}</a></p>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(c.heading)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="background:${BG};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td><img src="${site}/email/header.png" width="600" alt="RECALL · memory for AI agents" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
<tr><td bgcolor="${CARD}" style="background:${CARD};border:2px solid ${AMBER};padding:32px 32px 12px;">
<h1 style="margin:0 0 20px;font-family:${MONO};font-size:22px;line-height:1.3;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:${AMBER};">&#9632; ${esc(c.heading)}</h1>
${c.paragraphs.map(p).join("\n")}
${button}
<img src="${site}/email/divider.png" width="504" alt="" style="display:block;width:100%;max-width:504px;height:auto;border:0;margin:0 0 16px;">
${c.footnote ? `<p style="margin:0 0 20px;font-family:${MONO};font-size:12px;line-height:1.6;color:${MUTED};">${esc(c.footnote)}</p>` : ""}
</td></tr>
<tr><td style="padding:18px 4px 0;font-family:${MONO};font-size:11px;line-height:1.6;color:#6f675a;">
<a href="${site}" style="color:${MUTED};text-decoration:none;">recallmem.dev</a> · <a href="${site}/support" style="color:${MUTED};text-decoration:none;">support</a> · <a href="${site}/privacy" style="color:${MUTED};text-decoration:none;">privacy</a><br>
Recall is a trade name of Smidt Beheer · Binnendelta 11M, Blaricum · KvK 99124254
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    c.heading,
    "",
    ...c.paragraphs.flatMap((t) => [t, ""]),
    ...(c.button ? [`${c.button.label}: ${c.button.url}`, ""] : []),
    ...(c.footnote ? [c.footnote, ""] : []),
    "Recall · recallmem.dev · Smidt Beheer, KvK 99124254",
  ].join("\n");
  return { html, text };
}
