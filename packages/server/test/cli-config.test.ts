import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, run } from "../src/cli.js";
import { signToken } from "../src/http/auth.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/** `recall init`, `recall config` and how the other commands find their settings. */

interface Captured {
  code: number | null;
  out: string;
  err: string;
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON output
  json: any;
}

let home: string;
let server: ApiServer;
const SECRET = "cli-config-secret";
const URL_ = "http://recall.test";

async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  extra: Partial<CliIo> = {},
  s: ApiServer = server,
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env: { HOME: home, ...env },
    fetch: async (input, init) => s.app.fetch(new Request(input, init)),
    ...extra,
  };
  const code = await run(args, io);
  const text = out.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  return { code, out: text, err: err.join("\n"), json };
}

const recallFile = () => join(home, ".recall", "config.json");
const readRecall = () => JSON.parse(readFileSync(recallFile(), "utf8"));
const mode = (path: string) => statSync(path).mode & 0o777;
const posix = process.platform !== "win32";

beforeAll(async () => {
  server = await createTestServer({ RECALL_AUTH_ENABLED: "true", RECALL_AUTH_SECRET: SECRET });
});
afterAll(() => server.close());
beforeEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), "recall-cfg-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const KEY = signToken({ ad: true }, SECRET);

describe("cli init", () => {
  it("writes ~/.recall/config.json with mode 600 after checking the server", async () => {
    const res = await cli([
      "init",
      "--url",
      `${URL_}/`,
      "--api-key",
      KEY,
      "-w",
      "acme",
      "-p",
      "alice",
    ]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("ok   server");
    expect(res.out).toContain("ok   credentials: the key is accepted");
    expect(res.out).toContain(recallFile());
    expect(res.out).not.toContain(KEY);
    expect(readRecall()).toEqual({ url: URL_, apiKey: KEY, workspace: "acme", peer: "alice" });
    if (posix) {
      expect(mode(recallFile())).toBe(0o600);
      expect(mode(join(home, ".recall"))).toBe(0o700);
    }
  });

  it("reports as JSON without the key, and keeps other keys of an existing file", async () => {
    mkdirSync(join(home, ".recall"), { recursive: true });
    writeFileSync(
      recallFile(),
      JSON.stringify({ hosts: { claude: { enabled: true } }, peer: "old" }),
    );
    const res = await cli(["init", "--url", URL_, "--api-key", KEY, "-w", "acme", "--json"]);
    expect(res.code, res.err).toBe(0);
    expect(res.json).toMatchObject({
      path: recallFile(),
      url: URL_,
      workspace: "acme",
      peer: "old",
    });
    expect(res.json.api_key).toMatch(/^…/);
    expect(res.out).not.toContain(KEY);
    expect(res.json.checks.map((c: { ok: boolean }) => c.ok)).toEqual([true, true]);
    expect(readRecall()).toMatchObject({
      hosts: { claude: { enabled: true } },
      peer: "old",
      apiKey: KEY,
      workspace: "acme",
    });
  });

  it("takes pre-seeded answers from the environment", async () => {
    const res = await cli(["init"], {
      RECALL_URL: URL_,
      RECALL_API_KEY: KEY,
      RECALL_WORKSPACE_ID: "envws",
      RECALL_PEER_ID: "envpeer",
    });
    expect(res.code, res.err).toBe(0);
    expect(readRecall()).toEqual({ url: URL_, apiKey: KEY, workspace: "envws", peer: "envpeer" });
  });

  it("writes nothing when the key is rejected, unless forced", async () => {
    const bad = await cli(["init", "--url", URL_, "--api-key", "not-a-token", "--json"]);
    expect(bad.code).toBe(1);
    const error = JSON.parse(bad.err).error;
    expect(error.code).toBe("CHECK_FAILED");
    expect(error.message).toContain("HTTP 401");
    expect(error.message).toContain("Nothing was written");
    expect(existsSync(recallFile())).toBe(false);

    const forced = await cli(["init", "--url", URL_, "--api-key", "not-a-token", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("FAIL credentials");
    expect(readRecall().apiKey).toBe("not-a-token");
  });

  it("writes nothing when the server is unreachable, unless the check is skipped", async () => {
    const down: Partial<CliIo> = {
      fetch: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    };
    const res = await cli(["init", "--url", "http://127.0.0.1:1"], {}, down);
    expect(res.code).toBe(1);
    expect(res.err).toContain("Could not reach");
    expect(existsSync(recallFile())).toBe(false);
    const skipped = await cli(["init", "--url", "http://127.0.0.1:1", "--no-check"], {}, down);
    expect(skipped.code).toBe(0);
    expect(readRecall()).toEqual({ url: "http://127.0.0.1:1", workspace: "default" });
  });

  it("rejects malformed input before touching anything", async () => {
    expect((await cli(["init", "--url", "ftp://x", "--no-check"])).code).toBe(2);
    expect((await cli(["init", "--url", URL_, "-w", "bad id", "--no-check"])).code).toBe(2);
    expect((await cli(["init", "--timeout", "0"])).code).toBe(2);
    expect(existsSync(recallFile())).toBe(false);
    expect((await cli(["init", "--help"])).out).toContain("mode 600");
  });

  it("asks for what it was not given when a person is there to answer", async () => {
    const asked: { question: string; secret: boolean }[] = [];
    const answers = [URL_, KEY, "acme", "alice"];
    const prompt: CliIo["prompt"] = async (question, opts) => {
      asked.push({ question, secret: opts?.secret === true });
      return answers.shift() ?? "";
    };
    const res = await cli(["init"], {}, { prompt });
    expect(res.code, res.err).toBe(0);
    expect(asked.map((a) => a.question.replace(/( \[.*\])?: $/, ""))).toEqual([
      "Server URL",
      "API key (blank for none)",
      "Default workspace",
      "Your peer id (blank to skip)",
    ]);
    expect(asked.map((a) => a.secret)).toEqual([false, true, false, false]);
    expect(readRecall()).toEqual({ url: URL_, apiKey: KEY, workspace: "acme", peer: "alice" });

    // A second run offers what is there as the default; a blank answer keeps it.
    const again = await cli(["init", "-p", "bob"], {}, { prompt: async () => "" });
    expect(again.code, again.err).toBe(0);
    expect(readRecall()).toEqual({ url: URL_, apiKey: KEY, workspace: "acme", peer: "bob" });
  });

  it("ignores Honcho's config file entirely", async () => {
    mkdirSync(join(home, ".honcho"), { recursive: true });
    writeFileSync(
      join(home, ".honcho", "config.json"),
      JSON.stringify({ apiKey: "hch-secret", workspaceId: "from-honcho", peerName: "hannah" }),
    );
    const res = await cli(["init", "--no-check"]);
    expect(res.code, res.err).toBe(0);
    expect(readRecall()).toEqual({ url: "https://api.recallmem.dev", workspace: "default" });
    expect(readFileSync(recallFile(), "utf8")).not.toContain("hch-secret");
  });
});

describe("cli config: where settings come from", () => {
  const show = async (args: string[], env: Record<string, string | undefined> = {}) =>
    (await cli(["config", "--json", ...args], env)).json;

  it("falls back to defaults", async () => {
    const c = await show([]);
    expect(c).toMatchObject({
      url: "https://api.recallmem.dev",
      workspace: "default",
      peer: null,
      api_key: null,
      config_path: null,
    });
    expect(c.sources.url).toBe("default");
    expect(c.sources.peer).toBe("unset");
  });

  it("prefers flag, then RECALL_* env, then the file", async () => {
    mkdirSync(join(home, ".recall"), { recursive: true });
    writeFileSync(
      recallFile(),
      JSON.stringify({
        url: "http://file",
        workspace: "file-ws",
        peer: "file-peer",
        apiKey: "pk_live_abcdefgh1234",
      }),
    );

    const file = await show([]);
    expect(file).toMatchObject({ url: "http://file", workspace: "file-ws", peer: "file-peer" });
    expect(file.api_key).toBe("pk_live_…1234");
    expect(file.sources.url).toMatch(/^file .*config\.json$/);
    expect(file.config_path).toBe(recallFile());

    // Another service's variables are never read: its key must not reach a Recall server.
    const honchoEnv = await show([], {
      HONCHO_URL: "http://honcho-env",
      HONCHO_WORKSPACE_ID: "h-ws",
      HONCHO_API_KEY: "hch-xyz",
    });
    expect(honchoEnv).toMatchObject({ url: "http://file", workspace: "file-ws" });
    expect(honchoEnv.api_key).toBe("pk_live_…1234");

    const recallEnv = await show([], {
      HONCHO_URL: "http://honcho-env",
      RECALL_URL: "http://recall-env",
      RECALL_PEER_ID: "env-peer",
      RECALL_SESSION_ID: "env-session",
    });
    expect(recallEnv).toMatchObject({
      url: "http://recall-env",
      peer: "env-peer",
      session: "env-session",
    });

    const flags = await show(["--url", "http://flag/", "-w", "flag-ws", "-p", "flag-peer"], {
      RECALL_URL: "http://recall-env",
    });
    expect(flags).toMatchObject({ url: "http://flag", workspace: "flag-ws", peer: "flag-peer" });
    expect(flags.sources.url).toBe("flag --url");
  });

  it("never reads Honcho's config or HONCHO_* variables, so their key cannot reach Recall", async () => {
    mkdirSync(join(home, ".honcho"), { recursive: true });
    writeFileSync(
      join(home, ".honcho", "config.json"),
      JSON.stringify({ apiKey: "hch-0000abcd", environmentUrl: "http://old-honcho" }),
    );
    const c = await show([], { HONCHO_API_KEY: "hch-env-key" });
    expect(c).toMatchObject({
      url: "https://api.recallmem.dev",
      api_key: null,
      config_path: null,
    });
  });

  it("expands an environment placeholder in the file's key", async () => {
    mkdirSync(join(home, ".recall"), { recursive: true });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder the CLI expands
    writeFileSync(recallFile(), JSON.stringify({ apiKey: "${MY_KEY}" }));
    expect((await show([], { MY_KEY: "pk_test_wxyz9999" })).api_key).toBe("pk_test_…9999");
  });

  it("honours RECALL_CONFIG_DIR / RECALL_CONFIG_PATH", async () => {
    const dir = join(home, "elsewhere");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ workspace: "dir-ws" }));
    expect(await show([], { RECALL_CONFIG_DIR: dir })).toMatchObject({ workspace: "dir-ws" });
    const exact = join(home, "exact.json");
    writeFileSync(exact, JSON.stringify({ workspace: "exact-ws" }));
    expect(await show([], { RECALL_CONFIG_PATH: exact })).toMatchObject({
      workspace: "exact-ws",
    });
  });

  it("explains a broken config", async () => {
    mkdirSync(join(home, ".recall"), { recursive: true });
    writeFileSync(recallFile(), "{ nope");
    const bad = await cli(["config", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error.code).toBe("INVALID_CONFIG");
  });

  it("prints a readable summary with the key redacted", async () => {
    mkdirSync(join(home, ".recall"), { recursive: true });
    writeFileSync(recallFile(), JSON.stringify({ url: URL_, apiKey: KEY, peer: "alice" }));
    const res = await cli(["config"]);
    expect(res.out).toContain(`url:`);
    expect(res.out).toContain("(file ");
    expect(res.out).toContain("config file:");
    expect(res.out).not.toContain(KEY);
  });
});

describe("cli: resource commands use the saved settings", () => {
  it("needs no flags or environment after `init`", async () => {
    expect(
      (await cli(["init", "--url", URL_, "--api-key", KEY, "-w", "acme", "-p", "alice"])).code,
    ).toBe(0);
    // Conclusions need an existing workspace and peers; a first message or `create_peer` makes them.
    await server.request(
      "POST",
      "/v3/workspaces/acme/peers",
      { id: "alice" },
      { authorization: `Bearer ${KEY}` },
    );
    // No env at all except HOME.
    const write = await cli(["conclusion", "create", "Alice lives in Utrecht"]);
    expect(write.code, write.err).toBe(0);
    const peers = await cli(["peer", "list", "--json"]);
    expect(peers.json.map((p: { id: string }) => p.id)).toEqual(["alice"]);
    const list = await cli(["conclusion", "list", "--json"]);
    expect(list.json.map((c: { content: string }) => c.content)).toEqual([
      "Alice lives in Utrecht",
    ]);
    const inspect = await cli(["peer", "inspect"]);
    expect(inspect.out).toContain("alice");
    // And the environment still overrides the file.
    const other = await cli(["peer", "list", "--json"], { RECALL_WORKSPACE_ID: "elsewhere" });
    expect(other.json).toEqual([]);
  });
});
