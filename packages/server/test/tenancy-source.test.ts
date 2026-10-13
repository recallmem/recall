import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard rail for tenant isolation: workspace names are only unique per
 * account, so a workspace must never be looked up by name alone. Every such
 * comparison goes through `wsIs` (core/tenancy.ts) or the resolver built on it.
 * This fails if a raw comparison of a workspace name sneaks back in.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const FORBIDDEN = [
  /\bw\.name\s*(=|IN\b|<>|!=)/i, // alias w is the workspaces table everywhere
  /\bworkspaces\.name\s*(=|IN\b)/i,
  /FROM\s+workspaces\s+WHERE\s+name\b/i,
  /ON\s+CONFLICT\s*\(\s*name\s*\)/i,
];

describe("tenancy: source guard", () => {
  it("compares workspace names only through the account-scoped resolver", () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      if (rel === join("core", "tenancy.ts")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (FORBIDDEN.some((re) => re.test(line)))
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("inserts workspaces with an account in exactly one place", () => {
    const inserts = files(SRC).filter((f) =>
      /INSERT INTO workspaces/i.test(readFileSync(f, "utf8")),
    );
    expect(inserts.map((f) => relative(SRC, f))).toEqual([join("core", "workspaces.ts")]);
  });
});
