/**
 * Backwards-compatible email façade.
 *
 * All actual delivery lives in `./mail/`. This module exposes the
 * `send*Email` helpers historically called from `src/auth.ts` so the
 * BetterAuth callback wiring keeps a single import surface.
 */

import { config } from "../config.js";
import { sendEmail } from "./mail/index.js";

const VERIFY_TOKEN_TTL_HOURS = 1;
const RESET_TOKEN_TTL_HOURS = 1;
const CHANGE_EMAIL_TTL_HOURS = 1;
const MAGIC_LINK_TTL_MINUTES = 5;
const EMAIL_OTP_TTL_MINUTES = 10;

export async function sendVerificationEmail(
  email: string,
  url: string,
  appSlug?: string | null,
): Promise<void> {
  await sendEmail(
    "verify-email",
    email,
    { url, email, expiresInHours: VERIFY_TOKEN_TTL_HOURS },
    appSlug ?? null,
  );
}

export async function sendResetPasswordEmail(
  email: string,
  url: string,
  appSlug?: string | null,
): Promise<void> {
  await sendEmail(
    "reset-password",
    email,
    { url, email, expiresInHours: RESET_TOKEN_TTL_HOURS },
    appSlug ?? null,
  );
}

export async function sendChangeEmailVerification(
  email: string,
  newEmail: string,
  url: string,
  appSlug?: string | null,
): Promise<void> {
  await sendEmail(
    "change-email",
    email,
    { url, email, newEmail, expiresInHours: CHANGE_EMAIL_TTL_HOURS },
    appSlug ?? null,
  );
}

export async function sendMagicLinkEmail(
  email: string,
  url: string,
  appSlug?: string | null,
): Promise<void> {
  await sendEmail(
    "magic-link",
    email,
    { url, email, expiresInMinutes: MAGIC_LINK_TTL_MINUTES },
    appSlug ?? null,
  );
}

export async function sendEmailOtp(
  email: string,
  otp: string,
  type: "sign-in" | "email-verification" | "forget-password" | "change-email",
  appSlug?: string | null,
): Promise<void> {
  await sendEmail(
    "email-otp",
    email,
    { otp, email, type, expiresInMinutes: EMAIL_OTP_TTL_MINUTES },
    appSlug ?? null,
  );
}

export async function sendOrganizationInvitationEmail(
  email: string,
  args: {
    url: string;
    inviterName: string;
    orgName: string;
    role?: string;
  },
  appSlug?: string | null,
): Promise<void> {
  await sendEmail(
    "org-invitation",
    email,
    {
      url: args.url,
      email,
      inviterName: args.inviterName,
      orgName: args.orgName,
      role: args.role,
    },
    appSlug ?? null,
  );
}

// Re-export config getter for callers that wish to display the configured
// from-address (e.g. admin diagnostics page).
export const smtpFrom = config.smtp.from;
