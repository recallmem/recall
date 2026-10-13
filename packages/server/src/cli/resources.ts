import { type Api, createApi } from "./client.js";
import {
  CliError,
  type CliIo,
  checkId,
  intOption,
  parseWithPositionals,
  UsageError,
} from "./common.js";
import { clip, dash, keyValues, pageNote, table, wantsJson, when } from "./output.js";
import { resolveSettings, type Settings } from "./settings.js";

/**
 * Resource commands: workspaces, peers, sessions, conclusions and the queue.
 * They mirror the reference CLI's names where they make sense, talk to the
 * REST API with plain `fetch`, and print tables, or JSON with `--json`.
 */

const OPTIONS = {
  url: { type: "string" },
  "api-key": { type: "string" },
  workspace: { type: "string", short: "w" },
  peer: { type: "string", short: "p" },
  session: { type: "string", short: "s" },
  json: { type: "boolean" },
  timeout: { type: "string" },
  target: { type: "string" },
  observer: { type: "string" },
  observed: { type: "string" },
  sender: { type: "string" },
  level: { type: "string" },
  limit: { type: "string" },
  page: { type: "string" },
  size: { type: "string" },
  last: { type: "string" },
  reverse: { type: "boolean" },
  ids: { type: "boolean" },
  tokens: { type: "string" },
  "no-summary": { type: "boolean" },
  "peer-target": { type: "string" },
  "search-query": { type: "string" },
  "top-k": { type: "string" },
  reasoning: { type: "string", short: "r" },
  evidence: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  wait: { type: "string" },
  metadata: { type: "string" },
  data: { type: "string", short: "d" },
  scope: { type: "string", multiple: true },
  sessions: { type: "string", multiple: true },
  peers: { type: "string" },
  "observe-me": { type: "boolean" },
  "no-observe-me": { type: "boolean" },
  cascade: { type: "boolean" },
  "dry-run": { type: "boolean" },
  brief: { type: "boolean" },
  "max-conclusions": { type: "string" },
  "derived-from": { type: "string" },
  type: { type: "string" },
  rebuild: { type: "boolean" },
  "content-type": { type: "string" },
} as const;

type Values = ReturnType<typeof parseWithPositionals<typeof OPTIONS>>["values"];

interface Ctx {
  io: CliIo;
  settings: Settings;
  json: boolean;
  values: Values;
  /** Positional arguments after the subcommand name. */
  args: string[];
  call: Api["call"];
  ws(path: string): string;
  /** Print a result: the data as JSON, or the human rendering. */
  show(data: unknown, human: () => string): void;
}

type Handler = (c: Ctx) => Promise<void>;
const enc = encodeURIComponent;

// biome-ignore lint/suspicious/noExplicitAny: JSON rows
type Row = Record<string, any>;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === "") throw new UsageError(what);
  return value;
}

const peerFor = (c: Ctx, positional?: string): string =>
  checkId(
    "peer",
    positional ??
      c.settings.peer ??
      need(
        undefined,
        "no peer: name one with -p <peer>, or set RECALL_PEER_ID / run `recall init -p <peer>`",
      ),
  )!;

const sessionFor = (c: Ctx, positional?: string): string =>
  checkId(
    "session",
    positional ??
      c.settings.session ??
      need(
        undefined,
        "no session: name one with -s <session> or as an argument, or set RECALL_SESSION_ID",
      ),
  )!;

/** Only an explicit flag (not a configured default) narrows a listing. */
const flagged = (name: string, value: string | undefined) => checkId(name, value);

const paging = (c: Ctx, fallback: number) => ({
  size: intOption("--limit", c.values.limit ?? c.values.size, fallback, 1, 100),
  page: intOption("--page", c.values.page, 1, 1, 1_000_000),
  reverse: c.values.reverse ? true : undefined,
});

/** A JSON object given on the command line (`--metadata '{"plan": "pro"}'`). */
function jsonObject(label: string, raw: string | undefined): Row | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UsageError(`${label} must be a JSON object, e.g. '{"plan": "pro"}' (got ${raw})`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${label} must be a JSON object, e.g. '{"plan": "pro"}' (got ${raw})`);
  }
  return value as Row;
}

/** Ids from a repeatable and/or comma-separated option (`--scope a --scope b,c`), validated. */
function idList(label: string, raw: string | string[] | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.map((v) => checkId(label, v)!);
}

/** The question or query: the positional words joined. */
const words = (c: Ctx, usage: string): string => need(c.args.join(" ").trim() || undefined, usage);

/** Every item of a paginated listing (100 per request). */
async function everyItem(c: Ctx, method: string, path: string, body?: unknown): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const res = await c.call(method, path, { query: { page, size: 100 }, body });
    out.push(...res.items);
    if (page >= (res.pages ?? 1) || res.items.length === 0) return out;
  }
}

/** Fetches one peer or session without creating it (a filtered one-row list), or fails with *_NOT_FOUND. */
async function lookup(c: Ctx, kind: "peer" | "session", id: string): Promise<Row> {
  const found = await c.call("POST", c.ws(`/${kind}s/list`), {
    query: { size: 1 },
    body: { filters: { id } },
  });
  const row: Row | undefined = found.items[0];
  if (!row) {
    throw new CliError(
      `${kind.toUpperCase()}_NOT_FOUND`,
      `${kind === "peer" ? "Peer" : "Session"} '${id}' not found in workspace '${c.settings.workspace}'.`,
      { [kind]: id },
    );
  }
  return row;
}

const messageRows = (items: Row[], ids: boolean) =>
  table(
    ids ? ["ID", "WHEN", "PEER", "CONTENT"] : ["WHEN", "PEER", "CONTENT"],
    items.map((m) => [...(ids ? [m.id] : []), when(m.created_at), m.peer_id, clip(m.content, 100)]),
  );

const representationOptions = (c: Ctx) => ({
  target: flagged("--target", c.values.target) ?? null,
  search_query: c.values["search-query"] ?? null,
  max_conclusions:
    c.values["max-conclusions"] === undefined
      ? undefined
      : intOption("--max-conclusions", c.values["max-conclusions"], 25, 1, 100),
});

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

const workspaceList: Handler = async (c) => {
  const page = await c.call("POST", "/v3/workspaces/list", { query: paging(c, 50), body: {} });
  c.show(page.items, () =>
    page.items.length
      ? table(
          ["ID", "CREATED", "METADATA"],
          page.items.map((w: Row) => [
            w.id,
            when(w.created_at),
            clip(JSON.stringify(w.metadata), 50),
          ]),
        ) + pageNote(page)
      : "No workspaces.",
  );
};

const workspaceInspect: Handler = async (c) => {
  const id = checkId("workspace", c.args[0] ?? c.settings.workspace)!;
  const wsPath = (p: string) => `/v3/workspaces/${enc(id)}${p}`;
  // A workspace-scoped key cannot list workspaces; the rest still works.
  const meta = await c
    .call("POST", "/v3/workspaces/list", { query: { size: 1 }, body: { filters: { id } } })
    .catch((err) => {
      if (err instanceof CliError && ["UNAUTHORIZED", "FORBIDDEN"].includes(err.code)) return null;
      throw err;
    });
  const found: Row | undefined = meta?.items?.[0];
  if (meta && !found)
    throw new CliError("WORKSPACE_NOT_FOUND", `Workspace '${id}' not found.`, { workspace: id });
  const [peers, sessions, queue] = await Promise.all([
    c.call("POST", wsPath("/peers/list"), { query: { size: 100 }, body: {} }),
    c.call("POST", wsPath("/sessions/list"), { query: { size: 100 }, body: {} }),
    c.call("GET", wsPath("/queue/status")),
  ]);
  const data = {
    id,
    created_at: found?.created_at ?? null,
    metadata: found?.metadata ?? null,
    configuration: found?.configuration ?? null,
    peer_count: peers.total,
    peers: peers.items.map((p: Row) => p.id),
    session_count: sessions.total,
    sessions: sessions.items.map((s: Row) => s.id),
    queue: {
      total: queue.total_work_units,
      completed: queue.completed_work_units,
      in_progress: queue.in_progress_work_units,
      pending: queue.pending_work_units,
    },
  };
  c.show(data, () =>
    keyValues([
      ["workspace", id],
      ["created", when(data.created_at)],
      ["metadata", clip(JSON.stringify(data.metadata), 80)],
      [
        "peers",
        `${data.peer_count}${data.peers.length ? `  (${data.peers.slice(0, 8).join(", ")}${data.peer_count > 8 ? ", …" : ""})` : ""}`,
      ],
      [
        "sessions",
        `${data.session_count}${data.sessions.length ? `  (${data.sessions.slice(0, 8).join(", ")}${data.session_count > 8 ? ", …" : ""})` : ""}`,
      ],
      [
        "queue",
        `${data.queue.completed}/${data.queue.total} done, ${data.queue.pending} pending, ${data.queue.in_progress} running`,
      ],
    ]),
  );
};

const workspaceCreate: Handler = async (c) => {
  const id = checkId(
    "workspace",
    need(c.args[0], "workspace create needs an id: recall workspace create <workspace_id>"),
  )!;
  const metadata = jsonObject("--metadata", c.values.metadata);
  const ws = await c.call("POST", "/v3/workspaces", { body: { id, metadata } });
  c.show(ws, () => `Workspace '${ws.id}' is ready (created ${when(ws.created_at)}).`);
};

const workspaceDelete: Handler = async (c) => {
  const id = checkId(
    "workspace",
    need(c.args[0], "workspace delete needs an id: recall workspace delete <workspace_id> --yes"),
  )!;
  const wsPath = (p: string) => `/v3/workspaces/${enc(id)}${p}`;
  const sessions = (await everyItem(c, "POST", wsPath("/sessions/list"), {})).map(
    (s) => s.id as string,
  );
  if (c.values["dry-run"]) {
    c.show({ workspace: id, sessions, deleted: false }, () =>
      [
        `Would delete workspace '${id}'${sessions.length ? ` and its ${sessions.length} session(s): ${sessions.join(", ")}` : ""}.`,
        sessions.length && !c.values.cascade
          ? "It has sessions, so the real run needs --cascade."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }
  if (!c.values.yes)
    throw new UsageError(
      `deleting workspace '${id}' and everything in it is permanent: pass --yes (or --dry-run to preview)`,
    );
  if (sessions.length && !c.values.cascade) {
    throw new CliError(
      "HAS_ACTIVE_SESSIONS",
      `Workspace '${id}' still has ${sessions.length} session(s). Delete them first, or pass --cascade to delete them with it.`,
      { workspace: id, sessions },
    );
  }
  for (const s of sessions) await c.call("DELETE", wsPath(`/sessions/${enc(s)}`));
  await c.call("DELETE", wsPath(""));
  c.show(
    { workspace: id, sessions_deleted: sessions.length, deleted: true },
    () =>
      `Deleting workspace '${id}'${sessions.length ? ` (and ${sessions.length} session(s))` : ""}; the data is removed in the background.`,
  );
};

/** `--scope a --scope b` / `--scope a,b`: one scope as a string, several as a list. */
const scopeArg = (c: Ctx): string | string[] | null => {
  const scopes = idList("--scope", c.values.scope);
  return scopes.length === 0 ? null : scopes.length === 1 ? scopes[0]! : scopes;
};

const chatOutput = (c: Ctx, res: Row) => () => {
  const lines = [res.content ?? "(memory has no answer)"];
  if (res.abstained) lines.push("\n(memory abstained: it does not know)");
  if (c.values.evidence && res.evidence) {
    const ev = res.evidence as Row;
    lines.push(
      `\nEvidence: ${ev.conclusions?.length ?? 0} conclusions, ${ev.messages?.length ?? 0} messages`,
    );
  }
  return lines.join("\n");
};

const workspaceChat: Handler = async (c) => {
  const query = words(c, "workspace chat needs a question: recall workspace chat <query>");
  const res = await c.call("POST", c.ws("/chat"), {
    body: {
      query,
      session_id: flagged("--session", c.values.session) ?? null,
      scope: scopeArg(c),
      reasoning_level: c.values.reasoning ?? "low",
      include_evidence: c.values.evidence === true,
    },
  });
  c.show(res, chatOutput(c, res));
};

const searchOutput = (hits: Row[], query: string) => () =>
  hits.length
    ? table(
        ["SESSION", "PEER", "WHEN", "CONTENT"],
        hits.map((m) => [m.session_id, m.peer_id, when(m.created_at), clip(m.content, 80)]),
      )
    : `Nothing found for '${query}'.`;

const workspaceSearch: Handler = async (c) => {
  const query = words(c, "workspace search needs a query: recall workspace search <query>");
  const scopes = idList("--scope", c.values.scope);
  if (scopes.length > 1) throw new UsageError("workspace search takes one --scope");
  const hits = await c.call("POST", c.ws("/search"), {
    body: { query, limit: intOption("--limit", c.values.limit, 10, 1, 100), scope: scopes[0] },
  });
  c.show(hits, searchOutput(hits, query));
};

// ---------------------------------------------------------------------------
// peer
// ---------------------------------------------------------------------------

const peerList: Handler = async (c) => {
  const page = await c.call("POST", c.ws("/peers/list"), { query: paging(c, 50), body: {} });
  c.show(page.items, () =>
    page.items.length
      ? table(
          ["ID", "CREATED", "METADATA"],
          page.items.map((p: Row) => [
            p.id,
            when(p.created_at),
            clip(JSON.stringify(p.metadata), 50),
          ]),
        ) + pageNote(page)
      : `No peers in workspace '${c.settings.workspace}'.`,
  );
};

const peerInspect: Handler = async (c) => {
  const id = peerFor(c, c.args[0]);
  const found = await c.call("POST", c.ws("/peers/list"), {
    query: { size: 1 },
    body: { filters: { id } },
  });
  const peer: Row | undefined = found.items[0];
  if (!peer)
    throw new CliError(
      "PEER_NOT_FOUND",
      `Peer '${id}' not found in workspace '${c.settings.workspace}'.`,
      {
        peer: id,
      },
    );
  const [card, sessions, conclusions] = await Promise.all([
    c.call("GET", c.ws(`/peers/${enc(id)}/card`)),
    c.call("POST", c.ws(`/peers/${enc(id)}/sessions`), { query: { size: 1 }, body: {} }),
    c.call("POST", c.ws("/conclusions/list"), {
      query: { size: 1 },
      body: { filters: { observer_id: id, observed_id: id } },
    }),
  ]);
  const data = {
    id,
    workspace_id: c.settings.workspace,
    created_at: peer.created_at,
    metadata: peer.metadata,
    configuration: peer.configuration,
    peer_card: card.peer_card ?? null,
    session_count: sessions.total,
    conclusion_count: conclusions.total,
  };
  c.show(data, () =>
    [
      keyValues([
        ["peer", id],
        ["workspace", c.settings.workspace],
        ["created", when(data.created_at)],
        ["configuration", clip(JSON.stringify(data.configuration), 80)],
        ["sessions", String(data.session_count)],
        ["conclusions", `${data.conclusion_count} about itself`],
      ]),
      data.peer_card?.length
        ? `\nCard:\n${data.peer_card.map((l: string) => `  - ${l}`).join("\n")}`
        : "\nCard: (none yet)",
    ].join("\n"),
  );
};

const peerCard: Handler = async (c) => {
  const id = peerFor(c, c.args[0]);
  const target = flagged("--target", c.values.target);
  const res = await c.call("GET", c.ws(`/peers/${enc(id)}/card`), { query: { target } });
  const card: string[] | null = res.peer_card ?? null;
  c.show({ peer_id: id, target_id: target ?? id, peer_card: card }, () =>
    card?.length ? card.map((l) => `- ${l}`).join("\n") : `No card for '${id}' yet.`,
  );
};

const peerChat: Handler = async (c) => {
  const id = peerFor(c);
  const query = need(
    c.args.join(" ").trim() || undefined,
    "peer chat needs a question: recall peer chat <query>",
  );
  const scope = scopeArg(c);
  const sessions = c.values.sessions === undefined ? null : idList("--sessions", c.values.sessions);
  const session = flagged("--session", c.values.session) ?? null;
  if (scope && (sessions || session))
    throw new UsageError("--scope cannot be combined with --sessions or --session");
  const res = await c.call("POST", c.ws(`/peers/${enc(id)}/chat`), {
    body: {
      query,
      target: flagged("--target", c.values.target) ?? null,
      session_id: session,
      scope,
      ...(sessions ? { filters: { session_id: sessions } } : {}),
      reasoning_level: c.values.reasoning ?? "low",
      include_evidence: c.values.evidence === true,
    },
  });
  c.show(res, chatOutput(c, res));
};

const peerCreate: Handler = async (c) => {
  const id = checkId(
    "peer",
    need(c.args[0], "peer create needs an id: recall peer create <peer_id>"),
  )!;
  if (c.values["observe-me"] && c.values["no-observe-me"])
    throw new UsageError("use --observe-me or --no-observe-me, not both");
  const observe = c.values["observe-me"] ? true : c.values["no-observe-me"] ? false : undefined;
  const peer = await c.call("POST", c.ws("/peers"), {
    body: {
      id,
      metadata: jsonObject("--metadata", c.values.metadata),
      configuration: observe === undefined ? undefined : { observe_me: observe },
    },
  });
  c.show(peer, () => `Peer '${peer.id}' is ready in workspace '${c.settings.workspace}'.`);
};

const peerGetMetadata: Handler = async (c) => {
  const id = peerFor(c, c.args[0]);
  const peer = await lookup(c, "peer", id);
  c.show(peer.metadata ?? {}, () => JSON.stringify(peer.metadata ?? {}, null, 2));
};

/** `peer set-metadata <json>` (Honcho's form), `peer set-metadata <peer_id> <json>`, or `-d <json>`. */
const peerSetMetadata: Handler = async (c) => {
  const [first, second] = c.args;
  const raw = c.values.data ?? second ?? first;
  const id = peerFor(
    c,
    c.values.data !== undefined ? first : second === undefined ? undefined : first,
  );
  const metadata = need(
    jsonObject("metadata", raw),
    'peer set-metadata needs a JSON object: recall peer set-metadata \'{"plan": "pro"}\' -p <peer>',
  );
  const peer = await c.call("PUT", c.ws(`/peers/${enc(id)}`), { body: { metadata } });
  c.show(peer, () => `Replaced the metadata of peer '${id}'.`);
};

const representationText = (target: string, res: Row) => () =>
  res.representation ? String(res.representation) : `Nothing is known about '${target}' yet.`;

const peerRepresentation: Handler = async (c) => {
  const id = peerFor(c, c.args[0]);
  const opts = representationOptions(c);
  const res = await c.call("POST", c.ws(`/peers/${enc(id)}/representation`), {
    body: { ...opts, session_id: flagged("--session", c.values.session) ?? null },
  });
  c.show(
    { peer_id: id, target_id: opts.target ?? id, ...res },
    representationText(opts.target ?? id, res),
  );
};

/** Recall addition: erase a peer and everything learned from or about it (Honcho cannot). */
const peerDelete: Handler = async (c) => {
  const id = checkId(
    "peer",
    need(c.args[0], "peer delete needs an id: recall peer delete <peer_id> --yes"),
  )!;
  if (!c.values.yes)
    throw new UsageError(
      `deleting peer '${id}' erases its messages and everything memory holds about it, permanently: pass --yes`,
    );
  const res = await c.call("DELETE", c.ws(`/peers/${enc(id)}`));
  c.show(
    res,
    () =>
      `Deleted peer '${id}': ${res.messages_deleted} message(s) and ${res.conclusions_deleted} conclusion(s); summaries of ${res.sessions_affected} session(s) will be rebuilt.`,
  );
};

/** Recall addition: queue a dream (consolidation) now. Honcho's CLI has no command for it. */
const peerDream: Handler = async (c) => {
  const id = peerFor(c, c.args[0]);
  const type = c.values.type ?? "omni";
  if (type !== "omni" && type !== "card_refresh")
    throw new UsageError(`--type must be omni or card_refresh (got "${type}")`);
  const observed = flagged("--target", c.values.target) ?? id;
  await c.call("POST", c.ws("/schedule_dream"), {
    body: {
      observer: id,
      observed,
      dream_type: type,
      session_id: flagged("--session", c.values.session) ?? null,
      rebuild: c.values.rebuild === true,
    },
  });
  c.show(
    { observer: id, observed, dream_type: type, scheduled: true },
    () => `Queued a ${type} dream for ${id === observed ? id : `${id}'s view of ${observed}`}.`,
  );
};

const peerSearch: Handler = async (c) => {
  const id = peerFor(c);
  const query = need(
    c.args.join(" ").trim() || undefined,
    "peer search needs a query: recall peer search <query>",
  );
  const limit = intOption("--limit", c.values.limit, 10, 1, 100);
  const hits = await c.call("POST", c.ws(`/peers/${enc(id)}/search`), { body: { query, limit } });
  c.show(hits, () =>
    hits.length
      ? table(
          ["SESSION", "WHEN", "CONTENT"],
          hits.map((m: Row) => [m.session_id, when(m.created_at), clip(m.content, 90)]),
        )
      : `Nothing found for '${query}'.`,
  );
};

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

const sessionList: Handler = async (c) => {
  const peer = flagged("--peer", c.values.peer);
  const path = peer ? c.ws(`/peers/${enc(peer)}/sessions`) : c.ws("/sessions/list");
  const page = await c.call("POST", path, { query: paging(c, 50), body: {} });
  c.show(page.items, () =>
    page.items.length
      ? table(
          ["ID", "ACTIVE", "CREATED", "METADATA"],
          page.items.map((s: Row) => [
            s.id,
            s.is_active ? "yes" : "no",
            when(s.created_at),
            clip(JSON.stringify(s.metadata), 50),
          ]),
        ) + pageNote(page)
      : "No sessions.",
  );
};

const sessionInspect: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  const found = await c.call("POST", c.ws("/sessions/list"), {
    query: { size: 1 },
    body: { filters: { id } },
  });
  const session: Row | undefined = found.items[0];
  if (!session)
    throw new CliError(
      "SESSION_NOT_FOUND",
      `Session '${id}' not found in workspace '${c.settings.workspace}'.`,
      {
        session: id,
      },
    );
  const [peers, messages, summaries] = await Promise.all([
    c.call("GET", c.ws(`/sessions/${enc(id)}/peers`), { query: { size: 100 } }),
    c.call("POST", c.ws(`/sessions/${enc(id)}/messages/list`), { query: { size: 1 }, body: {} }),
    c.call("GET", c.ws(`/sessions/${enc(id)}/summaries`)),
  ]);
  const data = {
    id,
    workspace_id: c.settings.workspace,
    is_active: session.is_active,
    created_at: session.created_at,
    metadata: session.metadata,
    configuration: session.configuration,
    peers: peers.items.map((p: Row) => p.id),
    message_count: messages.total,
    summaries: {
      short: summaries.short_summary?.content ?? null,
      long: summaries.long_summary?.content ?? null,
    },
  };
  c.show(data, () =>
    keyValues([
      ["session", id],
      ["workspace", c.settings.workspace],
      ["created", when(data.created_at)],
      ["peers", data.peers.join(", ") || "-"],
      ["messages", String(data.message_count)],
      ["metadata", clip(JSON.stringify(data.metadata), 80)],
      ["summary", clip(data.summaries.short ?? data.summaries.long, 120)],
    ]),
  );
};

const sessionMessages: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  const peer = flagged("--peer", c.values.peer);
  const last =
    c.values.last === undefined ? undefined : intOption("--last", c.values.last, 20, 1, 100);
  const p = paging(c, 20);
  // --last N: the newest N, shown oldest first.
  const query = last ? { size: last, page: 1, reverse: true } : p;
  const page = await c.call("POST", c.ws(`/sessions/${enc(id)}/messages/list`), {
    query,
    body: peer ? { filters: { peer_id: peer } } : {},
  });
  const items: Row[] = last ? [...page.items].reverse() : page.items;
  c.show(items, () => {
    if (!items.length) return `No messages in session '${id}'.`;
    const header = c.values.ids ? ["ID", "WHEN", "PEER", "CONTENT"] : ["WHEN", "PEER", "CONTENT"];
    return (
      table(
        header,
        items.map((m) => [
          ...(c.values.ids ? [m.id] : []),
          when(m.created_at),
          m.peer_id,
          clip(m.content, 100),
        ]),
      ) + (last ? "" : pageNote(page))
    );
  });
};

const sessionContext: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  const target = flagged("--peer-target", c.values["peer-target"]) ?? c.settings.peer;
  const res = await c.call("GET", c.ws(`/sessions/${enc(id)}/context`), {
    query: {
      tokens:
        c.values.tokens === undefined
          ? undefined
          : intOption("--tokens", c.values.tokens, 0, 0, 100_000),
      summary: c.values["no-summary"] ? false : undefined,
      peer_target: target,
      search_query: c.values["search-query"],
    },
  });
  c.show(res, () => {
    const out: string[] = [];
    if (res.summary?.content) out.push(`Summary:\n  ${res.summary.content}`);
    if (res.peer_card?.length)
      out.push(`Card (${target}):\n${res.peer_card.map((l: string) => `  - ${l}`).join("\n")}`);
    if (res.peer_representation)
      out.push(
        `What is known about ${target}:\n  ${String(res.peer_representation).replace(/\n/g, "\n  ")}`,
      );
    out.push(
      res.messages?.length
        ? `Messages (${res.messages.length}):\n${(res.messages as Row[]).map((m) => `  ${m.peer_id}: ${clip(m.content, 120)}`).join("\n")}`
        : "Messages: none",
    );
    return out.join("\n\n");
  });
};

const sessionCreate: Handler = async (c) => {
  const id = checkId(
    "session",
    need(c.args[0], "session create needs an id: recall session create <session_id>"),
  )!;
  const peers = idList("--peers", c.values.peers);
  const session = await c.call("POST", c.ws("/sessions"), {
    body: {
      id,
      metadata: jsonObject("--metadata", c.values.metadata),
      peers: peers.length ? Object.fromEntries(peers.map((p) => [p, {}])) : undefined,
    },
  });
  c.show(
    session,
    () =>
      `Session '${session.id}' is ready${peers.length ? ` with ${peers.join(", ")}` : ""} in workspace '${c.settings.workspace}'.`,
  );
};

const sessionSummaries: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  const res = await c.call("GET", c.ws(`/sessions/${enc(id)}/summaries`));
  c.show(res, () => {
    const one = (label: string, s: Row | null) =>
      s
        ? `${label} (through message ${s.message_id}, ${s.token_count} tokens, ${when(s.created_at)}):\n  ${String(s.content).replace(/\n/g, "\n  ")}`
        : `${label}: none yet`;
    return [one("Short summary", res.short_summary), one("Long summary", res.long_summary)].join(
      "\n\n",
    );
  });
};

const sessionDelete: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  if (!c.values.yes)
    throw new UsageError(
      `deleting session '${id}' (its messages and what was learned from them) is permanent: pass --yes`,
    );
  await c.call("DELETE", c.ws(`/sessions/${enc(id)}`));
  c.show(
    { session: id, deleted: true },
    () => `Deleting session '${id}'; its data is removed in the background.`,
  );
};

const sessionPeers: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  const items = await everyItem(c, "GET", c.ws(`/sessions/${enc(id)}/peers`));
  c.show(items, () =>
    items.length
      ? table(
          ["ID", "METADATA"],
          items.map((p) => [p.id, clip(JSON.stringify(p.metadata), 60)]),
        )
      : `No peers in session '${id}'.`,
  );
};

const membersArgs = (c: Ctx, verb: string) => {
  const [session, ...peers] = c.args;
  if (!session || peers.length === 0)
    throw new UsageError(
      `session ${verb} needs a session and peers: recall session ${verb} <session_id> <peer_id...>`,
    );
  return { session: checkId("session", session)!, peers: peers.map((p) => checkId("peer", p)!) };
};

const sessionAddPeers: Handler = async (c) => {
  const { session, peers } = membersArgs(c, "add-peers");
  const res = await c.call("POST", c.ws(`/sessions/${enc(session)}/peers`), {
    body: Object.fromEntries(peers.map((p) => [p, {}])),
  });
  c.show(res, () => `Added ${peers.join(", ")} to session '${session}'.`);
};

const sessionRemovePeers: Handler = async (c) => {
  const { session, peers } = membersArgs(c, "remove-peers");
  const res = await c.call("DELETE", c.ws(`/sessions/${enc(session)}/peers`), { body: peers });
  c.show(res, () => `Removed ${peers.join(", ")} from session '${session}'.`);
};

/** `session search <query> [session_id]`. */
const sessionSearch: Handler = async (c) => {
  const [query, positional] = c.args;
  const q = need(
    query?.trim() || undefined,
    "session search needs a query: recall session search <query> [session_id]",
  );
  const id = sessionFor(c, positional);
  const hits = await c.call("POST", c.ws(`/sessions/${enc(id)}/search`), {
    body: { query: q, limit: intOption("--limit", c.values.limit, 10, 1, 100) },
  });
  c.show(hits, searchOutput(hits, q));
};

/** `session representation <peer_id> [session_id]`: what the peer is known for, from this session only. */
const sessionRepresentation: Handler = async (c) => {
  const [peerArg, positional] = c.args;
  const peer = peerFor(c, peerArg);
  const id = sessionFor(c, positional);
  const opts = representationOptions(c);
  const res = await c.call("POST", c.ws(`/peers/${enc(peer)}/representation`), {
    body: { ...opts, session_id: id },
  });
  c.show(
    { peer_id: peer, target_id: opts.target ?? peer, session_id: id, ...res },
    representationText(opts.target ?? peer, res),
  );
};

const sessionGetMetadata: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  const session = await lookup(c, "session", id);
  c.show(session.metadata ?? {}, () => JSON.stringify(session.metadata ?? {}, null, 2));
};

/** `session set-metadata [session_id] -d <json>` (Honcho's form); a trailing JSON argument works too. */
const sessionSetMetadata: Handler = async (c) => {
  const [first, second] = c.args;
  const inline = c.values.data === undefined && first?.trim().startsWith("{");
  const raw = c.values.data ?? (inline ? first : second);
  const id = sessionFor(c, inline ? undefined : first);
  const metadata = need(
    jsonObject("metadata", raw),
    'session set-metadata needs a JSON object: recall session set-metadata <session_id> -d \'{"topic": "x"}\'',
  );
  const session = await c.call("PUT", c.ws(`/sessions/${enc(id)}`), { body: { metadata } });
  c.show(session, () => `Replaced the metadata of session '${id}'.`);
};

const UPLOAD_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
};

/** Recall addition: `session upload <file> [session_id] -p <peer>` (PDF, text or JSON become messages). */
const sessionUpload: Handler = async (c) => {
  const [file, positional] = c.args;
  const path = need(
    file,
    "session upload needs a file: recall session upload <file> [session_id] -p <peer>",
  );
  const id = sessionFor(c, positional);
  const peer = peerFor(c);
  const { readFile } = await import("node:fs/promises");
  const { basename, extname } = await import("node:path");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${(err as Error).message}`);
  }
  const type =
    c.values["content-type"] ?? UPLOAD_TYPES[extname(path).toLowerCase()] ?? "text/plain";
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type }), basename(path));
  form.set("peer_id", peer);
  const metadata = jsonObject("--metadata", c.values.metadata);
  if (metadata) form.set("metadata", JSON.stringify(metadata));
  const created: Row[] = await c.call("POST", c.ws(`/sessions/${enc(id)}/messages/upload`), {
    form,
  });
  c.show(
    created,
    () =>
      `Added ${basename(path)} to session '${id}' as ${created.length} message(s) from ${peer}.`,
  );
};

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

const scopeFor = (c: Ctx, verb: string): string =>
  checkId(
    "scope",
    need(c.args[0], `scope ${verb} needs a scope: recall scope ${verb} <scope_id>`),
  )!;
const scopePath = (c: Ctx, scope: string, suffix = "") => c.ws(`/scopes/${enc(scope)}${suffix}`);

const scopeList: Handler = async (c) => {
  const page = await c.call("POST", c.ws("/scopes/list"), { query: paging(c, 50), body: {} });
  c.show(page.items, () =>
    page.items.length
      ? table(
          ["ID", "CREATED", "METADATA"],
          page.items.map((s: Row) => [
            s.id,
            when(s.created_at),
            clip(JSON.stringify(s.metadata), 50),
          ]),
        ) + pageNote(page)
      : `No scopes in workspace '${c.settings.workspace}'.`,
  );
};

const scopeCreate: Handler = async (c) => {
  const id = scopeFor(c, "create");
  const sessions = idList("--sessions", c.values.sessions);
  const scope = await c.call("POST", c.ws("/scopes"), {
    body: { id, metadata: jsonObject("--metadata", c.values.metadata) },
  });
  for (let i = 0; i < sessions.length; i += 100) {
    await c.call("POST", scopePath(c, id, "/sessions"), {
      body: { session_ids: sessions.slice(i, i + 100) },
    });
  }
  c.show(
    { ...scope, sessions },
    () => `Scope '${id}' is ready${sessions.length ? ` with ${sessions.length} session(s)` : ""}.`,
  );
};

const scopeInspect: Handler = async (c) => {
  const id = scopeFor(c, "inspect");
  const [scope, sessions, status] = await Promise.all([
    c.call("GET", scopePath(c, id)),
    c.call("POST", scopePath(c, id, "/sessions/list"), { query: { size: 100 }, body: {} }),
    c.call("GET", scopePath(c, id, "/status")),
  ]);
  const data = {
    ...scope,
    session_count: sessions.total,
    sessions: sessions.items.map((s: Row) => s.id),
    backfill_status: status.backfill_status,
  };
  c.show(data, () =>
    keyValues([
      ["scope", id],
      ["created", when(scope.created_at)],
      ["metadata", clip(JSON.stringify(scope.metadata), 80)],
      [
        "sessions",
        `${data.session_count}${data.sessions.length ? `  (${data.sessions.slice(0, 8).join(", ")}${data.session_count > 8 ? ", …" : ""})` : ""}`,
      ],
      [
        "backfill",
        Object.entries(status.backfill_status as Record<string, Row>)
          .map(([s, b]) => `${s}: ${b.state}`)
          .join(", ") || "-",
      ],
    ]),
  );
};

const scopeSessions: Handler = async (c) => {
  const id = scopeFor(c, "sessions");
  const page = await c.call("POST", scopePath(c, id, "/sessions/list"), {
    query: paging(c, 50),
    body: {},
  });
  c.show(page.items, () =>
    page.items.length
      ? table(
          ["ID", "CREATED"],
          page.items.map((s: Row) => [s.id, when(s.created_at)]),
        ) + pageNote(page)
      : `Scope '${id}' has no sessions.`,
  );
};

const scopeStatus: Handler = async (c) => {
  const id = scopeFor(c, "status");
  const res = await c.call("GET", scopePath(c, id, "/status"));
  const entries = Object.entries(res.backfill_status as Record<string, Row>);
  c.show(res, () =>
    entries.length
      ? table(
          ["SESSION", "STATE", "COPIED", "UPDATED"],
          entries.map(([s, b]) => [s, b.state, dash(b.docs_copied), when(b.updated_at)]),
        )
      : `Nothing has been copied into scope '${id}' yet.`,
  );
};

const scopeAddSessions: Handler = async (c) => {
  const id = scopeFor(c, "add-sessions");
  const sessions = c.args.slice(1).map((s) => checkId("session", s)!);
  if (!sessions.length)
    throw new UsageError(
      "scope add-sessions needs sessions: recall scope add-sessions <scope_id> <session_id...>",
    );
  for (let i = 0; i < sessions.length; i += 100) {
    await c.call("POST", scopePath(c, id, "/sessions"), {
      body: { session_ids: sessions.slice(i, i + 100) },
    });
  }
  c.show({ scope: id, added: sessions }, () => `Added ${sessions.join(", ")} to scope '${id}'.`);
};

const scopeRemoveSession: Handler = async (c) => {
  const id = scopeFor(c, "remove-session");
  const session = checkId(
    "session",
    need(
      c.args[1],
      "scope remove-session needs a session: recall scope remove-session <scope_id> <session_id>",
    ),
  )!;
  await c.call("DELETE", scopePath(c, id, `/sessions/${enc(session)}`));
  c.show({ scope: id, removed: session }, () => `Removed '${session}' from scope '${id}'.`);
};

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

/** `message list [session_id]`: the newest 20 by default (`--last N`), oldest first. */
const messageList: Handler = async (c) => {
  const id = sessionFor(c, c.args[0]);
  const author = flagged("--peer", c.values.peer);
  const last = intOption("--last", c.values.last, 20, 1, 100);
  const page = await c.call("POST", c.ws(`/sessions/${enc(id)}/messages/list`), {
    query: { size: last, page: 1, reverse: true },
    body: author ? { filters: { peer_id: author } } : {},
  });
  const items: Row[] = c.values.reverse ? page.items : [...page.items].reverse();
  c.show(items, () => {
    if (!items.length) return `No messages in session '${id}'.`;
    if (c.values.brief) return items.map((m) => `${m.peer_id}: ${clip(m.content, 120)}`).join("\n");
    return messageRows(items, true);
  });
};

const messageCreate: Handler = async (c) => {
  const content = words(
    c,
    "message create needs the text: recall message create <content> -p <peer>",
  );
  const peer = peerFor(c);
  const id = sessionFor(c);
  const created: Row[] = await c.call("POST", c.ws(`/sessions/${enc(id)}/messages`), {
    body: {
      messages: [{ peer_id: peer, content, metadata: jsonObject("--metadata", c.values.metadata) }],
    },
  });
  c.show(created[0], () => `Added message ${created[0]!.id} from ${peer} to session '${id}'.`);
};

const messageGet: Handler = async (c) => {
  const messageId = need(
    c.args[0],
    "message get needs an id: recall message get <message_id> -s <session>",
  );
  const id = sessionFor(c);
  const m = await c.call("GET", c.ws(`/sessions/${enc(id)}/messages/${enc(messageId)}`));
  c.show(m, () =>
    [
      keyValues([
        ["message", m.id],
        ["session", m.session_id],
        ["peer", m.peer_id],
        ["created", when(m.created_at)],
        ["tokens", String(m.token_count)],
        ["metadata", clip(JSON.stringify(m.metadata), 80)],
      ]),
      "",
      m.content,
    ].join("\n"),
  );
};

// ---------------------------------------------------------------------------
// conclusion
// ---------------------------------------------------------------------------

const pair = (c: Ctx, required: boolean) => {
  const observer = flagged("--observer", c.values.observer) ?? c.settings.peer;
  if (required && !observer)
    throw new UsageError("needs an observer: pass --observer <peer> (or -p <peer>)");
  const observed = flagged("--observed", c.values.observed) ?? observer;
  return { observer, observed };
};

const conclusionRows = (items: Row[]) =>
  table(
    ["ID", "WHO", "LEVEL", "SEEN", "CONTENT"],
    items.map((x) => [
      x.id,
      x.observer_id === x.observed_id ? x.observer_id : `${x.observer_id}>${x.observed_id}`,
      x.level,
      String(x.times_derived),
      clip(x.content, 80),
    ]),
  );

const conclusionList: Handler = async (c) => {
  const { observer, observed } = pair(c, false);
  const filters: Row = {};
  if (observer) filters.observer_id = observer;
  if (observed) filters.observed_id = observed;
  const session = flagged("--session", c.values.session);
  if (session) filters.session_id = session;
  if (c.values.level) filters.level = c.values.level;
  if (c.values["derived-from"]) filters.source_ids = { contains: c.values["derived-from"] };
  const page = await c.call("POST", c.ws("/conclusions/list"), {
    query: paging(c, 10),
    body: { filters },
  });
  c.show(page.items, () =>
    page.items.length ? conclusionRows(page.items) + pageNote(page) : "No conclusions.",
  );
};

const conclusionSearch: Handler = async (c) => {
  const { observer, observed } = pair(c, true);
  const query = need(
    c.args.join(" ").trim() || undefined,
    "conclusion search needs a query: recall conclusion search <query>",
  );
  const filters: Row = { observer_id: observer, observed_id: observed };
  if (c.values.level) filters.level = c.values.level;
  const items = await c.call("POST", c.ws("/conclusions/query"), {
    body: { query, top_k: intOption("--top-k", c.values["top-k"], 10, 1, 100), filters },
  });
  c.show(items, () => (items.length ? conclusionRows(items) : `Nothing found for '${query}'.`));
};

const conclusionCreate: Handler = async (c) => {
  const { observer, observed } = pair(c, true);
  if (!c.args.length)
    throw new UsageError("conclusion create needs the fact: recall conclusion create <content>");
  const session = flagged("--session", c.values.session);
  const created = await c.call("POST", c.ws("/conclusions"), {
    body: {
      conclusions: c.args.map((content) => ({
        content,
        observer_id: observer,
        observed_id: observed,
        session_id: session ?? null,
      })),
    },
  });
  c.show(created, () => `Saved ${created.length} conclusion(s):\n${conclusionRows(created)}`);
};

const conclusionDelete: Handler = async (c) => {
  if (!c.args.length)
    throw new UsageError("conclusion delete needs an id: recall conclusion delete <id> --yes");
  if (!c.values.yes)
    throw new UsageError(
      `deleting is permanent: pass --yes to delete ${c.args.length === 1 ? "this conclusion" : `these ${c.args.length} conclusions`}`,
    );
  const deleted: string[] = [];
  for (const id of c.args) {
    await c.call("DELETE", c.ws(`/conclusions/${enc(id)}`));
    deleted.push(id);
  }
  c.show({ deleted }, () => `Deleted ${deleted.join(", ")}`);
};

const conclusionGet: Handler = async (c) => {
  if (!c.args.length)
    throw new UsageError("conclusion get needs an id: recall conclusion get <id...>");
  const items: Row[] = [];
  for (const id of c.args) items.push(await c.call("GET", c.ws(`/conclusions/${enc(id)}`)));
  c.show(items.length === 1 ? items[0] : items, () => conclusionRows(items));
};

/** Conclusions that cite this one as a premise or source. */
const conclusionDerived: Handler = async (c) => {
  const id = need(c.args[0], "conclusion derived needs an id: recall conclusion derived <id>");
  const page = await c.call("POST", c.ws("/conclusions/list"), {
    query: paging(c, 10),
    body: { filters: { source_ids: { contains: id } } },
  });
  c.show(page.items, () =>
    page.items.length
      ? conclusionRows(page.items) + pageNote(page)
      : `Nothing has been derived from ${id}.`,
  );
};

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

const queueStatus: Handler = async (c) => {
  const wait =
    c.values.wait === undefined ? undefined : intOption("--wait", c.values.wait, 0, 0, 60_000);
  const res = await c.call("GET", c.ws("/queue/status"), {
    query: {
      session_id: flagged("--session", c.values.session),
      observer_id: flagged("--observer", c.values.observer),
      sender_id: flagged("--sender", c.values.sender),
      wait_ms: wait,
    },
  });
  c.show(res, () => {
    const lines = [
      keyValues([
        ["workspace", c.settings.workspace],
        ["work units", `${res.completed_work_units}/${res.total_work_units} done`],
        ["pending", String(res.pending_work_units)],
        ["running", String(res.in_progress_work_units)],
        ...(res.idle === undefined
          ? []
          : ([["idle", res.idle ? "yes" : "no (gave up waiting)"]] as [string, string][])),
      ]),
    ];
    const sessions = Object.values((res.sessions ?? {}) as Record<string, Row>);
    if (sessions.length) {
      lines.push(
        "",
        table(
          ["SESSION", "DONE", "PENDING", "RUNNING"],
          sessions.map((s) => [
            dash(s.session_id),
            `${s.completed_work_units}/${s.total_work_units}`,
            String(s.pending_work_units),
            String(s.in_progress_work_units),
          ]),
        ),
      );
    }
    return lines.join("\n");
  });
};

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const COMMON_HELP = `
Common options:
      --url <url>        Server (default: $RECALL_URL, ~/.recall/config.json)
      --api-key <key>    API key ($RECALL_API_KEY)
  -w, --workspace <id>   Workspace ($RECALL_WORKSPACE_ID, default "default")
      --timeout <ms>     Request timeout (default 60000)
      --json             Print JSON instead of a table (or set RECALL_JSON=1)`;

interface Group {
  name: string;
  usage: string;
  commands: Record<string, Handler>;
  aliases?: Record<string, string>;
}

const GROUPS: Record<string, Group> = {
  workspace: {
    name: "workspace",
    usage: `Usage: recall workspace <command> [options]

  list                          List workspaces (needs an unscoped key)
  create <workspace_id>         Create a workspace (--metadata <json>)
  inspect [workspace_id]        Metadata, peers, sessions and background work of a workspace
  delete <workspace_id> --yes   Delete a workspace and everything in it (--cascade deletes its
                                sessions first; --dry-run only shows what would go)
  chat <query>                  Ask a question across every peer's memory (uses a language model)
  search <query>                Search the messages of the whole workspace
  queue-status                  Same as "recall queue status"
${COMMON_HELP}
  -r, --reasoning <level>       chat: minimal|low|medium|high|max (default low)
      --scope <id>              chat: only these scopes' sessions (repeat or comma-separate);
                                search: one scope
  -s, --session <id>            chat: prefer this session
      --evidence                chat: include what the answer rests on
      --limit <n> --page <n>    list paging; search: results (default 10)`,
    commands: {
      list: workspaceList,
      create: workspaceCreate,
      inspect: workspaceInspect,
      delete: workspaceDelete,
      chat: workspaceChat,
      search: workspaceSearch,
      "queue-status": queueStatus,
    },
  },
  peer: {
    name: "peer",
    usage: `Usage: recall peer <command> [options]

  list                          Peers in the workspace
  create <peer_id>              Create a peer (--metadata <json>, --observe-me/--no-observe-me)
  inspect [peer_id]             Card, configuration, session and conclusion counts
  card [peer_id]                The peer card: the most stable facts about the person
  chat <query>                  Ask what the peer's memory knows (uses a language model)
  search <query>                Search the peer's messages
  representation [peer_id]      What memory knows about the peer, as text
  get-metadata [peer_id]        The peer's metadata
  set-metadata <json>           Replace the peer's metadata (or: set-metadata <peer_id> <json>)
  dream [peer_id]               Consolidate the peer's memory now (--type omni|card_refresh)
  delete <peer_id> --yes        Erase the peer, its messages and everything learned about it

The peer is -p <peer_id>, $RECALL_PEER_ID, or the default from "recall init".
${COMMON_HELP}
  -p, --peer <id>               Peer
      --target <id>             card, chat, representation, dream: about this other peer
  -r, --reasoning <level>       chat: minimal|low|medium|high|max (default low)
  -s, --session <id>            chat: prefer this session; representation: only this session
      --scope <id>              chat: answer from these scopes (repeat or comma-separate)
      --sessions <id>           chat: only these sessions (repeat or comma-separate)
      --evidence                chat: include what the answer rests on
      --search-query <text>     representation: focus on this topic
      --max-conclusions <n>     representation: at most this many facts (default 25)
      --rebuild                 dream --type card_refresh: rebuild the card from scratch
      --limit <n>               search: results (default 10); list: page size`,
    commands: {
      list: peerList,
      create: peerCreate,
      inspect: peerInspect,
      card: peerCard,
      chat: peerChat,
      search: peerSearch,
      representation: peerRepresentation,
      "get-metadata": peerGetMetadata,
      "set-metadata": peerSetMetadata,
      dream: peerDream,
      delete: peerDelete,
    },
  },
  session: {
    name: "session",
    usage: `Usage: recall session <command> [options]

  list                          Sessions in the workspace (-p <peer>: only that peer's)
  create <session_id>           Create a session (--peers a,b  --metadata <json>)
  inspect [session_id]          Peers, message count, summary
  messages [session_id]         The transcript (also: view)
  context [session_id]          What an agent would be given for its next prompt
  summaries [session_id]        The short and long summaries
  search <query> [session_id]   Search this session's messages
  representation <peer_id> [session_id]   What the peer is known for, from this session only
  peers [session_id]            Current members
  add-peers <session_id> <peer_id...>     Add members
  remove-peers <session_id> <peer_id...>  Remove members (their messages stay)
  get-metadata [session_id]     The session's metadata
  set-metadata [session_id] -d <json>     Replace the session's metadata
  upload <file> [session_id]    Add a PDF, text or JSON file as messages from -p <peer>
  delete [session_id] --yes     Delete the session, its messages and what was learned from them
${COMMON_HELP}
  -s, --session <id>            Session ($RECALL_SESSION_ID); or give it as an argument
  -p, --peer <id>               list: only this peer's sessions; messages: only this author;
                                upload: the author
      --last <n>                messages: the newest n, oldest first
      --size/--limit <n> --page <n> --reverse --ids     messages and list paging
      --tokens <n>              context: token budget
      --no-summary              context: leave out the summary of older turns
      --peer-target <id>        context: include what is known about this peer (default: your peer)
      --target <id> --search-query <text> --max-conclusions <n>   representation
      --content-type <type>     upload: override the type guessed from the file name`,
    commands: {
      list: sessionList,
      create: sessionCreate,
      inspect: sessionInspect,
      messages: sessionMessages,
      view: sessionMessages,
      context: sessionContext,
      summaries: sessionSummaries,
      search: sessionSearch,
      representation: sessionRepresentation,
      peers: sessionPeers,
      "add-peers": sessionAddPeers,
      "remove-peers": sessionRemovePeers,
      "get-metadata": sessionGetMetadata,
      "set-metadata": sessionSetMetadata,
      upload: sessionUpload,
      delete: sessionDelete,
    },
  },
  scope: {
    name: "scope",
    usage: `Usage: recall scope <command> [options]

A scope is a named set of sessions with its own memory of the peers in them.

  list                                  Scopes in the workspace
  create <scope_id>                     Create a scope (--sessions a,b  --metadata <json>)
  inspect <scope_id>                    Metadata, sessions and copy progress
  sessions <scope_id>                   Its sessions
  status <scope_id>                     Progress of copying each session's memory into it
  add-sessions <scope_id> <session_id...>
  remove-session <scope_id> <session_id>
${COMMON_HELP}
      --limit <n> --page <n>            list and sessions paging`,
    commands: {
      list: scopeList,
      create: scopeCreate,
      inspect: scopeInspect,
      sessions: scopeSessions,
      status: scopeStatus,
      "add-sessions": scopeAddSessions,
      "remove-session": scopeRemoveSession,
    },
  },
  message: {
    name: "message",
    usage: `Usage: recall message <command> [options]

  list [session_id]             The newest messages (default 20), oldest first
  create <content>              Add a message from -p <peer> to -s <session>
  get <message_id>              One message of -s <session>
${COMMON_HELP}
  -s, --session <id>            Session ($RECALL_SESSION_ID); list also takes it as an argument
  -p, --peer <id>               create: the author; list: only this author
      --last <n>                list: how many (default 20)
      --reverse                 list: newest first
      --brief                   list: one "peer: text" line each
      --metadata <json>         create: message metadata`,
    commands: { list: messageList, create: messageCreate, get: messageGet },
  },
  conclusion: {
    name: "conclusion",
    usage: `Usage: recall conclusion <command> [options]

  list                          Facts memory holds, newest first
  search <query>                Facts that best match a query
  get <id...>                   Fetch conclusions by id
  derived <id>                  Conclusions drawn from this one
  create <content...>           Save facts you know to be true
  delete <id...> --yes          Permanently remove conclusions
${COMMON_HELP}
      --observer <id>           Whose memory (default: -p / your peer)
      --observed <id>           About whom (default: the observer)
      --level <level>           explicit|deductive|inductive|contradiction
      --derived-from <id>       list: only conclusions drawn from this one
  -s, --session <id>            list, create: only/file under this session
      --limit <n> --page <n>    list and derived paging (default 10)   --top-k <n>  search results
  -y, --yes                     delete: confirm`,
    commands: {
      list: conclusionList,
      search: conclusionSearch,
      get: conclusionGet,
      derived: conclusionDerived,
      create: conclusionCreate,
      delete: conclusionDelete,
    },
  },
  queue: {
    name: "queue",
    usage: `Usage: recall queue status [options]

Shows how much background work (learning from messages, summaries, dreams) is
pending, running or done.
${COMMON_HELP}
  -s, --session <id>         Only this session
      --observer <id> --sender <id>   Only work involving these peers
      --wait <ms>            Wait up to this long for processing to finish`,
    commands: { status: queueStatus },
  },
};

export async function runGroup(group: string, args: string[], io: CliIo): Promise<number> {
  const def = GROUPS[group]!;
  const { values, positionals } = parseWithPositionals(args, OPTIONS);
  const [sub, ...rest] = positionals;
  if (values.help || !sub || sub === "help") {
    io.out(def.usage);
    return values.help || sub === "help" ? 0 : 2;
  }
  const handler = def.commands[sub];
  if (!handler) {
    throw new UsageError(
      `unknown subcommand "${sub}" (use ${Object.keys(def.commands).join(" | ")})`,
    );
  }
  const json = wantsJson(values.json, io.env);
  const settings = resolveSettings(io.env, {
    url: values.url,
    apiKey: values["api-key"],
    workspace: checkId("--workspace", values.workspace),
    peer: checkId("--peer", values.peer),
    session: checkId("--session", values.session),
  });
  const api = createApi(settings, io, intOption("--timeout", values.timeout, 60_000, 1, 3_600_000));
  await handler({
    io,
    settings,
    json,
    values,
    args: rest,
    call: api.call,
    ws: api.ws,
    show: (data, human) => io.out(json ? JSON.stringify(data, null, 2) : human()),
  });
  return 0;
}
