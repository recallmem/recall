import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { type ApiServer, createTestServer } from "./api-helpers.js";

/**
 * Shared plumbing for the agent-integration tests (integrations/*): a Recall
 * server on a real local port, and a way to run an integration's scripts as the
 * host agent would.
 */

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The project's former name, kept as the SHA-256 of its lower-case spelling so that the name itself
 * never ships with the repository. `mentionsOldName` is true when a text contains it anywhere.
 */
const OLD_NAME = {
  length: 8,
  sha256: "e106079a5e81432100115f248e56e3bf888e171d441ba5e187b510cc7fc819cc",
};

export function mentionsOldName(text: string): boolean {
  for (const word of new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])) {
    for (let i = 0; i + OLD_NAME.length <= word.length; i++) {
      const part = word.slice(i, i + OLD_NAME.length);
      if (createHash("sha256").update(part).digest("hex") === OLD_NAME.sha256) return true;
    }
  }
  return false;
}

// biome-ignore lint/suspicious/noExplicitAny: REST bodies are loosely typed here
export type Json = any;

export interface Served {
  server: ApiServer;
  url: string;
  requests: { method: string; path: string; authorization: string | null }[];
  stop: () => Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<Served> {
  const server = await createTestServer(env);
  const requests: Served["requests"] = [];
  const http = serve({
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        authorization: req.headers.get("authorization"),
      });
      return server.app.fetch(req);
    },
    port: 0,
    hostname: "127.0.0.1",
  });
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const { port } = http.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: async () => {
      http.close();
      await server.close();
    },
  };
}

/** A local URL nothing listens on. */
export async function closedPort(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a command with exactly the given environment (plus PATH), feeding `stdin`. */
export function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  {
    stdin = "",
    cwd,
    timeoutMs = 30_000,
  }: { stdin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "", ...env },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} did not finish in ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(stdin);
  });
}

/** Runs a Node script with the given environment, the way an agent runs a command hook. */
export const runNode = (
  file: string,
  input: unknown,
  env: Record<string, string>,
  args: string[] = [],
) =>
  run(process.execPath, [file, ...args], env, {
    stdin: typeof input === "string" ? input : JSON.stringify(input),
  });

/** Messages stored in a session, oldest first. */
export async function messagesOf(
  s: Served,
  workspace: string,
  session: string,
  headers: Record<string, string> = {},
): Promise<Json[]> {
  const res = await s.server.request(
    "POST",
    `/v3/workspaces/${workspace}/sessions/${session}/messages/list`,
    {},
    headers,
  );
  return res.status === 200 ? (await res.json()).items : [];
}

/** Creates a peer with a peer card and two facts, so recall has something to find. */
export async function seedMemory(s: Served, workspace: string, peer: string, name: string) {
  const post = (path: string, body: unknown) => s.server.request("POST", path, body);
  await post(`/v3/workspaces/${workspace}/peers`, { id: peer });
  await post(`/v3/workspaces/${workspace}/conclusions`, {
    conclusions: [
      { content: `${name} lives in Utrecht`, observer_id: peer, observed_id: peer },
      { content: `${name} prefers tabs over spaces`, observer_id: peer, observed_id: peer },
    ],
  });
  await s.server.request("PUT", `/v3/workspaces/${workspace}/peers/${peer}/card`, {
    peer_card: [`Name: ${name}`, "Works on a webshop"],
  });
}

/** A stand-in for the OpenAI Responses API that always answers `reply`. */
export async function fakeModel(reply: string) {
  const bodies: string[] = [];
  const server: Server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url?.endsWith("/responses")) {
        bodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type: string, payload: object) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
        send("response.created", { response: { id: "resp_1" } });
        send("response.output_item.done", {
          item: {
            type: "message",
            role: "assistant",
            id: "msg_1",
            content: [{ type: "output_text", text: reply }],
          },
        });
        send("response.completed", {
          response: {
            id: "resp_1",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        return res.end();
      }
      res.writeHead(req.url?.includes("/models") ? 200 : 404, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ object: "list", data: [], models: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
