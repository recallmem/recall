import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getBillingRow } from "../../billing/ledger.js";
import { scheduleManualDream } from "../../consolidate/index.js";
import type { AppContext } from "../../context.js";
import { getAccount } from "../../core/accounts.js";
import { createConclusions, deleteConclusion, storeConclusions } from "../../core/conclusions.js";
import { deletePeer, setPeerCard } from "../../core/peers.js";
import { newName } from "../../core/schemas.js";
import { wsKey } from "../../core/tenancy.js";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  MAX_WEBHOOK_ENDPOINTS,
  sendTestWebhook,
} from "../../core/webhooks.js";
import { ensureWorkspace } from "../../core/workspaces.js";
import { ApiError } from "../../lib/errors.js";
import { answerCache } from "../../recall/cache.js";
import type { ChatLevel } from "../../recall/prompts.js";
import { CONTEXT_MAX_TOKENS } from "../../recall/session-context.js";
import { retryFailed } from "../routes/queue.js";
import {
  type AskOutcome,
  accountWorkspace,
  ask,
  type ContextParams,
  cardSources,
  contextPreview,
  type FactQuery,
  factsByIds,
  nightShiftPairs,
  type PeerView,
  peerFacts,
  peerList,
  peerNames,
  peerSessions,
  peerView,
  sessionList,
  sessionView,
  supersedeFact,
  transcript,
  type WsHandle,
  webhookEndpoints,
  workspaceList,
  workspaceNames,
  workspaceQueue,
  workspaceStats,
} from "./explorer.js";
import { clip, setFlash, takeFlash } from "./flash.js";
import * as mv from "./memory-views.js";
import { withQuery } from "./memory-views.js";
import { dashPath } from "./paths.js";
import type { DashEnv, DashState } from "./session.js";
import * as v from "./views.js";

/**
 * The memory explorer (<base>/memory) and the playground (<base>/playground).
 *
 * Anyone signed in can browse, and ask a question (billed exactly like the chat
 * API, through the same code path). Owners and admins can also create a workspace
 * and edit memory: add, correct and delete facts, edit a peer card, forget a peer
 * (each through the API's own functions), retry failed background work, run the
 * night shift and manage a workspace's webhook endpoints. Every edit redirects
 * afterwards (post, redirect, get), so a reload never repeats it.
 * Every workspace is resolved inside the signed-in account (`accountWorkspace`),
 * so another account's workspace, peer or session answers 404 whatever the URL.
 */

type C = Context<DashEnv>;
type Render = (
  c: C,
  status: number,
  opts: Omit<Parameters<typeof v.page>[0], "dash">,
) => Response | Promise<Response>;

const LEVELS: ChatLevel[] = ["minimal", "low", "medium", "high", "max"];
const MANAGE_ROLES = new Set(["owner", "admin"]);
const PEER_FLASHES = [
  "fact_deleted",
  "fact_corrected",
  "fact_added",
  "card_saved",
  "card_line_removed",
] as const;
/** Longest fact typed in the dashboard (the API takes longer ones). */
const FACT_MAX = 2000;
/** The API's peer card limits (PUT …/peers/{id}/card). */
const CARD_MAX_ENTRIES = 500;
const CARD_ENTRY_MAX = 4000;
/** Test deliveries a workspace may queue a minute (as GET …/webhooks/test allows). */
const TESTS_PER_MIN = 6;
/** Night shifts a workspace may start a minute from the dashboard. */
const NIGHT_SHIFTS_PER_MIN = 2;

const intParam = (v: string | undefined, fallback: number) => {
  const x = Number.parseInt(v ?? "", 10);
  return Number.isFinite(x) && x > 0 ? x : fallback;
};
const nonce = () => randomBytes(12).toString("base64url");
const cleanNonce = (v: string | undefined) => (v && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);

export function registerMemory(
  app: Hono<DashEnv>,
  ctx: AppContext,
  h: { render: Render; base: (c: C) => string; notFound: (c: C) => Response | Promise<Response> },
): void {
  const { render } = h;
  const secret = ctx.config.hosted.sessionSecret;

  /** Signed-in user, or null (GET pages redirect to the login). */
  const signedIn = (c: C): DashState | null => c.get("dash");
  const requireUser = (c: C): DashState => {
    const dash = c.get("dash");
    if (!dash) throw new ApiError(401, "Sign in first");
    return dash;
  };
  const toLogin = (c: C) => c.redirect(dashPath("/login"), 303);

  /** Chat prices for this account, or null when it is not billed. */
  const pricesFor = async (accountId: string): Promise<Record<string, number> | null> =>
    ctx.billing.enabled && (await getBillingRow(ctx.db, accountId))
      ? ctx.config.hosted.billing.prices.chatMicros
      : null;

  const readAsk = (c: C, peer: string) => {
    const f = c.get("form");
    const query = (f.query ?? "").trim();
    if (!query) throw new ApiError(422, "Type a question first");
    if (query.length > 10_000)
      throw new ApiError(422, "The question is too long (10,000 characters at most)");
    const level = (f.level ?? "low") as ChatLevel;
    if (!LEVELS.includes(level)) throw new ApiError(422, "Unknown reasoning level");
    return {
      peer,
      perspective: f.perspective?.trim() || null,
      query,
      level,
      nonce: cleanNonce(f.nonce),
    };
  };

  // ---- workspaces ----------------------------------------------------------
  app.get("/memory", async (c) => {
    const dash = signedIn(c);
    if (!dash) return toLogin(c);
    return render(c, 200, {
      title: "Memory",
      active: "/memory",
      body: mv.memoryIndexPage({
        csrf: dash.csrf,
        canCreate: MANAGE_ROLES.has(dash.role),
        base: h.base(c),
        list: await workspaceList(ctx, dash.accountId, intParam(c.req.query("page"), 1)),
      }),
    });
  });

  app.post("/memory", async (c) => {
    const dash = requireUser(c);
    if (!MANAGE_ROLES.has(dash.role))
      throw new ApiError(403, "Your role cannot change this account");
    const name = (c.get("form").name ?? "").trim();
    const parsed = newName.safeParse(name);
    if (!parsed.success)
      return render(c, 422, {
        title: "Memory",
        active: "/memory",
        error: "Workspace ids use letters, digits, - and _ (up to 100 characters).",
        body: mv.memoryIndexPage({
          csrf: dash.csrf,
          canCreate: true,
          base: h.base(c),
          list: await workspaceList(ctx, dash.accountId, 1),
          name,
        }),
      });
    await ensureWorkspace(ctx.db, wsKey(dash.accountId, parsed.data));
    return c.redirect(mv.wsHref(parsed.data), 303);
  });

  const workspace = async (
    c: C,
    dash: DashState,
    tab: "peers" | "sessions" | "webhooks",
    sent: { status?: number; error?: string; url?: string } = {},
  ) => {
    const ws = await accountWorkspace(ctx, dash.accountId, c.req.param("ws") ?? "");
    const page = intParam(c.req.query("page"), 1);
    const manage = MANAGE_ROLES.has(dash.role);
    const msg = c.req.query("msg");
    // What the action that redirected here did (forgetting a peer, a test delivery): shown once.
    const flash =
      c.req.method === "GET"
        ? takeFlash(c, secret, dash.sessionId, ["peer_forgotten", "webhook_test"])
        : null;
    const endpoints = await webhookEndpoints(ctx, ws);
    const account =
      tab === "webhooks" && manage
        ? await getAccount(ctx.db, dash.accountId, { secrets: true })
        : null;
    return render(c, sent.status ?? 200, {
      title: ws.name,
      active: "/memory",
      notice: v.notice(msg),
      error: sent.error,
      body: mv.workspacePage({
        ws: await workspaceStats(ctx, ws),
        tab,
        queue: await workspaceQueue(ctx, ws),
        actions: manage ? { csrf: dash.csrf, dreams: ctx.config.features.dreams } : null,
        webhookCount: endpoints.length,
        ...(tab === "peers"
          ? { peers: await peerList(ctx, ws, page) }
          : tab === "sessions"
            ? { sessions: await sessionList(ctx, ws, page) }
            : {
                webhooks: {
                  csrf: dash.csrf,
                  canManage: manage,
                  enabled: ctx.config.features.webhooks,
                  endpoints,
                  max: MAX_WEBHOOK_ENDPOINTS,
                  url: sent.url,
                  tested: flash?.kind === "webhook_test" ? flash.endpoints : null,
                },
              }),
        forgotten: flash?.kind === "peer_forgotten" ? flash : null,
        extra:
          tab === "webhooks"
            ? v.webhookSecretCard({
                secret: account?.webhook_secret ?? null,
                rotated: msg === "secret_rotated",
                canManage: manage,
                rotateHref: withQuery(dashPath("/settings/rotate-webhook-secret"), {
                  next: `ws:${ws.name}`,
                }),
              })
            : undefined,
      }),
    });
  };

  app.get("/memory/:ws", async (c) => {
    const dash = signedIn(c);
    return dash ? workspace(c, dash, "peers") : toLogin(c);
  });
  app.get("/memory/:ws/sessions", async (c) => {
    const dash = signedIn(c);
    return dash ? workspace(c, dash, "sessions") : toLogin(c);
  });
  app.get("/memory/:ws/webhooks", async (c) => {
    const dash = signedIn(c);
    return dash ? workspace(c, dash, "webhooks") : toLogin(c);
  });

  // ---- peer ----------------------------------------------------------------
  const peerPage = async (
    c: C,
    dash: DashState,
    ws: WsHandle,
    peerName: string,
    asked: { outcome: AskOutcome } | null,
  ) => {
    const peer = await peerView(ctx, ws, peerName);
    // Default view: the peer's own memory when it has one, else every observer's.
    const observer = c.req.query("observer")?.trim();
    const fq: FactQuery = {
      state: c.req.query("state") === "all" ? "all" : "current",
      q: (c.req.query("q") ?? "").trim().slice(0, 200),
      observer: observer === "*" ? null : observer || (peer.totals.self > 0 ? peer.name : null),
      page: intParam(c.req.query("page"), 1),
    };
    const prices = await pricesFor(dash.accountId);
    const input = asked?.outcome.input;
    // An edit that redirected here: what it did, shown once.
    const flash = asked ? null : takeFlash(c, secret, dash.sessionId, PEER_FLASHES);
    return render(c, asked?.outcome.error ? asked.outcome.error.status : 200, {
      title: peer.name,
      active: "/memory",
      body: mv.peerPage({
        ws: ws.name,
        peer,
        fq,
        facts: await peerFacts(ctx, ws, peer, fq),
        sessions: await peerSessions(ctx, ws, peer.name),
        prices,
        outcome: asked?.outcome ?? null,
        edit: MANAGE_ROLES.has(dash.role) ? { csrf: dash.csrf } : null,
        flash,
        ask: {
          csrf: dash.csrf,
          nonce: nonce(),
          action: `${mv.peerHref(ws.name, peer.name)}/ask#answer`,
          hidden: {},
          peer: peer.name,
          observers: [peer.name, ...peer.observers],
          query: input?.query ?? "",
          level: input?.level ?? "low",
          perspective: input?.perspective ?? null,
          prices,
        },
      }),
    });
  };

  app.get("/memory/:ws/peers/:peer", async (c) => {
    const dash = signedIn(c);
    if (!dash) return toLogin(c);
    const ws = await accountWorkspace(ctx, dash.accountId, c.req.param("ws"));
    return peerPage(c, dash, ws, c.req.param("peer"), null);
  });

  app.post("/memory/:ws/peers/:peer/ask", async (c) => {
    const dash = requireUser(c);
    const ws = await accountWorkspace(ctx, dash.accountId, c.req.param("ws"));
    const outcome = await ask(ctx, ws, dash.accountId, readAsk(c, c.req.param("peer")));
    return peerPage(c, dash, ws, c.req.param("peer"), { outcome });
  });

  // ---- editing memory (owners and admins) --------------------------------------
  // Every edit goes through the API's own functions (POST and DELETE conclusions, PUT card,
  // DELETE peer), then redirects: reloading the page never repeats it.

  /** The signed-in owner or admin and the workspace in the URL (of their account). */
  const manageWs = async (c: C) => {
    const dash = requireUser(c);
    if (!MANAGE_ROLES.has(dash.role))
      throw new ApiError(403, "Your role cannot change this account");
    return { dash, ws: await accountWorkspace(ctx, dash.accountId, c.req.param("ws") ?? "") };
  };
  /** The peer page, on the view a fact belongs to. */
  const factsOf = (ws: string, peer: string, observer: string, state?: "all") =>
    withQuery(mv.peerHref(ws, peer), { observer, state }, "#facts");
  /** A fact about this peer in this workspace, or 404. */
  const peerFact = async (ws: WsHandle, peer: string, id: string) => {
    const fact = (await factsByIds(ctx, ws, [id])).get(id);
    if (!fact || fact.observedName !== peer) throw new ApiError(404, "Fact not found");
    return fact;
  };
  const factText = (raw: string | undefined) => {
    const text = (raw ?? "").trim();
    if (!text) throw new ApiError(422, "Write the fact first.");
    if (text.length > FACT_MAX) throw new ApiError(422, "A fact is at most 2,000 characters.");
    return text;
  };

  app.post("/memory/:ws/peers/:peer/facts", async (c) => {
    const { dash, ws } = await manageWs(c);
    const peer = await peerView(ctx, ws, c.req.param("peer"));
    const f = c.get("form");
    const content = factText(f.content);
    const observer = f.observer?.trim() || peer.name;
    if (observer !== peer.name && !peer.observers.includes(observer))
      throw new ApiError(422, "Pick whose memory the fact goes into.");
    await createConclusions(ctx, ws.key, [
      { content, observer_id: observer, observed_id: peer.name },
    ]);
    setFlash(c, secret, dash.sessionId, { kind: "fact_added", text: clip(content), observer });
    return c.redirect(factsOf(ws.name, peer.name, observer), 303);
  });

  app.post("/memory/:ws/peers/:peer/facts/:id/delete", async (c) => {
    const { dash, ws } = await manageWs(c);
    const peer = c.req.param("peer");
    const fact = await peerFact(ws, peer, c.req.param("id"));
    if (c.get("form").confirm !== "1") throw new ApiError(422, "Confirm the deletion first.");
    await deleteConclusion(ctx, ws.key, fact.id);
    setFlash(c, secret, dash.sessionId, {
      kind: "fact_deleted",
      text: clip(fact.content),
      observer: fact.observerName,
    });
    return c.redirect(
      factsOf(ws.name, peer, fact.observerName, fact.validTo ? "all" : undefined),
      303,
    );
  });

  app.post("/memory/:ws/peers/:peer/facts/:id/correct", async (c) => {
    const { dash, ws } = await manageWs(c);
    const peer = c.req.param("peer");
    const fact = await peerFact(ws, peer, c.req.param("id"));
    if (fact.validTo)
      throw new ApiError(422, "Only a current fact can be corrected; this one is already history.");
    const content = factText(c.get("form").content);
    const back = factsOf(ws.name, peer, fact.observerName);
    if (content === fact.content.trim()) return c.redirect(back, 303);
    // The correction is a new explicit fact in the same view (or the same fact already stored
    // there); the old one becomes its history.
    const [stored] = await storeConclusions(
      ctx,
      ws.key,
      [{ content, observer_id: fact.observerName, observed_id: peer }],
      { ignore: [fact.id] },
    );
    const created = stored!.conclusion;
    if (!(await supersedeFact(ctx, ws, fact.id, created.id))) {
      // Changed meanwhile (corrected or deleted elsewhere): do not leave a second version.
      if (!stored!.existing) await deleteConclusion(ctx, ws.key, created.id);
      throw new ApiError(
        409,
        "This fact changed while you were editing it. Reload the page and try again.",
      );
    }
    setFlash(c, secret, dash.sessionId, {
      kind: "fact_corrected",
      before: clip(fact.content),
      after: clip(content),
    });
    return c.redirect(back, 303);
  });

  app.post("/memory/:ws/peers/:peer/card", async (c) => {
    const { dash, ws } = await manageWs(c);
    const peer = await peerView(ctx, ws, c.req.param("peer"));
    if (peer.isScope) throw new ApiError(422, "A scope has no peer card.");
    const lines = (c.get("form").card ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > CARD_MAX_ENTRIES)
      throw new ApiError(422, `A peer card holds at most ${CARD_MAX_ENTRIES} entries.`);
    if (lines.some((l) => l.length > CARD_ENTRY_MAX))
      throw new ApiError(422, `Each card entry is at most ${CARD_ENTRY_MAX} characters.`);
    await setPeerCard(ctx, ws.key, peer.name, undefined, lines);
    setFlash(c, secret, dash.sessionId, { kind: "card_saved", entries: lines.length });
    return c.redirect(mv.peerHref(ws.name, peer.name), 303);
  });

  // One card line out, with the facts it rests on that the person ticked: deleting those facts
  // keeps the night shift's card refresh from writing the line back.
  app.post("/memory/:ws/peers/:peer/card/remove", async (c) => {
    const { dash, ws } = await manageWs(c);
    const peer = await peerView(ctx, ws, c.req.param("peer"));
    if (peer.isScope) throw new ApiError(422, "A scope has no peer card.");
    const form = c.get("form");
    const entry = (form.entry ?? "").trim();
    const card = peer.card ?? [];
    if (!entry || !card.includes(entry))
      throw new ApiError(409, "This line is no longer on the card. Reload the page and try again.");
    // Only facts listed under this line can be deleted from here.
    const [src] = await cardSources(ctx, ws, peer.internalId, peer.name, [entry]);
    const chosen = (src?.facts ?? []).filter((f) => form[`fact_${f.id}`] === "1");
    await setPeerCard(
      ctx,
      ws.key,
      peer.name,
      undefined,
      card.filter((l) => l !== entry),
    );
    for (const f of chosen) await deleteConclusion(ctx, ws.key, f.id);
    ctx.log.info(
      { workspace: ws.name, peer: peer.name, facts: chosen.length },
      "peer card line removed",
    );
    setFlash(c, secret, dash.sessionId, {
      kind: "card_line_removed",
      entry: clip(entry),
      facts: chosen.length,
    });
    return c.redirect(mv.peerHref(ws.name, peer.name), 303);
  });

  const forgetPage = (c: C, dash: DashState, ws: WsHandle, peer: PeerView, error?: string) =>
    render(c, error ? 422 : 200, {
      title: `Forget ${peer.name}`,
      active: "/memory",
      error,
      body: mv.forgetPeerPage({ csrf: dash.csrf, ws: ws.name, peer }),
    });

  app.get("/memory/:ws/peers/:peer/forget", async (c) => {
    if (!signedIn(c)) return toLogin(c);
    const { dash, ws } = await manageWs(c);
    const peer = await peerView(ctx, ws, c.req.param("peer"));
    if (peer.isScope) throw new ApiError(422, "A scope is not a person and cannot be forgotten.");
    return forgetPage(c, dash, ws, peer);
  });

  app.post("/memory/:ws/peers/:peer/forget", async (c) => {
    const { dash, ws } = await manageWs(c);
    const peer = await peerView(ctx, ws, c.req.param("peer"));
    const f = c.get("form");
    if (f.confirm !== "1") return forgetPage(c, dash, ws, peer);
    if ((f.confirm_text ?? "").trim() !== peer.name)
      return forgetPage(
        c,
        dash,
        ws,
        peer,
        `Type the peer id “${peer.name}” exactly to confirm. Nothing was deleted.`,
      );
    const result = await deletePeer(ctx, ws.key, peer.name);
    // Cached answers may quote the peer (as DELETE …/peers/{id} does).
    answerCache(ctx).clear();
    ctx.log.info(
      { account: dash.accountId, messages: result.messages_deleted },
      "peer forgotten from the dashboard",
    );
    setFlash(c, secret, dash.sessionId, {
      kind: "peer_forgotten",
      peer: peer.name,
      messages: result.messages_deleted,
      facts: result.conclusions_deleted,
      sessions: result.sessions_affected,
    });
    return c.redirect(mv.wsHref(ws.name), 303);
  });

  // ---- background work: retry failures, run the night shift ----------------------
  app.post("/memory/:ws/queue/retry", async (c) => {
    const { ws } = await manageWs(c);
    const retried = await retryFailed(ctx, ws.id);
    return c.redirect(
      withQuery(mv.wsHref(ws.name), { msg: retried ? "retried" : "retried_none" }),
      303,
    );
  });

  app.post("/memory/:ws/night-shift", async (c) => {
    const { ws } = await manageWs(c);
    if (!ctx.config.features.dreams)
      throw new ApiError(400, "The night shift is not enabled on this server.");
    if (ctx.tenancy.limiter.take(`night-shift:${ws.id}`, NIGHT_SHIFTS_PER_MIN) > 0)
      throw new ApiError(429, "The night shift was just started here. Try again in a minute.");
    const pairs = await nightShiftPairs(ctx, ws);
    for (const p of pairs)
      await scheduleManualDream(ctx, {
        workspaceId: ws.id,
        observer: p.observer,
        observed: p.observed,
        type: "omni",
        sessionName: null,
        rebuild: false,
      });
    return c.redirect(
      withQuery(mv.wsHref(ws.name), { msg: pairs.length ? "night_shift" : "night_shift_none" }),
      303,
    );
  });

  // ---- webhooks --------------------------------------------------------------
  const webhooksHref = (ws: string) => `${mv.wsHref(ws)}/webhooks`;

  app.post("/memory/:ws/webhooks", async (c) => {
    const { dash, ws } = await manageWs(c);
    const url = (c.get("form").url ?? "").trim().slice(0, 4000);
    try {
      await createWebhookEndpoint(ctx, ws.key, url);
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 422 && err.status !== 409)) throw err;
      return workspace(c, dash, "webhooks", { status: err.status, error: err.detail, url });
    }
    return c.redirect(withQuery(webhooksHref(ws.name), { msg: "webhook_added" }), 303);
  });

  app.post("/memory/:ws/webhooks/test", async (c) => {
    const { dash, ws } = await manageWs(c);
    // The same allowance as GET …/webhooks/test: each test queues a delivery per endpoint.
    if (ctx.tenancy.limiter.take(`webhook-test:${JSON.stringify(ws.key)}`, TESTS_PER_MIN) > 0)
      throw new ApiError(
        429,
        `At most ${TESTS_PER_MIN} test deliveries a minute per workspace. Try again shortly.`,
      );
    const endpoints = (await webhookEndpoints(ctx, ws)).length;
    await sendTestWebhook(ctx, ws.key);
    setFlash(c, secret, dash.sessionId, { kind: "webhook_test", endpoints });
    return c.redirect(`${webhooksHref(ws.name)}#webhooks`, 303);
  });

  app.post("/memory/:ws/webhooks/:endpoint/delete", async (c) => {
    const { ws } = await manageWs(c);
    if (c.get("form").confirm !== "1") throw new ApiError(422, "Confirm the deletion first.");
    await deleteWebhookEndpoint(ctx, ws.key, c.req.param("endpoint"));
    return c.redirect(withQuery(webhooksHref(ws.name), { msg: "webhook_deleted" }), 303);
  });

  // ---- session -------------------------------------------------------------
  app.get("/memory/:ws/sessions/:session", async (c) => {
    const dash = signedIn(c);
    if (!dash) return toLogin(c);
    const ws = await accountWorkspace(ctx, dash.accountId, c.req.param("ws"));
    const s = await sessionView(ctx, ws, c.req.param("session"));
    const page = c.req.query("page");
    const t = await transcript(ctx, ws, s, {
      page: page ? intParam(page, 1) : null,
      at: c.req.query("at")?.slice(0, 100) || null,
    });
    const previewing = c.req.query("preview") === "1";
    const target = c.req.query("peer_target")?.trim() || null;
    const params: ContextParams = {
      tokens: Math.min(intParam(c.req.query("tokens"), 2000), CONTEXT_MAX_TOKENS),
      peerTarget: target && s.peers.includes(target) ? target : null,
      summary: previewing ? c.req.query("summary") === "1" : true,
    };
    let ctxResult: Parameters<typeof mv.sessionPage>[0]["ctxResult"] = null;
    if (previewing) {
      try {
        ctxResult = {
          result: await contextPreview(ctx, ws, s, params, dash.accountId),
          error: null,
        };
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        ctxResult = { result: null, error: err.detail };
      }
    }
    return render(c, 200, {
      title: s.name,
      active: "/memory",
      body: mv.sessionPage({ ws: ws.name, s, transcript: t, ctxParams: params, ctxResult }),
    });
  });

  // ---- playground ----------------------------------------------------------
  const playground = async (
    c: C,
    dash: DashState,
    chosen: { ws?: string; peer?: string },
    outcome: AskOutcome | null,
  ) => {
    const names = await workspaceNames(ctx, dash.accountId);
    const prices = await pricesFor(dash.accountId);
    const wsName = chosen.ws && names.includes(chosen.ws) ? chosen.ws : (names[0] ?? null);
    let peers: string[] = [];
    let peer: string | null = null;
    let observers: string[] = [];
    if (wsName) {
      const ws = await accountWorkspace(ctx, dash.accountId, wsName);
      peers = await peerNames(ctx, ws);
      peer = chosen.peer && peers.includes(chosen.peer) ? chosen.peer : (peers[0] ?? null);
      if (chosen.peer && chosen.peer !== peer && outcome) peer = chosen.peer;
      if (peer) observers = [peer, ...(await peerView(ctx, ws, peer)).observers];
    }
    const input = outcome?.input;
    return render(c, outcome?.error ? outcome.error.status : 200, {
      title: "Playground",
      active: "/playground",
      body: mv.playgroundPage({
        base: h.base(c),
        workspaces: names,
        ws: wsName,
        peers,
        peer,
        prices,
        outcome,
        ask:
          wsName && peer
            ? {
                csrf: dash.csrf,
                nonce: nonce(),
                action: dashPath("/playground#answer"),
                hidden: { ws: wsName, peer },
                peer,
                observers,
                query: input?.query ?? "",
                level: input?.level ?? "low",
                perspective: input?.perspective ?? null,
                prices,
              }
            : null,
      }),
    });
  };

  app.get("/playground", async (c) => {
    const dash = signedIn(c);
    if (!dash) return toLogin(c);
    return playground(c, dash, { ws: c.req.query("ws"), peer: c.req.query("peer") }, null);
  });

  app.post("/playground", async (c) => {
    const dash = requireUser(c);
    const f = c.get("form");
    const ws = await accountWorkspace(ctx, dash.accountId, f.ws ?? "");
    const outcome = await ask(ctx, ws, dash.accountId, readAsk(c, f.peer ?? ""));
    return playground(c, dash, { ws: ws.name, peer: f.peer }, outcome);
  });
}
