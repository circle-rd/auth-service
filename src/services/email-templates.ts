/**
 * Email template resolver and renderer.
 *
 * Each email template is a single `.eml` file with the structure:
 *
 *     ---
 *     subject: Verify your email for <%= it.appName %>
 *     ---
 *     <html>
 *       <p>Click <a href="<%= it.url %>">here</a> to verify.</p>
 *     </html>
 *     ===TEXT===
 *     Click <%= it.url %> to verify.
 *
 * Sections:
 *   - YAML frontmatter (between `---` lines): only scalar keys are supported.
 *     The only required key is `subject`. Optional: `from`, `replyTo`.
 *   - HTML body: everything between the closing `---` and `===TEXT===`.
 *   - Plain-text body (after `===TEXT===`): optional. Falls back to a naive
 *     HTML-stripped version of the HTML body when absent.
 *
 * Both the subject line and each body section are processed through Eta with
 * HTML auto-escaping disabled for the subject (it's a header, not HTML) and
 * enabled for the HTML section. The text section uses `<%= %>` for raw values.
 *
 * Resolution order mirrors `templates.ts::resolveTemplate`:
 *   1. <TEMPLATES_DIR>/<appSlug>/emails/<name>.eml — per-app override
 *   2. <TEMPLATES_DIR>/default/emails/<name>.eml   — global override
 *   3. <BUILTIN>/emails/<name>.eml                 — bundled fallback
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplateString } from "./template-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_EMAIL_TEMPLATES_DIR = join(
  __dirname,
  "..",
  "..",
  "templates",
  "default",
  "emails",
);

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
}

export interface EmailFrontmatter {
  subject: string;
  from?: string;
  replyTo?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const TEXT_SEPARATOR = /\r?\n===TEXT===\r?\n/;

/**
 * Parse a minimal YAML-like frontmatter block into key/value pairs. Only
 * single-line scalar values are supported (`key: value`), with optional
 * surrounding quotes. Comments (`# ...`) and blank lines are ignored.
 */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Naive HTML→text fallback used when a template omits a `===TEXT===` section.
 * Strips tags, decodes a few entities, collapses whitespace.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function resolveEmailTemplate(
  name: string,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): string {
  const candidates: string[] = [];

  if (externalTemplatesDir) {
    if (appSlug) {
      candidates.push(
        join(externalTemplatesDir, appSlug, "emails", `${name}.eml`),
      );
    }
    candidates.push(
      join(externalTemplatesDir, "default", "emails", `${name}.eml`),
    );
  }

  candidates.push(join(BUILTIN_EMAIL_TEMPLATES_DIR, `${name}.eml`));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`No email template found for "${name}"`);
}

export function renderEmail(
  name: string,
  vars: Record<string, unknown>,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): RenderedEmail {
  const path = resolveEmailTemplate(name, appSlug, externalTemplatesDir);
  const raw = readFileSync(path, "utf-8");

  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(
      `Email template "${name}" is missing the YAML frontmatter block`,
    );
  }
  const fm = parseFrontmatter(match[1] ?? "") as Partial<EmailFrontmatter>;
  if (!fm.subject) {
    throw new Error(
      `Email template "${name}" is missing a "subject" frontmatter field`,
    );
  }

  const body = match[2] ?? "";
  const [htmlPart, textPart] = body.split(TEXT_SEPARATOR, 2);

  // Render via Eta. The body sections go through the file-aware renderer so
  // production caching applies; subject is small and rendered as a string.
  const subject = renderTemplateString(fm.subject, vars).trim();
  // For the HTML section we re-render from the original file location so any
  // future include/partial resolves relative to the template dir if needed.
  // The file already contains the frontmatter, so we render a sliced string.
  const html = renderTemplateString(htmlPart ?? "", vars).trim();
  const text =
    textPart !== undefined
      ? renderTemplateString(textPart, vars).trim()
      : htmlToText(html);

  return {
    subject,
    html,
    text,
    from: fm.from,
    replyTo: fm.replyTo,
  };
}
