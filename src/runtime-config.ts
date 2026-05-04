/**
 * Mutable runtime state for dynamic audience and CORS management.
 *
 * Seeded at startup from:
 *   1. OAUTH_VALID_AUDIENCES / CORS_ORIGINS env vars (backward compat)
 *   2. applications.url column in the DB
 *
 * Updated on every application create / update / delete — no server restart
 * needed when registering a new application via the admin UI.
 *
 * Why mutable arrays work:
 *  - @better-auth/oauth-provider spreads `validAudiences` into a new Set on
 *    every token request (`new Set([...opts.validAudiences])`), so mutations
 *    are picked up immediately.
 *  - BetterAuth reads `trustedOrigins` on every request for CSRF checks.
 *  - Fastify CORS uses an `origin` function that closes over `corsOrigins`.
 */

/** Live list of valid OAuth resource server audiences (RFC 8707).
 *  Passed by reference to @better-auth/oauth-provider's `validAudiences`. */
export const validAudiences: string[] = [];

/** Live list of trusted origins for BetterAuth CSRF checks.
 *  Passed by reference to betterAuth({ trustedOrigins }). */
export const trustedOrigins: string[] = [];

/** Live set of allowed CORS origins.
 *  Used by the Fastify CORS origin function and the manual /api/auth/* header
 *  injection (which bypasses the CORS plugin via reply.hijack()). */
export const corsOrigins = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Add a resource URL to validAudiences (deduplicated). No-op for empty/invalid values. */
export function addAudience(url: string | null | undefined): void {
  if (!url) return;
  if (!validAudiences.includes(url)) {
    validAudiences.push(url);
  }
}

/** Remove a resource URL from validAudiences. */
export function removeAudience(url: string | null | undefined): void {
  if (!url) return;
  const idx = validAudiences.indexOf(url);
  if (idx !== -1) validAudiences.splice(idx, 1);
}

/**
 * Add an origin derived from `rawUrl` to trustedOrigins and corsOrigins.
 * Accepts a full URL (e.g. "https://app.example.com/callback") and extracts
 * the origin ("https://app.example.com"). No-op for invalid URLs.
 */
export function addCorsOrigin(rawUrl: string | null | undefined): void {
  const origin = toOrigin(rawUrl);
  if (!origin) return;
  if (!trustedOrigins.includes(origin)) {
    trustedOrigins.push(origin);
  }
  corsOrigins.add(origin);
}

/**
 * Remove an origin from trustedOrigins and corsOrigins.
 * Call only when no other registered application shares the same origin.
 */
export function removeCorsOrigin(rawUrl: string | null | undefined): void {
  const origin = toOrigin(rawUrl);
  if (!origin) return;
  const idx = trustedOrigins.indexOf(origin);
  if (idx !== -1) trustedOrigins.splice(idx, 1);
  corsOrigins.delete(origin);
}

/** Extract the URL origin, returning null for invalid input. */
function toOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}
