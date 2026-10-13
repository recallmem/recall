import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { OpsAlerts } from "../src/lib/alerts.js";
import type { MailMessage } from "../src/lib/mailer.js";

const quiet = () =>
  new Writable({
    write(_chunk, _enc, done) {
      done();
    },
  });

function setup(send: (m: MailMessage) => Promise<void> = async () => {}) {
  const alerts = new OpsAlerts();
  const log = pino({ level: "info", hooks: alerts.hooks }, quiet());
  const sent: MailMessage[] = [];
  alerts.attach(
    {
      live: true,
      send: async (m) => {
        sent.push(m);
        await send(m);
      },
    },
    "ops@example.com",
    "https://recall.test",
  );
  return { log, sent };
}

describe("error alerts", () => {
  it("emails each distinct error once per quiet period, with its message and path", async () => {
    const { log, sent } = setup();
    log.info("all good");
    log.warn("a warning");
    log.error({ err: new Error("connection refused"), path: "/v3/x" }, "unhandled error");
    log.error({ err: new Error("again") }, "unhandled error");
    log.error({ err: new TypeError("boom") }, "queue drain failed");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({
      to: "ops@example.com",
      subject: "Recall error: unhandled error",
    });
    expect(sent[0]!.text).toContain("Error: connection refused");
    expect(sent[0]!.text).toContain("Path: /v3/x");
    expect(sent[1]!.subject).toBe("Recall error: queue drain failed");
    expect(sent[1]!.text).toContain("TypeError: boom");
  });

  it("sends nothing before it is attached, and a failing mailer neither throws nor loops", async () => {
    const alerts = new OpsAlerts();
    const log = pino({ level: "info", hooks: alerts.hooks }, quiet());
    expect(() => log.error("before attach")).not.toThrow();
    const failing = setup(async () => {
      throw new Error("mail down");
    });
    expect(() => failing.log.error("first failure")).not.toThrow();
    await vi.waitFor(() => expect(failing.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(failing.sent).toHaveLength(1);
  });
});
