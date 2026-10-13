import type { Logger } from "pino";

/**
 * Transactional email. With RESEND_API_KEY it posts to Resend's HTTP API;
 * without it (development) the message, including any sign-in link, is logged
 * and kept in `outbox` instead of being sent.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly live: boolean;
  send(msg: MailMessage): Promise<void>;
}

export class ResendMailer implements Mailer {
  readonly live = true;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Resend rejected the email (${res.status}): ${body}`);
    }
  }
}

export class LogMailer implements Mailer {
  readonly live = false;
  /** The most recent messages, newest last (development and tests). */
  readonly outbox: MailMessage[] = [];
  constructor(private readonly log: Logger) {}

  async send(msg: MailMessage): Promise<void> {
    this.outbox.push(msg);
    if (this.outbox.length > 50) this.outbox.shift();
    this.log.warn(
      { to: msg.to, subject: msg.subject, text: msg.text },
      "email not sent (RESEND_API_KEY unset); logged instead",
    );
  }
}
