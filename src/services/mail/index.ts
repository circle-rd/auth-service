/**
 * Mail pipeline entry point. Combines the template renderer (`email-templates`)
 * with the configured `MailTransport` to ship a fully rendered email.
 *
 * The transport is resolved lazily via `getMailTransport()` and memoised so
 * test setup can swap it out via `setMailTransport(...)` before the first
 * call — see `tests/helpers/mail-capture.ts`.
 */

import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { renderEmail } from "../email-templates.js";
import { NoopMailTransport } from "./noop-transport.js";
import { SmtpTransport } from "./smtp-transport.js";
import { getCachedLogoAttachment, ensureLogoAttachmentWarmed } from "./logo.js";
import type { MailTransport } from "./types.js";

export type { MailAttachment, MailMessage, MailTransport } from "./types.js";

let cached: MailTransport | null = null;

function buildTransport(): MailTransport {
  if (!config.smtp.host) return new NoopMailTransport();
  // Warm the embedded-logo cache at boot so the first real send already has it
  // without ever blocking on the network.
  void ensureLogoAttachmentWarmed();
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
 * Whether the active transport can actually deliver mail. False for the no-op
 * transport used when `SMTP_HOST` is unset, so callers can decide between
 * attempting a send and surfacing a clear "not configured" error.
 */
export function isMailConfigured(): boolean {
  return getMailTransport().name !== "noop";
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
  // Embed the instance logo as a CID attachment so clients render it without
  // an external request. Resolution never blocks delivery: use the cached
  // attachment and refresh it in the background for subsequent messages.
  const mailConfigured = isMailConfigured();
  const logo = mailConfigured ? getCachedLogoAttachment() : null;
  if (mailConfigured) void ensureLogoAttachmentWarmed();
  const merged: Record<string, unknown> = {
    appName: config.appName,
    authUrl: config.betterAuth.url,
    appSlug: appSlug ?? "",
    supportEmail: config.smtp.replyTo ?? "",
    logoUrl: config.appLogoUrl ?? "",
    logoCid: logo?.cid ?? "",
    hasLogo: Boolean(logo),
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
      attachments: logo ? [logo] : undefined,
    });
    if (!isMailConfigured()) {
      // Never report a dropped message as "sent": without SMTP there is no
      // delivery, and a misleading log hides broken email in production.
      logger.warn(
        `[mail] DROPPED (no SMTP configured) template=${name} to=${to}`,
      );
      return;
    }
    logger.info(
      `[mail] sent template=${name} to=${to} transport=${transport.name} duration_ms=${Date.now() - startedAt}`,
    );
  } catch (err) {
    logger.error(
      `[mail] FAILED template=${name} to=${to} transport=${transport.name} duration_ms=${Date.now() - startedAt} err=${String(err)}`,
    );
    throw err;
  }
}
