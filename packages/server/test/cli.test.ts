import { type ChildProcess, spawn } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { afterAll, describe, expect, it } from "vitest";
import { type CliIo, parseExpiry, redactUrl, run } from "../src/cli.js";
import { verifyToken } from "../src/http/auth.js";
import { VERSION } from "../src/version.js";
import { createTestServer } from "./api-helpers.js";

interface Captured {
  code: number | null;
  out: string;
  err: string;
}

async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (t) => out.push(t), err: (t) => err.push(t), env, fetch: fetchImpl };
  const code = await run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const SECRET = "cli-test-secret";

describe("cli: basics", () => {
  it("prints usage and the version", async () => {
    const version = await cli(["--version"]);
    expect(version).toMatchObject({ code: 0, out: VERSION });
    const pkg = (await import("../package.json", { with: { type: "json" } })).default;
    expect(VERSION).toBe(pkg.version);
    expect(pkg.bin.recall).toBe("dist/cli.js");

    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    for (const command of ["start", "token", "doctor"]) expect(help.out).toContain(command);
    expect((await cli([])).code).toBe(2);
    const unknown = await cli(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown command "frobnicate"');
    expect((await cli(["token", "--help"])).out).toContain("--admin");
  });
});

describe("cli: token", () => {
  const token = (args: string[], env: Record<string, string> = { RECALL_AUTH_SECRET: SECRET }) =>
    cli(["token", ...args], env);

  it("mints admin and scoped tokens the server verifies", async () => {
    const admin = await token(["--admin"]);
    expect(admin.code).toBe(0);
    expect(verifyToken(admin.out, SECRET)).toMatchObject({ ad: true });
    expect(verifyToken(admin.out, SECRET).exp).toBeUndefined();

    const ws = await token(["--workspace", "acme"]);
    expect(verifyToken(ws.out, SECRET)).toMatchObject({ w: "acme" });
    expect(verifyToken(ws.out, SECRET).ad).toBeUndefined();

    const scoped = await token(["-w", "acme", "-p", "alice", "-s", "chat-1"]);
    expect(verifyToken(scoped.out, SECRET)).toMatchObject({ w: "acme", p: "alice", s: "chat-1" });
    expect(() => verifyToken(scoped.out, "another-secret")).toThrow();
  });

  it("sets the expiry from durations, seconds or dates, and can print JSON", async () => {
    const before = Math.floor(Date.now() / 1000);
    const hour = await token(["--admin", "--expires", "1h"]);
    const exp = verifyToken(hour.out, SECRET).exp!;
    expect(exp).toBeGreaterThanOrEqual(before + 3600);
    expect(exp).toBeLessThanOrEqual(before + 3602);

    const json = JSON.parse((await token(["--admin", "--expires", "7d", "--json"])).out);
    expect(verifyToken(json.token, SECRET)).toEqual(json.claims);
    expect(json.expires_at).toBe(new Date(json.claims.exp * 1000).toISOString());

    expect(parseExpiry("90m", 0)).toBe(5400);
    expect(parseExpiry("2w", 0)).toBe(1_209_600);
    expect(parseExpiry("120", 0)).toBe(120);
    expect(parseExpiry("2030-01-01T00:00:00Z")).toBe(1_893_456_000);
    expect(() => parseExpiry("soon")).toThrow(/not a duration/);
    expect((await token(["--admin", "--expires", "2001-01-01"])).err).toContain("in the past");
  });

  it("takes the secret from --secret as well as the environment", async () => {
    const out = await token(["--admin", "--secret", "flag-secret"], {});
    expect(verifyToken(out.out, "flag-secret")).toMatchObject({ ad: true });
  });

  it("rejects invalid combinations with exit code 2", async () => {
    const cases: [string[], RegExp, Record<string, string>?][] = [
      [["--admin"], /No signing secret/, {}],
      [[], /Choose the token's scope/],
      [["--peer", "alice"], /need --workspace/],
      [["--admin", "-w", "acme"], /cannot be combined/],
      [["-w", "bad id!"], /must be 1-512 characters/],
      [["--bogus"], /Unknown option/],
    ];
    for (const [args, message, env] of cases) {
      const out = await token(args, env ?? { RECALL_AUTH_SECRET: SECRET });
      expect(out.code, args.join(" ")).toBe(2);
      expect(out.err, args.join(" ")).toMatch(message);
      expect(out.out).toBe("");
    }
  });

  it("produces tokens the running API accepts", async () => {
    const server = await createTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: SECRET,
    });
    try {
      const get = (jwt: string, path: string) =>
        server.request("POST", path, {}, { authorization: `Bearer ${jwt}` });
      const admin = (await token(["--admin"])).out;
      const acme = (await token(["-w", "acme"])).out;
      expect((await get(admin, "/v3/workspaces/list")).status).toBe(200);
      expect((await get(acme, "/v3/workspaces/list")).status).toBe(401);
      expect((await get(acme, "/v3/workspaces/acme/peers/list")).status).toBe(200);
      expect((await get(acme, "/v3/workspaces/other/peers/list")).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("cli: doctor", () => {
  it("shows what an unconfigured install would do, without needing a server", async () => {
    const out = await cli(["doctor"], {});
    expect(out.code).toBe(0);
    expect(out.out).toContain(`recall doctor (v${VERSION})`);
    expect(out.out).toMatch(/reasoner\s+mock\/default/);
    expect(out.out).toMatch(/embedding\s+mock\/hash/);
    expect(out.out).toContain("embedded Postgres (PGlite)");
    expect(out.out).toContain("no provider key set");
    expect(out.out).toContain("[skip] server /health");
  });

  it("reports provider keys and routes each task to the cheapest keyed model, never printing secrets", async () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-very-secret",
      RECALL_DATABASE_URL: "postgres://app:hunter2@db.internal:5432/recall",
    };
    const out = await cli(["doctor"], env);
    expect(out.code).toBe(0);
    expect(out.out).toMatch(/anthropic\s+configured/);
    expect(out.out).toMatch(/openai\s+-/);
    expect(out.out).toMatch(/chat_max\s+anthropic\/claude-opus-5-5/);
    expect(out.out).toContain("Postgres postgres://app:***@db.internal:5432/recall");
    expect(out.out + out.err).not.toContain("sk-ant-very-secret");
    expect(out.out + out.err).not.toContain("hunter2");
    expect(redactUrl("postgres://u:p@h/db")).toBe("postgres://u:***@h/db");
  });

  it("fails when a task is routed to a provider that has no key", async () => {
    const out = await cli(["doctor"], {
      ANTHROPIC_API_KEY: "k",
      RECALL_MODEL_CHAT_HIGH: "openai/gpt-5",
    });
    expect(out.code).toBe(1);
    expect(out.out).toMatch(/\[FAIL\] model routing: no key for: chat_high -> openai\/gpt-5/);
  });

  it("fails on an invalid configuration and warns about open access on a public address", async () => {
    const bad = await cli(["doctor"], { RECALL_AUTH_ENABLED: "true" });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/\[FAIL\] configuration: .*RECALL_AUTH_SECRET/);

    const open = await cli(["doctor"], { RECALL_HOST: "0.0.0.0" });
    expect(open.out).toMatch(/\[warn\] auth: disabled: anyone who can reach/);
    const local = await cli(["doctor"], { RECALL_HOST: "127.0.0.1" });
    expect(local.out).toMatch(/\[ok {2}\] auth: disabled, listening on loopback only/);
  });

  it("pings /health of the given URL (flag or env) and fails when it is unreachable", async () => {
    const server = await createTestServer();
    const http = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => http.once("listening", () => resolve()));
    const { port } = http.address() as AddressInfo;
    try {
      const ok = await cli(["doctor", "--url", `http://127.0.0.1:${port}/`]);
      expect(ok.code).toBe(0);
      expect(ok.out).toMatch(
        /\[ok {2}\] server \/health: http:\/\/127\.0\.0\.1:\d+\/health is healthy/,
      );
      const viaEnv = await cli(["doctor"], { RECALL_URL: `http://127.0.0.1:${port}` });
      expect(viaEnv.out).toContain("is healthy");
      const json = JSON.parse(
        (await cli(["doctor", "--json", "--url", `http://127.0.0.1:${port}`])).out,
      );
      expect(json.ok).toBe(true);
      expect(json.models.reasoner).toBe("mock/default");
      expect(json.providers.anthropic).toBe(false);
      expect(json.checks.find((c: { name: string }) => c.name === "server /health").status).toBe(
        "ok",
      );
    } finally {
      http.close();
      await server.close();
    }
    const down = await cli(["doctor", "--url", `http://127.0.0.1:${port}`, "--timeout", "1000"]);
    expect(down.code).toBe(1);
    expect(down.out).toMatch(/\[FAIL\] server \/health: .*unreachable/);

    const notHealthy = await cli(["doctor", "--url", "http://x"], {}, async () =>
      Response.json({ detail: "nope" }, { status: 503 }),
    );
    expect(notHealthy.code).toBe(1);
    expect(notHealthy.out).toContain("answered HTTP 503");
  });
});

describe("cli: start", () => {
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill("SIGKILL");
  });

  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });

  it("rejects bad flags without starting", async () => {
    const bad = await cli(["start", "--port", "banana"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--port must be an integer");
    const cfg = await cli(["start", "--role", "sideways"], {});
    expect(cfg.code).toBe(2);
    expect(cfg.err).toContain("Invalid configuration");
  });

  it("starts the server with the given port and data dir, serves the API and MCP, and stops on SIGTERM", async () => {
    const port = await freePort();
    const root = fileURLToPath(new URL("..", import.meta.url));
    let output = "";
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "start",
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--data-dir",
        "memory",
        "--log-level",
        "silent",
      ],
      {
        cwd: root,
        env: { ...process.env, RECALL_AUTH_ENABLED: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout!.on("data", (d) => {
      output += d;
    });
    child.stderr!.on("data", (d) => {
      output += d;
    });
    const exited = new Promise<number | null>((resolve) =>
      child!.once("exit", (code) => resolve(code)),
    );

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 25_000;
    let healthy = false;
    // The banner is printed once the worker has started too, which can be just after /health answers.
    while ((!healthy || !output.includes("listening on")) && Date.now() < deadline) {
      healthy = await fetch(`${base}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (!healthy || !output.includes("listening on"))
        await new Promise((r) => setTimeout(r, 150));
    }
    expect(healthy, output).toBe(true);
    expect(output).toContain(`listening on http://127.0.0.1:${port}`);
    expect(output).toContain("embedded Postgres (PGlite), in memory");

    const created = await fetch(`${base}/v3/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "from-cli" }),
    });
    expect(created.status).toBeLessThan(300);
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(200);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    child = undefined;
  }, 60_000);

  it("exits with an error, instead of hanging, when the port is taken", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
    const { port } = taken.address() as AddressInfo;
    const root = fileURLToPath(new URL("..", import.meta.url));
    try {
      const proc = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "start",
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
          "--data-dir",
          "memory",
          "--log-level",
          "silent",
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      proc.stderr!.on("data", (d) => {
        stderr += d;
      });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve(-1);
        }, 40_000);
        proc.once("exit", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code, stderr).toBe(1);
      expect(stderr).toContain("EADDRINUSE");
    } finally {
      taken.close();
    }
  }, 60_000);
});
