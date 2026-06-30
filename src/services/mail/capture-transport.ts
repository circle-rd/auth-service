import type { MailMessage, MailTransport } from "./types.js";

/**
 * In-memory MailTransport that records every send call. Used in unit tests
 * and as a drop-in replacement during integration tests so callers can assert
 * on rendered subject/HTML/text without standing up an SMTP relay.
 */
export class MailCaptureTransport implements MailTransport {
  readonly name = "capture";
  readonly messages: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.messages.push(msg);
  }

  /** Latest message sent to `to`, or `undefined` when none. */
  last(to?: string): MailMessage | undefined {
    if (to === undefined) return this.messages[this.messages.length - 1];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.to === to) return this.messages[i];
    }
    return undefined;
  }

  clear(): void {
    this.messages.length = 0;
  }
}
