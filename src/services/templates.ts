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

type PageName =
  | "login"
  | "register"
  | "verify-email"
  | "select-org"
  | "two-factor";

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
}

function resolveTemplate(
  page: PageName,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): string {
  const candidates: string[] = [];

  if (externalTemplatesDir) {
    if (appSlug) {
      candidates.push(join(externalTemplatesDir, appSlug, `${page}.html`));
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
    ALLOW_REGISTER: vars.allowRegister !== false ? "true" : "false",
    // Forward-slash escape prevents `</script>` injection when these JSON
    // blobs are inlined inside a <script> tag with `<%~` (raw output).
    ORGANIZATIONS_JSON: (vars.organizationsJson ?? "[]").replace(/\//g, "\\/"),
    SOCIAL_PROVIDERS_JSON: (vars.socialProvidersJson ?? "[]").replace(
      /\//g,
      "\\/",
    ),
    LOGIN_URL: vars.loginUrl ?? "/login",
    REGISTER_URL: vars.registerUrl ?? "/register",
  };

  return renderTemplateFile(path, it);
}
