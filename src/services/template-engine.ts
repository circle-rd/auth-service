/**
 * Shared Eta template engine for auth pages and emails.
 *
 * Resolution order is handled by callers (see `templates.ts` and
 * `email-templates.ts`); this module only exposes a single `renderTemplateFile`
 * helper that loads an absolute file path through Eta with HTML auto-escaping
 * enabled. Strings are rendered via `renderTemplateString` for inline cases
 * (e.g. email subject lines).
 *
 * Eta tag reference:
 *   `<%= it.x %>` — HTML-escaped output (default; matches the previous
 *                   {{VAR}} behaviour for user-facing strings)
 *   `<%~ it.x %>` — Raw output (use for JSON blobs / pre-computed safe HTML)
 *   `<% if (...) { %> ... <% } %>` — Control flow
 */

import { Eta } from "eta";
import { readFileSync } from "node:fs";

const isProduction = process.env.NODE_ENV === "production";

// In-memory file cache. Eta's own `cache: true` only caches compiled templates
// keyed by views/path; since callers resolve absolute paths themselves, we
// short-circuit disk reads here too.
const fileCache = new Map<string, string>();

const eta = new Eta({
  autoEscape: true,
  cache: isProduction,
  // `useWith` keeps the `it.` prefix mandatory; this is intentional so template
  // authors cannot shadow Eta internals by mistake.
  useWith: false,
  // Eta requires a `views` directory but we always pass absolute paths and
  // resolve overrides ourselves, so this is just a placeholder.
  views: "/",
});

export function renderTemplateFile(
  absolutePath: string,
  vars: Record<string, unknown>,
): string {
  let source = isProduction ? fileCache.get(absolutePath) : undefined;
  if (source === undefined) {
    source = readFileSync(absolutePath, "utf-8");
    if (isProduction) fileCache.set(absolutePath, source);
  }
  return eta.renderString(source, vars);
}

export function renderTemplateString(
  source: string,
  vars: Record<string, unknown>,
): string {
  return eta.renderString(source, vars);
}
