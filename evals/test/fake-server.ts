import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOptions {
  /** "recall": has /usage and the `idle` flag. "honcho": neither. */
  mode: "recall" | "honcho";
  /** Number of queue/status polls that report pending work before going idle. */
  busyPolls?: number;
  /** Return this answer for a chat to the given peer (default: echoes the query). */
  answer?: (peer: string, query: string) => string;
  /** Queue shows a pending unit that never starts (like a dream scheduled for later). */
  stuckPending?: boolean;
  failChat?: boolean;
  failMessages?: boolean;
}

export interface FakeServer {
  url: string;
  close(): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: test double, request bodies are arbitrary JSON
  calls: { method: string; path: string; body: any; headers: IncomingMessage["headers"] }[];
  workspaces: Map<
    string,
    { peers: string[]; sessions: Map<string, { content: string }[]>; polls: number; chats: number }
  >;
}

/** A tiny Honcho-v3-compatible HTTP server, enough to drive the harness end to end. */
export async function startFakeServer(opts: FakeOptions): Promise<FakeServer> {
  const calls: FakeServer["calls"] = [];
  const workspaces: FakeServer["workspaces"] = new Map();
  const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const path = url.pathname;
    calls.push({ method: req.method ?? "", path, body, headers: req.headers });
    const m = path.match(/^\/v3\/workspaces\/([^/]+)(?:\/(.*))?$/);

    if (path === "/health") return send(res, 200, { status: "ok" });
    if (path === "/v3/workspaces" && req.method === "POST") {
      workspaces.set(body.id, { peers: [], sessions: new Map(), polls: 0, chats: 0 });
      return send(res, 201, { id: body.id });
    }
    const ws = m ? workspaces.get(m[1] as string) : undefined;
    if (!m || !ws) return send(res, 404, { detail: "not found" });
    const rest = m[2] ?? "";

    if (rest === "peers" && req.method === "POST") {
      ws.peers.push(body.id);
      return send(res, 201, { id: body.id });
    }
    if (rest === "sessions" && req.method === "POST") {
      ws.sessions.set(body.id, []);
      return send(res, 201, { id: body.id });
    }
    const msgs = rest.match(/^sessions\/([^/]+)\/messages$/);
    if (msgs && req.method === "POST") {
      if (opts.failMessages) return send(res, 400, { detail: "bad messages" });
      const list = ws.sessions.get(msgs[1] as string);
      if (!list) return send(res, 404, { detail: "no session" });
      list.push(...body.messages);
      return send(
        res,
        201,
        body.messages.map((x: { content: string }, i: number) => ({
          id: `m${i}`,
          token_count: Math.ceil(x.content.length / 4),
        })),
      );
    }
    if (rest === "queue/status") {
      ws.polls++;
      const busy = ws.polls <= (opts.busyPolls ?? 0);
      if (opts.stuckPending) {
        return send(res, 200, {
          total_work_units: 4,
          completed_work_units: 3,
          in_progress_work_units: 0,
          pending_work_units: 1,
        });
      }
      const base = {
        total_work_units: 4,
        completed_work_units: busy ? 2 : 4,
        in_progress_work_units: busy ? 1 : 0,
        pending_work_units: busy ? 1 : 0,
      };
      const waiting = url.searchParams.has("wait_ms");
      return send(res, 200, opts.mode === "recall" && waiting ? { ...base, idle: !busy } : base);
    }
    const listed = rest.match(/^sessions\/([^/]+)\/messages\/list$/);
    if (listed && req.method === "POST") {
      // Like Honcho and Recall: a session that does not exist lists as an empty page.
      const list = ws.sessions.get(listed[1] as string) ?? [];
      const size = Number(url.searchParams.get("size") ?? 50);
      return send(res, 200, {
        items: list.slice(0, size),
        total: list.length,
        page: 1,
        size,
        pages: Math.ceil(list.length / size),
      });
    }
    const chat = rest.match(/^peers\/([^/]+)\/chat$/);
    if (chat && req.method === "POST") {
      if (opts.failChat) return send(res, 500, { detail: "boom" });
      ws.chats++;
      const content = opts.answer ? opts.answer(chat[1] as string, body.query) : body.query;
      return send(
        res,
        200,
        opts.mode === "recall"
          ? { content, citations: [], confidence: 0.5, abstained: false }
          : { content },
      );
    }
    if (rest === "usage" && req.method === "GET") {
      if (opts.mode === "honcho") return send(res, 404, { detail: "Not Found" });
      const totals = (calls: number, inp: number, cost: number) => ({
        calls,
        input_tokens: inp,
        output_tokens: 10 * calls,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: cost,
        unpriced_calls: 0,
      });
      const bg = { reasoner: totals(2, 1000, 0.002), embedding: totals(5, 0, 0.0001) };
      const chatTotals = ws.chats
        ? { chat_low: totals(ws.chats, 500 * ws.chats, 0.001 * ws.chats) }
        : {};
      const by_task = { ...bg, ...chatTotals };
      const total = Object.values(by_task).reduce(
        (a, t) => ({
          calls: a.calls + t.calls,
          input_tokens: a.input_tokens + t.input_tokens,
          output_tokens: a.output_tokens + t.output_tokens,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: a.cost_usd + t.cost_usd,
          unpriced_calls: 0,
        }),
        totals(0, 0, 0),
      );
      return send(res, 200, {
        workspace_id: m[1],
        total,
        by_task,
        items: Object.keys(by_task).map((task) => ({
          task,
          provider: "fake",
          model: "m1",
          calls: 1,
        })),
      });
    }
    if (rest === "sessions/list" && req.method === "POST") {
      return send(res, 200, { items: [...ws.sessions.keys()].map((id) => ({ id })), pages: 1 });
    }
    if (req.method === "DELETE") {
      const session = rest.match(/^sessions\/([^/]+)$/);
      if (session) ws.sessions.delete(session[1] as string);
      if (rest === "") {
        // Like Recall: a workspace with sessions left cannot be deleted.
        if (ws.sessions.size) return send(res, 409, { detail: "active session(s) remain" });
        workspaces.delete(m[1] as string);
      }
      return send(res, 202, { message: "ok" });
    }
    return send(res, 404, { detail: "unknown route" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    workspaces,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
