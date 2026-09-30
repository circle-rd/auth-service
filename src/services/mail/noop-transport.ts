import type { MailMessage, MailTransport } from "./types.js";

/**
 * No-op transport used in development when no SMTP is configured. Logs a
 * warning with the message subject so developers can see which emails would
 * have been delivered, but never performs network I/O.
 *
 * Production boot rejects this transport (see config validation): if a flow
 * that requires email is enabled, `SMTP_HOST` must be set.
 */
export class NoopMailTransport implements MailTransport {
  readonly name = "noop";

  async send(msg: MailMessage): Promise<void> {
    console.warn(
      `[mail:noop] SMTP not configured — dropping email to ${msg.to} ("${msg.subject}")`,
    );
  }
}
