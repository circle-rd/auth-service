/**
 * One policy for every URL that comes from Stripe. A Stripe payload is external
 * input: a `javascript:` or plain-http link must never reach a client, whether
 * it is stored, rendered or used as a redirect.
 */

/** Keep a nullable link only when it is an absolute https URL. */
export function httpsOnly(url: string | null | undefined): string | null {
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/** A required redirect (Checkout, Billing Portal) must be https. */
export function isHttpsUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}

/**
 * Keep an absolute http(s) URL for a public asset (a logo, a product page).
 * Not security-sensitive, but an invalid or non-web value must never reach
 * Stripe as an image or URL.
 */
export function httpUrlOrNull(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? trimmed
      : null;
  } catch {
    return null;
  }
}
