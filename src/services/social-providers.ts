/**
 * Per-application social provider gate.
 *
 * Semantics of `applications.enabledSocialProviders`:
 *  - `null`           → inherit globally enabled providers (no restriction)
 *  - `[]` (empty)     → social login disabled for this application
 *  - `[...providers]` → allow-list (only these providers are permitted)
 *
 * The credential provider (email/password) is never restricted by this gate.
 */
export function isSocialProviderAllowed(
  enabledSocialProviders: string[] | null | undefined,
  providerId: string,
): boolean {
  if (providerId === "credential") return true;
  if (enabledSocialProviders === null || enabledSocialProviders === undefined)
    return true;
  return enabledSocialProviders.includes(providerId);
}
