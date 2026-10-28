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
 * Both the subject line and each body section are processed through Eta:
 * `<%= %>` escapes HTML in the HTML section only. The subject (a header) and the
 * text section are not HTML, so their values are inserted as they are.
 *
 * Resolution order mirrors `templates.ts::resolveTemplate`:
 *   1. <TEMPLATES_DIR>/<appSlug>/emails/<name>.eml — per-app override
 *   2. <TEMPLATES_DIR>/default/emails/<name>.eml   — global override
 *   3. <BUILTIN>/emails/<name>.eml                 — bundled fallback
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPlainString, renderTemplateString } from "./template-engine.js";
import { APP_SLUG_RE } from "./templates.js";

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
  preheader?: string;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrap the inner content of a built-in template in a shared, email-client-safe
 * shell. Table layout, inline styles, a CID logo and a compact footer keep the
 * message readable even when a client blocks remote assets or strips classes.
 * External/tenant overrides stay in full control of their markup.
 */
function wrapEmailLayout(
  inner: string,
  vars: Record<string, unknown>,
  preheader?: string,
): string {
  const appName = escapeHtml(String(vars.appName ?? "Auth"));
  const authUrl = String(vars.authUrl ?? "");
  const supportEmail = String(vars.supportEmail ?? "");
  const logoCid = String(vars.logoCid ?? "");
  const hasLogo = Boolean(vars.hasLogo) && logoCid !== "";
  const year = new Date().getFullYear();
  const font =
    "'Inter','Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif";
  const initial = escapeHtml(appName.trim().charAt(0).toUpperCase() || "A");

  const brand = hasLogo
    ? `<img src="cid:${escapeHtml(logoCid)}" alt="${appName}" width="44" height="44" style="display:block;width:44px;height:44px;border:0;outline:none;text-decoration:none;border-radius:12px;" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" valign="middle" bgcolor="#2563eb" style="width:44px;height:44px;background-color:#2563eb;border-radius:12px;color:#ffffff;font-family:${font};font-size:19px;font-weight:700;line-height:44px;">${initial}</td></tr></table>`;

  const support = supportEmail
    ? `<p style="margin:0 0 6px;">Questions? <a href="mailto:${escapeHtml(supportEmail)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(supportEmail)}</a></p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${appName}</title>
<style>
@media only screen and (max-width:600px){
  .email-shell{width:100%!important;border-radius:0!important;}
  .email-pad{padding-left:22px!important;padding-right:22px!important;}
  .email-btn{display:block!important;}
}
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:#f4f4f7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f7;opacity:0;">${escapeHtml(preheader ?? `A message from ${appName}.`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f4f4f7;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e4e4e7;border-radius:16px;overflow:hidden;font-family:${font};">
<tr><td height="3" bgcolor="#2563eb" style="height:3px;background-color:#2563eb;line-height:3px;font-size:0;">&nbsp;</td></tr>
<tr><td class="email-pad" style="padding:28px 36px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="44" valign="middle" style="width:44px;vertical-align:middle;">${brand}</td>
<td valign="middle" style="padding-left:12px;vertical-align:middle;">
<div style="font-size:16px;font-weight:700;line-height:1.3;color:#18181b;letter-spacing:-0.02em;">${appName}</div>
<div style="margin-top:2px;font-size:10px;font-weight:600;line-height:1.3;letter-spacing:0.14em;text-transform:uppercase;color:#a1a1aa;">Account notification</div>
</td>
</tr></table>
</td></tr>
<tr><td class="email-pad" style="padding:24px 36px 34px;color:#3f3f46;font-size:15px;line-height:1.65;">${inner}</td></tr>
<tr><td class="email-pad" style="padding:22px 36px 28px;border-top:1px solid #e4e4e7;background-color:#fafafa;color:#71717a;font-size:12px;line-height:1.65;">
<p style="margin:0 0 6px;font-weight:600;color:#52525b;">${appName}</p>
${support}
${authUrl ? `<p style="margin:0 0 6px;"><a href="${escapeHtml(authUrl)}" style="color:#2563eb;text-decoration:none;word-break:break-all;">${escapeHtml(authUrl)}</a></p>` : ""}
<p style="margin:0;">This is an automated message &mdash; please do not reply.</p>
<p style="margin:6px 0 0;color:#a1a1aa;">&copy; ${year} ${appName}. All rights reserved.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function resolveEmailTemplate(
  name: string,
  appSlug: string | null,
  externalTemplatesDir: string | null,
): string {
  const candidates: string[] = [];

  if (externalTemplatesDir) {
    // The slug can come from a caller-controlled `client_id`: an unsafe one
    // never reaches the file system and falls through to the default templates.
    if (appSlug && APP_SLUG_RE.test(appSlug)) {
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
  const subject = renderPlainString(fm.subject, vars).trim();
  // For the HTML section we re-render from the original file location so any
  // future include/partial resolves relative to the template dir if needed.
  // The file already contains the frontmatter, so we render a sliced string.
  const innerHtml = renderTemplateString(htmlPart ?? "", vars).trim();
  const text =
    textPart !== undefined
      ? renderPlainString(textPart, vars).trim()
      : htmlToText(innerHtml);

  // Bundled templates get the shared branded shell; external overrides are
  // rendered verbatim so tenants keep full control.
  const preheader = fm.preheader
    ? renderPlainString(fm.preheader, vars).trim()
    : undefined;
  const html = path.startsWith(BUILTIN_EMAIL_TEMPLATES_DIR)
    ? wrapEmailLayout(innerHtml, vars, preheader)
    : innerHtml;

  return {
    subject,
    html,
    text,
    from: fm.from,
    replyTo: fm.replyTo,
  };
}
