import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO, run, type Served, startServer } from "./integration-helpers.js";

/**
 * The Hermes Agent memory provider (integrations/hermes/recall) is Python; its
 * tests (integrations/hermes/tests) run here against a real Recall server.
 * They use python3, or HERMES_PYTHON: point that at the Python of a Hermes
 * Agent install to also load the provider through Hermes' plugin loader and
 * drive it with Hermes' MemoryManager.
 */

const TESTS = join(REPO, "integrations/hermes/tests/test_recall_provider.py");

function python(candidate: string): string | null {
  const res = spawnSync(candidate, ["-c", "import sys; print(sys.version_info >= (3, 9))"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return res.status === 0 && res.stdout.trim() === "True" ? candidate : null;
}

const interpreters = [
  ...new Set([python("python3"), process.env.HERMES_PYTHON && python(process.env.HERMES_PYTHON)]),
].filter((p): p is string => Boolean(p));

describe.skipIf(interpreters.length === 0)("hermes: memory provider", () => {
  let s: Served;
  let home: string;
  beforeAll(async () => {
    s = await startServer();
    home = mkdtempSync(join(tmpdir(), "recall-hermes-home-"));
  });
  afterAll(async () => {
    await s.stop();
    rmSync(home, { recursive: true, force: true });
  });

  for (const interpreter of interpreters) {
    it(`passes its Python tests (${interpreter})`, async () => {
      const res = await run(
        interpreter,
        [TESTS, "-v"],
        { HOME: home, RECALL_TEST_URL: s.url, PYTHONDONTWRITEBYTECODE: "1" },
        { timeoutMs: 120_000 },
      );
      const report = res.stderr + res.stdout;
      expect(res.code, report).toBe(0);
      expect(report).toMatch(/Ran 9 tests/);
      if (interpreter === process.env.HERMES_PYTHON) {
        expect(report).toMatch(/test_loaded_and_driven_by_hermes .*\.\.\. ok/);
      }
    }, 150_000);
  }
});
