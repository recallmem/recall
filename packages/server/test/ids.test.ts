import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";

describe("ids", () => {
  it("are 21 URL-safe characters and never start like a flag", () => {
    for (let i = 0; i < 5000; i++) {
      const id = newId();
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{20}$/);
    }
  });
});
