/**
 * Helpers for moving between the public auth screens (sign-in, password
 * reset) while keeping the signed OAuth parameters that brought the user here.
 *
 * An OAuth authorization request lands on `/login` carrying `client_id`,
 * `sig` and `redirectTo`; those query parameters must survive a detour
 * through the password-reset screens so the flow resumes on the way back.
 */

const OAUTH_QUERY_KEYS = ['client_id', 'sig', 'redirectTo'] as const;

/**
 * Serialise the auth parameters carried by the current URL. Returns an empty
 * string when the URL carries none, so callers can append it unconditionally.
 */
export function authQueryString(
  query: Record<string, unknown> | undefined,
): string {
  const params = new URLSearchParams();
  if (!query) return '';
  for (const key of OAUTH_QUERY_KEYS) {
    const value = query[key];
    if (typeof value === 'string' && value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Build the path of an auth screen with the current auth parameters kept. */
export function authPagePath(
  path: string,
  query: Record<string, unknown> | undefined,
): string {
  return `${path}${authQueryString(query)}`;
}
