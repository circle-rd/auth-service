import nodemailer from "nodemailer";
import { config } from "../config.js";

function createTransporter(): nodemailer.Transporter | null {
  if (!config.smtp.host) return null;

  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth:
      config.smtp.user && config.smtp.pass
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
  });
}

/**
 * Send a password reset email.
 * Silently no-ops if SMTP is not configured.
 */
export async function sendResetPasswordEmail(
  email: string,
  url: string,
): Promise<void> {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn(
      "[email] SMTP not configured — skipping sendResetPasswordEmail",
    );
    return;
  }

  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: "Reset your password",
    text: `Click the link below to reset your password:\n\n${url}\n\nThis link expires in 1 hour.`,
    html: `<p>Click the link below to reset your password:</p>
<p><a href="${url}">${url}</a></p>
<p>This link expires in 1 hour.</p>`,
  });
}

/**
 * Send an email verification email.
 * Silently no-ops if SMTP is not configured.
 */
export async function sendVerificationEmail(
  email: string,
  url: string,
): Promise<void> {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn(
      "[email] SMTP not configured — skipping sendVerificationEmail",
    );
    return;
  }

  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: "Verify your email address",
    text: `Click the link below to verify your email address:\n\n${url}`,
    html: `<p>Click the link below to verify your email address:</p>
<p><a href="${url}">${url}</a></p>`,
  });
}
