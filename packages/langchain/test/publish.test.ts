import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const NAME = /honcho/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("what gets published", () => {
  it("never names another product in the source, README, LICENSE or package metadata", () => {
    const published = [
      ...files(join(root, "src")),
      join(root, "README.md"),
      join(root, "LICENSE"),
      join(root, "package.json"),
    ];
    const offenders = published.filter((file) => NAME.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("depends on the SDK and leaves the framework to the app", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["@recall-memory/sdk"]);
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["@langchain/core", "zod"]);
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
  });
});
