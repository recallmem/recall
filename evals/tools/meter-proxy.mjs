// OpenAI-compatible metering proxy for the benchmark.
// Forwards every request to https://api.openai.com unchanged and appends one JSON
// line per call (model, prompt/cached/cache-write/completion/reasoning tokens, USD, latency)
// to a log, so every system under test is measured the same way.
//
// Spend guard: with --budget-usd N the proxy refuses (HTTP 402, nothing forwarded) every
// request once the logged spend reaches N, so a run can never cross a hard cap. The running
// total is rebuilt from the log at start-up, so restarts keep counting. GET /__meter reports it.
//
// Usage: node meter-proxy.mjs <port> <logfile> [--budget-usd N] [--prices prices.json] [--upstream URL]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const [port, logFile] = [Number(positional[0]), positional[1]];
if (!port || !logFile) {
  console.error(
    "usage: meter-proxy.mjs <port> <logfile> [--budget-usd N] [--prices prices.json] [--upstream URL]",
  );
  process.exit(2);
}
const budgetUsd =
  flag("budget-usd") === undefined ? Number.POSITIVE_INFINITY : Number(flag("budget-usd"));
const pricesPath =
  flag("prices") ?? join(dirname(fileURLToPath(import.meta.url)), "openai-prices.json");
const PRICES = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(pricesPath, "utf8"))).filter(([k]) => !k.startsWith("_")),
);
// Overridable so the proxy itself can be tested against a local fake (see test/meter-proxy.test.ts).
const UPSTREAM = (flag("upstream") ?? "https://api.openai.com").replace(/\/+$/, "");

/** Price entry for a model id; dated variants ("gpt-4.1-2025-04-14") match their base name. */
function priceFor(model) {
  if (!model) return null;
  let best = null;
  for (const key of Object.keys(PRICES)) {
    if (model === key || model.startsWith(`${key}-`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? PRICES[best] : null;
}

/**
 * USD for one call. Cache writes (GPT-5.6 and later bill them at 1.25x input) use the
 * model's `cacheWrite` rate; models without one bill written tokens as ordinary input.
 */
function costOf(model, u) {
  const p = priceFor(model);
  if (!p || !u) return 0;
  const long = p.longContext && u.prompt_tokens > p.longContext.over ? p.longContext : null;
  const inRate = long?.input ?? p.input;
  const outRate = long?.output ?? p.output;
  const cachedRate = long?.cached ?? p.cached;
  const writeRate = long?.cacheWrite ?? p.cacheWrite ?? inRate;
  const cached = Math.min(u.cached_tokens, u.prompt_tokens);
  const written = Math.min(u.cache_write_tokens ?? 0, u.prompt_tokens - cached);
  return (
    ((u.prompt_tokens - cached - written) * inRate +
      cached * cachedRate +
      written * writeRate +
      u.completion_tokens * outRate) /
    1e6
  );
}

/** Pulls the usage object out of a JSON body or an SSE stream (Chat Completions or Responses API). */
function usageFrom(text, isStream) {
  const pick = (obj) => obj?.usage ?? obj?.response?.usage ?? null;
  if (!isStream) {
    try {
      return pick(JSON.parse(text));
    } catch {
      return null;
    }
  }
  let usage = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
    try {
      const u = pick(JSON.parse(line.slice(5)));
      if (u) usage = u;
    } catch {}
  }
  return usage;
}

const normalize = (u) => ({
  prompt_tokens: u?.prompt_tokens ?? u?.input_tokens ?? 0,
  cached_tokens:
    u?.prompt_tokens_details?.cached_tokens ?? u?.input_tokens_details?.cached_tokens ?? 0,
  cache_write_tokens:
    u?.prompt_tokens_details?.cache_write_tokens ??
    u?.input_tokens_details?.cache_write_tokens ??
    0,
  completion_tokens: u?.completion_tokens ?? u?.output_tokens ?? 0,
  reasoning_tokens:
    u?.completion_tokens_details?.reasoning_tokens ??
    u?.output_tokens_details?.reasoning_tokens ??
    0,
});

// Running total, rebuilt from the existing log so a restart keeps counting.
let spentUsd = 0;
let calls = 0;
let blocked = 0;
if (existsSync(logFile)) {
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      spentUsd += r.cost_usd ?? 0;
      calls++;
    } catch {}
  }
}

createServer(async (req, res) => {
  if (req.url === "/__meter") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ spentUsd, budgetUsd, calls, blocked }));
    return;
  }
  const started = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let model = null;
  let stream = false;
  try {
    const j = JSON.parse(body.toString("utf8"));
    model = j.model ?? null;
    stream = !!j.stream;
  } catch {}

  if (spentUsd >= budgetUsd) {
    blocked++;
    res.writeHead(402, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `meter-proxy: spend cap of $${budgetUsd} reached ($${spentUsd.toFixed(2)} spent); request not forwarded`,
          type: "budget_exhausted",
          code: "budget_exhausted",
        },
      }),
    );
    appendFileSync(
      logFile,
      `${JSON.stringify({ at: new Date().toISOString(), path: req.url, status: 402, model, blocked: true, cost_usd: 0 })}\n`,
    );
    return;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers["accept-encoding"];
  try {
    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    const outHeaders = {};
    up.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(k))
        outHeaders[k] = v;
    });
    res.writeHead(up.status, outHeaders);
    let text = "";
    const decoder = new TextDecoder();
    for await (const part of up.body) {
      res.write(part);
      text += decoder.decode(part, { stream: true });
    }
    const raw = usageFrom(text, stream);
    const u = normalize(raw);
    const cost = up.ok ? costOf(model, u) : 0;
    spentUsd += cost;
    calls++;
    appendFileSync(
      logFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        path: req.url,
        status: up.status,
        model,
        stream,
        ...u,
        usage_missing: !raw,
        priced: priceFor(model) !== null,
        cost_usd: cost,
        ms: Date.now() - started,
      })}\n`,
    );
    // Closed last: by the time a caller sees the end of the response, the call is already
    // counted against the budget and in the log.
    res.end();
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err) } }));
  }
}).listen(port, "127.0.0.1", () =>
  console.log(
    `meter proxy :${port} -> ${UPSTREAM}, log ${logFile}, budget ${Number.isFinite(budgetUsd) ? `$${budgetUsd}` : "none"}, spent so far $${spentUsd.toFixed(4)}`,
  ),
);
