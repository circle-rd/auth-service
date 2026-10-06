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
  | "device";

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

export interface TemplateVars {
  actionUrl: string;
  redirectTo: string;
  appSlug: string;
  errorMessage?: string;
  authUrl: string;
  oauthQuery?: string;
  allowRegister?: boolean;
  organizationsJson?: string;
  socialProvidersJson?: string;
  loginUrl?: string;
  registerUrl?: string;
  confirmationStatus?: ConfirmationStatus;
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
    LOGIN_URL: vars.loginUrl ?? "/login",
    REGISTER_URL: vars.registerUrl ?? "/register",
    // `status` query value for the confirmation page; empty on every other page.
    CONFIRMATION_STATUS: vars.confirmationStatus ?? "",
    ...confirmationCopy(vars.confirmationStatus),
  };

  return renderTemplateFile(path, it);
}
