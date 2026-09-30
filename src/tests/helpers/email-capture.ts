/**
 * Helpers to parse rendered email content captured by `MailCaptureTransport`
 * during integration tests.
 *
 * Templates ship as inline-styled HTML with primary action URLs and OTP
 * codes embedded in the markup. Tests use these utilities to extract the
 * dynamic payload (a token-bearing URL, a 6-digit OTP) and replay the
 * second leg of the flow with `app.inject()`.
 */

const HREF_RE = /href="([^"]+)"/gi;
const OTP_RE = /\b\d{6}\b/;

/**
 * Find the first http(s) URL in the rendered HTML's `href` attributes that
 * matches the optional predicate. Throws when none is found so tests fail
 * with a clear message rather than silently dereferencing `undefined`.
 */
export function extractUrl(
  html: string,
  predicate?: (url: string) => boolean,
): string {
  const matches: string[] = [];
  for (const m of html.matchAll(HREF_RE)) {
    const url = m[1];
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (predicate && !predicate(url)) continue;
    matches.push(url);
  }
  const first = matches[0];
  if (!first) {
    throw new Error(`No matching URL found in email HTML. HTML length=${html.length}`);
  }
  return first;
}

/** Extract the path + query portion of a URL (drops scheme + host). */
export function toPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Extract a 6-digit OTP code from the rendered HTML. */
export function extractOtp(html: string): string {
  const m = OTP_RE.exec(html);
  if (!m) throw new Error("No 6-digit OTP found in email HTML");
  return m[0];
}

/**
 * Parse `Set-Cookie` headers from a fastify-inject response into a `Cookie`
 * header value usable on the next request. Handles array and string forms.
 */
export function cookiesFromResponse(setCookie: string | string[] | undefined): string {
  if (!setCookie) return "";
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list
    .map((c) => c.split(";")[0])
    .filter((c): c is string => Boolean(c))
    .join("; ");
}
