/**
 * Template resolver for customisable auth pages.
 *
 * Resolution order for a given page (e.g. "login") and client app slug:
 *   1. <TEMPLATES_DIR>/<appSlug>/login.html   — per-application override
 *   2. <TEMPLATES_DIR>/default/login.html     — global override
 *   3. <__dirname>/../../templates/default/login.html — built-in fallback
 *
 * Templates are rendered with Eta. Built-in templates use uppercase variable
 * names (e.g. `<%= it.ACTION_URL %>`, `<%~ it.SOCIAL_PROVIDERS_JSON %>`) to
 * remain a 1:1 swap from the previous {{VAR}} substitution scheme. Custom
 * overrides may use any naming.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplateFile } from "./template-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_TEMPLATES_DIR = join(
  __dirname,
  "..",
  "..",
  "templates",
  "default",
);

export type PageName =
  | "login"
  | "register"
  | "verify-email"
  | "email-verified"
  | "select-org"
  | "two-factor"
  | "device"
  | "error"
  | "complete-registration"
  | "accept-invitation";

/**
 * Path of the post-verification confirmation page, and the flows it can report.
 * `activated` — a sign-up address was confirmed. `pending` — the request to
 * change the address was confirmed and the new address now has to be verified.
 * `updated` — a change of address was completed. The value travels in the
 * page's query string (`?status=`), which is what makes the two flows tell
 * different stories on one shared page.
 */
export const EMAIL_VERIFIED_PATH = "/email-verified";
export const CONFIRMATION_STATUSES = [
  "activated",
  "pending",
  "updated",
] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

// Application slugs are constrained to this charset everywhere else (admin
// route + OAuth client ids). Validating again here prevents `client_id` from
// being used as a path-traversal vector when resolving per-app templates.
const APP_SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Copy for the post-verification page, keyed by the flow that completed. The
 * server template system is standalone (Eta, English, one file per page), so
 * the wording lives here beside the other derived variables rather than being
 * branched inside the template — an override only has to lay the strings out.
 */
const CONFIRMATION_COPY: Record<
  ConfirmationStatus | "unknown",
  { heading: string; subtitle: string; badge: string; body: string }
> = {
  activated: {
    heading: "Account activated",
    subtitle: "Your email address is confirmed and your account is ready.",
    badge: "Account activated",
    body: "Thanks for confirming your address. You can now sign in with your password.",
  },
  pending: {
    heading: "Email change requested",
    subtitle: "We have confirmed your request to change your address.",
    badge: "Change requested",
    body: "We have sent a verification link to your new address. Follow it to complete the change.",
  },
  updated: {
    heading: "Email address updated",
    subtitle: "Your new email address is confirmed.",
    badge: "Email address updated",
    body: "Your account now uses your new address. Your password is unchanged.",
  },
  unknown: {
    heading: "Email confirmed",
    subtitle: "Your email address has been confirmed.",
    badge: "Email confirmed",
    body: "You can now sign in with your password.",
  },
};

/**
 * Copy for the generic authentication-error page, keyed by the OAuth / domain
 * error code that travelled in the query string (`?error=`). Codes come from
 * both this service (`REGISTRATION_CLOSED`, invitation errors) and the OAuth
 * provider plugin (RFC 6749 §4.1.2.1 values, e.g. `access_denied`). Unknown
 * codes fall back to neutral wording so an untrusted value is never echoed as
 * display copy.
 */
const ERROR_COPY: Record<
  string,
  { heading: string; subtitle: string; badge: string }
> = {
  REGISTRATION_CLOSED: {
    heading: "Registration is not available",
    subtitle:
      "This application does not accept new accounts. If you already have an account, sign in instead.",
    badge: "Registration closed",
  },
  INVITATION_INVALID: {
    heading: "This invitation is no longer valid",
    subtitle:
      "The invitation link is invalid, has expired, or has already been used. Ask an administrator to send a new one.",
    badge: "Invitation invalid",
  },
  INVITATION_EXPIRED: {
    heading: "This invitation has expired",
    subtitle:
      "Invitation links are time-limited. Ask an administrator to send a new one.",
    badge: "Invitation expired",
  },
  access_denied: {
    heading: "Access denied",
    subtitle:
      "The request was cancelled or you are not allowed to continue. Return to the application to try again.",
    badge: "Access denied",
  },
  invalid_request: {
    heading: "Invalid request",
    subtitle:
      "This sign-in request is malformed or incomplete. Start again from the application.",
    badge: "Invalid request",
  },
  unauthorized_client: {
    heading: "Application not authorized",
    subtitle: "This application is not allowed to make this request.",
    badge: "Unauthorized application",
  },
  invalid_client: {
    heading: "Application not recognized",
    subtitle: "This application could not be authenticated by the service.",
    badge: "Unknown application",
  },
  invalid_scope: {
    heading: "Requested access is not available",
    subtitle:
      "The application asked for permissions this service does not grant.",
    badge: "Invalid scope",
  },
  server_error: {
    heading: "Something went wrong",
    subtitle:
      "We could not complete this request because of a temporary problem. Please try again.",
    badge: "Server error",
  },
  temporarily_unavailable: {
    heading: "Service temporarily unavailable",
    subtitle:
      "The sign-in service is briefly unavailable. Please try again in a moment.",
    badge: "Unavailable",
  },
};

const DEFAULT_ERROR_COPY = {
  heading: "Something went wrong",
  subtitle:
    "We could not complete this request. Please try again or return to the application.",
  badge: "Authentication error",
};

function errorCopy(code: string | undefined): Record<string, string> {
  const copy = (code && ERROR_COPY[code]) || DEFAULT_ERROR_COPY;
  return {
    ERROR_HEADING: copy.heading,
    ERROR_SUBTITLE: copy.subtitle,
    ERROR_BADGE: copy.badge,
  };
}

export interface TemplateVars {
  actionUrl: string;
  redirectTo: string;
  appSlug: string;
  errorMessage?: string;
  authUrl: string;
  oauthQuery?: string;
  allowRegister?: boolean;
  organizationsJson?: string;
  // `socialProvidersJson` is what the page should show first (already narrowed
  // by last-used method on the login page); `socialProvidersAllJson` is the
  // full allow-list, so the page can offer the others behind a toggle.
  socialProvidersJson?: string;
  socialProvidersAllJson?: string;
  loginUrl?: string;
  registerUrl?: string;
  confirmationStatus?: ConfirmationStatus;
  // Instance-level branding, so server-rendered pages (notably the error page)
  // match the service identity instead of a bare page.
  appName?: string;
  logoUrl?: string;
  logoDarkUrl?: string;
  // Machine-readable error, surfaced by the error page. `errorCode` doubles as
  // the key into ERROR_COPY; `errorDescription` is the provider-supplied text.
  errorCode?: string;
  errorDescription?: string;
  // Pre-filled, read-only address and the raw invitation token for the
  // complete-registration page.
  email?: string;
  invitationToken?: string;
  // Shared invitation pages (`accept-invitation`, `complete-registration`).
  invitationKind?: "organization" | "application";
  invitationId?: string;
  targetName?: string;
  inviterName?: string;
  invitationRole?: string;
  sessionEmail?: string;
  sessionMatches?: boolean;
  hasAccount?: boolean;
  acceptUrl?: string;
  socialUrl?: string;
}

function confirmationCopy(
  status: ConfirmationStatus | undefined,
): Record<string, string> {
  const copy = CONFIRMATION_COPY[status ?? "unknown"];
  return {
    CONFIRMATION_HEADING: copy.heading,
    CONFIRMATION_SUBTITLE: copy.subtitle,
    CONFIRMATION_BADGE: copy.badge,
    CONFIRMATION_BODY: copy.body,
  };
}

function resolveTemplate(
  page: PageName,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): string {
  const candidates: string[] = [];
  const safeSlug =
    appSlug && APP_SLUG_RE.test(appSlug) && appSlug.length <= 64
      ? appSlug
      : null;

  if (externalTemplatesDir) {
    if (safeSlug) {
      candidates.push(join(externalTemplatesDir, safeSlug, `${page}.html`));
    }
    candidates.push(join(externalTemplatesDir, "default", `${page}.html`));
  }

  candidates.push(join(BUILTIN_TEMPLATES_DIR, `${page}.html`));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`No template found for page "${page}"`);
}

export function renderAuthPage(
  page: PageName,
  vars: TemplateVars,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): string {
  const path = resolveTemplate(page, appSlug, externalTemplatesDir);

  // Map TS camelCase fields to the UPPER_SNAKE names that built-in templates
  // reference. Defaults mirror the legacy substitution behaviour.
  const it: Record<string, unknown> = {
    ACTION_URL: vars.actionUrl,
    REDIRECT_TO: vars.redirectTo,
    APP_SLUG: vars.appSlug,
    AUTH_URL: vars.authUrl,
    ERROR_MESSAGE: vars.errorMessage ?? "",
    OAUTH_QUERY: vars.oauthQuery ?? "",
    // Real boolean (not the string "true"/"false"): `if (it.ALLOW_REGISTER)`
    // must behave correctly, and `<%~ it.ALLOW_REGISTER %>` emits a JS literal.
    ALLOW_REGISTER: vars.allowRegister !== false,
    // Forward-slash escape prevents `</script>` injection when these JSON
    // blobs are inlined inside a <script> tag with `<%~` (raw output).
    ORGANIZATIONS_JSON: (vars.organizationsJson ?? "[]").replace(/\//g, "\\/"),
    SOCIAL_PROVIDERS_JSON: (vars.socialProvidersJson ?? "[]").replace(
      /\//g,
      "\\/",
    ),
    SOCIAL_PROVIDERS_ALL_JSON: (
      vars.socialProvidersAllJson ??
      vars.socialProvidersJson ??
      "[]"
    ).replace(/\//g, "\\/"),
    LOGIN_URL: vars.loginUrl ?? "/login",
    REGISTER_URL: vars.registerUrl ?? "/register",
    // `status` query value for the confirmation page; empty on every other page.
    CONFIRMATION_STATUS: vars.confirmationStatus ?? "",
    ...confirmationCopy(vars.confirmationStatus),
    APP_NAME: vars.appName ?? "",
    LOGO_URL: vars.logoUrl ?? "",
    LOGO_DARK_URL: vars.logoDarkUrl ?? "",
    ERROR_CODE: vars.errorCode ?? "",
    ERROR_DESCRIPTION: vars.errorDescription ?? "",
    EMAIL: vars.email ?? "",
    INVITATION_TOKEN: vars.invitationToken ?? "",
    INVITATION_KIND: vars.invitationKind ?? "",
    INVITATION_ID: vars.invitationId ?? "",
    TARGET_NAME: vars.targetName ?? "",
    INVITER_NAME: vars.inviterName ?? "",
    INVITATION_ROLE: vars.invitationRole ?? "",
    SESSION_EMAIL: vars.sessionEmail ?? "",
    SESSION_MATCHES: vars.sessionMatches === true,
    HAS_ACCOUNT: vars.hasAccount === true,
    ACCEPT_URL: vars.acceptUrl ?? "",
    SOCIAL_URL: vars.socialUrl ?? "",
    ...errorCopy(vars.errorCode),
  };

  return renderTemplateFile(path, it);
}
