import nodemailer, { type Transporter } from "nodemailer";
import type { MailMessage, MailTransport } from "./types.js";

export interface SmtpTransportOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  replyTo?: string;
}

/**
 * SMTP-backed MailTransport built on Nodemailer. Port 465 is treated as
 * implicit TLS; every other port uses STARTTLS upgrade (Nodemailer default).
 * Auth is omitted entirely when no user/pass are provided so the transport
 * can talk to local relays (mailhog, postfix on the same host).
 */
export class SmtpTransport implements MailTransport {
  readonly name = "smtp";

  private readonly transporter: Transporter;
  private readonly defaultFrom: string;
  private readonly defaultReplyTo?: string;

  constructor(opts: SmtpTransportOptions) {
    this.defaultFrom = opts.from;
    this.defaultReplyTo = opts.replyTo;
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: opts.user && opts.pass ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async send(msg: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: msg.from ?? this.defaultFrom,
      to: msg.to,
      replyTo: msg.replyTo ?? this.defaultReplyTo,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
  }
}
