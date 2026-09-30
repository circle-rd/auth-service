/**
 * Outbound mail transport abstraction.
 *
 * The auth-service only depends on this interface; concrete implementations
 * (SMTP via Nodemailer, in-memory capture for tests, future Resend/SES) live
 * in sibling modules. This keeps the email pipeline decoupled from any
 * specific delivery mechanism.
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Overrides config.smtp.from when set (per-template `from:` frontmatter). */
  from?: string;
  /** Overrides config.smtp.replyTo / MAIL_REPLY_TO when set. */
  replyTo?: string;
}

export interface MailTransport {
  /**
   * Deliver a single message. Must throw on hard failure so callers can log
   * and surface the error; transient retries are the transport's concern.
   */
  send(msg: MailMessage): Promise<void>;
  /**
   * Optional connection/credentials check. Called at boot. Implementations
   * that cannot verify (no-op, capture) should omit this method.
   */
  verify?(): Promise<void>;
  /** Human-readable identifier surfaced in startup logs. */
  readonly name: string;
}
