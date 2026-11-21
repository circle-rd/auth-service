import { compatExtraScopes, type CompatSettings } from "./profiles.js";

export const RESOURCE_SELF_SCOPE = "resources:self:manage";

/** The user-resource scope is owned by the application's Resource sharing flag. */
export function withResourceSharingScope(
  scopes: readonly string[],
  enabled: boolean,
): string[] {
  const without = scopes.filter((scope) => scope !== RESOURCE_SELF_SCOPE);
  return enabled ? [...without, RESOURCE_SELF_SCOPE] : without;
}

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
  // Lets a third-party backend act for the signed-in user on their own shared
  // resources (create, validate, grant) through `/api/user/resources*`.
  RESOURCE_SELF_SCOPE,
  // Authorises opening a reverse tunnel to the relay (reverse-agent).
  "tunnel:serve",
  // Injects org_id (activeOrganizationId) in the access token. Clients that
  // need org-scoped data request it with `resource=<audience>` to get a JWT.
  "org",
] as const;

/** The scopes the OAuth provider accepts: native ones plus those a profile adds. */
export function supportedScopes(settings: CompatSettings): string[] {
  return [...NATIVE_SCOPES, ...compatExtraScopes(settings, NATIVE_SCOPES)];
}
