import { compatExtraScopes, type CompatSettings } from "./profiles.js";

export const RESOURCE_SELF_SCOPE = "resources:self:manage";
export const ORGANIZATION_SELF_SCOPE = "organizations:self:manage";

/** Adds or removes an application-owned scope, so its flag alone decides it. */
function withFlaggedScope(
  scopes: readonly string[],
  scope: string,
  enabled: boolean,
): string[] {
  const without = scopes.filter((granted) => granted !== scope);
  return enabled ? [...without, scope] : without;
}

/** The user-resource scope is owned by the application's Resource sharing flag. */
export function withResourceSharingScope(
  scopes: readonly string[],
  enabled: boolean,
): string[] {
  return withFlaggedScope(scopes, RESOURCE_SELF_SCOPE, enabled);
}

/** The team scope is owned by the application's Teams flag. */
export function withTeamsScope(
  scopes: readonly string[],
  enabled: boolean,
): string[] {
  return withFlaggedScope(scopes, ORGANIZATION_SELF_SCOPE, enabled);
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
  // Lets a third-party backend create, join and leave teams for the signed-in
  // user through `/api/user/organizations*`.
  ORGANIZATION_SELF_SCOPE,
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
