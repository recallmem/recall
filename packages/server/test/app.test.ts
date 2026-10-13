import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../src/http/auth.js";
import { createTestServer } from "./helpers.js";

describe("app shell", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  beforeAll(async () => {
    server = await createTestServer({
      RECALL_AUTH_ENABLED: "true",
      RECALL_AUTH_SECRET: "s3cret",
    });
  });
  afterAll(() => server.close());

  it("serves /health without auth", async () => {
    const res = await server.request("GET", "/health");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("names the deployed commit on /health when Vercel provides it", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "e4c902c0123456789abcdef0123456789abcdef0";
    const deployed = await createTestServer();
    try {
      const res = await deployed.request("GET", "/health");
      expect(await res.json()).toEqual({ status: "ok", commit: "e4c902c" });
    } finally {
      delete process.env.VERCEL_GIT_COMMIT_SHA;
      await deployed.close();
    }
  });

  it("round-trips tokens and rejects tampering", async () => {
    const { verifyToken } = await import("../src/http/auth.js");
    const token = signToken({ w: "ws", p: "alice" }, "s3cret");
    expect(verifyToken(token, "s3cret")).toMatchObject({ w: "ws", p: "alice" });
    expect(() => verifyToken(token, "other")).toThrow("Invalid JWT");
    expect(() => verifyToken(signToken({ p: "alice" }, "s3cret"), "s3cret")).toThrow(
      "missing workspace",
    );
    expect(() => verifyToken(signToken({ ad: true, exp: 1 }, "s3cret"), "s3cret")).toThrow(
      "JWT expired",
    );
  });
});
