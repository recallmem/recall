#!/usr/bin/env node
// Builds the guides (public/guides/<slug>.html) and their index (public/guides.html) from
// site/guides/<slug>.html fragments and site/guides/manifest.json. Code samples are not written
// in the fragments: a `<!-- example: NAME#REGION -->` line is replaced by a TypeScript/Python
// window cut from examples/guides/NAME.ts and NAME.py, the same files CI runs against a real
// server (packages/sdk/test/guides.test.ts, sdks/python/tests/test_guides.py). A framework guide
// shows one language, named in its manifest entry: `"languages": ["ts"]` for a TypeScript
// framework (its examples run in packages/ai-sdk, langchain, mastra) or `["py"]` for a Python one
// (they run in sdks/python-integrations/*/tests/test_guide.py).
// The header, footer and contents script come from public/docs.html, so the guides stay in step.
//
//   node scripts/site/guides.mjs           write the pages
//   node scripts/site/guides.mjs --check   exit 1 when a page is out of date (used by the tests)
//   node scripts/site/guides.mjs --only S  build only guide S (while drafting)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = join(SERVER, "../..");
const SRC = join(SERVER, "site/guides");
const OUT = join(SERVER, "public");
const EXAMPLES = join(REPO, "examples/guides");

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const attr = (s) => esc(s).replaceAll('"', "&quot;");

function between(text, start, end, what) {
  const i = text.indexOf(start);
  const j = text.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error(`docs.html: cannot find the ${what}`);
  return text.slice(i, j + end.length);
}

const docs = readFileSync(join(OUT, "docs.html"), "utf8");
const header = between(
  docs,
  '<header class="nav scrolled" id="nav">',
  "</header>",
  "header",
).replace('<span class="muted nowrap">/docs</span>', '<span class="muted nowrap">/guides</span>');
const footer = between(docs, "<footer>", "</footer>", "footer").replaceAll(
  'href="#',
  'href="/docs#',
);
// Byte for byte the docs' script, so the CSP hash that allows it covers the guides too.
const tocScript = between(docs, "  <script>\n    // On a phone", "</script>", "contents script");

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));

/** Lines between `#region NAME` and the next `#endregion`, dedented. */
function region(text, name, file) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`#\\s?region ${name}\\s*$`).test(l.trim()));
  if (start < 0) throw new Error(`${file}: no region "${name}"`);
  const end = lines.findIndex((l, i) => i > start && /#\s?endregion/.test(l));
  if (end < 0) throw new Error(`${file}: region "${name}" is not closed`);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return body
    .map((l) => l.slice(indent))
    .join("\n")
    .replace(/\s+$/, "");
}

/**
 * The source's import block as written (multi-line imports and blank lines between groups
 * kept), without lines a reader does not need: TypeScript type-only imports, Python's
 * `__future__` and `typing`.
 */
function importBlock(text, lang) {
  const out = [];
  let open = false;
  for (const line of text.split("\n")) {
    if (open) {
      out.push(line);
      if (/[)}]/.test(line)) open = false;
      continue;
    }
    const isImport = lang === "ts" ? /^import /.test(line) : /^(from|import) /.test(line);
    if (isImport) {
      const skip =
        lang === "ts" ? /^import type /.test(line) : /^from (__future__|typing) /.test(line);
      if (skip) continue;
      out.push(line);
      if (/[({]\s*$/.test(line)) open = true;
    } else if (line.trim() === "" && out.length) out.push("");
    else if (out.length && !/^\s*(#|\/\/)/.test(line)) break;
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What a reader needs above the first sample of a file: the imports and the client. */
function prelude(text, lang, file) {
  if (lang === "ts") {
    const client = text.match(/main\(recall = (new Recall\([^)]*\))\)/);
    if (!client) throw new Error(`${file}: main must read "main(recall = new Recall(...))"`);
    return `${importBlock(text, lang)}\n\nconst recall = ${client[1]};\n\n`;
  }
  const client = text.match(/recall = recall or (Recall\([^)]*\))/);
  if (!client) throw new Error(`${file}: main must read "recall = recall or Recall(...)"`);
  return `${importBlock(text, lang)}\n\nrecall = ${client[1]}\n\n`;
}

const LANGUAGES = [
  ["ts", "ts", "TypeScript"],
  ["py", "py", "Python"],
];

function codeWindow(name, regionName, shown, languages) {
  const tabs = [];
  const panels = [];
  const shownLanguages = LANGUAGES.filter(([lang]) => languages.includes(lang));
  for (const [lang, ext, label] of shownLanguages) {
    const file = join(EXAMPLES, `${name}.${ext}`);
    if (!existsSync(file)) throw new Error(`missing example ${file}`);
    const text = readFileSync(file, "utf8");
    const first = !shown.has(`${name}.${ext}`);
    shown.add(`${name}.${ext}`);
    const code = (first ? prelude(text, lang, file) : "") + region(text, regionName, file);
    const selected = lang === shownLanguages[0][0];
    tabs.push(
      `<button type="button" class="tab" role="tab" aria-selected="${selected}" data-tab="${lang}">${label}</button>`,
    );
    panels.push(
      `<pre data-panel="${lang}"${selected ? "" : " hidden"}><code>${esc(code)}</code></pre>`,
    );
  }
  return `<div class="code guide-code" data-tabbox>
  <div class="tabs" role="tablist" aria-label="Language">${tabs.join("")}</div>
${panels.join("\n")}
</div>`;
}

function head(title, description, path) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${attr(description)}" />
<meta name="theme-color" content="#0c0b0a" />
<meta property="og:title" content="${attr(title)}" />
<meta property="og:description" content="${attr(description)}" />
<meta property="og:type" content="article" />
<meta property="og:image" content="/og.png" />
<link rel="canonical" href="https://recallmem.dev${path}" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preload" href="/fonts/silkscreen-700.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/departure-mono.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="/site.css" />
<meta name="recall-api" content="https://api.recallmem.dev" data-site="https://recallmem.dev" />
</head>
<body>

${header}
`;
}

function tail() {
  return `
${footer}

<script src="/site.js" defer></script>
</body>
</html>
`;
}

const groups = [...new Set(manifest.map((g) => g.group))];

function guideNav(current) {
  const parts = [];
  for (const group of groups) {
    parts.push(`        <b>${esc(group)}</b>`);
    for (const g of manifest.filter((x) => x.group === group)) {
      const here = g.slug === current ? ' aria-current="page"' : "";
      parts.push(`        <a href="/guides/${g.slug}"${here}>${esc(g.title)}</a>`);
    }
  }
  return parts.join("\n");
}

function page(g) {
  const file = join(SRC, `${g.slug}.html`);
  let body = readFileSync(file, "utf8").trim();
  const shown = new Set();
  const languages = g.languages ?? ["ts", "py"];
  if (!languages.length || languages.some((l) => !LANGUAGES.some(([lang]) => lang === l)))
    throw new Error(`${g.slug}: languages must be some of ts, py`);
  body = body.replace(/^[ \t]*<!-- example: ([a-z0-9-]+)#([a-z0-9-]+) -->[ \t]*$/gm, (_, name, r) =>
    codeWindow(name, r, shown, languages),
  );
  if (body.includes("<!-- example:")) throw new Error(`${file}: malformed example marker`);
  const sections = [...body.matchAll(/<h2 id="([a-z0-9-]+)">(.*?)<\/h2>/g)];
  const onPage = sections
    .map(
      ([, id, text]) => `        <a class="sub" href="#${id}">${text.replace(/<[^>]+>/g, "")}</a>`,
    )
    .join("\n");
  return `${head(`${g.title} — Recall guides`, g.description, `/guides/${g.slug}`)}
<div class="docs">
  <aside class="toc" aria-label="Guides">
    <details class="toc-box" open>
      <summary>Guides</summary>
      <div class="toc-links">
        <a href="/guides">All guides</a>
        <b>On this page</b>
${onPage}
${guideNav(g.slug)}
        <b>Reference</b>
        <a href="/docs">Docs</a>
        <a href="/docs#api">REST API</a>
      </div>
    </details>
  </aside>
${tocScript}

  <article class="prose guide">
    <p class="crumbs"><a href="/guides">Guides</a> / ${esc(g.group)}</p>
${body}
    <p class="guide-next">Next: ${(g.next ?? [])
      .map((slug) => {
        const n = manifest.find((x) => x.slug === slug);
        if (!n) throw new Error(`${g.slug}: unknown next guide ${slug}`);
        return `<a href="/guides/${n.slug}">${esc(n.title)}</a>`;
      })
      .join(" · ")}</p>
  </article>
</div>
${tail()}`;
}

function index() {
  const cards = groups
    .map(
      (group) => `    <h2 id="${group.toLowerCase().replace(/[^a-z]+/g, "-")}">${esc(group)}</h2>
    <div class="guide-cards">
${manifest
  .filter((g) => g.group === group)
  .map(
    (g) =>
      `      <a class="guide-card" href="/guides/${g.slug}"><b>${esc(g.title)}</b><span>${esc(g.short)}</span></a>`,
  )
  .join("\n")}
    </div>`,
    )
    .join("\n\n");
  const description =
    "How to build with Recall, use case by use case: assistants, customer support, coding agents, game NPCs, sales, multi-agent systems, tutoring, community bots, coaching, voice agents and shopping. And framework by framework: the Vercel AI SDK, LangChain, LangChain.js, Mastra, the OpenAI Agents SDK and CrewAI.";
  return `${head("Guides — Recall", description, "/guides")}
<div class="docs">
  <aside class="toc" aria-label="Guides">
    <details class="toc-box" open>
      <summary>Guides</summary>
      <div class="toc-links">
${guideNav(null)}
        <b>Reference</b>
        <a href="/docs">Docs</a>
      </div>
    </details>
  </aside>
${tocScript}

  <article class="prose guide">
    <h1>Guides</h1>
    <p class="lede">One guide per kind of product, and one per agent framework. Each shows what memory changes for your users, how to map your product onto workspaces, peers and sessions, working code (TypeScript and Python, or the framework's own language, all of it run against a real Recall server on every change), the settings that matter, what it costs and how fast it is, and how to forget someone.</p>
    <p>New to Recall? Start with the <a href="/docs#quickstart">quickstart</a> and <a href="/guides/modeling">Designing workspaces, peers and sessions</a>. Building on an agent framework? The framework guides add Recall to the Vercel AI SDK, LangChain, LangChain.js, Mastra, the OpenAI Agents SDK or CrewAI in a few lines.</p>

${cards}
  </article>
</div>
${tail()}`;
}

const check = process.argv.includes("--check");
// --only SLUG: build just that guide (while drafting; the index needs every guide).
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
if (only && !manifest.some((g) => g.slug === only))
  throw new Error(`no guide "${only}" in manifest.json`);
const outputs = new Map();
for (const g of manifest.filter((x) => !only || x.slug === only))
  outputs.set(join(OUT, "guides", `${g.slug}.html`), page(g));
if (!only) outputs.set(join(OUT, "guides.html"), index());
const known = new Set(manifest.map((g) => `${g.slug}.html`));
for (const f of existsSync(join(SRC)) ? readdirSync(SRC) : []) {
  if (f.endsWith(".html") && !known.has(f))
    throw new Error(`site/guides/${f} is not in manifest.json`);
}

let stale = 0;
for (const [path, html] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === html) continue;
  stale++;
  if (check) console.error(`out of date: ${path.slice(SERVER.length + 1)}`);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }
}
if (check && stale) {
  console.error("run: node packages/server/scripts/site/guides.mjs");
  process.exit(1);
}
if (!check) console.log(`guides: ${outputs.size} pages, ${stale} written`);
