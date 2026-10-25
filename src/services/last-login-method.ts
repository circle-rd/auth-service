/**
 * Last-used sign-in method.
 *
 * BetterAuth's `lastLoginMethod` plugin records the method used for the most
 * recent sign-in in a browser cookie (`httpOnly: false`, 30-day lifetime). The
 * value is a provider id for social sign-ins (`google`, `github`) or a method
 * keyword for the others (`email`, `magic-link`, `email-otp`, `passkey`, `siwe`).
 *
 * We read it server-side so the sign-in page can narrow its social buttons to
 * the provider an existing user actually uses. That keeps returning social
 * users a one-click path without advertising a sign-up route to new visitors
 * when registration is closed.
 */

export const LAST_USED_LOGIN_METHOD_COOKIE =
  "better-auth.last_used_login_method";

/**
 * Extract the last-used sign-in method from a raw `Cookie` header value.
 * Returns `null` when the cookie is absent or empty.
 */
export function parseLastUsedLoginMethod(
  cookieHeader: string | undefined | null,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== LAST_USED_LOGIN_METHOD_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Narrow a page's offered social providers to the last-used one.
 *
 * Only a last-used value that is itself among the offered social providers
 * triggers narrowing — a non-social method (`email`, `magic-link`, …) or a
 * provider this application does not offer leaves the full list in place, so a
 * returning user is never left without a way to sign in.
 */
export function narrowSocialProvidersByLastUsed(
  providers: readonly string[],
  lastUsed: string | null,
): string[] {
  if (!lastUsed) return [...providers];
  return providers.includes(lastUsed) ? [lastUsed] : [...providers];
}
