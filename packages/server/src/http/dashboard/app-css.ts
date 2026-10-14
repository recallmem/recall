/** The dashboard stylesheet, served at <base>/static/app.css. */

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
button.wide,.button.wide{width:100%;max-width:460px;min-height:46px}
.or{margin:18px 0 0}
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
.card-line{display:block}
.card-src{margin-top:4px}
.card-src>summary{display:inline-block;font:500 12.5px var(--sans);color:var(--faint);cursor:pointer}
.card-src>summary:hover{color:var(--amber)}
.card-src[open]{padding:4px 0 2px}
.card-list .card-src-list li{padding:6px 0;border-bottom:1px dashed var(--line);font-size:13.5px}
.card-list .card-src-list li::before{content:none}
.card-src-list{margin:6px 0 0;padding:0;list-style:none}
.card-src-list label{display:inline;font:inherit;color:var(--fg)}
.card-src-list input{margin-right:6px;vertical-align:-2px}
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
