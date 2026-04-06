/**
 * Template resolver for customisable auth pages.
 *
 * Resolution order for a given page (e.g. "login") and client app slug:
 *   1. <TEMPLATES_DIR>/<appSlug>/login.html   — per-application override
 *   2. <TEMPLATES_DIR>/default/login.html     — global override
 *   3. <__dirname>/../../templates/default/login.html — built-in fallback
 *
 * Templates receive simple {{VAR}} substitutions for:
 *   ACTION_URL, REDIRECT_TO, APP_SLUG, ERROR_MESSAGE, AUTH_URL
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_TEMPLATES_DIR = join(
  __dirname,
  "..",
  "..",
  "templates",
  "default",
);

type PageName = "login" | "register" | "verify-email";

export interface TemplateVars {
  actionUrl: string;
  redirectTo: string;
  appSlug: string;
  errorMessage?: string;
  authUrl: string;
  /**
   * Raw OAuth query string (including sig) forwarded from BetterAuth's login
   * redirect. When present it is passed as `oauth_query` in the sign-in body
   * so BetterAuth's after-hook can resume the authorization flow.
   */
  oauthQuery?: string;
}

/**
 * Resolve the HTML template for a given auth page.
 *
 * @param page - Page identifier: login | register | verify-email
 * @param appSlug - OAuth client_id / application slug (used for per-app override)
 * @param externalTemplatesDir - Value of config.templatesDir (may be null)
 * @returns Raw HTML string of the resolved template
 */
function resolveTemplate(
  page: PageName,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): string {
  const candidates: string[] = [];

  if (externalTemplatesDir) {
    // 1. Per-application override
    if (appSlug) {
      candidates.push(join(externalTemplatesDir, appSlug, `${page}.html`));
    }
    // 2. Global override
    candidates.push(join(externalTemplatesDir, "default", `${page}.html`));
  }

  // 3. Built-in fallback (shipped with auth-service)
  candidates.push(join(BUILTIN_TEMPLATES_DIR, `${page}.html`));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf-8");
    }
  }

  throw new Error(`No template found for page "${page}"`);
}

/**
 * Render an auth page template with variable substitution.
 *
 * @param page - Page identifier
 * @param vars - Variables to inject into the template
 * @param appSlug - Application slug for per-app override lookup
 * @param externalTemplatesDir - Value of config.templatesDir
 * @returns Rendered HTML string ready to send
 */
export function renderAuthPage(
  page: PageName,
  vars: TemplateVars,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): string {
  const template = resolveTemplate(page, appSlug, externalTemplatesDir);

  return template
    .replace(/\{\{ACTION_URL\}\}/g, escapeHtml(vars.actionUrl))
    .replace(/\{\{REDIRECT_TO\}\}/g, escapeHtml(vars.redirectTo))
    .replace(/\{\{APP_SLUG\}\}/g, escapeHtml(vars.appSlug))
    .replace(/\{\{AUTH_URL\}\}/g, escapeHtml(vars.authUrl))
    .replace(
      /\{\{ERROR_MESSAGE\}\}/g,
      vars.errorMessage ? escapeHtml(vars.errorMessage) : "",
    )
    .replace(
      /\{\{OAUTH_QUERY\}\}/g,
      vars.oauthQuery ? escapeHtml(vars.oauthQuery) : "",
    );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
