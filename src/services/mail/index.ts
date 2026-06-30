/**
 * Mail pipeline entry point. Combines the template renderer (`email-templates`)
 * with the configured `MailTransport` to ship a fully rendered email.
 *
 * The transport is resolved lazily via `getMailTransport()` and memoised so
 * test setup can swap it out via `setMailTransport(...)` before the first
 * call — see `tests/helpers/mail-capture.ts`.
 */

import { config } from "../../config.js";
import { renderEmail } from "../email-templates.js";
import { NoopMailTransport } from "./noop-transport.js";
import { SmtpTransport } from "./smtp-transport.js";
import type { MailTransport } from "./types.js";

export type { MailMessage, MailTransport } from "./types.js";

let cached: MailTransport | null = null;

function buildTransport(): MailTransport {
  if (!config.smtp.host) return new NoopMailTransport();
  return new SmtpTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    user: config.smtp.user,
    pass: config.smtp.pass,
    from: config.smtp.from,
    replyTo: config.smtp.replyTo,
  });
}

export function getMailTransport(): MailTransport {
  if (!cached) cached = buildTransport();
  return cached;
}

/** Test-only: replace the active transport. Resets the memoised instance. */
export function setMailTransport(t: MailTransport | null): void {
  cached = t;
}

/**
 * Render and send an email template by name. Context fields commonly
 * available across templates (`appName`, `authUrl`, `appSlug`,
 * `supportEmail`, `logoUrl`) are auto-injected from `config`; per-call
 * `vars` win on key conflict.
 */
export async function sendEmail(
  name: string,
  to: string,
  vars: Record<string, unknown>,
  appSlug: string | null = null,
): Promise<void> {
  const transport = getMailTransport();
  const merged: Record<string, unknown> = {
    appName: config.appName,
    authUrl: config.betterAuth.url,
    appSlug: appSlug ?? "",
    supportEmail: config.smtp.replyTo ?? "",
    logoUrl: config.appLogoUrl ?? "",
    ...vars,
  };

  const rendered = renderEmail(name, merged, appSlug, config.templatesDir);
  const startedAt = Date.now();
  try {
    await transport.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: rendered.from,
      replyTo: rendered.replyTo,
    });
    console.info(
      `[mail] sent template=${name} to=${to} transport=${transport.name} duration_ms=${Date.now() - startedAt}`,
    );
  } catch (err) {
    console.error(
      `[mail] FAILED template=${name} to=${to} transport=${transport.name} duration_ms=${Date.now() - startedAt} err=${String(err)}`,
    );
    throw err;
  }
}
