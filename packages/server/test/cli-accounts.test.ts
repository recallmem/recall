import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliIo, run } from "../src/cli.js";
import { type ApiServer, createTestServer } from "./api-helpers.js";

const ADMIN = "operator-token-0123456789abcdef";

async function cli(
  args: string[],
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env,
    fetch: fetchImpl ?? fetch,
  };
  const code = await run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli: accounts and keys over the admin API", () => {
  let s: ApiServer;
  let viaApp: typeof fetch;
  const env = { RECALL_ADMIN_TOKEN: ADMIN };
  beforeAll(async () => {
    s = await createTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: "cli-secret",
      RECALL_ADMIN_TOKEN: ADMIN,
    });
    viaApp = ((input: string | URL | Request, init?: RequestInit) =>
      s.app.request(input as string, init)) as typeof fetch;
  });
  afterAll(() => s.close());

  it("creates and lists accounts, creates/lists/revokes keys, and the keys work", async () => {
    const url = "http://recall.test";
    const created = await cli(
      ["accounts", "create", "--name", "Acme BV", "--budget", "25", "--url", url, "--json"],
      env,
      viaApp,
    );
    expect(created.code).toBe(0);
    const account = JSON.parse(created.out);
    expect(account).toMatchObject({ name: "Acme BV", monthly_budget_usd: 25 });
    expect(account.webhook_secret).toMatch(/^whsec_/);

    const listed = await cli(["accounts", "list", "--url", url], env, viaApp);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(account.id);
    expect(listed.out).toContain("Acme BV");

    const key = await cli(
      ["keys", "create", "--account", account.id, "--name", "prod", "--url", url],
      env,
      viaApp,
    );
    expect(key.code).toBe(0);
    expect(key.out).toMatch(/^pk_live_[A-Za-z0-9]{32}$/);
    expect(key.err).toContain("shown only once");
    const auth = { authorization: `Bearer ${key.out}` };
    expect((await s.request("POST", "/v3/workspaces/list", {}, auth)).status).toBe(200);

    const scoped = await cli(
      [
        "keys",
        "create",
        "-a",
        account.id,
        "-w",
        "w",
        "-p",
        "alice",
        "--test",
        "--expires",
        "7d",
        "--json",
      ],
      { ...env, RECALL_ADMIN_URL: url },
      viaApp,
    );
    const scopedKey = JSON.parse(scoped.out);
    expect(scopedKey.key).toMatch(/^pk_test_/);
    expect(scopedKey.scope).toEqual({ workspace_id: "w", peer_id: "alice", session_id: null });
    expect(scopedKey.expires_at).not.toBeNull();

    const keys = await cli(["keys", "list", "--account", account.id, "--url", url], env, viaApp);
    expect(keys.out.split("\n")).toHaveLength(2);
    expect(keys.out).not.toContain(key.out);
    expect(keys.out).toContain("w=w p=alice");

    const id = JSON.parse(
      (await cli(["keys", "list", "-a", account.id, "--url", url, "--json"], env, viaApp)).out,
    ).find((k: { name: string }) => k.name === "prod").id;
    const revoked = await cli(["keys", "revoke", id, "--url", url], env, viaApp);
    expect(revoked.code).toBe(0);
    expect(revoked.out).toContain(`Revoked ${id}`);
    expect((await s.request("POST", "/v3/workspaces/list", {}, auth)).status).toBe(401);
  });

  it("explains usage mistakes with exit code 2 and API errors with exit code 1", async () => {
    expect((await cli(["keys", "create", "--url", "http://x"], env, viaApp)).code).toBe(2);
    expect((await cli(["accounts", "create", "--url", "http://x"], env, viaApp)).code).toBe(2);
    expect((await cli(["accounts", "list", "--url", "http://x"], {}, viaApp)).code).toBe(2);
    expect((await cli(["keys", "nope"], env, viaApp)).code).toBe(2);
    expect((await cli(["keys", "revoke", "--url", "http://x"], env, viaApp)).code).toBe(2);
    const wrong = await cli(
      ["accounts", "list", "--url", "http://x", "--admin-token", "x".repeat(30)],
      env,
      viaApp,
    );
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("401");
    expect((await cli(["accounts"], env)).code).toBe(2);
    expect((await cli(["keys", "--help"], env)).out).toContain("recall keys");
  });
});

describe("cli: accounts and keys straight on the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("works without a running server", async () => {
    const env = { RECALL_DATA_DIR: dir };
    const created = await cli(["accounts", "create", "--name", "Local", "--json"], env);
    expect(created.code, created.err).toBe(0);
    const account = JSON.parse(created.out);
    const listed = await cli(["accounts", "list", "--json"], env);
    expect(JSON.parse(listed.out).map((a: { id: string }) => a.id)).toEqual([
      "default",
      account.id,
    ]);
    const key = await cli(["keys", "create", "--account", account.id, "--json"], env);
    expect(JSON.parse(key.out)).toMatchObject({ account_id: account.id, admin: true });
    const unknown = await cli(["keys", "list", "--account", "acct_missing"], env);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Account not found");
  }, 60_000);
});
