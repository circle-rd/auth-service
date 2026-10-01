/**
 * Mutable runtime state for dynamic CORS / trusted-origin management.
 *
 * Seeded at startup from CORS_ORIGINS and the applications.url column, and
 * updated on every application create / update / delete — no server restart
 * needed when registering a new application via the admin UI.
 *
 * Protected OAuth resources (RFC 8707 audiences) are no longer held here:
 * BetterAuth 1.7 persists them in the `oauth_resource` table, synced by
 * services/oauth-resources.ts.
 */

/** Live list of trusted origins for BetterAuth CSRF checks.
 *  Passed by reference to betterAuth({ trustedOrigins }). */
export const trustedOrigins: string[] = [];

/** Live set of allowed CORS origins.
 *  Used by the Fastify CORS origin function and the manual /api/auth/* header
 *  injection (which bypasses the CORS plugin via reply.hijack()). */
export const corsOrigins = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────────

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
