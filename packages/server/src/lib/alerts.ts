import type { LoggerOptions } from "pino";
import { renderEmail } from "./email.js";
import type { Mailer } from "./mailer.js";

const QUIET_MS = 15 * 60_000;

/**
 * Emails the operator about errors (RECALL_ALERT_EMAIL): every error-level log line becomes an
 * email, at most one per distinct message per 15 minutes in this process, so a burst is one
 * email. Hooked into the logger before the mailer exists; nothing is sent until `attach`.
 * Only the error's name and message are sent, never request bodies.
 */
export class OpsAlerts {
  private send: ((subject: string, lines: string[]) => Promise<void>) | null = null;
  private readonly last = new Map<string, number>();

  /** The logger hook: pass to `pino({ hooks: alerts.hooks })`. */
  readonly hooks: NonNullable<LoggerOptions["hooks"]>;

  constructor() {
    const alerts = this;
    this.hooks = {
      // A plain function: pino calls it with the logger as `this`.
      logMethod(args, method, level) {
        if (level >= 50) alerts.notice(args as unknown[]);
        return method.apply(this, args);
      },
    };
  }

  attach(mailer: Mailer, to: string, siteUrl: string): void {
    this.send = async (subject, lines) => {
      await mailer.send({
        to,
        subject,
        ...renderEmail(siteUrl, {
          preheader: lines[0] ?? subject,
          heading: "Something failed",
          paragraphs: lines,
          footnote: "More errors with the same message are not emailed for 15 minutes.",
        }),
      });
    };
  }

  private notice(args: unknown[]): void {
    if (!this.send) return;
    const first = args[0];
    const msg = typeof first === "string" ? first : typeof args[1] === "string" ? args[1] : "error";
    if (msg === "could not send an alert") return; // never alert about alerting
    const now = Date.now();
    if (now - (this.last.get(msg) ?? 0) < QUIET_MS) return;
    this.last.set(msg, now);
    const obj = (first && typeof first === "object" ? first : {}) as Record<string, unknown>;
    const err = obj.err as { name?: string; message?: string } | undefined;
    const lines = [
      `Recall logged an error: "${msg}".`,
      ...(err?.message ? [`${err.name ?? "Error"}: ${String(err.message).slice(0, 300)}`] : []),
      ...(typeof obj.path === "string" ? [`Path: ${obj.path}`] : []),
      `Time: ${new Date(now).toISOString()}`,
    ];
    void this.send(`Recall error: ${msg}`.slice(0, 120), lines).catch(() => {
      // A failed alert is not itself alerted (that would loop); the original error is in the logs.
    });
  }
}
