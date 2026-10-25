import { compatExtraScopes, type CompatSettings } from "./profiles.js";

export const NATIVE_SCOPES = [
  "openid",
  "profile",
  "email",
  "phone",
  "offline_access",
  "roles",
  "permissions",
  "features",
  "wallet:self:read",
  // Injects org_id (activeOrganizationId) in the access token. Clients that
  // need org-scoped data request it with `resource=<audience>` to get a JWT.
  "org",
] as const;

/** The scopes the OAuth provider accepts: native ones plus those a profile adds. */
export function supportedScopes(settings: CompatSettings): string[] {
  return [...NATIVE_SCOPES, ...compatExtraScopes(settings, NATIVE_SCOPES)];
}
