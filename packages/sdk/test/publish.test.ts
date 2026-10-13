import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
    expect(published.length).toBeGreaterThan(5);
    const offenders = published.filter((file) => NAME.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
