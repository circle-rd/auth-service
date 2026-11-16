/**
 * Platform role ranking shared by the auth instance and the admin routes.
 *
 * Kept in its own module (rather than `auth.ts`) so route plugins can reuse the
 * hierarchy without importing the BetterAuth instance.
 */

const ROLE_RANK: Record<string, number> = { user: 0, admin: 1, superadmin: 2 };

/** Roles allowed on the administration surface. */
export const ADMIN_ROLES: readonly string[] = ["admin", "superadmin"];

// Each dashboard lists the roles that may read it, so a dedicated role can be
// granted one view later without widening the others.
export const DASHBOARD_ROLES = {
  security: ADMIN_ROLES,
  business: ADMIN_ROLES,
} as const satisfies Record<string, readonly string[]>;

/** A user's roles: BetterAuth stores several as one comma-separated string. */
export function rolesOf(role: string | null | undefined): string[] {
  return role
    ? role
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export function hasAnyRole(
  role: string | null | undefined,
  allowed: readonly string[],
): boolean {
  const owned = rolesOf(role);
  return allowed.some((entry) => owned.includes(entry));
}

export function roleRank(role: string | null | undefined): number {
  return Math.max(0, ...rolesOf(role).map((entry) => ROLE_RANK[entry] ?? 0));
}

/** A caller may only manage users that strictly outrank below them. */
export function canManageRole(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  return roleRank(callerRole) > roleRank(targetRole);
}

/**
 * Admin-route policy, intentionally looser than `canManageRole`: a superadmin
 * may target anyone (including other superadmins, which the last-superadmin
 * guard in the delete route relies on) while an admin may only target
 * non-admin users.
 */
export function canAdminTargetUser(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  return hasAnyRole(callerRole, ["superadmin"]) || roleRank(targetRole) < 1;
}
