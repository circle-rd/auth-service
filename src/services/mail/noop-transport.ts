import type { MailMessage, MailTransport } from "./types.js";

/**
 * No-op transport used when no SMTP is configured. It accepts the message and
 * intentionally does nothing; `sendEmail()` detects `name === "noop"` and
 * logs the drop itself, so no delivery log can be mistaken for a real send.
 *
 * Production boot rejects this transport (see config validation): if a flow
 * that requires email is enabled, `SMTP_HOST` must be set.
 */
export class NoopMailTransport implements MailTransport {
  readonly name = "noop";

  async send(_msg: MailMessage): Promise<void> {
    // Intentionally empty — see the class comment.
  }
}
