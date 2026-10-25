import { config } from "../config.js";
import { getUserClaims } from "../services/claims.js";
import type { ClaimMapping } from "./profiles.js";

type Claims = Record<string, unknown>;
type UserClaimsProfile = Parameters<typeof getUserClaims>[3];

// Native scope that makes getUserClaims compute the data a mapping copies, and
// the native claims that scope adds.
const SOURCE_SCOPE = {
  roles: "roles",
  permissions: "permissions",
  email: "email",
} as const;
const SOURCE_NATIVE_CLAIMS: Record<string, string[]> = {
  roles: ["roles"],
  permissions: ["permissions"],
  email: ["email", "email_verified"],
};

function sourceValue(
  mapping: ClaimMapping,
  claims: Claims,
  scopes: string[],
  clientId: string | undefined,
): unknown {
  switch (mapping.source) {
    case "roles":
      return claims.roles;
    case "permissions":
      return claims.permissions;
    case "email":
      return claims.email;
    case "scope":
      return scopes;
    case "clientId":
      return clientId;
  }
}

/**
 * Add the claims another identity provider would have emitted (`groups`,
 * `scp`…), copied from values auth-service already holds. A mapping only
 * fires when its trigger scope was requested, and the native claims it needed
 * are dropped again unless the client asked for them itself, so a mapping never
 * widens what a token discloses.
 */
export async function applyClaimMappings(
  mappings: readonly ClaimMapping[],
  scopes: string[],
  clientId: string | undefined,
  build: (effectiveScopes: string[]) => Promise<Claims>,
): Promise<Claims> {
  const active = mappings.filter((m) => !m.scope || scopes.includes(m.scope));
  if (active.length === 0) return build(scopes);

  const added = new Set<string>();
  for (const m of active) {
    const scope = SOURCE_SCOPE[m.source as keyof typeof SOURCE_SCOPE];
    if (scope && !scopes.includes(scope)) added.add(scope);
  }

  const claims = await build([...scopes, ...added]);
  const out: Claims = { ...claims };
  const targets = new Set(active.map((m) => m.claim));
  for (const m of active) {
    const value = sourceValue(m, claims, scopes, clientId);
    if (value !== undefined) out[m.claim] = value;
  }
  for (const scope of added) {
    for (const key of SOURCE_NATIVE_CLAIMS[scope] ?? []) {
      if (!targets.has(key)) delete out[key];
    }
  }
  return out;
}

/** getUserClaims, completed with the instance's claim mappings. */
export async function getCompatUserClaims(
  userId: string,
  clientId: string | undefined,
  scopes: string[],
  profile?: UserClaimsProfile,
): Promise<Claims> {
  return applyClaimMappings(
    config.compat.claimMappings,
    scopes,
    clientId,
    (effective) =>
      getUserClaims(userId, clientId, effective, profile) as Promise<Claims>,
  );
}
