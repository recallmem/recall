import { createHmac, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { pino } from "pino";
import Stripe from "stripe";
import { vi } from "vitest";
import { hostedConfig, loadConfig } from "../src/config.js";
import { type AppContext, createContext } from "../src/context.js";
import { type App, createApp } from "../src/http/app.js";
import { LogMailer } from "../src/lib/mailer.js";

/**
 * A hosted-mode test server: auth on, operator token, dashboard, and (unless
 * `billing: false`) prepaid billing with a real Stripe SDK instance whose API
 * methods are mocked (`stripe` below). Hosted mode normally insists on an
 * external Postgres; tests switch it on after config validation so they also
 * run on embedded PGlite. With RECALL_TEST_DATABASE_URL they use Postgres.
 */

export const ADMIN = "operator-token-0123456789abcdef";
export const WHSEC = "whsec_test_secret_for_recall";
export const PUBLIC_URL = "https://recall.test";
export const ORIGIN = PUBLIC_URL;

// biome-ignore lint/suspicious/noExplicitAny: loosely typed mocks
type Fn = (...args: any[]) => any;

export interface StripeMocks {
  customersCreate: ReturnType<typeof vi.fn<Fn>>;
  customersUpdate: ReturnType<typeof vi.fn<Fn>>;
  customersDel: ReturnType<typeof vi.fn<Fn>>;
  checkoutCreate: ReturnType<typeof vi.fn<Fn>>;
  portalCreate: ReturnType<typeof vi.fn<Fn>>;
  piCreate: ReturnType<typeof vi.fn<Fn>>;
  piRetrieve: ReturnType<typeof vi.fn<Fn>>;
  invoicesList: ReturnType<typeof vi.fn<Fn>>;
  invoicesCreate: ReturnType<typeof vi.fn<Fn>>;
  invoiceItemsCreate: ReturnType<typeof vi.fn<Fn>>;
  invoicesFinalize: ReturnType<typeof vi.fn<Fn>>;
  invoicesPay: ReturnType<typeof vi.fn<Fn>>;
  invoicesVoid: ReturnType<typeof vi.fn<Fn>>;
  invoicesDel: ReturnType<typeof vi.fn<Fn>>;
  invoicePaymentsList: ReturnType<typeof vi.fn<Fn>>;
  chargesRetrieve: ReturnType<typeof vi.fn<Fn>>;
}

/** A real Stripe client with every network-calling method we use replaced. */
export function mockStripe(): { stripe: Stripe; mocks: StripeMocks } {
  const stripe = new Stripe("sk_test_recall_dummy");
  let n = 0;
  const mocks: StripeMocks = {
    customersCreate: vi.fn<Fn>(async () => ({ id: `cus_test_${++n}`, object: "customer" })),
    customersUpdate: vi.fn<Fn>(async (id: string) => ({ id, object: "customer" })),
    customersDel: vi.fn<Fn>(async (id: string) => ({ id, deleted: true })),
    checkoutCreate: vi.fn<Fn>(async () => ({
      id: `cs_test_${++n}`,
      url: `https://checkout.stripe.com/c/pay/cs_test_${n}`,
    })),
    portalCreate: vi.fn<Fn>(async () => ({ url: "https://billing.stripe.com/p/session/test_1" })),
    piCreate: vi.fn<Fn>(async (p: { amount: number }) => ({
      id: `pi_auto_${++n}`,
      status: "succeeded",
      amount: p.amount,
      amount_received: p.amount,
    })),
    // Expanded, as Recall asks for it: a card saved to the customer for auto top-up.
    piRetrieve: vi.fn<Fn>(async (id: string) => ({
      id,
      payment_method: { id: "pm_card_visa", type: "card", customer: "cus_test" },
    })),
    invoicesList: vi.fn<Fn>(async () => ({ data: [] })),
    invoicesCreate: vi.fn<Fn>(async () => ({ id: `in_test_${++n}`, status: "draft" })),
    invoiceItemsCreate: vi.fn<Fn>(async () => ({ id: `ii_test_${++n}` })),
    invoicesFinalize: vi.fn<Fn>(async (id: string) => ({ id, status: "open" })),
    invoicesPay: vi.fn<Fn>(async (id: string) => ({
      id,
      status: "paid",
      payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_for_${id}` } }] },
    })),
    invoicesVoid: vi.fn<Fn>(async (id: string) => ({ id, status: "void" })),
    invoicesDel: vi.fn<Fn>(async (id: string) => ({ id, deleted: true })),
    invoicePaymentsList: vi.fn<Fn>(async (p: { invoice: string }) => ({
      data: [{ payment: { type: "payment_intent", payment_intent: `pi_for_${p.invoice}` } }],
    })),
    chargesRetrieve: vi.fn<Fn>(async (id: string) => ({ id, object: "charge" })),
  };
  Object.assign(stripe.customers, {
    create: mocks.customersCreate,
    update: mocks.customersUpdate,
    del: mocks.customersDel,
  });
  Object.assign(stripe.checkout.sessions, { create: mocks.checkoutCreate });
  Object.assign(stripe.billingPortal.sessions, { create: mocks.portalCreate });
  Object.assign(stripe.paymentIntents, { create: mocks.piCreate, retrieve: mocks.piRetrieve });
  Object.assign(stripe.invoices, {
    list: mocks.invoicesList,
    create: mocks.invoicesCreate,
    finalizeInvoice: mocks.invoicesFinalize,
    pay: mocks.invoicesPay,
    voidInvoice: mocks.invoicesVoid,
    del: mocks.invoicesDel,
  });
  Object.assign(stripe.invoiceItems, { create: mocks.invoiceItemsCreate });
  Object.assign(stripe.invoicePayments, { list: mocks.invoicePaymentsList });
  Object.assign(stripe.charges, { retrieve: mocks.chargesRetrieve });
  return { stripe, mocks };
}

/** Stripe's documented signature scheme: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<payload>")>`. */
export function signStripe(payload: string, secret = WHSEC, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

// biome-ignore lint/suspicious/noExplicitAny: loose test JSON
type Json = any;

export interface HostedServer {
  ctx: AppContext;
  app: App;
  stripe: Stripe;
  mocks: StripeMocks;
  /** The USD-per-EUR rate euro Checkout uses; set to null for "no rate known". */
  fx: { usdPerEur: number | null };
  mailer: LogMailer;
  logs: string[];
  /** JSON API request. */
  api: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Omit<Response, "json"> & { json(): Promise<Json> }>;
  webhook: (event: object, opts?: { signature?: string }) => Promise<Response>;
  close: () => Promise<void>;
}

export async function createHostedServer(
  opts: { billing?: boolean; env?: Record<string, string> } = {},
): Promise<HostedServer> {
  const billing = opts.billing !== false;
  const env: Record<string, string> = {
    RECALL_DATA_DIR: "memory",
    RECALL_AUTH_ENABLED: "true",
    RECALL_AUTH_SECRET: "hosted-test-auth-secret",
    RECALL_ADMIN_TOKEN: ADMIN,
    RECALL_PUBLIC_URL: PUBLIC_URL,
    RECALL_KEY_CACHE_TTL_MS: "0",
    RECALL_BUDGET_CACHE_TTL_MS: "0",
    // Requests carry the client's address the way one reverse proxy would add it (the Browser
    // below sends X-Forwarded-For); production trusts its platform's own header (config.ts).
    RECALL_TRUSTED_PROXY: "1",
    // Round prices so the tests' arithmetic does not follow the production defaults.
    RECALL_PRICE_INGEST_PER_MTOK_USD: "1",
    ...(billing ? { STRIPE_SECRET_KEY: "sk_test_recall_dummy", STRIPE_WEBHOOK_SECRET: WHSEC } : {}),
    ...opts.env,
  };
  let cleanup = async () => {};
  const url = process.env.RECALL_TEST_DATABASE_URL;
  if (url) {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    env.RECALL_DATABASE_URL = scoped.toString();
    cleanup = async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
  }
  const config = loadConfig(env);
  config.tenancy.hosted = true;
  config.hosted = hostedConfig({ ...config.env, RECALL_HOSTED: true });

  const logs: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      logs.push(String(chunk));
      done();
    },
  });
  const log = pino({ level: "warn" }, sink);
  const mailer = new LogMailer(log);
  const { stripe, mocks } = mockStripe();
  // Euro Checkout at a fixed rate (1 EUR = 1.25 USD), never the ECB; null stands for no rate.
  const fx: { usdPerEur: number | null } = { usdPerEur: 1.25 };
  const ctx = await createContext(config, {
    log,
    stripe,
    mailer,
    usdPerEur: async () => fx.usdPerEur,
  });
  const app = createApp(ctx);
  const api: HostedServer["api"] = async (method, path, body, headers = {}) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as never;
  const webhook = (event: object, o: { signature?: string } = {}) => {
    const payload = JSON.stringify(event);
    return app.request("/billing/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": o.signature ?? signStripe(payload),
      },
      body: payload,
    }) as Promise<Response>;
  };
  return {
    ctx,
    app,
    stripe,
    mocks,
    fx,
    mailer,
    logs,
    api,
    webhook,
    close: async () => {
      await ctx.close();
      await cleanup();
    },
  };
}

/**
 * A cookie-keeping browser for the server-rendered dashboard. With `origin`
 * (a dashboard on its own host) paths are requested on that origin and forms
 * are posted from it; by default paths are requested as they are and forms
 * come from PUBLIC_URL.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  lastCsrf = "";
  constructor(
    private readonly app: App,
    private readonly ip = "203.0.113.7",
    private readonly origin: string | null = null,
  ) {}

  private url(path: string) {
    return this.origin && path.startsWith("/") ? `${this.origin}${path}` : path;
  }

  private headers(extra: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    return { ...(cookie ? { cookie } : {}), "x-forwarded-for": this.ip, ...extra };
  }

  private keep(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async get(path: string): Promise<{ res: Response; html: string }> {
    const res = await this.app.request(this.url(path), { headers: this.headers() });
    this.keep(res);
    const html = await res.text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.lastCsrf = m[1]!;
    return { res, html };
  }

  async post(
    path: string,
    form: Record<string, string> = {},
    opts: { csrf?: string | null; headers?: Record<string, string> } = {},
  ): Promise<{ res: Response; html: string }> {
    const csrf = opts.csrf === undefined ? this.lastCsrf : opts.csrf;
    const body = new URLSearchParams({ ...(csrf === null ? {} : { _csrf: csrf }), ...form });
    const res = await this.app.request(this.url(path), {
      method: "POST",
      headers: this.headers({
        "content-type": "application/x-www-form-urlencoded",
        origin: this.origin ?? ORIGIN,
        ...opts.headers,
      }),
      body: body.toString(),
    });
    this.keep(res);
    const html = await res.text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.lastCsrf = m[1]!;
    return { res, html };
  }

  /**
   * Creates an API key the way a browser does: the form posts, the server redirects (303) and
   * the page it redirects to shows the key once. Returns that page and the key in it (null when
   * the form was refused: `posted` holds that response).
   */
  async createKey(
    form: Record<string, string> = {},
  ): Promise<{ res: Response; html: string; key: string | null; posted: Response }> {
    const base = this.origin ? "" : "/app";
    const posted = await this.post(`${base}/keys`, form);
    if (posted.res.status !== 303) return { ...posted, key: null, posted: posted.res };
    const location = new URL(posted.res.headers.get("location")!, "https://recall.invalid");
    const page = await this.get(`${location.pathname}${location.search}`);
    const key = page.html.match(/pk_(?:live|test)_[A-Za-z0-9]{32}/)?.[0] ?? null;
    return { ...page, key, posted: posted.res };
  }

  /** Full magic-link sign-in; returns the link that was emailed (and logged). */
  async signIn(server: HostedServer, email: string): Promise<string> {
    // The dashboard is at the root of its own host, else under /app.
    const base = this.origin ? "" : "/app";
    await this.get(`${base}/login`);
    const sent = await this.post(`${base}/login`, { email });
    if (sent.res.status !== 200) throw new Error(`login request: ${sent.res.status} ${sent.html}`);
    const mail = server.mailer.outbox.filter((m) => m.to === email.toLowerCase()).at(-1);
    if (!mail) throw new Error("no email sent");
    const link = mail.text.match(/https:\/\/\S+/)![0];
    const u = new URL(link);
    await this.get(`${u.pathname}${u.search}`);
    const done = await this.post(`${base}/auth/verify`, { token: u.searchParams.get("token")! });
    if (done.res.status !== 303) throw new Error(`verify: ${done.res.status} ${done.html}`);
    await this.get(base || "/");
    return link;
  }
}

export const csrfOf = (html: string) => html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
