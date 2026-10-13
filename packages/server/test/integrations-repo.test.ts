import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { mentionsOldName, REPO } from "./integration-helpers.js";

/** Repository-wide rules for the agent integrations' user-facing files. */

const SKIP = new Set(["node_modules", "__pycache__", ".git"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const userFacing = [
  ...files(join(REPO, "integrations")),
  join(REPO, ".claude-plugin/marketplace.json"),
  join(REPO, ".agents/plugins/marketplace.json"),
].filter((f) => /\.(md|json|ya?ml|mjs|js|py)$/.test(f));

describe("integrations: repository references", () => {
  it("never mention the old name, and link only to the public plugin repository", () => {
    expect(userFacing.length).toBeGreaterThan(20);
    for (const file of userFacing) {
      const text = readFileSync(file, "utf8");
      const name = relative(REPO, file);
      expect(mentionsOldName(text), name).toBe(false);
      // The plugin repository lives in the recallmem organisation: nothing links a personal account.
      expect(text, name).not.toMatch(/RedSix6\//i);
    }
  });
});
