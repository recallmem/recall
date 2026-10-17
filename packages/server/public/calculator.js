// The context bill (recallmem.dev/calculator): what re-sending a conversation's whole history
// costs per model call, against a memory that sends a fixed context. The page is rendered with
// the default scenario (scripts/site/pages.py, the same arithmetic in Python); this script makes
// it interactive and puts the inputs in the address so a bill can be shared. No storage, no
// requests.

/** Tokens of memory context a call sends with Recall (a summary and the facts that matter). */
const MEMORY_CONTEXT = 2000;
/** Recent messages a call sends with Recall, besides the memory context. */
const RECENT = 10;

/**
 * The bill for a scenario. Per user and day: msgs / 2 model calls (one per user message). Re-
 * sending: each call reads the history so far, up to the context window, at the input price less
 * the cache discount. Recall: each call reads the memory context and the recent messages at the
 * input price, and Recall learns each message once at its own price.
 */
function bill(s, prices) {
  const calls = s.msgs / 2;
  const perDay = s.msgs * s.tokens;
  const naive = [];
  const memory = [];
  let forgetsOn = null;
  let crossover = null;
  for (let d = 1; d <= s.days; d++) {
    const history = perDay * (d - 1) + perDay / 2;
    const resent = calls * Math.min(s.window, history) * (s.price / 1e6) * (1 - s.cached / 100);
    const memIn = MEMORY_CONTEXT + Math.min(RECENT, s.msgs * d) * s.tokens;
    const learn = s.msgs * Math.max(s.tokens, prices.minTokens) * (prices.ingest / 1e6);
    const mem = calls * memIn * (s.price / 1e6) + learn;
    naive.push(resent * s.users);
    memory.push(mem * s.users);
    if (forgetsOn === null && perDay * d > s.window) forgetsOn = d;
    if (crossover === null && resent > mem) crossover = d;
  }
  const sum = (a, from = 0) => a.slice(from).reduce((x, y) => x + y, 0);
  const lastMonth = Math.max(0, s.days - 30);
  return {
    naive,
    memory,
    naiveTotal: sum(naive),
    memoryTotal: sum(memory),
    naiveMonth: sum(naive, lastMonth),
    memoryMonth: sum(memory, lastMonth),
    forgetsOn,
    crossover,
  };
}

/** Dollars as the page shows them: $0.42, $1,234, $5.6M. */
function money(x) {
  if (x >= 1e6) return `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M`;
  if (x >= 1000) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (x >= 0.01) return `$${x.toFixed(2)}`;
  return x > 0 ? "< $0.01" : "$0";
}

/** A polyline's points for daily values: one flat step a day, scaled so `max` touches the top. */
function steps(values, max, w, h) {
  const n = values.length;
  const pts = [];
  values.forEach((v, i) => {
    const y = Math.round(h - 4 - (max ? (v / max) * (h - 12) : 0));
    pts.push(`${Math.round((i / n) * w)},${y}`, `${Math.round(((i + 1) / n) * w)},${y}`);
  });
  return pts.join(" ");
}

if (typeof module !== "undefined") module.exports = { bill, money, steps, MEMORY_CONTEXT, RECENT };

if (typeof document !== "undefined") {
  const root = document.querySelector("[data-bill]");
  if (root) {
    const prices = {
      ingest: Number(root.getAttribute("data-ingest")),
      minTokens: Number(root.getAttribute("data-min-tokens")),
    };
    const fields = ["users", "msgs", "tokens", "days", "price", "window", "cached"];
    const short = {
      users: "u",
      msgs: "m",
      tokens: "t",
      days: "d",
      price: "p",
      window: "w",
      cached: "c",
    };
    const input = (f) => root.querySelector(`[name="${f}"]`);
    const out = (k) => root.querySelector(`[data-out="${k}"]`);
    const q = new URLSearchParams(location.search);
    for (const f of fields) {
      const v = q.get(short[f]);
      if (v !== null && Number.isFinite(Number(v)) && input(f)) input(f).value = v;
    }
    const svgNs = "http://www.w3.org/2000/svg";
    const chart = root.querySelector("[data-chart]");
    const line = (cls) => {
      let el = chart.querySelector(`.${cls}`);
      if (!el) {
        el = document.createElementNS(svgNs, "polyline");
        el.setAttribute("class", cls);
        chart.appendChild(el);
      }
      return el;
    };
    const update = () => {
      const s = {};
      for (const f of fields) {
        const el = input(f);
        const v = el.value === "" ? Number.NaN : Number(el.value);
        const min = Number(el.min);
        const max = Number(el.max);
        s[f] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : Number(el.defaultValue);
      }
      const b = bill(s, prices);
      out("naive-total").textContent = money(b.naiveTotal);
      out("memory-total").textContent = money(b.memoryTotal);
      out("naive-month").textContent = money(b.naiveMonth);
      out("memory-month").textContent = money(b.memoryMonth);
      const ratio = b.memoryTotal > 0 ? b.naiveTotal / b.memoryTotal : 0;
      out("verdict").textContent =
        ratio >= 1.05
          ? `Re-sending costs ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× as much over ${s.days} days.`
          : "For conversations this short, re-sending the history is cheaper. Memory pays off once history grows.";
      out("crossover").textContent =
        b.crossover === null
          ? `Within ${s.days} days, re-sending stays cheaper per day.`
          : `From day ${b.crossover}, each day of re-sending costs more than a day with memory.`;
      out("forgets").textContent =
        b.forgetsOn === null
          ? `The whole history still fits in a ${s.window.toLocaleString("en-US")}-token window after ${s.days} days.`
          : `From day ${b.forgetsOn}, the history no longer fits in a ${s.window.toLocaleString("en-US")}-token window: re-sending starts dropping the oldest messages, so your agent forgets them anyway.`;
      const max = Math.max(...b.naive, ...b.memory);
      const w = 600;
      const h = 180;
      line("bill-naive").setAttribute("points", steps(b.naive, max, w, h));
      line("bill-memory").setAttribute("points", steps(b.memory, max, w, h));
      out("chart-max").textContent = `${money(max)} a day`;
      out("chart-days").textContent = `day ${s.days}`;
      const share = new URLSearchParams();
      for (const f of fields) share.set(short[f], String(s[f]));
      history.replaceState(null, "", `${location.pathname}?${share}`);
    };
    root.addEventListener("input", update);
    const copy = root.querySelector("[data-share]");
    if (copy) {
      copy.hidden = false;
      copy.addEventListener("click", () => {
        const done = (label) => {
          copy.textContent = label;
          setTimeout(() => {
            copy.textContent = "Copy a link to this bill";
          }, 1600);
        };
        if (navigator.clipboard)
          navigator.clipboard.writeText(location.href).then(
            () => done("Copied"),
            () => done("Copy the address bar"),
          );
        else done("Copy the address bar");
      });
    }
    update();
  }
}
