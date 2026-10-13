import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { safeErr } from "../src/lib/log-safety.js";

describe("log safety", () => {
  it("keeps a failed query's statement but not its bound values", () => {
    const err = new DrizzleQueryError(
      "INSERT INTO accounts (id, webhook_secret) VALUES ($1, $2)",
      ["acct_1", "whsec_supersecret"],
      new Error("duplicate key value violates unique constraint"),
    );
    const out = JSON.stringify(safeErr(err));
    expect(out).toContain("INSERT INTO accounts");
    expect(out).toContain("duplicate key");
    expect(out).not.toContain("whsec_supersecret");
  });
});
